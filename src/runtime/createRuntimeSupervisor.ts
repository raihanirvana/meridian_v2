import type { DlmmGateway } from "../adapters/dlmm/DlmmGateway.js";
import type { AiStrategyReviewer } from "../adapters/llm/AiStrategyReviewer.js";
import type { LlmGateway } from "../adapters/llm/LlmGateway.js";
import type { PriceGateway } from "../adapters/pricing/PriceGateway.js";
import type { ScreeningGateway } from "../adapters/screening/ScreeningGateway.js";
import type { NotifierGateway } from "../adapters/telegram/NotifierGateway.js";
import type { TokenIntelGateway } from "../adapters/analytics/TokenIntelGateway.js";
import type { WalletGateway } from "../adapters/wallet/WalletGateway.js";
import type { SwapGateway } from "../adapters/jupiter/SwapGateway.js";
import type { Action } from "../domain/entities/Action.js";
import type { Candidate } from "../domain/entities/Candidate.js";
import type { PortfolioState } from "../domain/entities/PortfolioState.js";
import type {
  ManagementEvaluationResult,
  ManagementPolicy,
  ManagementSignals,
} from "../domain/rules/managementRules.js";
import type { RebalanceDecisionValidationResult } from "../domain/rules/rebalanceDecisionRules.js";
import type { ScreeningPolicy } from "../domain/rules/screeningRules.js";
import {
  evaluatePortfolioRisk,
  type PortfolioRiskPolicy,
} from "../domain/rules/riskRules.js";
import {
  type FinalStrategyDecision,
  validateStrategyDecision,
} from "../domain/rules/strategyDecisionRules.js";
import type { UserConfig } from "../infra/config/configSchema.js";
import { createLogger } from "../infra/logging/logger.js";
import type { Position } from "../domain/entities/Position.js";
import type { RuntimeStores } from "./createRuntimeStores.js";
import { buildPortfolioState } from "../app/services/PortfolioStateBuilder.js";
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
import {
  requestDeploy,
  type DeployActionRequestPayload,
} from "../app/usecases/requestDeploy.js";
import type { LessonPromptService } from "../app/services/LessonPromptService.js";
import { DefaultPolicyProvider } from "../app/services/PolicyProvider.js";
import { DefaultSignalWeightsProvider } from "../app/services/SignalWeightsProvider.js";
import { createPostClaimSwapHook } from "../app/usecases/executePostClaimSwap.js";
import { reviewStrategyWithAi } from "../app/usecases/reviewStrategyWithAi.js";
import { createPerformanceLessonHook } from "../app/services/createPerformanceLessonHook.js";
import { createUlid } from "../infra/id/createUlid.js";

