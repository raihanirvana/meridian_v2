import { z } from "zod";

import {
  ClosePositionResultSchema,
  type DlmmGateway,
} from "../../adapters/dlmm/DlmmGateway.js";
import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { Action } from "../../domain/entities/Action.js";
import type { JournalEvent } from "../../domain/entities/JournalEvent.js";
import { PositionSchema, type Position } from "../../domain/entities/Position.js";
import { transitionActionStatus } from "../../domain/stateMachines/actionLifecycle.js";
import { transitionPositionStatus } from "../../domain/stateMachines/positionLifecycle.js";
import { PositionLock } from "../../infra/locks/positionLock.js";
import { WalletLock } from "../../infra/locks/walletLock.js";
import {
  buildCloseAccountingSummary,
  resolveOutOfRangeSince,
} from "../services/AccountingService.js";
import { logger } from "../../infra/logging/logger.js";
import { type PerformanceRecord } from "../../domain/entities/PerformanceRecord.js";

import { CloseActionRequestPayloadSchema } from "./requestClose.js";

const CloseActionResultPayloadSchema = ClosePositionResultSchema;

// This hook runs after the local position has entered RECONCILING, not while it
// is still in CLOSE_CONFIRMED. Callers should treat the snapshot as a finalized
// close candidate that is ready for post-close accounting/swap work.
export const PostCloseSwapInputSchema = z.object({
  actionId: z.string().min(1),
  wallet: z.string().min(1),
  reason: z.string().min(1),
  position: PositionSchema,
});

export type PostCloseSwapInput = z.infer<typeof PostCloseSwapInputSchema>;
export type PostCloseSwapHook = (
  input: PostCloseSwapInput,
) => Promise<Record<string, unknown> | null>;

export interface LessonHookInput {
  position: Position;
  performanceSnapshotPosition?: Position;
  closedAction: Action;
  reason: string;
  now: string;
}

export type LessonHook = (
  input: LessonHookInput,
) => Promise<PerformanceRecord | void>;

export interface FinalizeCloseInput {
  actionId: string;
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  dlmmGateway: DlmmGateway;
  journalRepository?: JournalRepository;
  walletLock?: WalletLock;
  positionLock?: PositionLock;
  now?: () => string;
  postCloseSwapHook?: PostCloseSwapHook;
  lessonHook?: LessonHook;
}

export interface FinalizeCloseResult {
  action: Action;
  position: Position | null;
  outcome:
    | "FINALIZED"
    | "TIMED_OUT"
    | "RECONCILIATION_REQUIRED"
    | "UNCHANGED";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message.trim().length > 0 ? error.message : fallback;
  }

  const value = String(error).trim();
  return value.length > 0 ? value : fallback;
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

function assertCloseAction(action: Action): asserts action is Action & {
  type: "CLOSE";
  positionId: string;
} {
  if (action.type !== "CLOSE" || action.positionId === null) {
    throw new Error(
      `Expected CLOSE action with positionId, received ${action.type}/${action.positionId}`,
    );
  }
}

function buildCloseConfirmedPosition(input: {
  confirmedPosition: Position;
  closingPosition: Position;
  actionId: string;
  now: string;
}): Position {
  const rangeLowerBin =
    input.confirmedPosition.rangeLowerBin ?? input.closingPosition.rangeLowerBin;
  const rangeUpperBin =
    input.confirmedPosition.rangeUpperBin ?? input.closingPosition.rangeUpperBin;
  const activeBin = input.confirmedPosition.activeBin ?? input.closingPosition.activeBin;
  const closeConfirmedStatus = transitionPositionStatus(
    input.closingPosition.status,
    "CLOSE_CONFIRMED",
  );

  return PositionSchema.parse({
    ...input.closingPosition,
    ...input.confirmedPosition,
    status: closeConfirmedStatus,
    closedAt: input.confirmedPosition.closedAt ?? input.now,
    lastSyncedAt: input.now,
    rangeLowerBin,
    rangeUpperBin,
    activeBin,
    outOfRangeSince: resolveOutOfRangeSince({
      activeBin,
      rangeLowerBin,
      rangeUpperBin,
      preferredValue:
        input.confirmedPosition.outOfRangeSince ??
        input.closingPosition.outOfRangeSince,
      fallbackValue: input.closingPosition.outOfRangeSince ?? input.now,
    }),
    lastWriteActionId: input.actionId,
    needsReconciliation: false,
  });
}

function buildReconcilingPosition(
  confirmedPosition: Position,
  actionId: string,
  now: string,
): Position {
  return PositionSchema.parse({
    ...confirmedPosition,
    status: transitionPositionStatus(confirmedPosition.status, "RECONCILING"),
    lastSyncedAt: now,
    lastWriteActionId: actionId,
    needsReconciliation: false,
  });
}

function buildClosedPosition(input: {
  reconcilingPosition: Position;
  actionId: string;
  now: string;
}): Position {
  return PositionSchema.parse({
    ...input.reconcilingPosition,
    status: transitionPositionStatus(input.reconcilingPosition.status, "CLOSED"),
    closedAt: input.reconcilingPosition.closedAt ?? input.now,
    currentValueBase: 0,
    currentValueUsd: 0,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    lastSyncedAt: input.now,
    lastWriteActionId: input.actionId,
    needsReconciliation: false,
  });
}

