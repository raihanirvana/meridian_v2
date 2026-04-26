import { z } from "zod";

import {
  ClosePositionResultSchema,
  isAmbiguousSubmissionError,
  type DlmmGateway,
} from "../../adapters/dlmm/DlmmGateway.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { RuntimeControlStore } from "../../adapters/storage/RuntimeControlStore.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { Action } from "../../domain/entities/Action.js";
import type { JournalEvent } from "../../domain/entities/JournalEvent.js";
import {
  PositionSchema,
  type Position,
} from "../../domain/entities/Position.js";
import { transitionPositionStatus } from "../../domain/stateMachines/positionLifecycle.js";
import type { QueueExecutionResult } from "../services/ActionQueue.js";

import {
  RebalanceActionRequestPayloadSchema,
  assertRebalanceRequestablePosition,
} from "./requestRebalance.js";

const CloseActionResultPayloadSchema = ClosePositionResultSchema;

export const RebalanceCloseSubmittedPayloadSchema = z
  .object({
    phase: z.literal("CLOSE_SUBMITTED"),
    closeResult: CloseActionResultPayloadSchema,
    closeAccounting: z.record(z.string(), z.unknown()).optional(),
    closedPositionId: z.string().min(1).optional(),
    availableCapitalUsd: z.number().nonnegative().optional(),
    performanceSnapshot: PositionSchema.optional(),
  })
  .strict();

export type RebalanceCloseSubmittedPayload = z.infer<
  typeof RebalanceCloseSubmittedPayloadSchema
>;

export interface ProcessRebalanceActionInput {
  action: Action;
  dlmmGateway: DlmmGateway;
  stateRepository: StateRepository;
  journalRepository?: JournalRepository;
  runtimeControlStore?: RuntimeControlStore;
  now?: () => string;
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

async function appendJournalEvent(
  journalRepository: JournalRepository | undefined,
  event: JournalEvent,
): Promise<void> {
  if (journalRepository === undefined) {
    return;
  }

  await journalRepository.append(event);
}

function assertRebalanceAction(action: Action): asserts action is Action & {
  type: "REBALANCE";
  positionId: string;
} {
  if (action.type !== "REBALANCE" || action.positionId === null) {
    throw new Error(
      `Expected REBALANCE action with positionId, received ${action.type}/${action.positionId}`,
    );
  }
}

function toRebalanceRequestedStatus(
  status: Position["status"],
): Position["status"] {
  switch (status) {
    case "OPEN":
      return transitionPositionStatus(
        transitionPositionStatus(status, "MANAGEMENT_REVIEW"),
        "REBALANCE_REQUESTED",
      );
    case "MANAGEMENT_REVIEW":
      return transitionPositionStatus(status, "REBALANCE_REQUESTED");
    case "HOLD":
      return transitionPositionStatus(
        transitionPositionStatus(status, "MANAGEMENT_REVIEW"),
        "REBALANCE_REQUESTED",
      );
    default:
      throw new Error(
        `Position status ${status} cannot transition to REBALANCE_REQUESTED`,
      );
  }
}

function buildClosingForRebalancePosition(input: {
  currentPosition: Position;
  actionId: string;
  reason: string;
  now: string;
}): Position {
  const requestedStatus = toRebalanceRequestedStatus(
    input.currentPosition.status,
  );

  return PositionSchema.parse({
    ...input.currentPosition,
    status: transitionPositionStatus(requestedStatus, "CLOSING_FOR_REBALANCE"),
    lastSyncedAt: input.now,
    lastManagementDecision: "REBALANCE",
    lastManagementReason: input.reason,
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

export async function processRebalanceAction(
  input: ProcessRebalanceActionInput,
): Promise<QueueExecutionResult> {
  assertRebalanceAction(input.action);

  const payload = RebalanceActionRequestPayloadSchema.parse(
    input.action.requestPayload,
  );
  const now = nowTimestamp(input.now);
  const currentPosition = await input.stateRepository.get(
    input.action.positionId,
  );

  if (currentPosition === null) {
    throw new Error(
      `Rebalance submission requires local position ${input.action.positionId}`,
    );
  }

  assertRebalanceRequestablePosition(currentPosition);

  if (
    input.runtimeControlStore !== undefined &&
    (await input.runtimeControlStore.snapshot()).stopAllDeploys.active
  ) {
    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "REBALANCE_BLOCKED_MANUAL_CIRCUIT_BREAKER",
      actor: input.action.requestedBy,
      wallet: input.action.wallet,
      positionId: input.action.positionId,
      actionId: input.action.actionId,
      before: toJournalRecord({
        actionId: input.action.actionId,
        requestPayload: payload,
      }),
      after: null,
      txIds: [],
      resultStatus: "ABORTED",
      error: "manual circuit breaker is active",
    });
    return {
      nextStatus: "ABORTED",
      txIds: [],
      resultPayload: null,
      error: "manual circuit breaker is active",
    };
  }

  let closeResult: z.infer<typeof CloseActionResultPayloadSchema> | null = null;

  try {
    closeResult = CloseActionResultPayloadSchema.parse(
      await input.dlmmGateway.closePosition({
        wallet: input.action.wallet,
        positionId: input.action.positionId,
        reason: payload.reason,
      }),
    );

    if (closeResult.closedPositionId !== input.action.positionId) {
      throw new Error(
        `Rebalance close submission returned mismatched positionId ${closeResult.closedPositionId} for ${input.action.positionId}`,
      );
    }
  } catch (error) {
    if (isAmbiguousSubmissionError(error)) {
      closeResult = CloseActionResultPayloadSchema.parse({
        actionType: "CLOSE",
        closedPositionId: input.action.positionId,
        txIds: error.txIds,
        submissionStatus: "maybe_submitted",
        submissionAmbiguous: true,
      });
      const reconciliationPosition = buildReconciliationRequiredPosition(
        currentPosition,
        input.action.actionId,
        now,
      );

      try {
        await input.stateRepository.upsert(reconciliationPosition);
      } catch {
        // Best effort; reconciliation can still rediscover the close leg.
      }

      await appendJournalEvent(input.journalRepository, {
        timestamp: now,
        eventType: "REBALANCE_CLOSE_SUBMISSION_AMBIGUOUS",
        actor: input.action.requestedBy,
        wallet: input.action.wallet,
        positionId: input.action.positionId,
        actionId: input.action.actionId,
        before: toJournalRecord({
          actionId: input.action.actionId,
          requestPayload: payload,
          position: currentPosition,
        }),
        after: toJournalRecord({
          position: reconciliationPosition,
          closeResult,
        }),
        txIds: error.txIds,
        resultStatus: "WAITING_CONFIRMATION",
        error: errorMessage(error, "rebalance close submission ambiguous"),
      });

      return {
        nextStatus: "WAITING_CONFIRMATION",
        txIds: error.txIds,
        resultPayload: toJournalRecord({
          phase: "CLOSE_SUBMITTED",
          closeResult,
        }),
        error: `Rebalance close submission ambiguous; reconciliation required: ${errorMessage(
          error,
          "ambiguous rebalance close submission",
        )}`,
      };
    }

    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "REBALANCE_CLOSE_SUBMISSION_FAILED",
      actor: input.action.requestedBy,
      wallet: input.action.wallet,
      positionId: input.action.positionId,
      actionId: input.action.actionId,
      before: toJournalRecord({
        actionId: input.action.actionId,
        requestPayload: payload,
      }),
      after: null,
      txIds: [],
      resultStatus: "FAILED",
      error: errorMessage(error, "rebalance close submission failed"),
    });
    throw error;
  }

