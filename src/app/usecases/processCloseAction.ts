import { z } from "zod";

import {
  ClosePositionResultSchema,
  isAmbiguousSubmissionError,
  type DlmmGateway,
} from "../../adapters/dlmm/DlmmGateway.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
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
  CloseActionRequestPayloadSchema,
  assertCloseRequestablePosition,
} from "./requestClose.js";

const CloseActionResultPayloadSchema = ClosePositionResultSchema;

export interface ProcessCloseActionInput {
  action: Action;
  dlmmGateway: DlmmGateway;
  stateRepository: StateRepository;
  journalRepository?: JournalRepository;
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

function toCloseRequestedStatus(
  status: Position["status"],
): Position["status"] {
  switch (status) {
    case "OPEN":
      return transitionPositionStatus(
        transitionPositionStatus(status, "MANAGEMENT_REVIEW"),
        "CLOSE_REQUESTED",
      );
    case "MANAGEMENT_REVIEW":
    case "HOLD":
    case "PARTIAL_CLOSE_CONFIRMED":
      return transitionPositionStatus(status, "CLOSE_REQUESTED");
    default:
      throw new Error(
        `Position status ${status} cannot transition to CLOSE_REQUESTED`,
      );
  }
}

function buildClosingPosition(input: {
  currentPosition: Position;
  actionId: string;
  reason: string;
  now: string;
}): Position {
  const closeRequestedStatus = toCloseRequestedStatus(
    input.currentPosition.status,
  );

  return PositionSchema.parse({
    ...input.currentPosition,
    status: transitionPositionStatus(closeRequestedStatus, "CLOSING"),
    lastSyncedAt: input.now,
    lastManagementDecision: "CLOSE",
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

export async function processCloseAction(
  input: ProcessCloseActionInput,
): Promise<QueueExecutionResult> {
  assertCloseAction(input.action);

  const payload = CloseActionRequestPayloadSchema.parse(
    input.action.requestPayload,
  );
  const now = nowTimestamp(input.now);
  const currentPosition = await input.stateRepository.get(
    input.action.positionId,
  );

  if (currentPosition === null) {
    throw new Error(
      `Close submission requires local position ${input.action.positionId}`,
    );
  }

  assertCloseRequestablePosition(currentPosition);

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
        `Close submission returned mismatched positionId ${closeResult.closedPositionId} for ${input.action.positionId}`,
      );
    }
  } catch (error) {
    if (isAmbiguousSubmissionError(error)) {
      const reconciliationPosition = buildReconciliationRequiredPosition(
        currentPosition,
        input.action.actionId,
        now,
      );

      try {
        await input.stateRepository.upsert(reconciliationPosition);
      } catch {
        // Best effort; reconciliation worker will rediscover via wallet snapshot.
      }

      await appendJournalEvent(input.journalRepository, {
        timestamp: now,
        eventType: "CLOSE_SUBMISSION_AMBIGUOUS",
        actor: input.action.requestedBy,
        wallet: input.action.wallet,
        positionId: input.action.positionId,
        actionId: input.action.actionId,
        before: toJournalRecord({
          actionId: input.action.actionId,
          requestPayload: payload,
          position: currentPosition,
        }),
        after: toJournalRecord({ position: reconciliationPosition }),
        txIds: error.txIds,
        resultStatus: "WAITING_CONFIRMATION",
        error: errorMessage(error, "close submission ambiguous"),
      });

      return {
        nextStatus: "WAITING_CONFIRMATION",
        txIds: error.txIds,
        resultPayload: toJournalRecord({
          actionType: "CLOSE",
          closedPositionId: input.action.positionId,
          txIds: error.txIds,
          submissionAmbiguous: true,
        }),
        error: `Close submission ambiguous; reconciliation required: ${errorMessage(
          error,
          "ambiguous close submission",
        )}`,
      };
    }

    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "CLOSE_SUBMISSION_FAILED",
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
      error: errorMessage(error, "close submission failed"),
    });
    throw error;
  }

  try {
    const closingPosition = buildClosingPosition({
      currentPosition,
      actionId: input.action.actionId,
      reason: payload.reason,
      now,
    });

    await input.stateRepository.upsert(closingPosition);
    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "CLOSE_SUBMITTED",
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
        closeResult,
      }),
      txIds: closeResult.txIds,
      resultStatus: "WAITING_CONFIRMATION",
      error: null,
    });

    return {
      nextStatus: "WAITING_CONFIRMATION",
      txIds: closeResult.txIds,
      resultPayload: toJournalRecord(closeResult),
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
      // Best effort only; the action payload still carries the target positionId
      // so reconciliation can recover the submitted close later.
    }

    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "CLOSE_SUBMITTED_REQUIRES_RECONCILIATION",
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
      error: errorMessage(error, "close submission requires reconciliation"),
    });

    return {
      nextStatus: "WAITING_CONFIRMATION",
      txIds: closeResult.txIds,
      resultPayload: toJournalRecord(closeResult),
      error: `Close submitted but local persistence requires reconciliation: ${errorMessage(
        error,
        "unknown local persistence error",
      )}`,
    };
  }
}