export interface RuntimeSupervisorInput {
  wallet: string;
  config: {
    risk: PortfolioRiskPolicy;
    screening: UserConfig["screening"];
    managementPolicy: ManagementPolicy;
    deploy: UserConfig["deploy"];
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
    aiStrategyReviewer?: AiStrategyReviewer;
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
    aiRebalanceDecision?: RebalanceDecisionValidationResult | undefined;
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

export interface CreateRuntimeSupervisorFromUserConfigInput extends Omit<
  RuntimeSupervisorInput,
  "config"
> {
  userConfig: UserConfig;
}

function nowIso(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

const TERMINAL_ACTION_STATUSES = new Set<Action["status"]>([
  "DONE",
  "FAILED",
  "ABORTED",
  "TIMED_OUT",
]);

function asOptionalNumberFromRecord(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asOptionalStringFromRecord(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function deriveDailyLossRemainingSol(input: {
  maxDailyLossSol?: number;
  dailyRealizedPnlUsd: number;
  solPriceUsd: number;
}): number | undefined {
  if (input.maxDailyLossSol === undefined || input.solPriceUsd <= 0) {
    return undefined;
  }

  const dailyLossSol = Math.max(
    0,
    -input.dailyRealizedPnlUsd / input.solPriceUsd,
  );
  return Math.max(0, input.maxDailyLossSol - dailyLossSol);
}

function classifyLiquidityDepth(input: {
  depthNearActiveUsd: number;
  tvlUsd: number;
}): "shallow" | "medium" | "deep" | "unknown" {
  if (input.depthNearActiveUsd <= 0 || input.tvlUsd <= 0) {
    return "unknown";
  }

  const depthPct = input.depthNearActiveUsd / input.tvlUsd;
  if (depthPct >= 0.2) {
    return "deep";
  }
  if (depthPct >= 0.05) {
    return "medium";
  }
  return "shallow";
}

function classifyTrendDirection(
  priceChange15mPct: number,
): "up" | "down" | "sideways" | "unknown" {
  if (!Number.isFinite(priceChange15mPct)) {
    return "unknown";
  }
  if (priceChange15mPct >= 1) {
    return "up";
  }
  if (priceChange15mPct <= -1) {
    return "down";
  }
  return "sideways";
}

function classifyTrendStrength(
  trendStrength15m: number,
): "weak" | "medium" | "strong" | "unknown" {
  if (!Number.isFinite(trendStrength15m)) {
    return "unknown";
  }
  if (trendStrength15m >= 70) {
    return "strong";
  }
  if (trendStrength15m >= 35) {
    return "medium";
  }
  return "weak";
}

function classifyMeanReversionSignal(
  meanReversionScore: number,
): "weak" | "medium" | "strong" | "unknown" {
  if (!Number.isFinite(meanReversionScore)) {
    return "unknown";
  }
  if (meanReversionScore >= 70) {
    return "strong";
  }
  if (meanReversionScore >= 35) {
    return "medium";
  }
  return "weak";
}

function buildAutoDeployPayload(input: {
  candidate: Candidate;
  poolInfo: Awaited<ReturnType<DlmmGateway["getPoolInfo"]>>;
  deployConfig: UserConfig["deploy"];
  solPriceUsd: number;
  finalStrategyDecision?: FinalStrategyDecision;
}): DeployActionRequestPayload {
  const tokenXMint = asOptionalStringFromRecord(
    input.candidate.tokenRiskSnapshot,
    "tokenXMint",
  );
  const tokenYMint = asOptionalStringFromRecord(
    input.candidate.tokenRiskSnapshot,
    "tokenYMint",
  );
  if (tokenXMint === undefined || tokenYMint === undefined) {
    throw new Error("shortlisted candidate is missing token mints");
  }

  const amountBase =
    tokenXMint === SOL_MINT ? input.deployConfig.defaultAmountSol : 0;
  const amountQuote =
    tokenYMint === SOL_MINT ? input.deployConfig.defaultAmountSol : 0;
  if (amountBase <= 0 && amountQuote <= 0) {
    throw new Error("auto deploy currently only supports SOL-paired pools");
  }

  const activeBin = input.poolInfo.activeBin;
  const binsBelow =
    input.finalStrategyDecision?.binsBelow ?? input.deployConfig.binsBelow;
  const binsAbove =
    input.finalStrategyDecision?.binsAbove ?? input.deployConfig.binsAbove;
  const slippageBps =
    input.finalStrategyDecision?.slippageBps ?? input.deployConfig.slippageBps;
  const strategy =
    input.finalStrategyDecision?.strategy ?? input.deployConfig.strategy;
  const rangeLowerBin = activeBin - binsBelow;
  const rangeUpperBin = activeBin + binsAbove;
  const feeTvlRatio = asOptionalNumberFromRecord(
    input.candidate.screeningSnapshot,
    "feeToTvlRatio",
  );
  const organicScore = asOptionalNumberFromRecord(
    input.candidate.screeningSnapshot,
    "organicScore",
  );

  return {
    poolAddress: input.candidate.poolAddress,
    tokenXMint,
    tokenYMint,
    baseMint: tokenXMint,
    quoteMint: tokenYMint,
    amountBase,
    amountQuote,
    slippageBps,
    strategy,
    rangeLowerBin,
    rangeUpperBin,
    initialActiveBin: activeBin,
    estimatedValueUsd: input.deployConfig.defaultAmountSol * input.solPriceUsd,
    entryMetadata: {
      poolName: input.candidate.symbolPair,
      binStep: input.poolInfo.binStep,
      activeBinAtEntry: activeBin,
      poolTvlUsd: input.candidate.marketFeatureSnapshot.tvlUsd,
      volume5mUsd: input.candidate.marketFeatureSnapshot.volume5mUsd,
      volume15mUsd: input.candidate.marketFeatureSnapshot.volume15mUsd,
      volume1hUsd: input.candidate.marketFeatureSnapshot.volume1hUsd,
      volume24hUsd: input.candidate.marketFeatureSnapshot.volume24hUsd,
      fees15mUsd: input.candidate.marketFeatureSnapshot.fees15mUsd,
      fees1hUsd: input.candidate.marketFeatureSnapshot.fees1hUsd,
      feeTvlRatio24h: input.candidate.marketFeatureSnapshot.feeTvlRatio24h,
      priceChange5mPct: input.candidate.marketFeatureSnapshot.priceChange5mPct,
      priceChange15mPct:
        input.candidate.marketFeatureSnapshot.priceChange15mPct,
      priceChange1hPct: input.candidate.marketFeatureSnapshot.priceChange1hPct,
      volatility15mPct: input.candidate.marketFeatureSnapshot.volatility15mPct,
      liquidityDepthNearActive: classifyLiquidityDepth({
        depthNearActiveUsd:
          input.candidate.dlmmMicrostructureSnapshot.depthNearActiveUsd,
        tvlUsd: input.candidate.marketFeatureSnapshot.tvlUsd,
      }),
      trendDirection: classifyTrendDirection(
        input.candidate.marketFeatureSnapshot.priceChange15mPct,
      ),
      trendStrength: classifyTrendStrength(
        input.candidate.marketFeatureSnapshot.trendStrength15m,
      ),
      meanReversionSignal: classifyMeanReversionSignal(
        input.candidate.marketFeatureSnapshot.meanReversionScore,
      ),
      ...(feeTvlRatio === undefined ? {} : { feeTvlRatio }),
      ...(organicScore === undefined ? {} : { organicScore }),
      amountSol: input.deployConfig.defaultAmountSol,
    },
  };
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
    requireFreshSnapshot: input.config.screening.requireFreshSnapshot,
    maxEstimatedSlippageBps: input.config.screening.maxEstimatedSlippageBps,
    maxStrategySnapshotAgeMs: input.config.screening.maxStrategySnapshotAgeMs,
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
    shortlistLimit: input.config.screening.aiReviewPoolSize ?? 30,
  };
  const policyProvider = new DefaultPolicyProvider({
    basePolicy: baseScreeningPolicy,
    runtimePolicyStore: input.stores.runtimePolicyStore,
  });
  const signalWeightsProvider = new DefaultSignalWeightsProvider({
    darwinEnabled: input.config.darwin.enabled,
    signalWeightsStore: input.stores.signalWeightsStore,
  });
  const lessonHook = createPerformanceLessonHook({
    performanceRepository: input.stores.performanceRepository,
    lessonRepository: input.stores.lessonRepository,
    poolMemoryRepository: input.stores.poolMemoryRepository,
    journalRepository: input.stores.journalRepository,
    runtimePolicyStore: input.stores.runtimePolicyStore,
    signalWeightsStore: input.stores.signalWeightsStore,
    config: {
      darwin: input.config.darwin,
    },
    now: () => nowIso(input.now),
    idGen: createUlid,
  });
  const postClaimSwapHook =
    input.gateways.swapGateway === undefined
      ? undefined
      : createPostClaimSwapHook(input.gateways.swapGateway);

  async function appendAutoDeployJournal(inputEvent: {
    timestamp: string;
    candidate: Candidate | null;
    actionId: string | null;
    resultStatus: string;
    detail: string;
    payload?: DeployActionRequestPayload;
    error?: string | null;
  }): Promise<void> {
    await input.stores.journalRepository.append({
      timestamp: inputEvent.timestamp,
      eventType: "AUTO_DEPLOY_FROM_SHORTLIST",
      actor: "system",
      wallet: input.wallet,
      positionId: null,
      actionId: inputEvent.actionId,
      before: null,
      after: {
        candidateId: inputEvent.candidate?.candidateId ?? null,
        poolAddress: inputEvent.candidate?.poolAddress ?? null,
        symbolPair: inputEvent.candidate?.symbolPair ?? null,
        resultStatus: inputEvent.resultStatus,
        detail: inputEvent.detail,
        ...(inputEvent.payload === undefined
          ? {}
          : { requestPayload: inputEvent.payload }),
      },
      txIds: [],
      resultStatus: inputEvent.resultStatus,
      error: inputEvent.error ?? null,
    });
  }

  async function appendStrategyDecisionJournal(inputEvent: {
    timestamp: string;
    candidate: Candidate;
    finalStrategyDecision: FinalStrategyDecision;
    aiSource: string | null;
    aiError?: string | null;
    riskDecision?: {
      allowed: boolean;
      decision: string;
      reason: string;
      blockingRules: string[];
    };
  }): Promise<void> {
    await input.stores.journalRepository.append({
      timestamp: inputEvent.timestamp,
      eventType: "STRATEGY_DECISION_VALIDATED",
      actor: inputEvent.finalStrategyDecision.source === "AI" ? "ai" : "system",
      wallet: input.wallet,
      positionId: null,
      actionId: null,
      before: null,
      after: {
        candidateId: inputEvent.candidate.candidateId,
        poolAddress: inputEvent.candidate.poolAddress,
        symbolPair: inputEvent.candidate.symbolPair,
        configStaticStrategy: {
          strategy: input.config.deploy.strategy,
          binsBelow: input.config.deploy.binsBelow,
          binsAbove: input.config.deploy.binsAbove,
          slippageBps: input.config.deploy.slippageBps,
        },
        deterministicStrategy: {
          recommendedByRules:
            inputEvent.candidate.strategySuitability.recommendedByRules,
          curveScore: inputEvent.candidate.strategySuitability.curveScore,
          spotScore: inputEvent.candidate.strategySuitability.spotScore,
          bidAskScore: inputEvent.candidate.strategySuitability.bidAskScore,
          riskFlags: inputEvent.candidate.strategySuitability.strategyRiskFlags,
        },
        aiStrategy: {
          source: inputEvent.aiSource,
          error: inputEvent.aiError ?? null,
          recommendedStrategy:
            inputEvent.finalStrategyDecision.aiRecommendedStrategy,
        },
        finalStrategyDecision: inputEvent.finalStrategyDecision,
        ...(inputEvent.riskDecision === undefined
          ? {}
          : { riskDecision: inputEvent.riskDecision }),
      },
      txIds: [],
      resultStatus: inputEvent.finalStrategyDecision.rejected
        ? "REJECTED"
        : "VALIDATED",
      error:
        inputEvent.finalStrategyDecision.rejected ||
        inputEvent.riskDecision?.allowed === false
          ? [
              ...inputEvent.finalStrategyDecision.riskFlags,
              ...(inputEvent.riskDecision?.blockingRules ?? []),
            ].join("; ")
          : null,
    });
  }

  async function maybeAutoDeployFromShortlist(
    screening: RunScreeningCycleResult,
  ): Promise<void> {
    if (!input.config.deploy.autoDeployFromShortlist) {
      return;
    }

    const timestamp = nowIso(input.now);
    if (screening.shortlist.length === 0) {
      await appendAutoDeployJournal({
        timestamp,
        candidate: null,
        actionId: null,
        resultStatus: "SKIPPED",
        detail: "auto deploy skipped because shortlist is empty",
      });
      return;
    }

    if (
      input.config.ai.strategyReviewMode === "dry_run_payload" &&
      !input.config.runtime.dryRun
    ) {
      await appendAutoDeployJournal({
        timestamp,
        candidate: screening.shortlist[0] ?? null,
        actionId: null,
        resultStatus: "BLOCKED",
        detail:
          "auto deploy blocked because ai.strategyReviewMode=dry_run_payload cannot submit live",
        error: "dry_run_payload mode requires runtime.dryRun=true",
      });
      return;
    }

    if (
      (await input.stores.runtimeControlStore.snapshot()).stopAllDeploys.active
    ) {
      await appendAutoDeployJournal({
        timestamp,
        candidate: screening.shortlist[0] ?? null,
        actionId: null,
        resultStatus: "BLOCKED",
        detail: "auto deploy blocked by manual circuit breaker",
        error: "manual circuit breaker is active",
      });
      return;
    }

    const portfolio = await buildPortfolioState({
      wallet: input.wallet,
      minReserveUsd: input.config.risk.minReserveUsd,
      dailyLossLimitPct: input.config.risk.dailyLossLimitPct,
      circuitBreakerCooldownMin: input.config.risk.circuitBreakerCooldownMin,
      stateRepository: input.stores.stateRepository,
      actionRepository: input.stores.actionRepository,
      journalRepository: input.stores.journalRepository,
      walletGateway: input.gateways.walletGateway,
      priceGateway: input.gateways.priceGateway,
      now: timestamp,
    });
    if (
      portfolio.circuitBreakerState === "ON" ||
      portfolio.circuitBreakerState === "COOLDOWN"
    ) {
      await appendAutoDeployJournal({
        timestamp,
        candidate: screening.shortlist[0] ?? null,
        actionId: null,
        resultStatus: "BLOCKED",
        detail: `auto deploy blocked by portfolio circuit breaker ${portfolio.circuitBreakerState}`,
        error: "portfolio circuit breaker is active",
      });
      return;
    }
    if (portfolio.openPositions >= input.config.risk.maxConcurrentPositions) {
      await appendAutoDeployJournal({
        timestamp,
        candidate: screening.shortlist[0] ?? null,
        actionId: null,
        resultStatus: "BLOCKED",
        detail: "auto deploy blocked by maxConcurrentPositions",
        error: "max concurrent positions reached",
      });
      return;
    }

    const actions = await input.stores.actionRepository.list();
    const pendingActions = actions.filter(
      (action) =>
        action.wallet === input.wallet &&
        !TERMINAL_ACTION_STATUSES.has(action.status),
    );
    if (pendingActions.length > 0) {
      await appendAutoDeployJournal({
        timestamp,
        candidate: screening.shortlist[0] ?? null,
        actionId: null,
        resultStatus: "SKIPPED",
        detail: "auto deploy skipped because pending actions exist",
      });
      return;
    }

    const oneHourAgo = Date.parse(timestamp) - 60 * 60 * 1000;
    const recentDeploys = actions.filter((action) => {
      const requestedAtMs = Date.parse(action.requestedAt);
      return (
        action.wallet === input.wallet &&
        action.type === "DEPLOY" &&
        action.status !== "FAILED" &&
        action.status !== "ABORTED" &&
        action.status !== "TIMED_OUT" &&
        Number.isFinite(requestedAtMs) &&
        requestedAtMs >= oneHourAgo
      );
    });
    if (recentDeploys.length >= input.config.risk.maxNewDeploysPerHour) {
      await appendAutoDeployJournal({
        timestamp,
        candidate: screening.shortlist[0] ?? null,
        actionId: null,
        resultStatus: "BLOCKED",
        detail: "auto deploy blocked by maxNewDeploysPerHour",
        error: "hourly deploy limit reached",
      });
      return;
    }

    const solPrice = await input.gateways.priceGateway.getSolPriceUsd();
    const dailyLossRemainingSol = deriveDailyLossRemainingSol({
      ...(input.config.risk.maxDailyLossSol === undefined
        ? {}
        : { maxDailyLossSol: input.config.risk.maxDailyLossSol }),
      dailyRealizedPnlUsd: portfolio.dailyRealizedPnl,
      solPriceUsd: solPrice.priceUsd,
    });
    const strategyReviews = input.config.ai.strategyReviewEnabled
      ? await reviewStrategyWithAi({
          wallet: input.wallet,
          candidates: screening.shortlist,
          aiMode: input.config.ai.mode,
          ...(input.gateways.aiStrategyReviewer === undefined
            ? {}
            : { reviewer: input.gateways.aiStrategyReviewer }),
          ...(input.lessonPromptService === undefined
            ? {}
            : { lessonPromptService: input.lessonPromptService }),
          journalRepository: input.stores.journalRepository,
          minConfidence: input.config.ai.minAiStrategyConfidence,
          timeoutMs: input.aiTimeoutMs ?? input.config.ai.timeoutMs ?? 500,
          defaults: {
            binsBelow: input.config.deploy.binsBelow,
            binsAbove: input.config.deploy.binsAbove,
            slippageBps: input.config.deploy.slippageBps,
          },
          botContext: {
            walletRiskMode: input.config.ai.walletRiskMode,
            maxPositionSol: input.config.deploy.defaultAmountSol,
            maxSlippageBps: input.config.deploy.maxSlippageBps,
            maxActiveBinDrift: input.config.deploy.maxActiveBinDrift,
            maxOpenPositions: input.config.risk.maxConcurrentPositions,
            currentlyOpenPositions: portfolio.openPositions,
            allowedStrategies: ["curve", "spot", "bid_ask"],
            ...(dailyLossRemainingSol === undefined
              ? {}
              : { dailyLossRemainingSol }),
          },
          ...(input.now === undefined ? {} : { now: input.now }),
        })
      : null;
    const strategyReviewByCandidateId = new Map(
      (strategyReviews?.reviews ?? []).map((review) => [
        review.candidateId,
        review,
      ]),
    );
    const candidateById = new Map(
      screening.shortlist.map((candidate) => [
        candidate.candidateId,
        candidate,
      ]),
    );
    const aiOrderedCandidates =
      strategyReviews === null
        ? screening.shortlist
        : [
            ...strategyReviews.reviews.flatMap((review) => {
              const candidate = candidateById.get(review.candidateId);
              return candidate === undefined ? [] : [candidate];
            }),
            ...screening.shortlist.filter(
              (candidate) =>
                !strategyReviewByCandidateId.has(candidate.candidateId),
            ),
          ];
    let deployedThisCycle = 0;
    for (const candidate of aiOrderedCandidates) {
      if (deployedThisCycle >= input.config.deploy.maxAutoDeploysPerCycle) {
        break;
      }

      try {
        const portfolioForRisk: PortfolioState = input.config.runtime.dryRun
          ? portfolio
          : {
              ...portfolio,
              pendingActions: portfolio.pendingActions + deployedThisCycle,
              openPositions: portfolio.openPositions + deployedThisCycle,
            };
        const poolInfo = await input.gateways.dlmmGateway.getPoolInfo(
          candidate.poolAddress,
        );
        const reviewItem = strategyReviewByCandidateId.get(
          candidate.candidateId,
        );
        const requestedStrategyMode = input.config.ai.strategyReviewEnabled
          ? input.config.ai.strategyReviewMode
          : "recommendation_only";
        const strategyMode =
          requestedStrategyMode === "manual_live" ||
          (requestedStrategyMode === "guarded_auto" &&
            !input.config.runtime.dryRun &&
            !input.config.ai.allowAiStrategyForDeploy)
            ? "recommendation_only"
            : requestedStrategyMode;
        const finalStrategyDecision = validateStrategyDecision({
          candidate,
          mode: strategyMode,
          aiReview: reviewItem?.review ?? null,
          configStrategy: {
            strategy: input.config.deploy.strategy,
            binsBelow: input.config.deploy.binsBelow,
            binsAbove: input.config.deploy.binsAbove,
            slippageBps: input.config.deploy.slippageBps,
          },
          policy: {
            minCandidateScore: 55,
            minAiStrategyConfidence: input.config.ai.minAiStrategyConfidence,
            allowedStrategies: ["spot", "curve", "bid_ask"],
            maxActiveBinDrift: input.config.deploy.maxActiveBinDrift,
            maxBinsBelow: input.config.deploy.maxBinsBelow,
            maxBinsAbove: input.config.deploy.maxBinsAbove,
            maxSlippageBps: input.config.deploy.maxSlippageBps,
            requireFreshSnapshot: input.config.deploy.requireFreshSnapshot,
            strategyFallbackMode: input.config.deploy.strategyFallbackMode,
          },
          simulationPassed: true,
        });
        await appendStrategyDecisionJournal({
          timestamp,
          candidate,
          finalStrategyDecision,
          aiSource: reviewItem?.source ?? null,
          aiError: reviewItem?.aiError ?? null,
        });
        if (finalStrategyDecision.rejected) {
          await appendAutoDeployJournal({
            timestamp,
            candidate,
            actionId: null,
            resultStatus: "BLOCKED",
            detail: "auto deploy blocked by strategy decision validator",
            error: finalStrategyDecision.riskFlags.join("; "),
          });
          continue;
        }

        const payload = buildAutoDeployPayload({
          candidate,
          poolInfo,
          deployConfig: input.config.deploy,
          solPriceUsd: solPrice.priceUsd,
          finalStrategyDecision,
        });

        const riskResult = evaluatePortfolioRisk({
          action: "DEPLOY",
          portfolio: portfolioForRisk,
          policy: input.config.risk,
          proposedAllocationUsd: payload.estimatedValueUsd,
          proposedPoolAddress: payload.poolAddress,
          proposedTokenMints: [
            ...new Set([payload.tokenXMint, payload.tokenYMint]),
          ],
          recentNewDeploys: recentDeploys.length + deployedThisCycle,
          position: null,
          solPriceUsd: solPrice.priceUsd,
        });
        if (!riskResult.allowed) {
          await input.stores.journalRepository.append({
            timestamp,
            eventType: "DEPLOY_REQUEST_BLOCKED_BY_RISK",
            actor: "system",
            wallet: input.wallet,
            positionId: null,
            actionId: null,
            before: null,
            after: {
              requestPayload: payload,
              riskDecision: riskResult.decision,
              blockingRules: riskResult.blockingRules,
              projectedExposureByPool: riskResult.projectedExposureByPool,
              projectedExposureByToken: riskResult.projectedExposureByToken,
            },
            txIds: [],
            resultStatus: "BLOCKED",
            error: riskResult.reason,
          });
          await appendStrategyDecisionJournal({
            timestamp,
            candidate,
            finalStrategyDecision,
            aiSource: reviewItem?.source ?? null,
            aiError: reviewItem?.aiError ?? null,
            riskDecision: {
              allowed: riskResult.allowed,
              decision: riskResult.decision,
              reason: riskResult.reason,
              blockingRules: riskResult.blockingRules,
            },
          });
          await appendAutoDeployJournal({
            timestamp,
            candidate,
            actionId: null,
            resultStatus: "BLOCKED",
            detail: "auto deploy blocked by full portfolio risk engine",
            payload,
            error: riskResult.reason,
          });
          continue;
        }

        if (payload.estimatedValueUsd > portfolio.availableBalance) {
          await appendAutoDeployJournal({
            timestamp,
            candidate,
            actionId: null,
            resultStatus: "BLOCKED",
            detail: "auto deploy blocked by available balance",
            payload,
            error: "insufficient available balance after reserve",
          });
          continue;
        }

        if (input.config.runtime.dryRun) {
          await appendAutoDeployJournal({
            timestamp,
            candidate,
            actionId: null,
            resultStatus: "DRY_RUN",
            detail:
              "runtime dryRun=true; auto deploy payload validated but not queued",
            payload,
          });
          deployedThisCycle += 1;
          continue;
        }

        const action = await requestDeploy({
          actionQueue: input.stores.actionQueue,
          wallet: input.wallet,
          payload,
          requestedBy: "system",
          requestedAt: timestamp,
          journalRepository: input.stores.journalRepository,
          runtimeControlStore: input.stores.runtimeControlStore,
          riskGuard: {
            portfolio: portfolioForRisk,
            policy: input.config.risk,
            recentNewDeploys: recentDeploys.length + deployedThisCycle,
            solPriceUsd: solPrice.priceUsd,
          },
        });
        await appendAutoDeployJournal({
          timestamp,
          candidate,
          actionId: action.actionId,
          resultStatus: "QUEUED",
          detail: "auto deploy queued from shortlist",
          payload,
        });
        deployedThisCycle += 1;
      } catch (error) {
        await appendAutoDeployJournal({
          timestamp,
          candidate,
          actionId: null,
          resultStatus: "SKIPPED",
          detail: "auto deploy candidate skipped",
          error:
            error instanceof Error
              ? error.message
              : "auto deploy candidate failed",
        });
      }
    }
  }

  async function buildCompoundDeployRiskGuard(inputEvent: {
    wallet: string;
    now: string;
  }) {
    const [portfolio, actions, solPrice] = await Promise.all([
      buildPortfolioState({
        wallet: inputEvent.wallet,
        minReserveUsd: input.config.risk.minReserveUsd,
        dailyLossLimitPct: input.config.risk.dailyLossLimitPct,
        circuitBreakerCooldownMin: input.config.risk.circuitBreakerCooldownMin,
        stateRepository: input.stores.stateRepository,
        actionRepository: input.stores.actionRepository,
        journalRepository: input.stores.journalRepository,
        walletGateway: input.gateways.walletGateway,
        priceGateway: input.gateways.priceGateway,
        now: inputEvent.now,
      }),
      input.stores.actionRepository.list(),
      input.gateways.priceGateway.getSolPriceUsd(),
    ]);
    const oneHourAgo = Date.parse(inputEvent.now) - 60 * 60 * 1000;
    const recentNewDeploys = actions.filter((action) => {
      const requestedAtMs = Date.parse(action.requestedAt);
      return (
        action.wallet === inputEvent.wallet &&
        action.type === "DEPLOY" &&
        action.status !== "FAILED" &&
        action.status !== "ABORTED" &&
        action.status !== "TIMED_OUT" &&
        Number.isFinite(requestedAtMs) &&
        requestedAtMs >= oneHourAgo
      );
    }).length;

    return {
      portfolio,
      policy: input.config.risk,
      recentNewDeploys,
      solPriceUsd: solPrice.priceUsd,
    };
  }

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

      const screening = await runScreeningWorker({
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
        enrichmentConcurrency: input.config.screening.enrichmentConcurrency,
        schedulerMetadataStore: input.stores.schedulerMetadataStore,
        intervalSec: input.config.schedule.screeningIntervalSec,
        triggerSource,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      await maybeAutoDeployFromShortlist(screening);
      return screening;
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
        performanceRepository: input.stores.performanceRepository,
        runtimeControlStore: input.stores.runtimeControlStore,
        schedulerMetadataStore: input.stores.schedulerMetadataStore,
        intervalSec: input.config.schedule.reconciliationIntervalSec,
        triggerSource,
        wallets: [input.wallet],
        dryRun: input.config.runtime.dryRun,
        ...(postClaimSwapHook === undefined ? {} : { postClaimSwapHook }),
        lessonHook,
        claimCompoundRiskGuardProvider: buildCompoundDeployRiskGuard,
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
        dlmmGateway: input.gateways.dlmmGateway,
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
      const screening =
        cycleInput.includeScreening === false
          ? null
          : await this.runScreeningTick(triggerSource);
      const reconciliation = await this.runReconciliationTick(triggerSource);
      const management = await this.runManagementTick(triggerSource);
      const processedActions = await this.runActionQueueTick();
      const reporting =
        cycleInput.includeReporting === false
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
        maxRebalancesPerPosition:
          input.userConfig.risk.maxRebalancesPerPosition,
      },
      deploy: input.userConfig.deploy,
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