  try {
    const closingPosition = buildClosingForRebalancePosition({
      currentPosition,
      actionId: input.action.actionId,
      reason: payload.reason,
      now,
    });
    const resultPayload = RebalanceCloseSubmittedPayloadSchema.parse({
      phase: "CLOSE_SUBMITTED",
      closeResult,
    });

    await input.stateRepository.upsert(closingPosition);
    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "REBALANCE_CLOSE_SUBMITTED",
      actor: input.action.requestedBy,
      wallet: input.action.wallet,
      positionId: input.action.positionId,
      actionId: input.action.actionId,
      before: toJournalRecord({
        actionId: input.action.actionId,
        position: currentPosition,
      }),
      after: toJournalRecord({
        actionId: input.action.actionId,
        position: closingPosition,
        resultPayload,
      }),
      txIds: closeResult.txIds,
      resultStatus: "WAITING_CONFIRMATION",
      error: null,
    });

    return {
      nextStatus: "WAITING_CONFIRMATION",
      txIds: closeResult.txIds,
      resultPayload: toJournalRecord(resultPayload),
      error: null,
    };
  } catch (error) {
    const reconciliationPosition = buildReconciliationRequiredPosition(
      currentPosition,
      input.action.actionId,
      now,
    );

    try {
      await input.stateRepository.upsert(reconciliationPosition);
    } catch {
      // Best effort only; the rebalance action still carries the target
      // positionId so reconciliation can recover the close leg later.
    }

    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "REBALANCE_CLOSE_REQUIRES_RECONCILIATION",
      actor: input.action.requestedBy,
      wallet: input.action.wallet,
      positionId: input.action.positionId,
      actionId: input.action.actionId,
      before: toJournalRecord({
        actionId: input.action.actionId,
        requestPayload: payload,
      }),
      after: toJournalRecord({
        position: reconciliationPosition,
        closeResult,
      }),
      txIds: closeResult.txIds,
      resultStatus: "WAITING_CONFIRMATION",
      error: errorMessage(
        error,
        "rebalance close submission requires reconciliation",
      ),
    });

    return {
      nextStatus: "WAITING_CONFIRMATION",
      txIds: closeResult.txIds,
      resultPayload: toJournalRecord({
        phase: "CLOSE_SUBMITTED",
        closeResult,
      }),
      error: `Rebalance close submitted but local persistence requires reconciliation: ${errorMessage(
        error,
        "unknown local persistence error",
      )}`,
    };
  }
}
