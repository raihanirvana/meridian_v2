import path from "node:path";
import process from "node:process";
import { z } from "zod";

import { HttpTokenIntelGateway } from "../adapters/analytics/HttpTokenIntelGateway.js";
import { HttpDlmmGateway } from "../adapters/dlmm/HttpDlmmGateway.js";
import { JupiterApiSwapGateway } from "../adapters/jupiter/JupiterApiSwapGateway.js";
import { HttpLlmGateway } from "../adapters/llm/HttpLlmGateway.js";
import {
  type SolPriceQuote,
  type PriceGateway,
} from "../adapters/pricing/PriceGateway.js";
import {
  type WalletBalanceSnapshot,
  type WalletGateway,
} from "../adapters/wallet/WalletGateway.js";
import { HttpScreeningGateway } from "../adapters/screening/HttpScreeningGateway.js";
import type { ManagementSignals } from "../domain/rules/managementRules.js";
import type { ScreeningPolicy } from "../domain/rules/screeningRules.js";
import { loadConfig, redactSecretsForLogging } from "../infra/config/loadConfig.js";
import { createLogger } from "../infra/logging/logger.js";
import { DefaultLessonPromptService } from "../app/services/LessonPromptService.js";
import { resolveAdaptiveScreeningIntervalSec } from "../app/services/AdaptiveScreeningInterval.js";

import { createRuntimeStores } from "./createRuntimeStores.js";
import { createRuntimeSupervisorFromUserConfig } from "./createRuntimeSupervisor.js";

const RuntimeBootstrapEnvSchema = z
  .object({
    PUBLIC_WALLET_ADDRESS: z.string().min(1),
    DLMM_API_BASE_URL: z.url(),
    DLMM_API_KEY: z.string().min(1).optional(),
    SCREENING_API_BASE_URL: z.url().optional(),
    ANALYTICS_API_BASE_URL: z.url().optional(),
    JUPITER_QUOTE_BASE_URL: z.url().optional(),
    JUPITER_EXECUTE_BASE_URL: z.url().optional(),
    MOCK_SOL_PRICE_USD: z.coerce.number().positive().default(150),
    MOCK_WALLET_BALANCE_SOL: z.coerce.number().nonnegative().default(1),
    ACTION_QUEUE_INTERVAL_SEC: z.coerce.number().int().positive().default(5),
    DLMM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  })
  .strict();

