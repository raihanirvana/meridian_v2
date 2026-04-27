import { z } from "zod";

import {
  DeployLiquidityResultSchema,
  type DlmmGateway,
} from "../../adapters/dlmm/DlmmGateway.js";
import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { PerformanceRepositoryInterface } from "../../adapters/storage/PerformanceRepository.js";
import type { RuntimeControlStore } from "../../adapters/storage/RuntimeControlStore.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { Action } from "../../domain/entities/Action.js";
import type { JournalEvent } from "../../domain/entities/JournalEvent.js";
import {
  PositionSchema,
  type Position,
} from "../../domain/entities/Position.js";
import { transitionActionStatus } from "../../domain/stateMachines/actionLifecycle.js";
import { transitionPositionStatus } from "../../domain/stateMachines/positionLifecycle.js";
import { type ReconciliationOutcome } from "../../domain/types/enums.js";
import { PositionLock } from "../../infra/locks/positionLock.js";
import { WalletLock } from "../../infra/locks/walletLock.js";

import {
  finalizeRebalance,
  RebalanceActionResultPayloadSchema,
  type FinalizeRebalanceResult,
} from "./finalizeRebalance.js";
import {
  finalizeClose,
  runLessonHookIdempotent,
  type LessonHook,
  type PostCloseSwapHook,
} from "./finalizeClose.js";
import { CloseActionRequestPayloadSchema } from "./requestClose.js";
import { RebalanceActionRequestPayloadSchema } from "./requestRebalance.js";
import {
  finalizeClaimFees,
  type CompoundDeployRiskGuard,
  type PostClaimSwapHook,
} from "./finalizeClaimFees.js";
import { confirmDeployAction } from "./processDeployAction.js";
import type { ActionQueue } from "../services/ActionQueue.js";

const TRACKED_SNAPSHOT_STATUSES = new Set<Position["status"]>([
  "DEPLOY_REQUESTED",
  "DEPLOYING",
  "OPEN",
  "MANAGEMENT_REVIEW",
  "HOLD",
  "CLAIM_REQUESTED",
  "CLAIMING",
  "CLAIM_CONFIRMED",
  "PARTIAL_CLOSE_REQUESTED",
  "PARTIAL_CLOSING",
  "PARTIAL_CLOSE_CONFIRMED",
  "REBALANCE_REQUESTED",
  "CLOSING_FOR_REBALANCE",
  "CLOSE_REQUESTED",
  "CLOSING",
  "CLOSE_CONFIRMED",
  "REDEPLOY_REQUESTED",
  "REDEPLOYING",
  "RECONCILIATION_REQUIRED",
  "RECONCILING",
]);

const LEARNING_RECOVERY_STATUSES = new Set<Action["status"]>([
  "DONE",
  "FAILED",
  "TIMED_OUT",
  "ABORTED",
]);

export interface ReconciliationRecord {
  scope: "ACTION" | "POSITION";
  entityId: string;
  wallet: string;
  positionId: string | null;
  actionId: string | null;
  outcome: ReconciliationOutcome;
  detail: string;
}

export interface ReconcilePortfolioInput {
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  dlmmGateway: DlmmGateway;
  actionQueue?: ActionQueue;
  journalRepository?: JournalRepository;
  performanceRepository?: PerformanceRepositoryInterface;
  runtimeControlStore?: RuntimeControlStore;
  walletLock?: WalletLock;
  positionLock?: PositionLock;
  now?: () => string;
  wallets?: string[];
  postCloseSwapHook?: PostCloseSwapHook;
  lessonHook?: LessonHook;
  postClaimSwapHook?: PostClaimSwapHook;
  claimCompoundRiskGuardProvider?: (input: {
    wallet: string;
    now: string;
  }) => Promise<CompoundDeployRiskGuard> | CompoundDeployRiskGuard;
  dryRun?: boolean;
}

export interface ReconcilePortfolioResult {
  records: ReconciliationRecord[];
}

interface RecoverReconcilingActionInput {
  action: Action;
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  dlmmGateway: DlmmGateway;
  actionQueue?: ActionQueue;
  journalRepository?: JournalRepository;
  runtimeControlStore?: RuntimeControlStore;
  postClaimSwapHook?: PostClaimSwapHook;
  lessonHook?: LessonHook;
  claimCompoundRiskGuardProvider?: ReconcilePortfolioInput["claimCompoundRiskGuardProvider"];
  walletLock: WalletLock;
  positionLock: PositionLock;
  now: string;
}

