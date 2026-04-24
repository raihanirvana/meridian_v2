import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { z } from "zod";

import { HttpTokenIntelGateway } from "../adapters/analytics/HttpTokenIntelGateway.js";
import { HttpDlmmGateway } from "../adapters/dlmm/HttpDlmmGateway.js";
import { MeteoraSdkDlmmGateway } from "../adapters/dlmm/MeteoraSdkDlmmGateway.js";
import { JupiterApiSwapGateway } from "../adapters/jupiter/JupiterApiSwapGateway.js";
import { HttpLlmGateway } from "../adapters/llm/HttpLlmGateway.js";
import { JupiterSolPriceGateway } from "../adapters/pricing/JupiterSolPriceGateway.js";
import { HttpTelegramNotifierGateway } from "../adapters/telegram/HttpTelegramNotifierGateway.js";
import { HttpTelegramOperatorGateway } from "../adapters/telegram/HttpTelegramOperatorGateway.js";
import { type PriceGateway } from "../adapters/pricing/PriceGateway.js";
import { type WalletGateway } from "../adapters/wallet/WalletGateway.js";
import { SolanaRpcWalletGateway } from "../adapters/wallet/SolanaRpcWalletGateway.js";
import { HttpScreeningGateway } from "../adapters/screening/HttpScreeningGateway.js";
import { MeteoraPoolDiscoveryScreeningGateway } from "../adapters/screening/MeteoraPoolDiscoveryScreeningGateway.js";
import type { ManagementSignals } from "../domain/rules/managementRules.js";
import type { ScreeningPolicy } from "../domain/rules/screeningRules.js";
import type { UserConfig } from "../infra/config/configSchema.js";
import {
  loadConfig,
  redactSecretsForLogging,
} from "../infra/config/loadConfig.js";
import { createLogger } from "../infra/logging/logger.js";
import { DefaultLessonPromptService } from "../app/services/LessonPromptService.js";
import { DefaultPolicyProvider } from "../app/services/PolicyProvider.js";
import { resolveAdaptiveScreeningIntervalSec } from "../app/services/AdaptiveScreeningInterval.js";
import { handleCliOperatorCommand } from "../app/usecases/handleCliOperatorCommand.js";
import { handleTelegramOperatorCommand } from "../app/usecases/handleTelegramOperatorCommand.js";

import { createRuntimeStores } from "./createRuntimeStores.js";
import { createRuntimeSupervisorFromUserConfig } from "./createRuntimeSupervisor.js";

