import type { DlmmGateway } from "../adapters/dlmm/DlmmGateway.js";
import type { LlmGateway } from "../adapters/llm/LlmGateway.js";
import type { PriceGateway } from "../adapters/pricing/PriceGateway.js";
import type { ScreeningGateway } from "../adapters/screening/ScreeningGateway.js";
import type { NotifierGateway } from "../adapters/telegram/NotifierGateway.js";
import type { TokenIntelGateway } from "../adapters/analytics/TokenIntelGateway.js";
import type { WalletGateway } from "../adapters/wallet/WalletGateway.js";
import type { SwapGateway } from "../adapters/jupiter/SwapGateway.js";
import type { Action } from "../domain/entities/Action.js";
import type { PortfolioState } from "../domain/entities/PortfolioState.js";
import type {
  ManagementEvaluationResult,
  ManagementPolicy,
  ManagementSignals,
} from "../domain/rules/managementRules.js";
import type { ScreeningPolicy } from "../domain/rules/screeningRules.js";
import type {
  PortfolioRiskPolicy,
} from "../domain/rules/riskRules.js";
import type { UserConfig } from "../infra/config/configSchema.js";
import { createLogger } from "../infra/logging/logger.js";
import type { Position } from "../domain/entities/Position.js";
import type { RuntimeStores } from "./createRuntimeStores.js";
import { processActionQueue } from "../app/usecases/processActionQueue.js";
import { processCloseAction } from "../app/usecases/processCloseAction.js";
import { processClaimFeesAction } from "../app/usecases/processClaimFeesAction.js";
import { processDeployAction } from "../app/usecases/processDeployAction.js";
import { processRebalanceAction } from "../app/usecases/processRebalanceAction.js";
import { runManagementWorker } from "../app/workers/managementWorker.js";
import { runReconciliationWorker } from "../app/workers/reconciliationWorker.js";
import { runReportingWorker } from "../app/workers/reportingWorker.js";
import { runScreeningWorker } from "../app/workers/screeningWorker.js";
import { runStartupRecoveryChecklist } from "../app/usecases/runStartupRecoveryChecklist.js";
import type { RunScreeningCycleResult } from "../app/usecases/runScreeningCycle.js";
import type { RebalanceActionRequestPayload } from "../app/usecases/requestRebalance.js";
import type { LessonPromptService } from "../app/services/LessonPromptService.js";
import { DefaultPolicyProvider } from "../app/services/PolicyProvider.js";
import { DefaultSignalWeightsProvider } from "../app/services/SignalWeightsProvider.js";
import { createPostClaimSwapHook } from "../app/usecases/executePostClaimSwap.js";

export interface RuntimeSupervisorInput {
  wallet: string;
  config: {
    risk: PortfolioRiskPolicy;
    screening: UserConfig["screening"];
    managementPolicy: ManagementPolicy;
    claim: UserConfig["claim"];
    ai: UserConfig["ai"];
    poolMemory: UserConfig["poolMemory"];
    schedule: UserConfig["schedule"];
    darwin: UserConfig["darwin"];
    notifications: UserConfig["notifications"];
    reporting: UserConfig["reporting"];
    runtime: UserConfig["runtime"];
  };
  stores: RuntimeStores;
  gateways: {
    dlmmGateway: DlmmGateway;
    screeningGateway?: ScreeningGateway;
    tokenIntelGateway?: TokenIntelGateway;
    walletGateway: WalletGateway;
    priceGateway: PriceGateway;
    swapGateway?: SwapGateway;
    llmGateway?: LlmGateway;
    notifierGateway?: NotifierGateway;
  };
  signalProvider: (input: {
    position: Position;
    portfolio: PortfolioState;
    now: string;
  }) => Promise<ManagementSignals> | ManagementSignals;
  rebalancePlanner?: (input: {
    position: Position;
    portfolio: PortfolioState;
    now: string;
    evaluation: ManagementEvaluationResult;
    signals: ManagementSignals;
  }) =>
    | Promise<RebalanceActionRequestPayload | null>
    | RebalanceActionRequestPayload
    | null;
  lessonPromptService?: LessonPromptService;
  alertRecipient?: string;
  aiTimeoutMs?: number;
  now?: () => string;
}

