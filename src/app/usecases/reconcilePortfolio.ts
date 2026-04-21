import { z } from "zod";

import { DeployLiquidityResultSchema, type DlmmGateway } from "../../adapters/dlmm/DlmmGateway.js";
import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { Action } from "../../domain/entities/Action.js";
import type { JournalEvent } from "../../domain/entities/JournalEvent.js";
import { PositionSchema, type Position } from "../../domain/entities/Position.js";
import { transitionActionStatus } from "../../domain/stateMachines/actionLifecycle.js";
import { transitionPositionStatus } from "../../domain/stateMachines/positionLifecycle.js";
import { type ReconciliationOutcome } from "../../domain/types/enums.js";
import { PositionLock } from "../../infra/locks/positionLock.js";
import { WalletLock } from "../../infra/locks/walletLock.js";

import {
  finalizeClose,
  type PostCloseSwapHook,
} from "./finalizeClose.js";
import { confirmDeployAction } from "./processDeployAction.js";

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
  "RECONCILING",
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
  journalRepository?: JournalRepository;
  walletLock?: WalletLock;
  positionLock?: PositionLock;
  now?: () => string;
  wallets?: string[];
  postCloseSwapHook?: PostCloseSwapHook;
}

export interface ReconcilePortfolioResult {
  records: ReconciliationRecord[];
}

interface RecoverReconcilingActionInput {
  action: Action;
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  journalRepository?: JournalRepository;
  walletLock: WalletLock;
  positionLock: PositionLock;
  now: string;
}

function nowTimestamp(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function toJournalRecord(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(
    JSON.parse(JSON.stringify(value)),
  );
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

function buildReconciliationRequiredPosition(
  position: Position,
  actionId: string | null,
  now: string,
): Position {
  return PositionSchema.parse({
    ...position,
    status: transitionPositionStatus(position.status, "RECONCILIATION_REQUIRED"),
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

async function recoverReconcilingAction(
  input: RecoverReconcilingActionInput,
): Promise<ReconciliationRecord> {
  const targetPositionId = getActionPositionId(input.action);

  const work = async (): Promise<ReconciliationRecord> => {
    const latestAction = await input.actionRepository.get(input.action.actionId);
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

    const failedAction = {
      ...latestAction,
      status: transitionActionStatus(latestAction.status, "FAILED"),
      error: "Startup recovery requires reconciliation for interrupted reconciling action",
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
            positionId: result.position?.positionId ?? getDeployPositionId(result.action),
            actionId: result.action.actionId,
            outcome:
              result.outcome === "CONFIRMED" || result.outcome === "UNCHANGED"
                ? "RECONCILED_OK"
                : "REQUIRES_RETRY",
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
        });

        records.push(
          createRecord({
            scope: "ACTION",
            entityId: result.action.actionId,
            wallet: result.action.wallet,
            positionId: result.position?.positionId ?? result.action.positionId,
            actionId: result.action.actionId,
            outcome:
              result.outcome === "FINALIZED" || result.outcome === "UNCHANGED"
                ? "RECONCILED_OK"
                : "REQUIRES_RETRY",
            detail: `Close confirmation recovery finished with ${result.outcome}`,
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

  const reconcilingActions = await input.actionRepository.listByStatuses([
    "RECONCILING",
  ]);

  for (const action of reconcilingActions) {
    try {
      records.push(
        await recoverReconcilingAction({
          action,
          actionRepository: input.actionRepository,
          stateRepository: input.stateRepository,
          walletLock,
          positionLock,
          now,
          ...(input.journalRepository === undefined
            ? {}
            : { journalRepository: input.journalRepository }),
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

  const allPositions = await input.stateRepository.list();
  const allActions = await input.actionRepository.list();
  const wallets = getWalletsToInspect(allPositions, allActions, input.wallets);

  for (const wallet of wallets) {
    try {
      const snapshot = await input.dlmmGateway.listPositionsForWallet(wallet);
      const snapshotIds = new Set(snapshot.positions.map((position) => position.positionId));
      const positionsForWallet = allPositions.filter(
        (position) => position.wallet === wallet && shouldCheckSnapshot(position),
      );

      for (const position of positionsForWallet) {
        if (snapshotIds.has(position.positionId)) {
          continue;
        }

        const latestPosition = await input.stateRepository.get(position.positionId);
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