const RuntimeBootstrapEnvSchema = z
  .object({
    PUBLIC_WALLET_ADDRESS: z.string().min(1),
    DLMM_API_BASE_URL: z.url().optional(),
    DLMM_API_KEY: z.string().min(1).optional(),
    METEORA_DLMM_DATA_API_BASE_URL: z.url().optional(),
    METEORA_POOL_DISCOVERY_BASE_URL: z.url().optional(),
    SCREENING_API_BASE_URL: z.url().optional(),
    ANALYTICS_API_BASE_URL: z.url().optional(),
    JUPITER_QUOTE_BASE_URL: z.url().optional(),
    JUPITER_EXECUTE_BASE_URL: z.url().optional(),
    ACTION_QUEUE_INTERVAL_SEC: z.coerce.number().int().positive().default(5),
    DLMM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    MERIDIAN_DATA_DIR: z.string().min(1).optional(),
  })
  .strict();

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseRuntimeDotEnv(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

function loadRuntimeEnv(envFilePath: string): NodeJS.ProcessEnv {
  const envFileValues = fs.existsSync(envFilePath)
    ? parseRuntimeDotEnv(fs.readFileSync(envFilePath, "utf8"))
    : {};

  return {
    ...envFileValues,
    ...process.env,
  };
}

function parseRuntimeBootstrapEnv(env: NodeJS.ProcessEnv) {
  return RuntimeBootstrapEnvSchema.parse({
    PUBLIC_WALLET_ADDRESS: emptyToUndefined(env.PUBLIC_WALLET_ADDRESS),
    DLMM_API_BASE_URL: emptyToUndefined(env.DLMM_API_BASE_URL),
    DLMM_API_KEY: emptyToUndefined(env.DLMM_API_KEY),
    METEORA_DLMM_DATA_API_BASE_URL: emptyToUndefined(
      env.METEORA_DLMM_DATA_API_BASE_URL,
    ),
    METEORA_POOL_DISCOVERY_BASE_URL: emptyToUndefined(
      env.METEORA_POOL_DISCOVERY_BASE_URL,
    ),
    SCREENING_API_BASE_URL: emptyToUndefined(env.SCREENING_API_BASE_URL),
    ANALYTICS_API_BASE_URL: emptyToUndefined(env.ANALYTICS_API_BASE_URL),
    JUPITER_QUOTE_BASE_URL: emptyToUndefined(env.JUPITER_QUOTE_BASE_URL),
    JUPITER_EXECUTE_BASE_URL: emptyToUndefined(env.JUPITER_EXECUTE_BASE_URL),
    ACTION_QUEUE_INTERVAL_SEC: emptyToUndefined(env.ACTION_QUEUE_INTERVAL_SEC),
    DLMM_TIMEOUT_MS: emptyToUndefined(env.DLMM_TIMEOUT_MS),
    MERIDIAN_DATA_DIR: emptyToUndefined(env.MERIDIAN_DATA_DIR),
  });
}

function createConservativeSignalProvider(): (input: {
  position: unknown;
  portfolio: unknown;
  now: string;
}) => Promise<ManagementSignals> {
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

function toRuntimeScreeningPolicy(userScreening: {
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
}): ScreeningPolicy {
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

function isDryRunWriteCommand(rawCommand: string): boolean {
  return /^\/?(deploy|close|rebalance)\b/i.test(rawCommand.trim());
}

function startOperatorStdinLoop(input: {
  enabled: boolean;
  dryRun: boolean;
  logger: ReturnType<typeof createLogger>;
  wallet: string;
  actionQueue: ReturnType<typeof createRuntimeStores>["actionQueue"];
  stateRepository: ReturnType<typeof createRuntimeStores>["stateRepository"];
  actionRepository: ReturnType<typeof createRuntimeStores>["actionRepository"];
  journalRepository: ReturnType<
    typeof createRuntimeStores
  >["journalRepository"];
  walletGateway: WalletGateway;
  priceGateway: PriceGateway;
  riskPolicy: UserConfig["risk"];
  lessonRepository: ReturnType<typeof createRuntimeStores>["lessonRepository"];
  performanceRepository: ReturnType<
    typeof createRuntimeStores
  >["performanceRepository"];
  poolMemoryRepository: ReturnType<
    typeof createRuntimeStores
  >["poolMemoryRepository"];
  runtimePolicyStore: ReturnType<
    typeof createRuntimeStores
  >["runtimePolicyStore"];
  runtimeControlStore: ReturnType<
    typeof createRuntimeStores
  >["runtimeControlStore"];
  policyProvider: DefaultPolicyProvider;
  reportingSolMode: boolean;
}): (() => void) | null {
  if (!input.enabled) {
    return null;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });

  input.logger.info(
    "operator stdin loop enabled; type commands like `status`, `positions`, or `circuit_breaker_trip reason`",
  );

  rl.on("line", (line) => {
    const rawCommand = line.trim();
    if (rawCommand.length === 0) {
      return;
    }

    if (input.dryRun && isDryRunWriteCommand(rawCommand)) {
      const message =
        "runtime dryRun=true; write operator commands are disabled and were not queued";
      input.logger.warn({ rawCommand }, message);
      process.stderr.write(`${message}\n`);
      return;
    }

    void handleCliOperatorCommand({
      rawCommand,
      wallet: input.wallet,
      requestedBy: "operator",
      actionQueue: input.actionQueue,
      stateRepository: input.stateRepository,
      actionRepository: input.actionRepository,
      journalRepository: input.journalRepository,
      walletGateway: input.walletGateway,
      priceGateway: input.priceGateway,
      riskPolicy: input.riskPolicy,
      lessonRepository: input.lessonRepository,
      performanceRepository: input.performanceRepository,
      poolMemoryRepository: input.poolMemoryRepository,
      runtimePolicyStore: input.runtimePolicyStore,
      runtimeControlStore: input.runtimeControlStore,
      policyProvider: input.policyProvider,
      previousPortfolioState: null,
      reportingSolMode: input.reportingSolMode,
    })
      .then((result) => {
        process.stdout.write(`${result.text}\n`);
      })
      .catch((error) => {
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "operator command failed";
        input.logger.warn(
          { err: error, rawCommand },
          "operator stdin command failed",
        );
        process.stderr.write(`${message}\n`);
      });
  });

  rl.on("close", () => {
    input.logger.info("operator stdin loop closed");
  });

  return () => {
    rl.close();
  };
}

function startTelegramOperatorPolling(input: {
  enabled: boolean;
  dryRun: boolean;
  logger: ReturnType<typeof createLogger>;
  wallet: string;
  operatorGateway: HttpTelegramOperatorGateway;
  notifierGateway: HttpTelegramNotifierGateway;
  authorizedChatId: string;
  actionQueue: ReturnType<typeof createRuntimeStores>["actionQueue"];
  stateRepository: ReturnType<typeof createRuntimeStores>["stateRepository"];
  actionRepository: ReturnType<typeof createRuntimeStores>["actionRepository"];
  journalRepository: ReturnType<
    typeof createRuntimeStores
  >["journalRepository"];
  walletGateway: WalletGateway;
  priceGateway: PriceGateway;
  riskPolicy: UserConfig["risk"];
  lessonRepository: ReturnType<typeof createRuntimeStores>["lessonRepository"];
  performanceRepository: ReturnType<
    typeof createRuntimeStores
  >["performanceRepository"];
  poolMemoryRepository: ReturnType<
    typeof createRuntimeStores
  >["poolMemoryRepository"];
  runtimePolicyStore: ReturnType<
    typeof createRuntimeStores
  >["runtimePolicyStore"];
  runtimeControlStore: ReturnType<
    typeof createRuntimeStores
  >["runtimeControlStore"];
  policyProvider: DefaultPolicyProvider;
  reportingSolMode: boolean;
}): (() => void) | null {
  if (!input.enabled) {
    return null;
  }

  let stopped = false;
  let nextOffset: number | undefined;

  const poll = async () => {
    if (stopped) {
      return;
    }

    try {
      const updates = await input.operatorGateway.getUpdates({
        ...(nextOffset === undefined ? {} : { offset: nextOffset }),
        timeoutSec: 30,
      });

      for (const update of updates) {
        nextOffset = update.updateId + 1;

        if (update.chatId !== input.authorizedChatId) {
          input.logger.warn(
            {
              chatId: update.chatId,
              authorizedChatId: input.authorizedChatId,
            },
            "ignoring Telegram operator command from unauthorized chat",
          );
          continue;
        }

        if (input.dryRun && isDryRunWriteCommand(update.text)) {
          const message =
            "runtime dryRun=true; write operator commands are disabled and were not queued";
          input.logger.warn(
            { chatId: update.chatId, rawCommand: update.text },
            message,
          );
          await input.notifierGateway.sendMessage({
            recipient: update.chatId,
            message,
          });
          continue;
        }

        await handleTelegramOperatorCommand({
          notifierGateway: input.notifierGateway,
          recipient: update.chatId,
          rawCommand: update.text,
          wallet: input.wallet,
          requestedBy: "operator",
          actionQueue: input.actionQueue,
          stateRepository: input.stateRepository,
          actionRepository: input.actionRepository,
          journalRepository: input.journalRepository,
          walletGateway: input.walletGateway,
          priceGateway: input.priceGateway,
          riskPolicy: input.riskPolicy,
          lessonRepository: input.lessonRepository,
          performanceRepository: input.performanceRepository,
          poolMemoryRepository: input.poolMemoryRepository,
          runtimePolicyStore: input.runtimePolicyStore,
          runtimeControlStore: input.runtimeControlStore,
          policyProvider: input.policyProvider,
          previousPortfolioState: null,
          reportingSolMode: input.reportingSolMode,
        });
      }
    } catch (error) {
      input.logger.warn(
        { err: error },
        "telegram operator polling failed; continuing",
      );
    } finally {
      if (!stopped) {
        setTimeout(() => {
          void poll();
        }, 1000);
      }
    }
  };

  void poll();
  input.logger.info(
    { authorizedChatId: input.authorizedChatId },
    "telegram operator polling enabled",
  );

  return () => {
    stopped = true;
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
  const runtimeEnv = parseRuntimeBootstrapEnv(loadRuntimeEnv(envFilePath));
  const logger = createLogger(config.user.runtime.logLevel);
  const now = () => new Date().toISOString();

  logger.info(
    {
      config: redactSecretsForLogging(config),
      wallet: runtimeEnv.PUBLIC_WALLET_ADDRESS,
      dlmmMode:
        runtimeEnv.DLMM_API_BASE_URL === undefined
          ? "meteora_sdk"
          : "http_wrapper",
      liveBridges: {
        walletBalance: "rpc",
        solPrice: "jupiter-quote",
      },
    },
    "runtime bootstrap configuration loaded",
  );

  const stores = createRuntimeStores({
    baseScreeningPolicy: toRuntimeScreeningPolicy(config.user.screening),
    ...(runtimeEnv.MERIDIAN_DATA_DIR === undefined
      ? {}
      : { dataDir: runtimeEnv.MERIDIAN_DATA_DIR }),
  });
  const policyProvider = new DefaultPolicyProvider({
    basePolicy: toRuntimeScreeningPolicy(config.user.screening),
    runtimePolicyStore: stores.runtimePolicyStore,
  });
  const walletGateway = new SolanaRpcWalletGateway({
    rpcUrl: config.secrets.RPC_URL,
    timeoutMs: runtimeEnv.DLMM_TIMEOUT_MS,
    now,
  });
  const priceGateway = new JupiterSolPriceGateway({
    ...(runtimeEnv.JUPITER_QUOTE_BASE_URL === undefined
      ? {}
      : { quoteBaseUrl: runtimeEnv.JUPITER_QUOTE_BASE_URL }),
    ...(config.secrets.JUPITER_API_KEY === undefined
      ? {}
      : { apiKey: config.secrets.JUPITER_API_KEY }),
    timeoutMs: runtimeEnv.DLMM_TIMEOUT_MS,
    now,
  });
  const screeningGateway =
    runtimeEnv.SCREENING_API_BASE_URL === undefined
      ? new MeteoraPoolDiscoveryScreeningGateway({
          ...(runtimeEnv.METEORA_POOL_DISCOVERY_BASE_URL === undefined
            ? {}
            : { baseUrl: runtimeEnv.METEORA_POOL_DISCOVERY_BASE_URL }),
          timeoutMs: runtimeEnv.DLMM_TIMEOUT_MS,
          now,
        })
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
  const liveTelegramNotifier =
    config.secrets.TELEGRAM_BOT_TOKEN === undefined
      ? undefined
      : new HttpTelegramNotifierGateway({
          botToken: config.secrets.TELEGRAM_BOT_TOKEN,
          timeoutMs: runtimeEnv.DLMM_TIMEOUT_MS,
        });
  const liveTelegramOperatorGateway =
    config.secrets.TELEGRAM_BOT_TOKEN === undefined
      ? undefined
      : new HttpTelegramOperatorGateway({
          botToken: config.secrets.TELEGRAM_BOT_TOKEN,
          timeoutMs: runtimeEnv.DLMM_TIMEOUT_MS,
        });
  const dlmmGateway =
    runtimeEnv.DLMM_API_BASE_URL === undefined
      ? new MeteoraSdkDlmmGateway({
          rpcUrl: config.secrets.RPC_URL,
          walletPrivateKey: config.secrets.WALLET_PRIVATE_KEY,
          wallet: runtimeEnv.PUBLIC_WALLET_ADDRESS,
          timeoutMs: runtimeEnv.DLMM_TIMEOUT_MS,
          defaultSlippageBps: config.user.deploy.slippageBps,
          ...(runtimeEnv.METEORA_DLMM_DATA_API_BASE_URL === undefined
            ? {}
            : {
                dataApiBaseUrl: runtimeEnv.METEORA_DLMM_DATA_API_BASE_URL,
              }),
        })
      : new HttpDlmmGateway({
          baseUrl: runtimeEnv.DLMM_API_BASE_URL,
          ...(runtimeEnv.DLMM_API_KEY === undefined
            ? {}
            : { apiKey: runtimeEnv.DLMM_API_KEY }),
          timeoutMs: runtimeEnv.DLMM_TIMEOUT_MS,
        });
  const supervisor = createRuntimeSupervisorFromUserConfig({
    wallet: runtimeEnv.PUBLIC_WALLET_ADDRESS,
    userConfig: config.user,
    stores,
    gateways: {
      dlmmGateway,
      ...(screeningGateway === undefined ? {} : { screeningGateway }),
      ...(tokenIntelGateway === undefined ? {} : { tokenIntelGateway }),
      walletGateway,
      priceGateway,
      ...(swapGateway === undefined ? {} : { swapGateway }),
      ...(liveLlmGateway === undefined ? {} : { llmGateway: liveLlmGateway }),
      ...(config.user.notifications.telegramEnabled &&
      liveTelegramNotifier !== undefined &&
      config.user.notifications.alertChatId !== undefined
        ? {
            notifierGateway: liveTelegramNotifier,
          }
        : {}),
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
  const stopOperatorStdinLoop = startOperatorStdinLoop({
    enabled: config.user.runtime.operatorStdinEnabled,
    dryRun: config.user.runtime.dryRun,
    logger,
    wallet: runtimeEnv.PUBLIC_WALLET_ADDRESS,
    actionQueue: stores.actionQueue,
    stateRepository: stores.stateRepository,
    actionRepository: stores.actionRepository,
    journalRepository: stores.journalRepository,
    walletGateway,
    priceGateway,
    riskPolicy: config.user.risk,
    lessonRepository: stores.lessonRepository,
    performanceRepository: stores.performanceRepository,
    poolMemoryRepository: stores.poolMemoryRepository,
    runtimePolicyStore: stores.runtimePolicyStore,
    runtimeControlStore: stores.runtimeControlStore,
    policyProvider,
    reportingSolMode: config.user.reporting.solMode,
  });
  const stopTelegramOperatorPolling =
    config.user.notifications.telegramEnabled &&
    config.user.notifications.telegramOperatorCommandsEnabled &&
    liveTelegramOperatorGateway !== undefined &&
    liveTelegramNotifier !== undefined &&
    config.user.notifications.alertChatId !== undefined
      ? startTelegramOperatorPolling({
          enabled: true,
          dryRun: config.user.runtime.dryRun,
          logger,
          wallet: runtimeEnv.PUBLIC_WALLET_ADDRESS,
          operatorGateway: liveTelegramOperatorGateway,
          notifierGateway: liveTelegramNotifier,
          authorizedChatId: config.user.notifications.alertChatId,
          actionQueue: stores.actionQueue,
          stateRepository: stores.stateRepository,
          actionRepository: stores.actionRepository,
          journalRepository: stores.journalRepository,
          walletGateway,
          priceGateway,
          riskPolicy: config.user.risk,
          lessonRepository: stores.lessonRepository,
          performanceRepository: stores.performanceRepository,
          poolMemoryRepository: stores.poolMemoryRepository,
          runtimePolicyStore: stores.runtimePolicyStore,
          runtimeControlStore: stores.runtimeControlStore,
          policyProvider,
          reportingSolMode: config.user.reporting.solMode,
        })
      : null;

  if (
    config.user.notifications.telegramEnabled &&
    (config.secrets.TELEGRAM_BOT_TOKEN === undefined ||
      config.user.notifications.alertChatId === undefined)
  ) {
    logger.warn(
      {
        hasTelegramBotToken: config.secrets.TELEGRAM_BOT_TOKEN !== undefined,
        hasAlertChatId: config.user.notifications.alertChatId !== undefined,
      },
      "telegramEnabled=true but Telegram notifier is not fully configured; alerts stay in logs/report only",
    );
  }

  if (
    config.user.notifications.telegramOperatorCommandsEnabled &&
    (config.user.notifications.telegramEnabled !== true ||
      config.secrets.TELEGRAM_BOT_TOKEN === undefined ||
      config.user.notifications.alertChatId === undefined)
  ) {
    logger.warn(
      {
        telegramEnabled: config.user.notifications.telegramEnabled,
        hasTelegramBotToken: config.secrets.TELEGRAM_BOT_TOKEN !== undefined,
        hasAlertChatId: config.user.notifications.alertChatId !== undefined,
      },
      "telegramOperatorCommandsEnabled=true but inbound Telegram operator polling is not fully configured",
    );
  }

  if (
    config.user.notifications.telegramEnabled &&
    config.secrets.TELEGRAM_BOT_TOKEN !== undefined &&
    config.user.notifications.alertChatId !== undefined
  ) {
    logger.info(
      {
        alertChatId: config.user.notifications.alertChatId,
      },
      "live Telegram notifier configured",
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
  let reconciliationTickRunning = false;
  let managementTickRunning = false;
  let reportingTickRunning = false;
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
    if (reconciliationTickRunning) {
      return;
    }

    reconciliationTickRunning = true;
    void supervisor
      .runReconciliationTick("cron")
      .catch((error) => {
        logger.error({ err: error }, "reconciliation tick failed");
      })
      .finally(() => {
        reconciliationTickRunning = false;
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
    if (managementTickRunning) {
      return;
    }

    managementTickRunning = true;
    void supervisor
      .runManagementTick("cron")
      .catch((error) => {
        logger.error({ err: error }, "management tick failed");
      })
      .finally(() => {
        managementTickRunning = false;
      });
  }, config.user.schedule.managementIntervalSec * 1000);

  const reportingTimer = setInterval(() => {
    if (reportingTickRunning) {
      return;
    }

    reportingTickRunning = true;
    void supervisor
      .runReportingTick("cron")
      .catch((error) => {
        logger.error({ err: error }, "reporting tick failed");
      })
      .finally(() => {
        reportingTickRunning = false;
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
    stopOperatorStdinLoop?.();
    stopTelegramOperatorPolling?.();
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
