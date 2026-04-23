import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import type { RuntimeControlStore } from "../../adapters/storage/RuntimeControlStore.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { PriceGateway } from "../../adapters/pricing/PriceGateway.js";
import type { WalletGateway } from "../../adapters/wallet/WalletGateway.js";
import type { LlmGateway } from "../../adapters/llm/LlmGateway.js";
import type { Position } from "../../domain/entities/Position.js";
import type { PortfolioState } from "../../domain/entities/PortfolioState.js";
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
import type { Actor, ManagementAction } from "../../domain/types/enums.js";
import type { UserConfig } from "../../infra/config/configSchema.js";
import type { ActionQueue } from "../services/ActionQueue.js";
import { adviseManagementDecision } from "../services/AiAdvisoryService.js";
import { type LessonPromptService } from "../services/LessonPromptService.js";
import { buildPortfolioState } from "../services/PortfolioStateBuilder.js";
import { countRecentNewDeploys } from "../services/RecentDeployCounter.js";

import { recordPoolSnapshot } from "./recordPoolSnapshot.js";
import { requestClose } from "./requestClose.js";
import { requestClaimFees } from "./requestClaimFees.js";
import {
  deriveRebalanceCapitalRequirement,
  requestRebalance,
  type RebalanceActionRequestPayload,
} from "./requestRebalance.js";

function proposedTokenMints(payload: RebalanceActionRequestPayload): string[] {
  return [...new Set([
    payload.redeploy.baseMint,
    payload.redeploy.quoteMint,
  ])];
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

  const estimatedInitialValueUsd = position.currentValueUsd - position.unrealizedPnlUsd;
  if (!Number.isFinite(estimatedInitialValueUsd) || estimatedInitialValueUsd <= 0) {
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
  }) =>
    | Promise<RebalanceActionRequestPayload | null>
    | RebalanceActionRequestPayload
    | null;
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
    throw new Error("LessonPromptService is required for AI advisory");
  },
};

export async function runManagementCycle(
  input: RunManagementCycleInput,
): Promise<RunManagementCycleResult> {
  const now = input.now?.() ?? new Date().toISOString();
  const requestedBy = input.requestedBy ?? "system";
  const aiMode = input.aiMode ?? "disabled";
  let previousPortfolioState = input.previousPortfolioState ?? null;
  const positions = (await input.stateRepository.list())
    .filter(
      (position) => position.wallet === input.wallet && position.status === "OPEN",
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
    const signals = await input.signalProvider({
      position: managedPosition,
      portfolio,
      now,
    });
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
      ...(input.llmGateway === undefined ? {} : { llmGateway: input.llmGateway }),
      ...(input.aiTimeoutMs === undefined ? {} : { timeoutMs: input.aiTimeoutMs }),
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

    const rebalancePayload =
      input.rebalancePlanner === undefined
        ? null
        : await input.rebalancePlanner({
            position: managedPosition,
            portfolio,
            now,
            evaluation,
            signals,
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
      input.runtimeControlStore !== undefined &&
      (await input.runtimeControlStore.snapshot()).stopAllDeploys.active
    ) {
      const baseRiskResult = evaluatePortfolioRisk({
        action: "REBALANCE",
        portfolio,
        policy: input.riskPolicy,
        proposedAllocationUsd:
          deriveRebalanceCapitalRequirement(rebalancePayload.redeploy),
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
      proposedAllocationUsd:
        deriveRebalanceCapitalRequirement(rebalancePayload.redeploy),
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