function nowTimestamp(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function toJournalRecord(value: unknown): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(JSON.stringify(value)));
}

async function appendJournalEvent(
  journalRepository: JournalRepository | undefined,
  event: JournalEvent,
): Promise<void> {
  if (journalRepository === undefined) {
    return;
  }

  await journalRepository.append(event);
}

function createRecord(input: ReconciliationRecord): ReconciliationRecord {
  return input;
}

function shouldCheckSnapshot(position: Position): boolean {
  return TRACKED_SNAPSHOT_STATUSES.has(position.status);
}

function shouldSyncLiveSnapshot(position: Position): boolean {
  return (
    position.status === "OPEN" ||
    position.status === "HOLD" ||
    position.status === "MANAGEMENT_REVIEW" ||
    position.status === "RECONCILIATION_REQUIRED"
  );
}

function mergeLiveSnapshotPosition(input: {
  localPosition: Position;
  snapshotPosition: Position;
  now: string;
}): Position {
  const liveCurrentValueBase =
    input.snapshotPosition.currentValueBase > 0
      ? input.snapshotPosition.currentValueBase
      : input.localPosition.currentValueBase;
  const liveCurrentValueQuote =
    input.snapshotPosition.currentValueQuote !== undefined &&
    input.snapshotPosition.currentValueQuote > 0
      ? input.snapshotPosition.currentValueQuote
      : input.localPosition.currentValueQuote;
  const syncedStatus =
    input.localPosition.status === "RECONCILIATION_REQUIRED"
      ? transitionPositionStatus(
          transitionPositionStatus(input.localPosition.status, "RECONCILING"),
          "OPEN",
        )
      : input.localPosition.status;

  return PositionSchema.parse({
    ...input.localPosition,
    status: syncedStatus,
    tokenXMint: input.snapshotPosition.tokenXMint,
    tokenYMint: input.snapshotPosition.tokenYMint,
    currentValueBase: liveCurrentValueBase,
    ...(liveCurrentValueQuote === undefined
      ? {}
      : { currentValueQuote: liveCurrentValueQuote }),
    currentValueUsd: input.snapshotPosition.currentValueUsd,
    // Live DLMM snapshots can expose all-time earned fees rather than strictly
    // claimed fees. Preserve the local accounting counters; claim finalization
    // is the authoritative path for incrementing them.
    feesClaimedBase: input.localPosition.feesClaimedBase,
    feesClaimedUsd: input.localPosition.feesClaimedUsd,
    unrealizedPnlUsd: input.snapshotPosition.unrealizedPnlUsd,
    rangeLowerBin: input.snapshotPosition.rangeLowerBin,
    rangeUpperBin: input.snapshotPosition.rangeUpperBin,
    activeBin: input.snapshotPosition.activeBin,
    outOfRangeSince:
      input.snapshotPosition.outOfRangeSince !== null
        ? (input.localPosition.outOfRangeSince ?? input.now)
        : null,
    lastSyncedAt: input.now,
    needsReconciliation: false,
  });
}

function buildReconciliationRequiredPosition(
  position: Position,
  actionId: string | null,
  now: string,
): Position {
  return PositionSchema.parse({
    ...position,
    status: transitionPositionStatus(
      position.status,
      "RECONCILIATION_REQUIRED",
    ),
    lastSyncedAt: now,
    lastWriteActionId: actionId ?? position.lastWriteActionId,
    needsReconciliation: true,
  });
}

function getWalletsToInspect(
  positions: Position[],
  actions: Action[],
  inputWallets: string[] | undefined,
): string[] {
  const wallets = new Set<string>(inputWallets ?? []);

  for (const position of positions) {
    wallets.add(position.wallet);
  }

  for (const action of actions) {
    wallets.add(action.wallet);
  }

  return [...wallets].sort((left, right) => left.localeCompare(right));
}

function getDeployPositionId(action: Action): string | null {
  const parsed = DeployLiquidityResultSchema.safeParse(action.resultPayload);
  return parsed.success ? parsed.data.positionId : null;
}

function getActionPositionId(action: Action): string | null {
  if (action.type === "DEPLOY") {
    return getDeployPositionId(action);
  }

  return action.positionId;
}