export interface RuntimeSupervisor {
  runStartupRecovery(): ReturnType<typeof runStartupRecoveryChecklist>;
  runScreeningTick(
    triggerSource?: "cron" | "manual" | "startup",
  ): Promise<RunScreeningCycleResult | null>;
  runActionQueueTick(): Promise<Action[]>;
  runReconciliationTick(
    triggerSource?: "cron" | "manual" | "startup",
  ): ReturnType<typeof runReconciliationWorker>;
  runManagementTick(
    triggerSource?: "cron" | "manual" | "startup",
  ): ReturnType<typeof runManagementWorker>;
  runReportingTick(
    triggerSource?: "cron" | "manual" | "startup",
  ): ReturnType<typeof runReportingWorker>;
  runRecommendedCycle(input?: {
    triggerSource?: "cron" | "manual" | "startup";
    includeReporting?: boolean;
    includeScreening?: boolean;
  }): Promise<{
    screening: Awaited<ReturnType<RuntimeSupervisor["runScreeningTick"]>>;
    reconciliation: Awaited<ReturnType<typeof runReconciliationWorker>>;
    management: Awaited<ReturnType<typeof runManagementWorker>>;
    processedActions: Action[];
    reporting: Awaited<ReturnType<typeof runReportingWorker>> | null;
  }>;
}

export interface CreateRuntimeSupervisorFromUserConfigInput
  extends Omit<RuntimeSupervisorInput, "config"> {
  userConfig: UserConfig;
}

