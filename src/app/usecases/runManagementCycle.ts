import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import type { RuntimeControlStore } from "../../adapters/storage/RuntimeControlStore.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { PriceGateway } from "../../adapters/pricing/PriceGateway.js";
import type { WalletGateway } from "../../adapters/wallet/WalletGateway.js";
import type { LlmGateway } from "../../adapters/llm/LlmGateway.js";
import type { DlmmGateway, PoolInfo } from "../../adapters/dlmm/DlmmGateway.js";
import type { Action } from "../../domain/entities/Action.js";
import type { Position } from "../../domain/entities/Position.js";
import type { PortfolioState } from "../../domain/entities/PortfolioState.js";
import type { RebalanceReviewInput } from "../../domain/entities/RebalanceDecision.js";
import {
  evaluateManagementAction,
  type ManagementEvaluationResult,
  type ManagementPolicy,
  type ManagementSignals,
} from "../../domain/rules/managementRules.js";
import {
  evaluatePortfolioRisk,
  type PortfolioRiskEvaluationResult,
  type PortfolioRiskPolicy,
} from "../../domain/rules/riskRules.js";
import {
  validateRebalanceDecision,
  type RebalanceDecisionValidationResult,
} from "../../domain/rules/rebalanceDecisionRules.js";
import type { Actor, ManagementAction } from "../../domain/types/enums.js";
import type { UserConfig } from "../../infra/config/configSchema.js";
import type { ActionQueue } from "../services/ActionQueue.js";
import { adviseManagementDecision } from "../services/AiAdvisoryService.js";
import type { AiRebalancePlanner } from "../services/AiRebalancePlanner.js";
import { type LessonPromptService } from "../services/LessonPromptService.js";
import { buildPortfolioState } from "../services/PortfolioStateBuilder.js";
import { countRecentNewDeploys } from "../services/RecentDeployCounter.js";

import { recordPoolSnapshot } from "./recordPoolSnapshot.js";
import { requestClose } from "./requestClose.js";
import { requestClaimFees } from "./requestClaimFees.js";
import { reviewRebalanceWithAi } from "./reviewRebalanceWithAi.js";
import {
  deriveRebalanceCapitalRequirement,
  requestRebalance,
  type RebalanceActionRequestPayload,
} from "./requestRebalance.js";

function proposedTokenMints(payload: RebalanceActionRequestPayload): string[] {
  return [...new Set([payload.redeploy.baseMint, payload.redeploy.quoteMint])];
}

function diffMinutes(from: string | null, to: string): number {
  if (from === null) {
    return 0;
  }

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return 0;
  }

  return Math.max(0, Math.floor((toMs - fromMs) / 60_000));
}

function isPositionInRange(position: Position): boolean {
  return (
    position.activeBin !== null &&
    position.activeBin >= position.rangeLowerBin &&
    position.activeBin <= position.rangeUpperBin
  );
}

function deriveSnapshotPnlPct(position: Position): number {
  const estimatedInitialValueUsd = Math.max(
    position.currentValueUsd - position.unrealizedPnlUsd,
    0,
  );

  if (estimatedInitialValueUsd <= 0) {
    return 0;
  }

  return (position.unrealizedPnlUsd / estimatedInitialValueUsd) * 100;
}

function deriveDailyLossRemainingSol(input: {
  portfolio: PortfolioState;
  riskPolicy: PortfolioRiskPolicy;
}): number | null {
  if (
    input.riskPolicy.maxDailyLossSol === undefined ||
    input.portfolio.solPriceUsd === undefined ||
    input.portfolio.solPriceUsd <= 0
  ) {
    return null;
  }

  const dailyLossSol = Math.max(
    0,
    -input.portfolio.dailyRealizedPnl / input.portfolio.solPriceUsd,
  );
  return Math.max(0, input.riskPolicy.maxDailyLossSol - dailyLossSol);
}

function buildRebalanceReviewInput(input: {
  position: Position;
  portfolio: PortfolioState;
  signals: ManagementSignals;
  evaluation: ManagementEvaluationResult;
  riskPolicy: PortfolioRiskPolicy;
  managementPolicy: ManagementPolicy;
  poolInfo?: PoolInfo;
  now: string;
}): RebalanceReviewInput {
  const ageMinutes = diffMinutes(input.position.openedAt, input.now);
  const outOfRangeMinutes = diffMinutes(
    input.position.outOfRangeSince,
    input.now,
  );
  const pnlPct = deriveSnapshotPnlPct(input.position);
  const metadata = input.position.entryMetadata;
  const binStep = input.poolInfo?.binStep ?? metadata?.binStep ?? null;
  const liveActiveBin = input.poolInfo?.activeBin ?? null;
  const activeBinAtEntry = metadata?.activeBinAtEntry ?? null;
  const lastRebalanceAgeMinutes =
    input.position.lastRebalanceAt == null
      ? null
      : diffMinutes(input.position.lastRebalanceAt, input.now);

  return {
    position: {
      positionId: input.position.positionId,
      poolAddress: input.position.poolAddress,
      strategy: input.position.strategy,
      lowerBin: input.position.rangeLowerBin,
      upperBin: input.position.rangeUpperBin,
      activeBinAtEntry,
      currentActiveBin: input.position.activeBin,
      binStep,
      ageMinutes,
      outOfRangeMinutes,
      positionValueUsd: input.position.currentValueUsd,
      unclaimedFeesUsd: input.signals.claimableFeesUsd,
      pnlPct,
      rebalanceCount: input.position.rebalanceCount,
      lastRebalanceAgeMinutes,
      partialCloseCount: input.position.partialCloseCount,
    },
    pool: {
      poolAddress: input.position.poolAddress,
      tvlUsd: metadata?.poolTvlUsd ?? 0,
      volume5mUsd: metadata?.volume5mUsd ?? 0,
      volume15mUsd: metadata?.volume15mUsd ?? 0,
      volume1hUsd: metadata?.volume1hUsd ?? 0,
      volume24hUsd: metadata?.volume24hUsd ?? 0,
      fees15mUsd: metadata?.fees15mUsd ?? 0,
      fees1hUsd: metadata?.fees1hUsd ?? 0,
      feeTvlRatio24h: metadata?.feeTvlRatio24h ?? metadata?.feeTvlRatio ?? 0,
      liquidityDepthNearActive: input.signals.liquidityCollapse
        ? "shallow"
        : (metadata?.liquidityDepthNearActive ?? "unknown"),
      priceChange5mPct: metadata?.priceChange5mPct ?? 0,
      priceChange15mPct: metadata?.priceChange15mPct ?? 0,
      priceChange1hPct: metadata?.priceChange1hPct ?? 0,
      volatility15m: metadata?.volatility15mPct ?? metadata?.volatility ?? 0,
      trendDirection: metadata?.trendDirection ?? "unknown",
      trendStrength: metadata?.trendStrength ?? "unknown",
      meanReversionSignal: metadata?.meanReversionSignal ?? "unknown",
      currentActiveBin: liveActiveBin,
    },
    walletRisk: {
      dailyLossRemainingSol: deriveDailyLossRemainingSol({
        portfolio: input.portfolio,
        riskPolicy: input.riskPolicy,
      }),
      openPositions: input.portfolio.openPositions,
      maxOpenPositions: input.riskPolicy.maxConcurrentPositions,
      maxRebalancesPerPosition: input.managementPolicy.maxRebalancesPerPosition,
      maxPositionSol: input.position.entryMetadata?.amountSol ?? null,
    },
    triggerReasons: input.evaluation.triggerReasons,
  };
}