function readPerformanceSnapshot(action: Action): Position | undefined {
  if (action.resultPayload === null) {
    return undefined;
  }

  const parsed = PositionSchema.safeParse(
    action.resultPayload["performanceSnapshot"],
  );
  return parsed.success ? parsed.data : undefined;
}

async function ensureTerminalClosedPositionLearning(input: {
  action: Action;
  stateRepository: StateRepository;
  lessonHook?: LessonHook;
  performanceRepository?: PerformanceRepositoryInterface;
  performanceRecordedPositionIds?: Set<string>;
  journalRepository?: JournalRepository;
  now: string;
}): Promise<ReconciliationRecord | null> {
  if (
    input.lessonHook === undefined ||
    !LEARNING_RECOVERY_STATUSES.has(input.action.status)
  ) {
    return null;
  }

  if (input.action.type === "CLOSE") {
    const positionId = input.action.positionId;
    const performanceSnapshot = readPerformanceSnapshot(input.action);
    const closeRequest = CloseActionRequestPayloadSchema.safeParse(
      input.action.requestPayload,
    );
    if (
      positionId === null ||
      performanceSnapshot === undefined ||
      !closeRequest.success
    ) {
      return null;
    }

    if (input.performanceRecordedPositionIds?.has(positionId)) {
      return null;
    }

    const position = await input.stateRepository.get(positionId);
    if (position === null || position.status !== "CLOSED") {
      return null;
    }

    await runLessonHookIdempotent({
      lessonHook: input.lessonHook,
      ...(input.journalRepository === undefined
        ? {}
        : { journalRepository: input.journalRepository }),
      position,
      performanceSnapshotPosition: performanceSnapshot,
      closedAction: input.action,
      reason: closeRequest.data.reason,
      now: input.now,
    });

    input.performanceRecordedPositionIds?.add(positionId);

    return createRecord({
      scope: "ACTION",
      entityId: input.action.actionId,
      wallet: input.action.wallet,
      positionId,
      actionId: input.action.actionId,
      outcome: "RECONCILED_OK",
      detail:
        "Terminal close action learning was re-ensured from durable performance snapshot",
    });
  }

  if (input.action.type === "REBALANCE") {
    const request = RebalanceActionRequestPayloadSchema.safeParse(
      input.action.requestPayload,
    );
    const payload = RebalanceActionResultPayloadSchema.safeParse(
      input.action.resultPayload,
    );
    if (!request.success || !payload.success) {
      return null;
    }

    const performanceSnapshot = payload.data.performanceSnapshot;
    const oldPositionId =
      "closedPositionId" in payload.data &&
      payload.data.closedPositionId !== undefined
        ? payload.data.closedPositionId
        : input.action.positionId;
    if (performanceSnapshot === undefined || oldPositionId === null) {
      return null;
    }

    if (input.performanceRecordedPositionIds?.has(oldPositionId)) {
      return null;
    }

    const position = await input.stateRepository.get(oldPositionId);
    if (position === null || position.status !== "CLOSED") {
      return null;
    }

    await runLessonHookIdempotent({
      lessonHook: input.lessonHook,
      ...(input.journalRepository === undefined
        ? {}
        : { journalRepository: input.journalRepository }),
      position,
      performanceSnapshotPosition: performanceSnapshot,
      closedAction: input.action,
      reason: request.data.reason,
      now: input.now,
    });

    input.performanceRecordedPositionIds?.add(oldPositionId);

    return createRecord({
      scope: "ACTION",
      entityId: input.action.actionId,
      wallet: input.action.wallet,
      positionId: oldPositionId,
      actionId: input.action.actionId,
      outcome: "RECONCILED_OK",
      detail:
        "Terminal rebalance old-leg learning was re-ensured from durable performance snapshot",
    });
  }

  return null;
}

function mapRebalanceReconciliationOutcome(
  result: FinalizeRebalanceResult,
): ReconciliationOutcome {
  switch (result.outcome) {
    case "FINALIZED":
    case "UNCHANGED":
      return "RECONCILED_OK";
    case "REDEPLOY_SUBMITTED":
      return "REQUIRES_RETRY";
    case "TIMED_OUT":
    case "REBALANCE_ABORTED":
      return "MANUAL_REVIEW_REQUIRED";
  }
}