function nowIso(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

export function createRuntimeSupervisor(
  input: RuntimeSupervisorInput,
): RuntimeSupervisor {
  const logger = createLogger(input.config.runtime.logLevel);
  let previousPortfolioState: PortfolioState | null = null;
  const baseScreeningPolicy: ScreeningPolicy = {
    timeframe: input.config.screening.timeframe,
    minMarketCapUsd: input.config.screening.minMarketCapUsd,
    maxMarketCapUsd: input.config.screening.maxMarketCapUsd,
    minTvlUsd: input.config.screening.minTvlUsd,
    minVolumeUsd: input.config.screening.minVolumeUsd,
    ...(input.config.screening.minVolumeTrendPct === undefined
      ? {}
      : { minVolumeTrendPct: input.config.screening.minVolumeTrendPct }),
    minFeeActiveTvlRatio: input.config.screening.minFeeActiveTvlRatio,
    minFeePerTvl24h: input.config.screening.minFeePerTvl24h,
    minOrganic: input.config.screening.minOrganic,
    ...(input.config.screening.minTokenAgeHours === undefined
      ? {}
      : { minTokenAgeHours: input.config.screening.minTokenAgeHours }),
    ...(input.config.screening.maxTokenAgeHours === undefined
      ? {}
      : { maxTokenAgeHours: input.config.screening.maxTokenAgeHours }),
    ...(input.config.screening.athFilterPct === undefined
      ? {}
      : { athFilterPct: input.config.screening.athFilterPct }),
    minHolderCount: input.config.screening.minHolderCount,
    allowedBinSteps: input.config.screening.allowedBinSteps,
    blockedLaunchpads: input.config.screening.blockedLaunchpads,
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
  const policyProvider = new DefaultPolicyProvider({
    basePolicy: baseScreeningPolicy,
    runtimePolicyStore: input.stores.runtimePolicyStore,
  });
  const signalWeightsProvider = new DefaultSignalWeightsProvider({
    darwinEnabled: input.config.darwin.enabled,
    signalWeightsStore: input.stores.signalWeightsStore,
  });
  const postClaimSwapHook =
    input.gateways.swapGateway === undefined
      ? undefined
      : createPostClaimSwapHook(input.gateways.swapGateway);

  async function runQueueHandler(action: Action) {
    switch (action.type) {
      case "DEPLOY":
        return processDeployAction({
          action,
          dlmmGateway: input.gateways.dlmmGateway,
          stateRepository: input.stores.stateRepository,
          journalRepository: input.stores.journalRepository,
          runtimeControlStore: input.stores.runtimeControlStore,
          ...(input.now === undefined ? {} : { now: input.now }),
        });
      case "CLOSE":
        return processCloseAction({
          action,
          dlmmGateway: input.gateways.dlmmGateway,
          stateRepository: input.stores.stateRepository,
          journalRepository: input.stores.journalRepository,
          ...(input.now === undefined ? {} : { now: input.now }),
        });
      case "CLAIM_FEES":
        return processClaimFeesAction({
          action,
          dlmmGateway: input.gateways.dlmmGateway,
          stateRepository: input.stores.stateRepository,
          journalRepository: input.stores.journalRepository,
          ...(input.now === undefined ? {} : { now: input.now }),
        });
      case "REBALANCE":
        return processRebalanceAction({
          action,
          dlmmGateway: input.gateways.dlmmGateway,
          stateRepository: input.stores.stateRepository,
          journalRepository: input.stores.journalRepository,
          runtimeControlStore: input.stores.runtimeControlStore,
          ...(input.now === undefined ? {} : { now: input.now }),
        });
      default:
        logger.warn(
          { actionId: action.actionId, type: action.type },
          "unsupported queue action type in runtime supervisor",
        );
        return {
          nextStatus: "ABORTED",
          error: `Unsupported runtime queue handler for action ${action.type}`,
        } as const;
    }
  }

  return {
    async runStartupRecovery() {
      return runStartupRecoveryChecklist({
        wallet: input.wallet,
        stateRepository: input.stores.stateRepository,
        actionRepository: input.stores.actionRepository,
        journalRepository: input.stores.journalRepository,
        lessonRepository: input.stores.lessonRepository,
        performanceRepository: input.stores.performanceRepository,
        poolMemoryRepository: input.stores.poolMemoryRepository,
        runtimePolicyStore: input.stores.runtimePolicyStore,
        signalWeightsStore: input.stores.signalWeightsStore,
        schedulerMetadataStore: input.stores.schedulerMetadataStore,
        now: nowIso(input.now),
      });
    },

    async runScreeningTick(triggerSource = "cron") {
      if (input.gateways.screeningGateway === undefined) {
        return null;
      }

      return runScreeningWorker({
        wallet: input.wallet,
        screeningGateway: input.gateways.screeningGateway,
        ...(input.gateways.tokenIntelGateway === undefined
          ? {}
          : { tokenIntelGateway: input.gateways.tokenIntelGateway }),
        stateRepository: input.stores.stateRepository,
        actionRepository: input.stores.actionRepository,
        journalRepository: input.stores.journalRepository,
        walletGateway: input.gateways.walletGateway,
        priceGateway: input.gateways.priceGateway,
        riskPolicy: input.config.risk,
        policyProvider,
        signalWeightsProvider,
        aiMode: input.config.ai.mode,
        ...(input.lessonPromptService === undefined
          ? {}
          : { lessonPromptService: input.lessonPromptService }),
        ...(input.gateways.llmGateway === undefined
          ? {}
          : { llmGateway: input.gateways.llmGateway }),
        ...(input.aiTimeoutMs === undefined
          ? {}
          : { aiTimeoutMs: input.aiTimeoutMs }),
        poolMemoryRepository: input.stores.poolMemoryRepository,
        schedulerMetadataStore: input.stores.schedulerMetadataStore,
        intervalSec: input.config.schedule.screeningIntervalSec,
        triggerSource,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    },

    async runActionQueueTick() {
      if (input.config.runtime.dryRun) {
        logger.info(
          "runtime dryRun=true; action queue processing skipped to prevent live writes",
        );
        return [];
      }

      return processActionQueue({
        actionQueue: input.stores.actionQueue,
        handler: runQueueHandler,
      });
    },

    async runReconciliationTick(triggerSource = "cron") {
      return runReconciliationWorker({
        actionRepository: input.stores.actionRepository,
        stateRepository: input.stores.stateRepository,
        dlmmGateway: input.gateways.dlmmGateway,
        actionQueue: input.stores.actionQueue,
        journalRepository: input.stores.journalRepository,
        runtimeControlStore: input.stores.runtimeControlStore,
        schedulerMetadataStore: input.stores.schedulerMetadataStore,
        intervalSec: input.config.schedule.reconciliationIntervalSec,
        triggerSource,
        wallets: [input.wallet],
        ...(postClaimSwapHook === undefined
          ? {}
          : { postClaimSwapHook }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    },

    async runManagementTick(triggerSource = "cron") {
      const result = await runManagementWorker({
        wallet: input.wallet,
        actionQueue: input.stores.actionQueue,
        stateRepository: input.stores.stateRepository,
        actionRepository: input.stores.actionRepository,
        journalRepository: input.stores.journalRepository,
        walletGateway: input.gateways.walletGateway,
        priceGateway: input.gateways.priceGateway,
        riskPolicy: input.config.risk,
        managementPolicy: input.config.managementPolicy,
        claimConfig: input.config.claim,
        aiMode: input.config.ai.mode,
        ...(input.gateways.llmGateway === undefined
          ? {}
          : { llmGateway: input.gateways.llmGateway }),
        ...(input.lessonPromptService === undefined
          ? {}
          : { lessonPromptService: input.lessonPromptService }),
        ...(input.aiTimeoutMs === undefined
          ? {}
          : { aiTimeoutMs: input.aiTimeoutMs }),
        signalProvider: input.signalProvider,
        poolMemoryRepository: input.stores.poolMemoryRepository,
        runtimeControlStore: input.stores.runtimeControlStore,
        poolMemorySnapshotsEnabled: input.config.poolMemory.snapshotsEnabled,
        ...(input.rebalancePlanner === undefined
          ? {}
          : { rebalancePlanner: input.rebalancePlanner }),
        schedulerMetadataStore: input.stores.schedulerMetadataStore,
        intervalSec: input.config.schedule.managementIntervalSec,
        triggerSource,
        previousPortfolioState,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      previousPortfolioState = result.portfolioState;
      return result;
    },

    async runReportingTick(triggerSource = "cron") {
      return runReportingWorker({
        wallet: input.wallet,
        stateRepository: input.stores.stateRepository,
        actionRepository: input.stores.actionRepository,
        lessonRepository: input.stores.lessonRepository,
        performanceRepository: input.stores.performanceRepository,
        poolMemoryRepository: input.stores.poolMemoryRepository,
        priceGateway: input.gateways.priceGateway,
        schedulerMetadataStore: input.stores.schedulerMetadataStore,
        ...(input.gateways.notifierGateway === undefined
          ? {}
          : { notifierGateway: input.gateways.notifierGateway }),
        ...(input.alertRecipient === undefined
          ? {}
          : { alertRecipient: input.alertRecipient }),
        ...(input.config.risk.dailyProfitTargetSol === undefined
          ? {}
          : { dailyProfitTargetSol: input.config.risk.dailyProfitTargetSol }),
        solMode: input.config.reporting.solMode,
        briefingEmoji: input.config.reporting.briefingEmoji,
        intervalSec: input.config.schedule.reportingIntervalSec,
        triggerSource,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    },

    async runRecommendedCycle(cycleInput = {}) {
      const triggerSource = cycleInput.triggerSource ?? "cron";
      const screening = cycleInput.includeScreening === false
        ? null
        : await this.runScreeningTick(triggerSource);
      const reconciliation = await this.runReconciliationTick(triggerSource);
      const management = await this.runManagementTick(triggerSource);
      const processedActions = await this.runActionQueueTick();
      const reporting = cycleInput.includeReporting === false
        ? null
        : await this.runReportingTick(triggerSource);

      return {
        screening,
        reconciliation,
        management,
        processedActions,
        reporting,
      };
    },
  };
}

export function createRuntimeSupervisorFromUserConfig(
  input: CreateRuntimeSupervisorFromUserConfigInput,
): RuntimeSupervisor {
  return createRuntimeSupervisor({
    ...input,
    config: {
      risk: input.userConfig.risk,
      screening: input.userConfig.screening,
      managementPolicy: {
        ...input.userConfig.management,
        maxRebalancesPerPosition: input.userConfig.risk.maxRebalancesPerPosition,
      },
      claim: input.userConfig.claim,
      ai: input.userConfig.ai,
      poolMemory: input.userConfig.poolMemory,
      schedule: input.userConfig.schedule,
      darwin: input.userConfig.darwin,
      notifications: input.userConfig.notifications,
      reporting: input.userConfig.reporting,
      runtime: input.userConfig.runtime,
    },
  });
}