function emptyToUndefined(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseRuntimeBootstrapEnv(env: NodeJS.ProcessEnv) {
  return RuntimeBootstrapEnvSchema.parse({
    PUBLIC_WALLET_ADDRESS: emptyToUndefined(env.PUBLIC_WALLET_ADDRESS),
    DLMM_API_BASE_URL: emptyToUndefined(env.DLMM_API_BASE_URL),
    DLMM_API_KEY: emptyToUndefined(env.DLMM_API_KEY),
    SCREENING_API_BASE_URL: emptyToUndefined(env.SCREENING_API_BASE_URL),
    ANALYTICS_API_BASE_URL: emptyToUndefined(env.ANALYTICS_API_BASE_URL),
    JUPITER_QUOTE_BASE_URL: emptyToUndefined(env.JUPITER_QUOTE_BASE_URL),
    JUPITER_EXECUTE_BASE_URL: emptyToUndefined(env.JUPITER_EXECUTE_BASE_URL),
    MOCK_SOL_PRICE_USD: emptyToUndefined(env.MOCK_SOL_PRICE_USD),
    MOCK_WALLET_BALANCE_SOL: emptyToUndefined(env.MOCK_WALLET_BALANCE_SOL),
    ACTION_QUEUE_INTERVAL_SEC: emptyToUndefined(env.ACTION_QUEUE_INTERVAL_SEC),
    DLMM_TIMEOUT_MS: emptyToUndefined(env.DLMM_TIMEOUT_MS),
  });
}

class StaticEnvWalletGateway implements WalletGateway {
  public constructor(
    private readonly wallet: string,
    private readonly balanceSol: number,
    private readonly now: () => string,
  ) {}

  public async getWalletBalance(wallet: string): Promise<WalletBalanceSnapshot> {
    return {
      wallet,
      balanceSol: wallet === this.wallet ? this.balanceSol : 0,
      asOf: this.now(),
    };
  }
}

class StaticEnvPriceGateway implements PriceGateway {
  public constructor(
    private readonly priceUsd: number,
    private readonly now: () => string,
  ) {}

  public async getSolPriceUsd(): Promise<SolPriceQuote> {
    return {
      symbol: "SOL",
      priceUsd: this.priceUsd,
      asOf: this.now(),
    };
  }
}

function createConservativeSignalProvider(): (
  input: {
    position: unknown;
    portfolio: unknown;
    now: string;
  },
) => Promise<ManagementSignals> {
  return async (_input) => ({
    forcedManualClose: false,
    severeTokenRisk: false,
    liquidityCollapse: false,
    severeNegativeYield: false,
    claimableFeesUsd: 0,
    expectedRebalanceImprovement: false,
    dataIncomplete: false,
  });
}

function toRuntimeScreeningPolicy(
  userScreening: {
    timeframe: "5m" | "1h" | "24h";
    minMarketCapUsd: number;
    maxMarketCapUsd: number;
    minTvlUsd: number;
    minVolumeUsd: number;
    minVolumeTrendPct?: number | undefined;
    minFeeActiveTvlRatio: number;
    minFeePerTvl24h: number;
    minOrganic: number;
    minHolderCount: number;
    allowedBinSteps: number[];
    blockedLaunchpads: string[];
  },
): ScreeningPolicy {
  return {
    ...userScreening,
    blockedTokenMints: [],
    blockedDeployers: [],
    allowedPairTypes: ["volatile", "stable"],
    maxTopHolderPct: 35,
    maxBotHolderPct: 20,
    maxBundleRiskPct: 20,
    maxWashTradingRiskPct: 20,
    rejectDuplicatePoolExposure: true,
    rejectDuplicateTokenExposure: true,
    shortlistLimit: 3,
  };
}

async function main() {
  const cwd = process.cwd();
  const envFilePath = path.join(cwd, ".env");
  const userConfigPath = path.join(cwd, "user-config.json");
  const config = loadConfig({
    envFilePath,
    userConfigPath,
  });
  const runtimeEnv = parseRuntimeBootstrapEnv(process.env);
  const logger = createLogger(config.user.runtime.logLevel);
  const now = () => new Date().toISOString();

  logger.info(
    {
      config: redactSecretsForLogging(config),
      wallet: runtimeEnv.PUBLIC_WALLET_ADDRESS,
      envBridge: {
        usingStaticWalletBalance: true,
        usingStaticSolPrice: true,
      },
    },
    "runtime bootstrap configuration loaded",
  );

  const stores = createRuntimeStores({
    baseScreeningPolicy: toRuntimeScreeningPolicy(config.user.screening),
  });
  const screeningGateway =
    runtimeEnv.SCREENING_API_BASE_URL === undefined
      ? undefined
      : new HttpScreeningGateway({
          baseUrl: runtimeEnv.SCREENING_API_BASE_URL,
          ...(config.secrets.SCREENING_API_KEY === undefined
            ? {}
            : { apiKey: config.secrets.SCREENING_API_KEY }),
        });
  const tokenIntelGateway =
    runtimeEnv.ANALYTICS_API_BASE_URL === undefined
      ? undefined
      : new HttpTokenIntelGateway({
          baseUrl: runtimeEnv.ANALYTICS_API_BASE_URL,
          ...(config.secrets.ANALYTICS_API_KEY === undefined
            ? {}
            : { apiKey: config.secrets.ANALYTICS_API_KEY }),
        });
  const swapGateway =
    runtimeEnv.JUPITER_EXECUTE_BASE_URL === undefined
      ? undefined
      : new JupiterApiSwapGateway({
          ...(config.secrets.JUPITER_API_KEY === undefined
            ? {}
            : { apiKey: config.secrets.JUPITER_API_KEY }),
          ...(runtimeEnv.JUPITER_QUOTE_BASE_URL === undefined
            ? {}
            : { quoteBaseUrl: runtimeEnv.JUPITER_QUOTE_BASE_URL }),
          executeBaseUrl: runtimeEnv.JUPITER_EXECUTE_BASE_URL,
        });
  const liveLlmGateway =
    config.user.ai.mode !== "disabled" &&
    config.secrets.LLM_BASE_URL !== undefined &&
    (config.user.ai.generalModel !== undefined ||
      config.user.ai.managementModel !== undefined ||
      config.user.ai.screeningModel !== undefined)
      ? new HttpLlmGateway({
          baseUrl: config.secrets.LLM_BASE_URL,
          ...(config.secrets.LLM_API_KEY === undefined
            ? {}
            : { apiKey: config.secrets.LLM_API_KEY }),
          ...(config.user.ai.generalModel === undefined
            ? {}
            : { generalModel: config.user.ai.generalModel }),
          ...(config.user.ai.managementModel === undefined
            ? {}
            : { managementModel: config.user.ai.managementModel }),
          ...(config.user.ai.screeningModel === undefined
            ? {}
            : { screeningModel: config.user.ai.screeningModel }),
          ...(config.user.ai.timeoutMs === undefined
            ? {}
            : { timeoutMs: config.user.ai.timeoutMs }),
        })
      : undefined;
  const supervisor = createRuntimeSupervisorFromUserConfig({
    wallet: runtimeEnv.PUBLIC_WALLET_ADDRESS,
    userConfig: config.user,
    stores,
    gateways: {
      dlmmGateway: new HttpDlmmGateway({
        baseUrl: runtimeEnv.DLMM_API_BASE_URL,
        ...(runtimeEnv.DLMM_API_KEY === undefined
          ? {}
          : { apiKey: runtimeEnv.DLMM_API_KEY }),
        timeoutMs: runtimeEnv.DLMM_TIMEOUT_MS,
      }),
      ...(screeningGateway === undefined ? {} : { screeningGateway }),
      ...(tokenIntelGateway === undefined ? {} : { tokenIntelGateway }),
      walletGateway: new StaticEnvWalletGateway(
        runtimeEnv.PUBLIC_WALLET_ADDRESS,
        runtimeEnv.MOCK_WALLET_BALANCE_SOL,
        now,
      ),
      priceGateway: new StaticEnvPriceGateway(
        runtimeEnv.MOCK_SOL_PRICE_USD,
        now,
      ),
      ...(swapGateway === undefined ? {} : { swapGateway }),
      ...(liveLlmGateway === undefined ? {} : { llmGateway: liveLlmGateway }),
    },
    signalProvider: createConservativeSignalProvider(),
    rebalancePlanner: async () => null,
    lessonPromptService: new DefaultLessonPromptService(
      stores.lessonRepository,
      stores.poolMemoryRepository,
    ),
    ...(config.user.notifications.alertChatId === undefined
      ? {}
      : { alertRecipient: config.user.notifications.alertChatId }),
    ...(config.user.ai.timeoutMs === undefined
      ? {}
      : { aiTimeoutMs: config.user.ai.timeoutMs }),
    now,
  });

  if (config.user.notifications.telegramEnabled) {
    logger.warn(
      "telegramEnabled=true but no live NotifierGateway is wired in runLive.ts yet; alerts stay in logs/report only",
    );
  }

  if (config.user.ai.mode !== "disabled") {
    if (liveLlmGateway === undefined) {
      logger.warn(
        "AI mode is enabled but live LlmGateway is not fully configured; runtime will fall back to deterministic behavior",
      );
    } else {
      logger.info(
        {
          generalModel: config.user.ai.generalModel ?? null,
          managementModel:
            config.user.ai.managementModel ??
            config.user.ai.generalModel ??
            null,
          screeningModel:
            config.user.ai.screeningModel ??
            config.user.ai.generalModel ??
            null,
        },
        "live LLM gateway configured",
      );
    }
  }

  const startup = await supervisor.runStartupRecovery();
  logger.info(
    {
      status: startup.status,
      checklist: startup.checklist,
      report: startup.report,
    },
    "startup recovery completed",
  );

  const startupCycle = await supervisor.runRecommendedCycle({
    triggerSource: "startup",
    includeReporting: true,
    includeScreening: true,
  });
  logger.info(
    {
      screeningShortlist: startupCycle.screening?.shortlist.length ?? 0,
      reconciledRecords: startupCycle.reconciliation.records.length,
      evaluatedPositions: startupCycle.management.positionResults.length,
      processedActions: startupCycle.processedActions.length,
      deliveredAlerts: startupCycle.reporting?.deliveredAlerts.length ?? 0,
    },
    "startup cycle completed",
  );

  let queueTickRunning = false;
  let screeningTimer: ReturnType<typeof setTimeout> | null = null;

  const queueTimer = setInterval(() => {
    if (queueTickRunning) {
      return;
    }

    queueTickRunning = true;
    void supervisor
      .runActionQueueTick()
      .then((processed) => {
        if (processed.length > 0) {
          logger.info(
            { processedActions: processed.map((action) => action.actionId) },
            "action queue tick completed",
          );
        }
      })
      .catch((error) => {
        logger.error({ err: error }, "action queue tick failed");
      })
      .finally(() => {
        queueTickRunning = false;
      });
  }, runtimeEnv.ACTION_QUEUE_INTERVAL_SEC * 1000);

  const reconciliationTimer = setInterval(() => {
    void supervisor.runReconciliationTick("cron").catch((error) => {
      logger.error({ err: error }, "reconciliation tick failed");
    });
  }, config.user.schedule.reconciliationIntervalSec * 1000);

  const scheduleNextScreeningTick = () => {
    if (screeningGateway === undefined) {
      return;
    }

    const nextIntervalSec = resolveAdaptiveScreeningIntervalSec({
      defaultIntervalSec: config.user.schedule.screeningIntervalSec,
      timezone: config.user.screening.intervalTimezone,
      peakHours: config.user.screening.peakHours,
      now: new Date(),
    });

    screeningTimer = setTimeout(() => {
      void supervisor
        .runScreeningTick("cron")
        .then((result) => {
          if (result !== null) {
            logger.info(
              {
                timeframe: result.timeframe,
                shortlist: result.shortlist.length,
                aiSource: result.aiSource,
                nextIntervalSec,
              },
              "screening tick completed",
            );
          }
        })
        .catch((error) => {
          logger.error({ err: error }, "screening tick failed");
        })
        .finally(() => {
          scheduleNextScreeningTick();
        });
    }, nextIntervalSec * 1000);
  };

  scheduleNextScreeningTick();

  const managementTimer = setInterval(() => {
    void supervisor.runManagementTick("cron").catch((error) => {
      logger.error({ err: error }, "management tick failed");
    });
  }, config.user.schedule.managementIntervalSec * 1000);

  const reportingTimer = setInterval(() => {
    void supervisor.runReportingTick("cron").catch((error) => {
      logger.error({ err: error }, "reporting tick failed");
    });
  }, config.user.schedule.reportingIntervalSec * 1000);

  const stop = (signal: string) => {
    clearInterval(queueTimer);
    if (screeningTimer !== null) {
      clearTimeout(screeningTimer);
    }
    clearInterval(reconciliationTimer);
    clearInterval(managementTimer);
    clearInterval(reportingTimer);
    logger.info({ signal }, "runtime supervisor stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  logger.info(
    {
      wallet: runtimeEnv.PUBLIC_WALLET_ADDRESS,
      dataDir: stores.paths.dataDir,
      queueIntervalSec: runtimeEnv.ACTION_QUEUE_INTERVAL_SEC,
      screeningIntervalSec: config.user.schedule.screeningIntervalSec,
      reconciliationIntervalSec: config.user.schedule.reconciliationIntervalSec,
      managementIntervalSec: config.user.schedule.managementIntervalSec,
      reportingIntervalSec: config.user.schedule.reportingIntervalSec,
      dryRun: config.user.runtime.dryRun,
    },
    "runtime supervisor is running",
  );
}

void main().catch((error) => {
  const logger = createLogger("error");
  logger.error({ err: error }, "runtime bootstrap failed");
  process.exit(1);
});