function mapDeployReconciliationOutcome(
  outcome: "CONFIRMED" | "TIMED_OUT" | "UNCHANGED",
): ReconciliationOutcome {
  switch (outcome) {
    case "CONFIRMED":
    case "UNCHANGED":
      return "RECONCILED_OK";
    case "TIMED_OUT":
      return "MANUAL_REVIEW_REQUIRED";
  }
}

function mapCloseReconciliationOutcome(
  outcome: "FINALIZED" | "TIMED_OUT" | "RECONCILIATION_REQUIRED" | "UNCHANGED",
): ReconciliationOutcome {
  switch (outcome) {
    case "FINALIZED":
    case "UNCHANGED":
      return "RECONCILED_OK";
    case "TIMED_OUT":
    case "RECONCILIATION_REQUIRED":
      return "MANUAL_REVIEW_REQUIRED";
  }
}

function mapClaimReconciliationOutcome(
  outcome: "FINALIZED" | "TIMED_OUT" | "UNCHANGED",
): ReconciliationOutcome {
  switch (outcome) {
    case "FINALIZED":
    case "UNCHANGED":
      return "RECONCILED_OK";
    case "TIMED_OUT":
      return "MANUAL_REVIEW_REQUIRED";
  }
}

async function recoverReconcilingAction(
  input: RecoverReconcilingActionInput,
): Promise<ReconciliationRecord> {
  const targetPositionId = getActionPositionId(input.action);

  const work = async (): Promise<ReconciliationRecord> => {
    const latestAction = await input.actionRepository.get(
      input.action.actionId,
    );
    if (latestAction === null) {
      return createRecord({
        scope: "ACTION",
        entityId: input.action.actionId,
        wallet: input.action.wallet,
        positionId: targetPositionId,
        actionId: input.action.actionId,
        outcome: "MANUAL_REVIEW_REQUIRED",
        detail: "Reconciling action disappeared during startup recovery",
      });
    }

    if (latestAction.status !== "RECONCILING") {
      return createRecord({
        scope: "ACTION",
        entityId: latestAction.actionId,
        wallet: latestAction.wallet,
        positionId: getActionPositionId(latestAction),
        actionId: latestAction.actionId,
        outcome: "RECONCILED_OK",
        detail: `Action already moved to ${latestAction.status} before startup recovery ran`,
      });
    }

    if (latestAction.type === "CLAIM_FEES") {
      const result = await finalizeClaimFees({
        actionId: latestAction.actionId,
        actionRepository: input.actionRepository,
        stateRepository: input.stateRepository,
        dlmmGateway: input.dlmmGateway,
        walletLock: input.walletLock,
        positionLock: input.positionLock,
        now: () => input.now,
        ...(input.claimCompoundRiskGuardProvider === undefined
          ? {}
          : {
              compoundDeployRiskGuard:
                await input.claimCompoundRiskGuardProvider({
                  wallet: latestAction.wallet,
                  now: input.now,
                }),
            }),
        ...(input.actionQueue === undefined
          ? {}
          : { actionQueue: input.actionQueue }),
        ...(input.runtimeControlStore === undefined
          ? {}
          : { runtimeControlStore: input.runtimeControlStore }),
        ...(input.journalRepository === undefined
          ? {}
          : { journalRepository: input.journalRepository }),
        ...(input.postClaimSwapHook === undefined
          ? {}
          : { postClaimSwapHook: input.postClaimSwapHook }),
      });

      return createRecord({
        scope: "ACTION",
        entityId: result.action.actionId,
        wallet: result.action.wallet,
        positionId: result.position?.positionId ?? result.action.positionId,
        actionId: result.action.actionId,
        outcome: mapClaimReconciliationOutcome(result.outcome),
        detail: `Claim-fees reconciling recovery finished with ${result.outcome}`,
      });
    }

    const position =
      targetPositionId === null
        ? null
        : await input.stateRepository.get(targetPositionId);

    if (
      position !== null &&
      position.status !== "CLOSED" &&
      position.status !== "ABORTED"
    ) {
      const reconciliationPosition = buildReconciliationRequiredPosition(
        position,
        latestAction.actionId,
        input.now,
      );
      await input.stateRepository.upsert(reconciliationPosition);
    }

    if (
      latestAction.type === "CLOSE" &&
      position !== null &&
      position.status === "CLOSED"
    ) {
      const closeRequest = CloseActionRequestPayloadSchema.safeParse(
        latestAction.requestPayload,
      );
      if (closeRequest.success) {
        const performanceSnapshot = readPerformanceSnapshot(latestAction);
        await runLessonHookIdempotent({
          ...(input.lessonHook === undefined
            ? {}
            : { lessonHook: input.lessonHook }),
          ...(input.journalRepository === undefined
            ? {}
            : { journalRepository: input.journalRepository }),
          position,
          ...(performanceSnapshot === undefined
            ? {}
            : { performanceSnapshotPosition: performanceSnapshot }),
          closedAction: latestAction,
          reason: closeRequest.data.reason,
          now: input.now,
        });
      }

      // Close already succeeded on-chain (position is CLOSED with zero balances)
      // and the lesson hook has been re-run idempotently. Only the finalizer was
      // interrupted, so finalize the action as DONE rather than FAILED — keeping
      // the audit trail accurate.
      const doneAction = {
        ...latestAction,
        status: transitionActionStatus(latestAction.status, "DONE"),
        error: null,
        completedAt: input.now,
      } satisfies Action;
      await input.actionRepository.upsert(doneAction);

      await appendJournalEvent(input.journalRepository, {
        timestamp: input.now,
        eventType: "ACTION_STARTUP_RECOVERY_FINALIZED_CLOSED_ACTION",
        actor: latestAction.requestedBy,
        wallet: latestAction.wallet,
        positionId: targetPositionId,
        actionId: latestAction.actionId,
        before: toJournalRecord({
          action: latestAction,
          position,
        }),
        after: toJournalRecord({
          action: doneAction,
          position,
        }),
        txIds: latestAction.txIds,
        resultStatus: doneAction.status,
        error: null,
      });

      return createRecord({
        scope: "ACTION",
        entityId: doneAction.actionId,
        wallet: doneAction.wallet,
        positionId: targetPositionId,
        actionId: doneAction.actionId,
        outcome: "RECONCILED_OK",
        detail:
          "Startup recovery confirmed close already complete on-chain; action transitioned to DONE",
      });
    }

    const failedAction = {
      ...latestAction,
      status: transitionActionStatus(latestAction.status, "FAILED"),
      error:
        "Startup recovery requires reconciliation for interrupted reconciling action",
      completedAt: input.now,
    } satisfies Action;
    await input.actionRepository.upsert(failedAction);

    await appendJournalEvent(input.journalRepository, {
      timestamp: input.now,
      eventType: "ACTION_STARTUP_RECOVERY_REQUIRES_RECONCILIATION",
      actor: latestAction.requestedBy,
      wallet: latestAction.wallet,
      positionId: targetPositionId,
      actionId: latestAction.actionId,
      before: toJournalRecord({
        action: latestAction,
        position,
      }),
      after: toJournalRecord({
        action: failedAction,
      }),
      txIds: latestAction.txIds,
      resultStatus: failedAction.status,
      error: failedAction.error,
    });

    return createRecord({
      scope: "ACTION",
      entityId: failedAction.actionId,
      wallet: failedAction.wallet,
      positionId: targetPositionId,
      actionId: failedAction.actionId,
      outcome: "REQUIRES_RETRY",
      detail:
        "Startup recovery downgraded a RECONCILING action to reconciliation-required follow-up",
    });
  };

  return input.walletLock.withLock(input.action.wallet, async () => {
    if (targetPositionId === null) {
      return work();
    }

    return input.positionLock.withLock(targetPositionId, work);
  });
}