function buildReconciliationRequiredPosition(
  position: Position,
  actionId: string,
  now: string,
): Position {
  return PositionSchema.parse({
    ...position,
    status: transitionPositionStatus(position.status, "RECONCILIATION_REQUIRED"),
    lastSyncedAt: now,
    lastWriteActionId: actionId,
    needsReconciliation: true,
  });
}

export async function finalizeClose(
  input: FinalizeCloseInput,
): Promise<FinalizeCloseResult> {
  const action = await input.actionRepository.get(input.actionId);
  if (action === null) {
    throw new Error(`Close action not found: ${input.actionId}`);
  }

  assertCloseAction(action);
  const now = nowTimestamp(input.now);
  const walletLock = input.walletLock ?? new WalletLock();

  if (
    action.status === "DONE" ||
    action.status === "TIMED_OUT" ||
    action.status === "FAILED" ||
    action.status === "ABORTED"
  ) {
    return {
      action,
      position: await input.stateRepository.get(action.positionId),
      outcome: "UNCHANGED",
    };
  }

  if (action.status !== "WAITING_CONFIRMATION") {
    throw new Error(
      `Close finalization expected WAITING_CONFIRMATION, received ${action.status}`,
    );
  }

  const closeResult = CloseActionResultPayloadSchema.parse(action.resultPayload);
  const positionLock = input.positionLock ?? new PositionLock();

  return walletLock.withLock(action.wallet, () =>
    positionLock.withLock(action.positionId, async () => {
      const latestAction = await input.actionRepository.get(action.actionId);
      if (latestAction === null) {
        throw new Error(`Close action disappeared during finalization: ${action.actionId}`);
      }

      assertCloseAction(latestAction);

      if (
        latestAction.status === "DONE" ||
        latestAction.status === "TIMED_OUT" ||
        latestAction.status === "FAILED" ||
        latestAction.status === "ABORTED"
      ) {
        return {
          action: latestAction,
          position: await input.stateRepository.get(latestAction.positionId),
          outcome: "UNCHANGED" as const,
        };
      }

      if (latestAction.status !== "WAITING_CONFIRMATION") {
        throw new Error(
          `Close finalization expected WAITING_CONFIRMATION, received ${latestAction.status}`,
        );
      }

      const payload = CloseActionRequestPayloadSchema.parse(latestAction.requestPayload);
      const closingPosition = await input.stateRepository.get(latestAction.positionId);
      const confirmedPosition = await input.dlmmGateway.getPosition(
        latestAction.positionId,
      );

      if (
        closingPosition !== null &&
        closingPosition.status === "CLOSED" &&
        confirmedPosition !== null &&
        confirmedPosition.status === "CLOSE_CONFIRMED"
      ) {
        const accounting = buildCloseAccountingSummary(closingPosition, null);
        const reconcilingAction = {
          ...latestAction,
          status: transitionActionStatus(latestAction.status, "RECONCILING"),
        } satisfies Action;
        await input.actionRepository.upsert(reconcilingAction);

        const doneAction = {
          ...reconcilingAction,
          status: transitionActionStatus(reconcilingAction.status, "DONE"),
          resultPayload: toJournalRecord({
            ...closeResult,
            accounting,
          }),
          completedAt: now,
          error: null,
        } satisfies Action;
        await input.actionRepository.upsert(doneAction);

        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "CLOSE_FINALIZED",
          actor: latestAction.requestedBy,
          wallet: latestAction.wallet,
          positionId: latestAction.positionId,
          actionId: latestAction.actionId,
          before: toJournalRecord({
            action: latestAction,
            position: closingPosition,
          }),
          after: toJournalRecord({
            action: doneAction,
            position: closingPosition,
          }),
          txIds: doneAction.txIds,
          resultStatus: doneAction.status,
          error: null,
        });

        return {
          action: doneAction,
          position: closingPosition,
          outcome: "FINALIZED",
        };
      }

      const resumeReconcilingPosition =
        closingPosition !== null &&
        closingPosition.status === "RECONCILING" &&
        confirmedPosition !== null &&
        confirmedPosition.status === "CLOSE_CONFIRMED"
          ? closingPosition
          : null;

      if (
        closingPosition === null ||
        (closingPosition.status !== "CLOSING" && resumeReconcilingPosition === null) ||
        confirmedPosition === null ||
        confirmedPosition.status !== "CLOSE_CONFIRMED"
      ) {
        const sourcePosition = closingPosition ?? confirmedPosition;

        if (sourcePosition === null) {
          throw new Error(
            `Close finalization cannot build reconciliation state for ${latestAction.positionId}`,
          );
        }

        const reconciliationPosition = buildReconciliationRequiredPosition(
          sourcePosition,
          latestAction.actionId,
          now,
        );
        await input.stateRepository.upsert(reconciliationPosition);

        const timedOutAction = {
          ...latestAction,
          status: transitionActionStatus(latestAction.status, "TIMED_OUT"),
          error:
            closingPosition === null
              ? `Close finalization requires reconciliation because local closing position is missing for ${latestAction.positionId}`
              : closingPosition.status !== "CLOSING"
                ? `Close finalization requires reconciliation because local position status is ${closingPosition.status} for ${latestAction.positionId}`
                : confirmedPosition === null
                  ? `Close confirmation not found for position ${latestAction.positionId}`
                  : `Close confirmation returned non-close-confirmed status ${confirmedPosition.status} for ${latestAction.positionId}`,
          completedAt: now,
        } satisfies Action;

        await input.actionRepository.upsert(timedOutAction);

        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "CLOSE_TIMED_OUT",
          actor: latestAction.requestedBy,
          wallet: latestAction.wallet,
          positionId: latestAction.positionId,
          actionId: latestAction.actionId,
          before: toJournalRecord({
            action: latestAction,
            position: closingPosition,
          }),
          after: toJournalRecord({
            action: timedOutAction,
            position: reconciliationPosition,
          }),
          txIds: latestAction.txIds,
          resultStatus: timedOutAction.status,
          error: timedOutAction.error,
        });

        return {
          action: timedOutAction,
          position: reconciliationPosition,
          outcome: "TIMED_OUT",
        };
      }

      const closeConfirmedPosition = resumeReconcilingPosition ?? buildCloseConfirmedPosition({
        confirmedPosition,
        closingPosition,
        actionId: latestAction.actionId,
        now,
      });
      const reconcilingPosition = resumeReconcilingPosition ?? buildReconcilingPosition(
        closeConfirmedPosition,
        latestAction.actionId,
        now,
      );
      const reconcilingAction = {
        ...latestAction,
        status: transitionActionStatus(latestAction.status, "RECONCILING"),
      } satisfies Action;

      try {
        await input.stateRepository.upsert(reconcilingPosition);
        await input.actionRepository.upsert(reconcilingAction);

        const postCloseSwap =
          (await input.postCloseSwapHook?.(
            PostCloseSwapInputSchema.parse({
              actionId: reconcilingAction.actionId,
              wallet: reconcilingAction.wallet,
              reason: payload.reason,
              position: reconcilingPosition,
            }),
          )) ?? null;

        const closedPosition = buildClosedPosition({
          reconcilingPosition,
          actionId: latestAction.actionId,
          now,
        });
        const accounting = buildCloseAccountingSummary(closedPosition, postCloseSwap);
        await input.stateRepository.upsert(closedPosition);

        const doneAction = {
          ...reconcilingAction,
          status: transitionActionStatus(reconcilingAction.status, "DONE"),
          resultPayload: toJournalRecord({
            ...closeResult,
            accounting,
          }),
          completedAt: now,
          error: null,
        } satisfies Action;
        await input.actionRepository.upsert(doneAction);

        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "CLOSE_FINALIZED",
          actor: latestAction.requestedBy,
          wallet: latestAction.wallet,
          positionId: latestAction.positionId,
          actionId: latestAction.actionId,
          before: toJournalRecord({
            action: latestAction,
            position: closingPosition,
          }),
          after: toJournalRecord({
            action: doneAction,
            position: closedPosition,
          }),
          txIds: doneAction.txIds,
          resultStatus: doneAction.status,
          error: null,
        });

        if (input.lessonHook !== undefined) {
          try {
            await input.lessonHook({
              position: closedPosition,
              performanceSnapshotPosition: closeConfirmedPosition,
              closedAction: doneAction,
              reason: payload.reason,
              now,
            });
          } catch (error) {
            logger.warn(
              {
                err: error,
                actionId: doneAction.actionId,
                positionId: closedPosition.positionId,
              },
              "close lesson hook failed after finalization",
            );
          }
        }

        return {
          action: doneAction,
          position: closedPosition,
          outcome: "FINALIZED",
        };
      } catch (error) {
        const reconciliationPosition = buildReconciliationRequiredPosition(
          reconcilingPosition,
          latestAction.actionId,
          now,
        );
        await input.stateRepository.upsert(reconciliationPosition);

        const failedAction = {
          ...reconcilingAction,
          status: transitionActionStatus(reconcilingAction.status, "FAILED"),
          error: `Close finalization requires reconciliation: ${errorMessage(
            error,
            "unknown accounting finalization error",
          )}`,
          completedAt: now,
        } satisfies Action;
        await input.actionRepository.upsert(failedAction);

        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "CLOSE_FINALIZATION_FAILED",
          actor: latestAction.requestedBy,
          wallet: latestAction.wallet,
          positionId: latestAction.positionId,
          actionId: latestAction.actionId,
          before: toJournalRecord({
            action: reconcilingAction,
            position: reconcilingPosition,
          }),
          after: toJournalRecord({
            action: failedAction,
            position: reconciliationPosition,
          }),
          txIds: failedAction.txIds,
          resultStatus: failedAction.status,
          error: failedAction.error,
        });

        return {
          action: failedAction,
          position: reconciliationPosition,
          outcome: "RECONCILIATION_REQUIRED",
        };
      }
    }),
  );
}
