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
import {
  PositionSchema,
  type Position,
} from "../../domain/entities/Position.js";
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
  outcome: "FINALIZED" | "TIMED_OUT" | "RECONCILIATION_REQUIRED" | "UNCHANGED";
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
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(JSON.stringify(value)));
}

function readPerformanceSnapshot(action: Action): Position | undefined {
  if (action.resultPayload === null) {
    return undefined;
  }

  const snapshot = PositionSchema.safeParse(
    action.resultPayload["performanceSnapshot"],
  );
  return snapshot.success ? snapshot.data : undefined;
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

export async function runLessonHookIdempotent(input: {
  lessonHook?: LessonHook;
  journalRepository?: JournalRepository;
  position: Position;
  performanceSnapshotPosition?: Position;
  closedAction: Action;
  reason: string;
  now: string;
}): Promise<void> {
  if (input.lessonHook === undefined) {
    return;
  }

  try {
    await input.lessonHook({
      position: input.position,
      ...(input.performanceSnapshotPosition === undefined
        ? {}
        : { performanceSnapshotPosition: input.performanceSnapshotPosition }),
      closedAction: input.closedAction,
      reason: input.reason,
      now: input.now,
    });
  } catch (error) {
    const failureMessage = errorMessage(error, "lesson hook failed");
    logger.warn(
      {
        err: error,
        actionId: input.closedAction.actionId,
        positionId: input.position.positionId,
      },
      "lesson hook failed after close finalization",
    );
    await appendJournalEvent(input.journalRepository, {
      timestamp: input.now,
      eventType: "LESSON_HOOK_FAILED",
      actor: "system",
      wallet: input.position.wallet,
      positionId: input.position.positionId,
      actionId: input.closedAction.actionId,
      before: null,
      after: {
        reason: input.reason,
        pool: input.position.poolAddress,
      },
      txIds: [],
      resultStatus: "FAILED",
      error: failureMessage,
    });
  }
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
    input.confirmedPosition.rangeLowerBin ??
    input.closingPosition.rangeLowerBin;
  const rangeUpperBin =
    input.confirmedPosition.rangeUpperBin ??
    input.closingPosition.rangeUpperBin;
  const activeBin =
    input.confirmedPosition.activeBin ?? input.closingPosition.activeBin;
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

function inferCloseConfirmedPosition(
  closingPosition: Position | null,
  confirmedPosition: Position | null,
  useOpenOnlyReadModel: boolean,
  actionId: string,
  now: string,
): Position | null {
  if (
    confirmedPosition !== null &&
    confirmedPosition.status === "CLOSE_CONFIRMED"
  ) {
    return confirmedPosition;
  }

  if (
    useOpenOnlyReadModel &&
    confirmedPosition === null &&
    closingPosition !== null &&
    (closingPosition.status === "CLOSING" ||
      closingPosition.status === "CLOSE_CONFIRMED" ||
      closingPosition.status === "RECONCILING" ||
      closingPosition.status === "CLOSED")
  ) {
    return buildCloseConfirmedPosition({
      confirmedPosition: closingPosition,
      closingPosition,
      actionId,
      now,
    });
  }

  return null;
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
    status: transitionPositionStatus(
      input.reconcilingPosition.status,
      "CLOSED",
    ),
    closedAt: input.reconcilingPosition.closedAt ?? input.now,
    currentValueBase: 0,
    currentValueQuote: 0,
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
    status: transitionPositionStatus(
      position.status,
      "RECONCILIATION_REQUIRED",
    ),
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
    const existingPosition = await input.stateRepository.get(action.positionId);
    if (
      existingPosition !== null &&
      existingPosition.status === "CLOSED" &&
      action.status === "DONE"
    ) {
      const closeRequest = CloseActionRequestPayloadSchema.safeParse(
        action.requestPayload,
      );
      if (closeRequest.success) {
        const performanceSnapshot = readPerformanceSnapshot(action);
        await runLessonHookIdempotent({
          ...(input.lessonHook === undefined
            ? {}
            : { lessonHook: input.lessonHook }),
          ...(input.journalRepository === undefined
            ? {}
            : { journalRepository: input.journalRepository }),
          position: existingPosition,
          ...(performanceSnapshot === undefined
            ? {}
            : { performanceSnapshotPosition: performanceSnapshot }),
          closedAction: action,
          reason: closeRequest.data.reason,
          now,
        });
      }
    }
    return {
      action,
      position: existingPosition,
      outcome: "UNCHANGED",
    };
  }

  if (action.status !== "WAITING_CONFIRMATION") {
    throw new Error(
      `Close finalization expected WAITING_CONFIRMATION, received ${action.status}`,
    );
  }

  const closeResult = CloseActionResultPayloadSchema.parse(
    action.resultPayload,
  );
  const positionLock = input.positionLock ?? new PositionLock();

  return walletLock.withLock(action.wallet, () =>
    positionLock.withLock(action.positionId, async () => {
      const latestAction = await input.actionRepository.get(action.actionId);
      if (latestAction === null) {
        throw new Error(
          `Close action disappeared during finalization: ${action.actionId}`,
        );
      }

      assertCloseAction(latestAction);

      if (
        latestAction.status === "DONE" ||
        latestAction.status === "TIMED_OUT" ||
        latestAction.status === "FAILED" ||
        latestAction.status === "ABORTED"
      ) {
        const existingPosition = await input.stateRepository.get(
          latestAction.positionId,
        );
        if (
          existingPosition !== null &&
          existingPosition.status === "CLOSED" &&
          latestAction.status === "DONE"
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
              position: existingPosition,
              ...(performanceSnapshot === undefined
                ? {}
                : { performanceSnapshotPosition: performanceSnapshot }),
              closedAction: latestAction,
              reason: closeRequest.data.reason,
              now,
            });
          }
        }
        return {
          action: latestAction,
          position: existingPosition,
          outcome: "UNCHANGED" as const,
        };
      }

      if (latestAction.status !== "WAITING_CONFIRMATION") {
        throw new Error(
          `Close finalization expected WAITING_CONFIRMATION, received ${latestAction.status}`,
        );
      }

      const payload = CloseActionRequestPayloadSchema.parse(
        latestAction.requestPayload,
      );
      const closingPosition = await input.stateRepository.get(
        latestAction.positionId,
      );
      const confirmedPosition = await input.dlmmGateway.getPosition(
        latestAction.positionId,
      );
      const closeConfirmedPositionLike = inferCloseConfirmedPosition(
        closingPosition,
        confirmedPosition,
        input.dlmmGateway.reconciliationReadModel === "open_only",
        latestAction.actionId,
        now,
      );

      if (
        closingPosition !== null &&
        closingPosition.status === "CLOSED" &&
        closeConfirmedPositionLike !== null
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
            performanceSnapshot: closeConfirmedPositionLike,
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

        await runLessonHookIdempotent({
          ...(input.lessonHook === undefined
            ? {}
            : { lessonHook: input.lessonHook }),
          ...(input.journalRepository === undefined
            ? {}
            : { journalRepository: input.journalRepository }),
          position: closingPosition,
          performanceSnapshotPosition: closeConfirmedPositionLike,
          closedAction: doneAction,
          reason: payload.reason,
          now,
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
        closeConfirmedPositionLike !== null
          ? closingPosition
          : null;

      if (
        closingPosition === null ||
        (closingPosition.status !== "CLOSING" &&
          resumeReconcilingPosition === null) ||
        closeConfirmedPositionLike === null
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
                : closeConfirmedPositionLike === null
                  ? `Close confirmation not found for position ${latestAction.positionId}`
                  : `Close confirmation returned unsupported status ${confirmedPosition?.status ?? "unknown"} for ${latestAction.positionId}`,
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

      const closeConfirmedPosition =
        resumeReconcilingPosition ?? closeConfirmedPositionLike;
      if (closeConfirmedPosition === null) {
        throw new Error(
          `Close finalization could not infer confirmed close state for ${latestAction.positionId}`,
        );
      }
      const reconcilingPosition =
        resumeReconcilingPosition ??
        buildReconcilingPosition(
          closeConfirmedPosition,
          latestAction.actionId,
          now,
        );
      const performanceSnapshotPosition =
        closeConfirmedPosition.entryMetadata === undefined &&
        closingPosition.entryMetadata !== undefined
          ? PositionSchema.parse({
              ...closeConfirmedPosition,
              entryMetadata: closingPosition.entryMetadata,
            })
          : closeConfirmedPosition;
      const reconcilingAction = {
        ...latestAction,
        status: transitionActionStatus(latestAction.status, "RECONCILING"),
        resultPayload: toJournalRecord({
          ...closeResult,
          performanceSnapshot: performanceSnapshotPosition,
        }),
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
        const accounting = buildCloseAccountingSummary(
          closedPosition,
          postCloseSwap,
        );
        await input.stateRepository.upsert(closedPosition);

        const doneAction = {
          ...reconcilingAction,
          status: transitionActionStatus(reconcilingAction.status, "DONE"),
          resultPayload: toJournalRecord({
            ...closeResult,
            accounting,
            performanceSnapshot: performanceSnapshotPosition,
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

        await runLessonHookIdempotent({
          ...(input.lessonHook === undefined
            ? {}
            : { lessonHook: input.lessonHook }),
          ...(input.journalRepository === undefined
            ? {}
            : { journalRepository: input.journalRepository }),
          position: closedPosition,
          performanceSnapshotPosition,
          closedAction: doneAction,
          reason: payload.reason,
          now,
        });

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