export async function reconcilePortfolio(
  input: ReconcilePortfolioInput,
): Promise<ReconcilePortfolioResult> {
  const now = nowTimestamp(input.now);
  const walletLock = input.walletLock ?? new WalletLock();
  const positionLock = input.positionLock ?? new PositionLock();
  const records: ReconciliationRecord[] = [];

  const waitingActions = await input.actionRepository.listByStatuses([
    "WAITING_CONFIRMATION",
  ]);

  if (input.dryRun === true) {
    for (const action of waitingActions) {
      records.push(
        createRecord({
          scope: "ACTION",
          entityId: action.actionId,
          wallet: action.wallet,
          positionId: getActionPositionId(action),
          actionId: action.actionId,
          outcome: "REQUIRES_RETRY",
          detail:
            "Dry-run reconciliation skipped WAITING_CONFIRMATION recovery to prevent live writes",
        }),
      );
    }
  } else {
    for (const action of waitingActions) {
      try {
        if (action.type === "DEPLOY") {
          const result = await confirmDeployAction({
            actionId: action.actionId,
            actionRepository: input.actionRepository,
            stateRepository: input.stateRepository,
            dlmmGateway: input.dlmmGateway,
            walletLock,
            positionLock,
            now: () => now,
            ...(input.journalRepository === undefined
              ? {}
              : { journalRepository: input.journalRepository }),
          });

          records.push(
            createRecord({
              scope: "ACTION",
              entityId: result.action.actionId,
              wallet: result.action.wallet,
              positionId:
                result.position?.positionId ??
                getDeployPositionId(result.action),
              actionId: result.action.actionId,
              outcome: mapDeployReconciliationOutcome(result.outcome),
              detail: `Deploy confirmation recovery finished with ${result.outcome}`,
            }),
          );
          continue;
        }

        if (action.type === "CLOSE") {
          const result = await finalizeClose({
            actionId: action.actionId,
            actionRepository: input.actionRepository,
            stateRepository: input.stateRepository,
            dlmmGateway: input.dlmmGateway,
            walletLock,
            positionLock,
            now: () => now,
            ...(input.journalRepository === undefined
              ? {}
              : { journalRepository: input.journalRepository }),
            ...(input.postCloseSwapHook === undefined
              ? {}
              : { postCloseSwapHook: input.postCloseSwapHook }),
            ...(input.lessonHook === undefined
              ? {}
              : { lessonHook: input.lessonHook }),
          });

          records.push(
            createRecord({
              scope: "ACTION",
              entityId: result.action.actionId,
              wallet: result.action.wallet,
              positionId:
                result.position?.positionId ?? result.action.positionId,
              actionId: result.action.actionId,
              outcome: mapCloseReconciliationOutcome(result.outcome),
              detail: `Close confirmation recovery finished with ${result.outcome}`,
            }),
          );
          continue;
        }

        if (action.type === "REBALANCE") {
          const result = await finalizeRebalance({
            actionId: action.actionId,
            actionRepository: input.actionRepository,
            stateRepository: input.stateRepository,
            dlmmGateway: input.dlmmGateway,
            walletLock,
            positionLock,
            now: () => now,
            ...(input.journalRepository === undefined
              ? {}
              : { journalRepository: input.journalRepository }),
            ...(input.runtimeControlStore === undefined
              ? {}
              : { runtimeControlStore: input.runtimeControlStore }),
            ...(input.lessonHook === undefined
              ? {}
              : { lessonHook: input.lessonHook }),
          });

          records.push(
            createRecord({
              scope: "ACTION",
              entityId: result.action.actionId,
              wallet: result.action.wallet,
              positionId:
                result.newPosition?.positionId ??
                result.oldPosition?.positionId ??
                result.action.positionId,
              actionId: result.action.actionId,
              outcome: mapRebalanceReconciliationOutcome(result),
              detail: `Rebalance recovery finished with ${result.outcome}`,
            }),
          );
          continue;
        }

        if (action.type === "CLAIM_FEES") {
          const result = await finalizeClaimFees({
            actionId: action.actionId,
            actionRepository: input.actionRepository,
            stateRepository: input.stateRepository,
            dlmmGateway: input.dlmmGateway,
            walletLock,
            positionLock,
            now: () => now,
            ...(input.claimCompoundRiskGuardProvider === undefined
              ? {}
              : {
                  compoundDeployRiskGuard:
                    await input.claimCompoundRiskGuardProvider({
                      wallet: action.wallet,
                      now,
                    }),
                }),
            ...(input.actionQueue === undefined
              ? {}
              : { actionQueue: input.actionQueue }),
            ...(input.runtimeControlStore === undefined
              ? {}
              : { runtimeControlStore: input.runtimeControlStore }),
            ...(input.journalRepository === undefined
              ? {}
              : { journalRepository: input.journalRepository }),
            ...(input.postClaimSwapHook === undefined
              ? {}
              : { postClaimSwapHook: input.postClaimSwapHook }),
          });

          records.push(
            createRecord({
              scope: "ACTION",
              entityId: result.action.actionId,
              wallet: result.action.wallet,
              positionId:
                result.position?.positionId ?? result.action.positionId,
              actionId: result.action.actionId,
              outcome: mapClaimReconciliationOutcome(result.outcome),
              detail: `Claim-fees recovery finished with ${result.outcome}`,
            }),
          );
          continue;
        }

        records.push(
          createRecord({
            scope: "ACTION",
            entityId: action.actionId,
            wallet: action.wallet,
            positionId: getActionPositionId(action),
            actionId: action.actionId,
            outcome: "MANUAL_REVIEW_REQUIRED",
            detail: `Unsupported WAITING_CONFIRMATION action type ${action.type} during reconciliation`,
          }),
        );
      } catch (error) {
        records.push(
          createRecord({
            scope: "ACTION",
            entityId: action.actionId,
            wallet: action.wallet,
            positionId: getActionPositionId(action),
            actionId: action.actionId,
            outcome: "MANUAL_REVIEW_REQUIRED",
            detail:
              error instanceof Error
                ? error.message
                : "Unexpected reconciliation error while recovering waiting action",
          }),
        );
      }
    }
  }

  const reconcilingActions = await input.actionRepository.listByStatuses([
    "RECONCILING",
  ]);

  if (input.dryRun === true) {
    for (const action of reconcilingActions) {
      records.push(
        createRecord({
          scope: "ACTION",
          entityId: action.actionId,
          wallet: action.wallet,
          positionId: getActionPositionId(action),
          actionId: action.actionId,
          outcome: "REQUIRES_RETRY",
          detail:
            "Dry-run reconciliation skipped RECONCILING recovery to prevent live writes",
        }),
      );
    }
  } else {
    for (const action of reconcilingActions) {
      try {
        records.push(
          await recoverReconcilingAction({
            action,
            actionRepository: input.actionRepository,
            stateRepository: input.stateRepository,
            dlmmGateway: input.dlmmGateway,
            ...(input.actionQueue === undefined
              ? {}
              : { actionQueue: input.actionQueue }),
            walletLock,
            positionLock,
            now,
            ...(input.journalRepository === undefined
              ? {}
              : { journalRepository: input.journalRepository }),
            ...(input.runtimeControlStore === undefined
              ? {}
              : { runtimeControlStore: input.runtimeControlStore }),
            ...(input.postClaimSwapHook === undefined
              ? {}
              : { postClaimSwapHook: input.postClaimSwapHook }),
            ...(input.lessonHook === undefined
              ? {}
              : { lessonHook: input.lessonHook }),
            ...(input.claimCompoundRiskGuardProvider === undefined
              ? {}
              : {
                  claimCompoundRiskGuardProvider:
                    input.claimCompoundRiskGuardProvider,
                }),
          }),
        );
      } catch (error) {
        records.push(
          createRecord({
            scope: "ACTION",
            entityId: action.actionId,
            wallet: action.wallet,
            positionId: getActionPositionId(action),
            actionId: action.actionId,
            outcome: "MANUAL_REVIEW_REQUIRED",
            detail:
              error instanceof Error
                ? error.message
                : "Unexpected startup recovery error for reconciling action",
          }),
        );
      }
    }
  }

  const allPositions = await input.stateRepository.list();
  const allActions = await input.actionRepository.list();

  if (input.dryRun !== true) {
    // Pre-compute the set of positionIds that already have a durable performance
    // record so we can skip re-running the lesson hook on every cycle. Lesson
    // hook side-effects are idempotent, but skipping here avoids noisy
    // reconciliation/journal records and unnecessary repo reads for closed
    // positions that have already been learned from.
    const performanceRecordedPositionIds =
      input.performanceRepository === undefined
        ? undefined
        : new Set(
            (await input.performanceRepository.list()).map(
              (record) => record.positionId,
            ),
          );

    for (const action of allActions) {
      const learningRecord = await ensureTerminalClosedPositionLearning({
        action,
        stateRepository: input.stateRepository,
        ...(input.lessonHook === undefined
          ? {}
          : { lessonHook: input.lessonHook }),
        ...(input.performanceRepository === undefined
          ? {}
          : { performanceRepository: input.performanceRepository }),
        ...(performanceRecordedPositionIds === undefined
          ? {}
          : { performanceRecordedPositionIds }),
        ...(input.journalRepository === undefined
          ? {}
          : { journalRepository: input.journalRepository }),
        now,
      });
      if (learningRecord !== null) {
        records.push(learningRecord);
      }
    }
  }

  const wallets = getWalletsToInspect(allPositions, allActions, input.wallets);

  for (const wallet of wallets) {
    try {
      const snapshot = await input.dlmmGateway.listPositionsForWallet(wallet);
      const snapshotById = new Map(
        snapshot.positions.map((position) => [position.positionId, position]),
      );
      const positionsForWallet = allPositions.filter(
        (position) =>
          position.wallet === wallet && shouldCheckSnapshot(position),
      );

      for (const position of positionsForWallet) {
        if (input.dryRun === true) {
          records.push(
            createRecord({
              scope: "POSITION",
              entityId: position.positionId,
              wallet,
              positionId: position.positionId,
              actionId: position.lastWriteActionId,
              outcome: "REQUIRES_RETRY",
              detail: "Dry-run skipped snapshot reconciliation write",
            }),
          );
          continue;
        }

        const liveSnapshot = snapshotById.get(position.positionId);
        if (liveSnapshot !== undefined) {
          const latestPosition = await input.stateRepository.get(
            position.positionId,
          );
          if (
            latestPosition !== null &&
            shouldSyncLiveSnapshot(latestPosition)
          ) {
            const syncedPosition = mergeLiveSnapshotPosition({
              localPosition: latestPosition,
              snapshotPosition: liveSnapshot,
              now,
            });
            await input.stateRepository.upsert(syncedPosition);
            if (latestPosition.status === "RECONCILIATION_REQUIRED") {
              await appendJournalEvent(input.journalRepository, {
                timestamp: now,
                eventType: "POSITION_RECONCILED_FROM_LIVE_SNAPSHOT",
                actor: "system",
                wallet,
                positionId: syncedPosition.positionId,
                actionId: syncedPosition.lastWriteActionId,
                before: toJournalRecord({ position: latestPosition }),
                after: toJournalRecord({ position: syncedPosition }),
                txIds: [],
                resultStatus: syncedPosition.status,
                error: null,
              });
            }
            records.push(
              createRecord({
                scope: "POSITION",
                entityId: syncedPosition.positionId,
                wallet,
                positionId: syncedPosition.positionId,
                actionId: syncedPosition.lastWriteActionId,
                outcome: "RECONCILED_OK",
                detail:
                  latestPosition.status === "RECONCILIATION_REQUIRED"
                    ? "Local reconciliation-required position restored from live DLMM snapshot"
                    : "Local open position synced from live DLMM snapshot",
              }),
            );
          }
          continue;
        }

        const latestPosition = await input.stateRepository.get(
          position.positionId,
        );
        if (
          latestPosition === null ||
          latestPosition.status === "RECONCILIATION_REQUIRED" ||
          latestPosition.status === "CLOSED" ||
          latestPosition.status === "ABORTED"
        ) {
          continue;
        }

        const reconciliationPosition = buildReconciliationRequiredPosition(
          latestPosition,
          latestPosition.lastWriteActionId,
          now,
        );
        await input.stateRepository.upsert(reconciliationPosition);
        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "POSITION_MISSING_FROM_SNAPSHOT",
          actor: "system",
          wallet,
          positionId: latestPosition.positionId,
          actionId: latestPosition.lastWriteActionId,
          before: toJournalRecord({
            position: latestPosition,
          }),
          after: toJournalRecord({
            position: reconciliationPosition,
          }),
          txIds: [],
          resultStatus: reconciliationPosition.status,
          error: "Position missing from wallet snapshot during reconciliation",
        });

        records.push(
          createRecord({
            scope: "POSITION",
            entityId: latestPosition.positionId,
            wallet,
            positionId: latestPosition.positionId,
            actionId: latestPosition.lastWriteActionId,
            outcome: "REQUIRES_RETRY",
            detail:
              "Local position missing from wallet snapshot; marked RECONCILIATION_REQUIRED instead of auto-closing",
          }),
        );
      }
    } catch (error) {
      records.push(
        createRecord({
          scope: "POSITION",
          entityId: wallet,
          wallet,
          positionId: null,
          actionId: null,
          outcome: "MANUAL_REVIEW_REQUIRED",
          detail:
            error instanceof Error
              ? error.message
              : "Wallet snapshot reconciliation failed",
        }),
      );
    }
  }

  return {
    records,
  };
}