const MAX_TRAILING_SNAPSHOT_AGE_MINUTES = 15;

function tryDeriveFreshSnapshotPnlPct(input: {
  position: Position;
  now: string;
}): number | null {
  const { position, now } = input;
  if (position.lastSyncedAt === null) {
    return null;
  }

  const nowMs = Date.parse(now);
  const syncedMs = Date.parse(position.lastSyncedAt);
  if (Number.isNaN(nowMs) || Number.isNaN(syncedMs)) {
    return null;
  }

  const ageMinutes = Math.max(0, Math.floor((nowMs - syncedMs) / 60_000));
  if (ageMinutes > MAX_TRAILING_SNAPSHOT_AGE_MINUTES) {
    return null;
  }

  const estimatedInitialValueUsd =
    position.currentValueUsd - position.unrealizedPnlUsd;
  if (
    !Number.isFinite(estimatedInitialValueUsd) ||
    estimatedInitialValueUsd <= 0
  ) {
    return null;
  }

  const pnlPct = (position.unrealizedPnlUsd / estimatedInitialValueUsd) * 100;
  return Number.isFinite(pnlPct) ? pnlPct : null;
}

function maybeRefreshPeakPnl(input: {
  position: Position;
  now: string;
  policy: ManagementPolicy;
}): Position {
  if (input.policy.trailingTakeProfitEnabled !== true) {
    return input.position;
  }

  const currentPnlPct = tryDeriveFreshSnapshotPnlPct({
    position: input.position,
    now: input.now,
  });
  if (currentPnlPct === null) {
    return input.position;
  }

  const previousPeak = input.position.peakPnlPct ?? null;
  if (previousPeak !== null && currentPnlPct <= previousPeak) {
    return input.position;
  }

  return {
    ...input.position,
    peakPnlPct: currentPnlPct,
    peakPnlRecordedAt: input.now,
  };
}

function sanitizePositionForTrailingEvaluation(input: {
  position: Position;
  now: string;
  policy: ManagementPolicy;
}): Position {
  if (input.policy.trailingTakeProfitEnabled !== true) {
    return input.position;
  }

  const currentPnlPct = tryDeriveFreshSnapshotPnlPct({
    position: input.position,
    now: input.now,
  });
  if (currentPnlPct !== null) {
    return input.position;
  }

  return {
    ...input.position,
    peakPnlPct: null,
    peakPnlRecordedAt: null,
  };
}

export type ManagementCycleResultStatus =
  | "NO_ACTION"
  | "RECONCILE_ONLY"
  | "DISPATCHED"
  | "DRY_RUN"
  | "BLOCKED_BY_RISK"
  | "SKIPPED_UNSUPPORTED";

export interface ManagementCyclePositionResult {
  positionId: string;
  managementAction: ManagementAction;
  status: ManagementCycleResultStatus;
  reason: string;
  triggerReasons: string[];
  actionId: string | null;
  riskResult: PortfolioRiskEvaluationResult | null;
  aiMode: UserConfig["ai"]["mode"];
  aiSource: "DISABLED" | "DETERMINISTIC" | "AI" | "FALLBACK";
  aiSuggestedAction: ManagementAction | null;
  aiReasoning: string | null;
}

export interface RunManagementCycleInput {
  wallet: string;
  actionQueue: ActionQueue;
  stateRepository: StateRepository;
  actionRepository: ActionRepository;
  journalRepository: JournalRepository;
  walletGateway: WalletGateway;
  priceGateway: PriceGateway;
  riskPolicy: PortfolioRiskPolicy;
  managementPolicy: ManagementPolicy;
  aiMode?: UserConfig["ai"]["mode"];
  dlmmGateway?: DlmmGateway;
  llmGateway?: LlmGateway;
  lessonPromptService?: LessonPromptService;
  aiTimeoutMs?: number;
  signalProvider: (input: {
    position: Position;
    portfolio: PortfolioState;
    now: string;
  }) => Promise<ManagementSignals> | ManagementSignals;
  poolMemoryRepository?: PoolMemoryRepository;
  runtimeControlStore?: RuntimeControlStore;
  poolMemorySnapshotsEnabled?: boolean;
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
  aiRebalancePlanner?: AiRebalancePlanner;
  requestedBy?: Actor;
  dryRun?: boolean;
  claimConfig?: {
    autoSwapAfterClaim: boolean;
    swapOutputMint: string;
    autoCompoundFees: boolean;
    compoundToSide: "base" | "quote";
  };
  previousPortfolioState?: PortfolioState | null;
  now?: () => string;
}

export interface RunManagementCycleResult {
  wallet: string;
  evaluatedAt: string;
  portfolioState: PortfolioState | null;
  positionResults: ManagementCyclePositionResult[];
}

const ACTIVE_WRITE_ACTION_STATUSES: Action["status"][] = [
  "QUEUED",
  "RUNNING",
  "WAITING_CONFIRMATION",
  "RECONCILING",
  "RETRY_QUEUED",
];

async function findActiveWriteActionForPosition(input: {
  actionRepository: ActionRepository;
  wallet: string;
  positionId: string;
}): Promise<Action | null> {
  const pendingActions = await input.actionRepository.listByStatuses(
    ACTIVE_WRITE_ACTION_STATUSES,
  );

  return (
    pendingActions.find(
      (action) =>
        action.wallet === input.wallet && action.positionId === input.positionId,
    ) ?? null
  );
}

async function appendJournalEvent(
  journalRepository: JournalRepository,
  event: {
    timestamp: string;
    eventType: string;
    actor: Actor;
    wallet: string;
    positionId: string | null;
    actionId: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    txIds: string[];
    resultStatus: string;
    error: string | null;
  },
): Promise<void> {
  await journalRepository.append(event);
}

function advisoryBypassForDeterministicResult(
  aiMode: UserConfig["ai"]["mode"],
): {
  source: "DISABLED" | "DETERMINISTIC";
  aiSuggestedAction: null;
  aiReasoning: null;
} {
  return {
    source: aiMode === "disabled" ? "DISABLED" : "DETERMINISTIC",
    aiSuggestedAction: null,
    aiReasoning: null,
  };
}

const missingLessonPromptService: LessonPromptService = {
  async buildLessonsPrompt(): Promise<string | null> {
    return null;
  },
};

function fallbackIncompleteSignals(): ManagementSignals {
  return {
    forcedManualClose: false,
    severeTokenRisk: false,
    liquidityCollapse: false,
    severeNegativeYield: false,
    claimableFeesUsd: 0,
    expectedRebalanceImprovement: false,
    dataIncomplete: true,
  };
}

export async function runManagementCycle(
  input: RunManagementCycleInput,
): Promise<RunManagementCycleResult> {
  const now = input.now?.() ?? new Date().toISOString();
  const requestedBy = input.requestedBy ?? "system";
  const aiMode = input.aiMode ?? "disabled";
  let previousPortfolioState = input.previousPortfolioState ?? null;
  const positions = (await input.stateRepository.list())
    .filter(
      (position) =>
        position.wallet === input.wallet && position.status === "OPEN",
    )
    .sort((left, right) => left.positionId.localeCompare(right.positionId));

  const positionResults: ManagementCyclePositionResult[] = [];

  for (const position of positions) {
    const managedPosition = maybeRefreshPeakPnl({
      position,
      now,
      policy: input.managementPolicy,
    });
    if (managedPosition !== position) {
      await input.stateRepository.upsert(managedPosition);
    }

    const portfolio = await buildPortfolioState({
      wallet: input.wallet,
      minReserveUsd: input.riskPolicy.minReserveUsd,
      dailyLossLimitPct: input.riskPolicy.dailyLossLimitPct,
      circuitBreakerCooldownMin: input.riskPolicy.circuitBreakerCooldownMin,
      stateRepository: input.stateRepository,
      actionRepository: input.actionRepository,
      journalRepository: input.journalRepository,
      walletGateway: input.walletGateway,
      priceGateway: input.priceGateway,
      previousPortfolioState,
      now,
    });
    previousPortfolioState = portfolio;
    const recentNewDeploys = await countRecentNewDeploys({
      wallet: input.wallet,
      actionRepository: input.actionRepository,
      now,
    });
    let signals: ManagementSignals;
    try {
      signals = await input.signalProvider({
        position: managedPosition,
        portfolio,
        now,
      });
    } catch (error) {
      await appendJournalEvent(input.journalRepository, {
        timestamp: now,
        eventType: "MANAGEMENT_SIGNAL_PROVIDER_FAILED",
        actor: requestedBy,
        wallet: input.wallet,
        positionId: managedPosition.positionId,
        actionId: null,
        before: null,
        after: null,
        txIds: [],
        resultStatus: "RECONCILE_ONLY",
        error:
          error instanceof Error ? error.message : "signal provider failed",
      });
      signals = fallbackIncompleteSignals();
    }
    if (
      input.poolMemoryRepository !== undefined &&
      input.poolMemorySnapshotsEnabled === true
    ) {
      await recordPoolSnapshot({
        poolMemoryRepository: input.poolMemoryRepository,
        ...(input.journalRepository === undefined
          ? {}
          : { journalRepository: input.journalRepository }),
        poolAddress: managedPosition.poolAddress,
        name: managedPosition.poolAddress,
        baseMint: managedPosition.baseMint,
        snapshot: {
          ts: now,
          positionId: managedPosition.positionId,
          pnlPct: deriveSnapshotPnlPct(managedPosition),
          pnlUsd: managedPosition.unrealizedPnlUsd,
          inRange: isPositionInRange(managedPosition),
          unclaimedFeesUsd: signals.claimableFeesUsd,
          minutesOutOfRange: diffMinutes(managedPosition.outOfRangeSince, now),
          ageMinutes: diffMinutes(managedPosition.openedAt, now),
        },
      });
    }
    const evaluation = evaluateManagementAction({
      now,
      position: sanitizePositionForTrailingEvaluation({
        position: managedPosition,
        now,
        policy: input.managementPolicy,
      }),
      portfolio,
      signals,
      policy: input.managementPolicy,
    });

    if (evaluation.action === "HOLD") {
      const aiAdvisory = advisoryBypassForDeterministicResult(aiMode);
      positionResults.push({
        positionId: managedPosition.positionId,
        managementAction: evaluation.action,
        status: "NO_ACTION",
        reason: evaluation.reason,
        triggerReasons: evaluation.triggerReasons,
        actionId: null,
        riskResult: null,
        aiMode,
        aiSource: aiAdvisory.source,
        aiSuggestedAction: aiAdvisory.aiSuggestedAction,
        aiReasoning: aiAdvisory.aiReasoning,
      });
      continue;
    }

    if (evaluation.action === "RECONCILE_ONLY") {
      const aiAdvisory = advisoryBypassForDeterministicResult(aiMode);
      positionResults.push({
        positionId: managedPosition.positionId,
        managementAction: evaluation.action,
        status: "RECONCILE_ONLY",
        reason: evaluation.reason,
        triggerReasons: evaluation.triggerReasons,
        actionId: null,
        riskResult: null,
        aiMode,
        aiSource: aiAdvisory.source,
        aiSuggestedAction: aiAdvisory.aiSuggestedAction,
        aiReasoning: aiAdvisory.aiReasoning,
      });
      continue;
    }

    const aiAdvisory = await adviseManagementDecision({
      aiMode,
      evaluation,
      position: managedPosition,
      triggerReasons: evaluation.triggerReasons,
      lessonPromptService:
        input.lessonPromptService ?? missingLessonPromptService,
      wallet: input.wallet,
      journalRepository: input.journalRepository,
      ...(input.llmGateway === undefined
        ? {}
        : { llmGateway: input.llmGateway }),
      ...(input.aiTimeoutMs === undefined
        ? {}
        : { timeoutMs: input.aiTimeoutMs }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });

    if (evaluation.action === "PARTIAL_CLOSE") {
      await appendJournalEvent(input.journalRepository, {
        timestamp: now,
        eventType: "MANAGEMENT_ACTION_UNSUPPORTED",
        actor: requestedBy,
        wallet: input.wallet,
        positionId: managedPosition.positionId,
        actionId: null,
        before: null,
        after: {
          action: evaluation.action,
          reason: evaluation.reason,
          triggerReasons: evaluation.triggerReasons,
        },
        txIds: [],
        resultStatus: "SKIPPED_UNSUPPORTED",
        error: null,
      });

      positionResults.push({
        positionId: managedPosition.positionId,
        managementAction: evaluation.action,
        status: "SKIPPED_UNSUPPORTED",
        reason: evaluation.reason,
        triggerReasons: evaluation.triggerReasons,
        actionId: null,
        riskResult: null,
        aiMode,
        aiSource: aiAdvisory.source,
        aiSuggestedAction: aiAdvisory.aiSuggestedAction,
        aiReasoning: aiAdvisory.aiReasoning,
      });
      continue;
    }

    if (evaluation.action === "CLAIM_FEES") {
      if (input.dryRun) {
        positionResults.push({
          positionId: managedPosition.positionId,
          managementAction: evaluation.action,
          status: "DRY_RUN",
          reason: evaluation.reason,
          triggerReasons: evaluation.triggerReasons,
          actionId: null,
          riskResult: null,
          aiMode,
          aiSource: aiAdvisory.source,
          aiSuggestedAction: aiAdvisory.aiSuggestedAction,
          aiReasoning: aiAdvisory.aiReasoning,
        });
        continue;
      }

      const activeWriteAction = await findActiveWriteActionForPosition({
        actionRepository: input.actionRepository,
        wallet: input.wallet,
        positionId: managedPosition.positionId,
      });
      if (activeWriteAction !== null) {
        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "MANAGEMENT_CLAIM_SKIPPED_PENDING_ACTION",
          actor: requestedBy,
          wallet: input.wallet,
          positionId: managedPosition.positionId,
          actionId: activeWriteAction.actionId,
          before: null,
          after: {
            action: evaluation.action,
            reason: evaluation.reason,
            triggerReasons: evaluation.triggerReasons,
            blockingActionId: activeWriteAction.actionId,
            blockingActionType: activeWriteAction.type,
            blockingActionStatus: activeWriteAction.status,
          },
          txIds: activeWriteAction.txIds,
          resultStatus: "BLOCKED_BY_RISK",
          error: "wallet already has an active write action",
        });

        positionResults.push({
          positionId: managedPosition.positionId,
          managementAction: evaluation.action,
          status: "BLOCKED_BY_RISK",
          reason: "wallet already has an active write action",
          triggerReasons: [
            ...evaluation.triggerReasons,
            "wallet already has an active write action",
          ],
          actionId: null,
          riskResult: null,
          aiMode,
          aiSource: aiAdvisory.source,
          aiSuggestedAction: aiAdvisory.aiSuggestedAction,
          aiReasoning: aiAdvisory.aiReasoning,
        });
        continue;
      }

      const action = await requestClaimFees({
        actionQueue: input.actionQueue,
        stateRepository: input.stateRepository,
        wallet: input.wallet,
        positionId: managedPosition.positionId,
        payload: {
          reason: evaluation.reason,
          ...(input.claimConfig?.autoCompoundFees === true
            ? {
                autoCompound: {
                  outputMint:
                    input.claimConfig.compoundToSide === "base"
                      ? managedPosition.baseMint
                      : managedPosition.quoteMint,
                },
              }
            : {}),
          ...(input.claimConfig?.autoCompoundFees !== true &&
          input.claimConfig?.autoSwapAfterClaim === true
            ? { autoSwapOutputMint: input.claimConfig.swapOutputMint }
            : {}),
        },
        requestedBy,
        requestedAt: now,
        ...(input.journalRepository === undefined
          ? {}
          : { journalRepository: input.journalRepository }),
      });

      positionResults.push({
        positionId: managedPosition.positionId,
        managementAction: evaluation.action,
        status: "DISPATCHED",
        reason: evaluation.reason,
        triggerReasons: evaluation.triggerReasons,
        actionId: action.actionId,
        riskResult: null,
        aiMode,
        aiSource: aiAdvisory.source,
        aiSuggestedAction: aiAdvisory.aiSuggestedAction,
        aiReasoning: aiAdvisory.aiReasoning,
      });
      continue;
    }

    if (evaluation.action === "CLOSE") {
      if (input.dryRun) {
        positionResults.push({
          positionId: managedPosition.positionId,
          managementAction: evaluation.action,
          status: "DRY_RUN",
          reason: evaluation.reason,
          triggerReasons: evaluation.triggerReasons,
          actionId: null,
          riskResult: null,
          aiMode,
          aiSource: aiAdvisory.source,
          aiSuggestedAction: aiAdvisory.aiSuggestedAction,
          aiReasoning: aiAdvisory.aiReasoning,
        });
        continue;
      }

      const activeWriteAction = await findActiveWriteActionForPosition({
        actionRepository: input.actionRepository,
        wallet: input.wallet,
        positionId: managedPosition.positionId,
      });
      if (activeWriteAction !== null) {
        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "MANAGEMENT_CLOSE_SKIPPED_PENDING_ACTION",
          actor: requestedBy,
          wallet: input.wallet,
          positionId: managedPosition.positionId,
          actionId: activeWriteAction.actionId,
          before: null,
          after: {
            action: evaluation.action,
            reason: evaluation.reason,
            triggerReasons: evaluation.triggerReasons,
            blockingActionId: activeWriteAction.actionId,
            blockingActionType: activeWriteAction.type,
            blockingActionStatus: activeWriteAction.status,
          },
          txIds: activeWriteAction.txIds,
          resultStatus: "BLOCKED_BY_RISK",
          error: "wallet already has an active write action",
        });

        positionResults.push({
          positionId: managedPosition.positionId,
          managementAction: evaluation.action,
          status: "BLOCKED_BY_RISK",
          reason: "wallet already has an active write action",
          triggerReasons: [
            ...evaluation.triggerReasons,
            "wallet already has an active write action",
          ],
          actionId: null,
          riskResult: null,
          aiMode,
          aiSource: aiAdvisory.source,
          aiSuggestedAction: aiAdvisory.aiSuggestedAction,
          aiReasoning: aiAdvisory.aiReasoning,
        });
        continue;
      }

      const action = await requestClose({
        actionQueue: input.actionQueue,
        stateRepository: input.stateRepository,
        wallet: input.wallet,
        positionId: managedPosition.positionId,
        payload: {
          reason: evaluation.reason,
        },
        requestedBy,
        requestedAt: now,
        ...(input.journalRepository === undefined
          ? {}
          : { journalRepository: input.journalRepository }),
      });

      positionResults.push({
        positionId: managedPosition.positionId,
        managementAction: evaluation.action,
        status: "DISPATCHED",
        reason: evaluation.reason,
        triggerReasons: evaluation.triggerReasons,
        actionId: action.actionId,
        riskResult: null,
        aiMode,
        aiSource: aiAdvisory.source,
        aiSuggestedAction: aiAdvisory.aiSuggestedAction,
        aiReasoning: aiAdvisory.aiReasoning,
      });
      continue;
    }

    let aiRebalanceReview: Awaited<
      ReturnType<typeof reviewRebalanceWithAi>
    > | null = null;
    let aiRebalanceReviewInput: RebalanceReviewInput | null = null;
    if (
      evaluation.action === "REBALANCE" &&
      input.managementPolicy.aiRebalanceEnabled === true
    ) {
      const aiRebalanceMode =
        input.managementPolicy.aiRebalanceMode ?? "advisory";
      const llmRebalancePlanner =
        input.llmGateway?.reviewRebalanceDecision === undefined
          ? undefined
          : ({
              reviewRebalanceDecision:
                input.llmGateway.reviewRebalanceDecision.bind(input.llmGateway),
            } satisfies AiRebalancePlanner);
      const plannerForReview = input.aiRebalancePlanner ?? llmRebalancePlanner;
      let rebalancePoolInfo: PoolInfo | undefined;
      if (input.dlmmGateway !== undefined) {
        try {
          rebalancePoolInfo = await input.dlmmGateway.getPoolInfo(
            managedPosition.poolAddress,
          );
        } catch {
          rebalancePoolInfo = undefined;
        }
      }
      const rebalanceReviewInput = buildRebalanceReviewInput({
        position: managedPosition,
        portfolio,
        signals,
        evaluation,
        riskPolicy: input.riskPolicy,
        managementPolicy: input.managementPolicy,
        ...(rebalancePoolInfo === undefined
          ? {}
          : { poolInfo: rebalancePoolInfo }),
        now,
      });
      aiRebalanceReviewInput = rebalanceReviewInput;
      aiRebalanceReview = await reviewRebalanceWithAi({
        wallet: input.wallet,
        positionId: managedPosition.positionId,
        mode: aiRebalanceMode,
        review: rebalanceReviewInput,
        ...(plannerForReview === undefined
          ? {}
          : { planner: plannerForReview }),
        validationPolicy: {
          minAiRebalanceConfidence:
            input.managementPolicy.minAiRebalanceConfidence ?? 0.78,
          maxRebalancesPerPosition:
            input.managementPolicy.maxRebalancesPerPosition,
          minPositionAgeMinutesBeforeRebalance:
            input.managementPolicy.minPositionAgeMinutesBeforeRebalance ?? 8,
          rebalanceCooldownMinutes:
            input.managementPolicy.rebalanceCooldownMinutes ?? 20,
          maxOutOfRangeMinutes: input.managementPolicy.maxOutOfRangeMinutes,
          rebalanceEdgeThresholdPct:
            input.managementPolicy.rebalanceEdgeThresholdPct ?? 0.1,
          maxRebalanceBinsBelow:
            input.managementPolicy.maxRebalanceBinsBelow ?? 90,
          maxRebalanceBinsAbove:
            input.managementPolicy.maxRebalanceBinsAbove ?? 90,
          maxRebalanceSlippageBps:
            input.managementPolicy.maxRebalanceSlippageBps ?? 150,
          requireFreshActiveBin:
            input.managementPolicy.requireFreshActiveBin ?? true,
          maxActiveBinDrift: input.managementPolicy.maxActiveBinDrift ?? 3,
          requireRebalanceSimulation: false,
          exitInsteadOfRebalanceWhenRiskHigh:
            input.managementPolicy.exitInsteadOfRebalanceWhenRiskHigh ?? true,
          minTvlUsd: input.managementPolicy.minRebalancePoolTvlUsd ?? 0,
        },
        lessonPromptService:
          input.lessonPromptService ?? missingLessonPromptService,
        journalRepository: input.journalRepository,
        actor: requestedBy,
        now,
      });

      if (aiRebalanceMode === "dry_run") {
        positionResults.push({
          positionId: managedPosition.positionId,
          managementAction: evaluation.action,
          status: "DRY_RUN",
          reason: `AI rebalance dry-run action: ${aiRebalanceReview.validation.action}`,
          triggerReasons: [
            ...evaluation.triggerReasons,
            ...aiRebalanceReview.validation.reasonCodes,
          ],
          actionId: null,
          riskResult: null,
          aiMode,
          aiSource: aiAdvisory.source,
          aiSuggestedAction: aiAdvisory.aiSuggestedAction,
          aiReasoning: aiAdvisory.aiReasoning,
        });
        continue;
      }

      if (aiRebalanceMode === "constrained_action") {
        if (!aiRebalanceReview.validation.allowed) {
          positionResults.push({
            positionId: managedPosition.positionId,
            managementAction: evaluation.action,
            status: "BLOCKED_BY_RISK",
            reason: "AI rebalance decision blocked by validator",
            triggerReasons: [
              ...evaluation.triggerReasons,
              ...aiRebalanceReview.validation.reasonCodes,
            ],
            actionId: null,
            riskResult: null,
            aiMode,
            aiSource: aiAdvisory.source,
            aiSuggestedAction: aiAdvisory.aiSuggestedAction,
            aiReasoning: aiAdvisory.aiReasoning,
          });
          continue;
        }

        if (aiRebalanceReview.validation.action === "hold") {
          positionResults.push({
            positionId: managedPosition.positionId,
            managementAction: "HOLD",
            status: "NO_ACTION",
            reason: "AI rebalance planner selected hold",
            triggerReasons: aiRebalanceReview.validation.reasonCodes,
            actionId: null,
            riskResult: null,
            aiMode,
            aiSource: aiAdvisory.source,
            aiSuggestedAction: aiAdvisory.aiSuggestedAction,
            aiReasoning: aiAdvisory.aiReasoning,
          });
          continue;
        }

        if (aiRebalanceReview.validation.action === "claim_only") {
          if (input.dryRun) {
            positionResults.push({
              positionId: managedPosition.positionId,
              managementAction: "CLAIM_FEES",
              status: "DRY_RUN",
              reason: "AI rebalance planner selected claim only",
              triggerReasons: aiRebalanceReview.validation.reasonCodes,
              actionId: null,
              riskResult: null,
              aiMode,
              aiSource: aiAdvisory.source,
              aiSuggestedAction: aiAdvisory.aiSuggestedAction,
              aiReasoning: aiAdvisory.aiReasoning,
            });
            continue;
          }

          const activeWriteAction = await findActiveWriteActionForPosition({
            actionRepository: input.actionRepository,
            wallet: input.wallet,
            positionId: managedPosition.positionId,
          });
          if (activeWriteAction !== null) {
            await appendJournalEvent(input.journalRepository, {
              timestamp: now,
              eventType: "MANAGEMENT_CLAIM_SKIPPED_PENDING_ACTION",
              actor: requestedBy,
              wallet: input.wallet,
              positionId: managedPosition.positionId,
              actionId: activeWriteAction.actionId,
              before: null,
              after: {
                action: "CLAIM_FEES",
                reason: "AI rebalance planner selected claim only",
                triggerReasons: aiRebalanceReview.validation.reasonCodes,
                blockingActionId: activeWriteAction.actionId,
                blockingActionType: activeWriteAction.type,
                blockingActionStatus: activeWriteAction.status,
              },
              txIds: activeWriteAction.txIds,
              resultStatus: "BLOCKED_BY_RISK",
              error: "wallet already has an active write action",
            });
            positionResults.push({
              positionId: managedPosition.positionId,
              managementAction: "CLAIM_FEES",
              status: "BLOCKED_BY_RISK",
              reason: "wallet already has an active write action",
              triggerReasons: [
                ...aiRebalanceReview.validation.reasonCodes,
                "wallet already has an active write action",
              ],
              actionId: null,
              riskResult: null,
              aiMode,
              aiSource: aiAdvisory.source,
              aiSuggestedAction: aiAdvisory.aiSuggestedAction,
              aiReasoning: aiAdvisory.aiReasoning,
            });
            continue;
          }

          const action = await requestClaimFees({
            actionQueue: input.actionQueue,
            stateRepository: input.stateRepository,
            wallet: input.wallet,
            positionId: managedPosition.positionId,
            payload: {
              reason: "AI rebalance planner selected claim only",
            },
            requestedBy,
            requestedAt: now,
            ...(input.journalRepository === undefined
              ? {}
              : { journalRepository: input.journalRepository }),
          });
          positionResults.push({
            positionId: managedPosition.positionId,
            managementAction: "CLAIM_FEES",
            status: "DISPATCHED",
            reason: "AI rebalance planner selected claim only",
            triggerReasons: aiRebalanceReview.validation.reasonCodes,
            actionId: action.actionId,
            riskResult: null,
            aiMode,
            aiSource: aiAdvisory.source,
            aiSuggestedAction: aiAdvisory.aiSuggestedAction,
            aiReasoning: aiAdvisory.aiReasoning,
          });
          continue;
        }

        if (aiRebalanceReview.validation.action === "exit") {
          if (input.dryRun) {
            positionResults.push({
              positionId: managedPosition.positionId,
              managementAction: "CLOSE",
              status: "DRY_RUN",
              reason: "AI rebalance planner selected exit",
              triggerReasons: aiRebalanceReview.validation.reasonCodes,
              actionId: null,
              riskResult: null,
              aiMode,
              aiSource: aiAdvisory.source,
              aiSuggestedAction: aiAdvisory.aiSuggestedAction,
              aiReasoning: aiAdvisory.aiReasoning,
            });
            continue;
          }

          const activeWriteAction = await findActiveWriteActionForPosition({
            actionRepository: input.actionRepository,
            wallet: input.wallet,
            positionId: managedPosition.positionId,
          });
          if (activeWriteAction !== null) {
            await appendJournalEvent(input.journalRepository, {
              timestamp: now,
              eventType: "MANAGEMENT_CLOSE_SKIPPED_PENDING_ACTION",
              actor: requestedBy,
              wallet: input.wallet,
              positionId: managedPosition.positionId,
              actionId: activeWriteAction.actionId,
              before: null,
              after: {
                action: "CLOSE",
                reason: "AI rebalance planner selected exit",
                triggerReasons: aiRebalanceReview.validation.reasonCodes,
                blockingActionId: activeWriteAction.actionId,
                blockingActionType: activeWriteAction.type,
                blockingActionStatus: activeWriteAction.status,
              },
              txIds: activeWriteAction.txIds,
              resultStatus: "BLOCKED_BY_RISK",
              error: "wallet already has an active write action",
            });
            positionResults.push({
              positionId: managedPosition.positionId,
              managementAction: "CLOSE",
              status: "BLOCKED_BY_RISK",
              reason: "wallet already has an active write action",
              triggerReasons: [
                ...aiRebalanceReview.validation.reasonCodes,
                "wallet already has an active write action",
              ],
              actionId: null,
              riskResult: null,
              aiMode,
              aiSource: aiAdvisory.source,
              aiSuggestedAction: aiAdvisory.aiSuggestedAction,
              aiReasoning: aiAdvisory.aiReasoning,
            });
            continue;
          }

          const action = await requestClose({
            actionQueue: input.actionQueue,
            stateRepository: input.stateRepository,
            wallet: input.wallet,
            positionId: managedPosition.positionId,
            payload: {
              reason: "AI rebalance planner selected exit",
            },
            requestedBy,
            requestedAt: now,
            ...(input.journalRepository === undefined
              ? {}
              : { journalRepository: input.journalRepository }),
          });
          positionResults.push({
            positionId: managedPosition.positionId,
            managementAction: "CLOSE",
            status: "DISPATCHED",
            reason: "AI rebalance planner selected exit",
            triggerReasons: aiRebalanceReview.validation.reasonCodes,
            actionId: action.actionId,
            riskResult: null,
            aiMode,
            aiSource: aiAdvisory.source,
            aiSuggestedAction: aiAdvisory.aiSuggestedAction,
            aiReasoning: aiAdvisory.aiReasoning,
          });
          continue;
        }
      }
    }

    const rebalancePayload =
      input.rebalancePlanner === undefined
        ? null
        : await input.rebalancePlanner({
            position: managedPosition,
            portfolio,
            now,
            evaluation,
            signals,
            ...(aiRebalanceReview === null ||
            (input.managementPolicy.aiRebalanceMode ?? "advisory") !==
              "constrained_action"
              ? {}
              : { aiRebalanceDecision: aiRebalanceReview.validation }),
          });

    if (rebalancePayload === null) {
      await appendJournalEvent(input.journalRepository, {
        timestamp: now,
        eventType: "MANAGEMENT_REBALANCE_SKIPPED",
        actor: requestedBy,
        wallet: input.wallet,
        positionId: managedPosition.positionId,
        actionId: null,
        before: null,
        after: {
          action: evaluation.action,
          reason: evaluation.reason,
          triggerReasons: evaluation.triggerReasons,
        },
        txIds: [],
        resultStatus: "SKIPPED_UNSUPPORTED",
        error: null,
      });

      positionResults.push({
        positionId: managedPosition.positionId,
        managementAction: evaluation.action,
        status: "SKIPPED_UNSUPPORTED",
        reason: evaluation.reason,
        triggerReasons: evaluation.triggerReasons,
        actionId: null,
        riskResult: null,
        aiMode,
        aiSource: aiAdvisory.source,
        aiSuggestedAction: aiAdvisory.aiSuggestedAction,
        aiReasoning: aiAdvisory.aiReasoning,
      });
      continue;
    }

    if (
      aiRebalanceReview !== null &&
      aiRebalanceReviewInput !== null &&
      aiRebalanceReview.validation.action === "rebalance_same_pool"
    ) {
      const freshActiveBin = rebalancePayload.redeploy.initialActiveBin;
      const aiSnapshotActiveBin = aiRebalanceReviewInput.pool.currentActiveBin;
      const maxActiveBinDrift = input.managementPolicy.maxActiveBinDrift ?? 3;
      const freshActiveBinDrift =
        freshActiveBin === null || aiSnapshotActiveBin === null
          ? null
          : Math.abs(freshActiveBin - aiSnapshotActiveBin);

      if (
        freshActiveBin === null ||
        aiSnapshotActiveBin === null ||
        freshActiveBinDrift === null ||
        freshActiveBinDrift > maxActiveBinDrift
      ) {
        const reason = "rebalance_fresh_active_bin_drift_above_limit";
        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "REBALANCE_DECISION_VALIDATED",
          actor: requestedBy,
          wallet: input.wallet,
          positionId: managedPosition.positionId,
          actionId: null,
          before: null,
          after: {
            allowed: false,
            action: "rebalance_same_pool",
            reasonCodes: [reason],
            riskFlags: [reason],
            rebalancePlan: aiRebalanceReview.validation.rebalancePlan,
            freshActiveBin,
            aiSnapshotActiveBin,
            freshActiveBinDrift,
            maxActiveBinDrift,
          },
          txIds: [],
          resultStatus: "BLOCKED",
          error: reason,
        });

        positionResults.push({
          positionId: managedPosition.positionId,
          managementAction: evaluation.action,
          status: "BLOCKED_BY_RISK",
          reason: "AI rebalance fresh active bin drift exceeded limit",
          triggerReasons: [...evaluation.triggerReasons, reason],
          actionId: null,
          riskResult: null,
          aiMode,
          aiSource: aiAdvisory.source,
          aiSuggestedAction: aiAdvisory.aiSuggestedAction,
          aiReasoning: aiAdvisory.aiReasoning,
        });
        continue;
      }
    }

    if (
      aiRebalanceReview !== null &&
      aiRebalanceReviewInput !== null &&
      aiRebalanceReview.validation.action === "rebalance_same_pool" &&
      (input.managementPolicy.requireRebalanceSimulation ?? true)
    ) {
      const closeSimulation =
        input.dlmmGateway === undefined
          ? { ok: false, reason: "DLMM gateway simulation is not wired" }
          : await input.dlmmGateway.simulateClosePosition({
              wallet: input.wallet,
              positionId: managedPosition.positionId,
              reason: rebalancePayload.reason,
            });
      const redeploySimulation =
        input.dlmmGateway === undefined
          ? { ok: false, reason: "DLMM gateway simulation is not wired" }
          : await input.dlmmGateway.simulateDeployLiquidity({
              wallet: input.wallet,
              poolAddress: rebalancePayload.redeploy.poolAddress,
              tokenXMint: rebalancePayload.redeploy.tokenXMint,
              tokenYMint: rebalancePayload.redeploy.tokenYMint,
              baseMint: rebalancePayload.redeploy.baseMint,
              quoteMint: rebalancePayload.redeploy.quoteMint,
              amountBase: rebalancePayload.redeploy.amountBase,
              amountQuote: rebalancePayload.redeploy.amountQuote,
              slippageBps: rebalancePayload.redeploy.slippageBps,
              strategy: rebalancePayload.redeploy.strategy,
              rangeLowerBin: rebalancePayload.redeploy.rangeLowerBin,
              rangeUpperBin: rebalancePayload.redeploy.rangeUpperBin,
              initialActiveBin: rebalancePayload.redeploy.initialActiveBin,
            });
      const simulationValidation = validateRebalanceDecision({
        decision: aiRebalanceReview.decision,
        review: aiRebalanceReviewInput,
        policy: {
          minAiRebalanceConfidence:
            input.managementPolicy.minAiRebalanceConfidence ?? 0.78,
          maxRebalancesPerPosition:
            input.managementPolicy.maxRebalancesPerPosition,
          minPositionAgeMinutesBeforeRebalance:
            input.managementPolicy.minPositionAgeMinutesBeforeRebalance ?? 8,
          rebalanceCooldownMinutes:
            input.managementPolicy.rebalanceCooldownMinutes ?? 20,
          maxOutOfRangeMinutes: input.managementPolicy.maxOutOfRangeMinutes,
          rebalanceEdgeThresholdPct:
            input.managementPolicy.rebalanceEdgeThresholdPct ?? 0.1,
          maxRebalanceBinsBelow:
            input.managementPolicy.maxRebalanceBinsBelow ?? 90,
          maxRebalanceBinsAbove:
            input.managementPolicy.maxRebalanceBinsAbove ?? 90,
          maxRebalanceSlippageBps:
            input.managementPolicy.maxRebalanceSlippageBps ?? 150,
          requireFreshActiveBin:
            input.managementPolicy.requireFreshActiveBin ?? true,
          maxActiveBinDrift: input.managementPolicy.maxActiveBinDrift ?? 3,
          requireRebalanceSimulation: true,
          exitInsteadOfRebalanceWhenRiskHigh:
            input.managementPolicy.exitInsteadOfRebalanceWhenRiskHigh ?? true,
          minTvlUsd: input.managementPolicy.minRebalancePoolTvlUsd ?? 0,
          closeSimulationPassed: closeSimulation.ok,
          redeploySimulationPassed: redeploySimulation.ok,
        },
      });
      aiRebalanceReview = {
        ...aiRebalanceReview,
        validation: simulationValidation,
      };

      await appendJournalEvent(input.journalRepository, {
        timestamp: now,
        eventType: "REBALANCE_PREFLIGHT_SIMULATED",
        actor: requestedBy,
        wallet: input.wallet,
        positionId: managedPosition.positionId,
        actionId: null,
        before: null,
        after: {
          closeSimulation,
          redeploySimulation,
          validation: simulationValidation,
        },
        txIds: [],
        resultStatus: simulationValidation.allowed ? "PASSED" : "BLOCKED",
        error: simulationValidation.allowed
          ? null
          : [
              closeSimulation.ok ? null : closeSimulation.reason,
              redeploySimulation.ok ? null : redeploySimulation.reason,
            ]
              .filter((reason): reason is string => reason !== null)
              .join("; "),
      });

      if (!simulationValidation.allowed) {
        positionResults.push({
          positionId: managedPosition.positionId,
          managementAction: evaluation.action,
          status: "BLOCKED_BY_RISK",
          reason: "AI rebalance preflight simulation failed",
          triggerReasons: [
            ...evaluation.triggerReasons,
            ...simulationValidation.reasonCodes,
          ],
          actionId: null,
          riskResult: null,
          aiMode,
          aiSource: aiAdvisory.source,
          aiSuggestedAction: aiAdvisory.aiSuggestedAction,
          aiReasoning: aiAdvisory.aiReasoning,
        });
        continue;
      }
    }

    if (
      input.runtimeControlStore !== undefined &&
      (await input.runtimeControlStore.snapshot()).stopAllDeploys.active
    ) {
      const baseRiskResult = evaluatePortfolioRisk({
        action: "REBALANCE",
        portfolio,
        policy: input.riskPolicy,
        proposedAllocationUsd: deriveRebalanceCapitalRequirement(
          rebalancePayload.redeploy,
        ),
        proposedPoolAddress: rebalancePayload.redeploy.poolAddress,
        proposedTokenMints: proposedTokenMints(rebalancePayload),
        recentNewDeploys,
        position: managedPosition,
      });
      const riskResult: PortfolioRiskEvaluationResult = {
        ...baseRiskResult,
        allowed: false,
        decision: "BLOCK",
        reason: "manual circuit breaker is active",
        blockingRules: ["manual circuit breaker is active"],
      };
      positionResults.push({
        positionId: managedPosition.positionId,
        managementAction: evaluation.action,
        status: "BLOCKED_BY_RISK",
        reason: evaluation.reason,
        triggerReasons: evaluation.triggerReasons,
        actionId: null,
        riskResult,
        aiMode,
        aiSource: aiAdvisory.source,
        aiSuggestedAction: aiAdvisory.aiSuggestedAction,
        aiReasoning: aiAdvisory.aiReasoning,
      });
      continue;
    }

    const riskResult = evaluatePortfolioRisk({
      action: "REBALANCE",
      portfolio,
      policy: input.riskPolicy,
      proposedAllocationUsd: deriveRebalanceCapitalRequirement(
        rebalancePayload.redeploy,
      ),
      proposedPoolAddress: rebalancePayload.redeploy.poolAddress,
      proposedTokenMints: proposedTokenMints(rebalancePayload),
      recentNewDeploys,
      position: managedPosition,
    });

    if (!riskResult.allowed) {
      positionResults.push({
        positionId: managedPosition.positionId,
        managementAction: evaluation.action,
        status: "BLOCKED_BY_RISK",
        reason: evaluation.reason,
        triggerReasons: evaluation.triggerReasons,
        actionId: null,
        riskResult,
        aiMode,
        aiSource: aiAdvisory.source,
        aiSuggestedAction: aiAdvisory.aiSuggestedAction,
        aiReasoning: aiAdvisory.aiReasoning,
      });
      continue;
    }

    if (input.dryRun) {
      positionResults.push({
        positionId: managedPosition.positionId,
        managementAction: evaluation.action,
        status: "DRY_RUN",
        reason: evaluation.reason,
        triggerReasons: evaluation.triggerReasons,
        actionId: null,
        riskResult,
        aiMode,
        aiSource: aiAdvisory.source,
        aiSuggestedAction: aiAdvisory.aiSuggestedAction,
        aiReasoning: aiAdvisory.aiReasoning,
      });
      continue;
    }

    const action = await requestRebalance({
      actionQueue: input.actionQueue,
      stateRepository: input.stateRepository,
      wallet: input.wallet,
      positionId: managedPosition.positionId,
      payload: rebalancePayload,
      requestedBy,
      requestedAt: now,
      ...(input.journalRepository === undefined
        ? {}
        : { journalRepository: input.journalRepository }),
      ...(input.runtimeControlStore === undefined
        ? {}
        : { runtimeControlStore: input.runtimeControlStore }),
      riskGuard: {
        portfolio,
        policy: input.riskPolicy,
      },
    });

    positionResults.push({
      positionId: managedPosition.positionId,
      managementAction: evaluation.action,
      status: "DISPATCHED",
      reason: evaluation.reason,
      triggerReasons: evaluation.triggerReasons,
      actionId: action.actionId,
      riskResult,
      aiMode,
      aiSource: aiAdvisory.source,
      aiSuggestedAction: aiAdvisory.aiSuggestedAction,
      aiReasoning: aiAdvisory.aiReasoning,
    });
  }

  return {
    wallet: input.wallet,
    evaluatedAt: now,
    portfolioState: previousPortfolioState,
    positionResults,
  };
}
