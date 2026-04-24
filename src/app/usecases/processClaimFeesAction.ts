import { z } from "zod";

import {
  ClaimFeesResultSchema,
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
  ClaimFeesActionRequestPayloadSchema,
  assertClaimFeesRequestablePosition,
} from "./requestClaimFees.js";
import { PositionEntryMetadataSchema } from "../../domain/entities/Position.js";

const ClaimFeesActionResultPayloadSchema = ClaimFeesResultSchema;

const CompoundDeployTemplateSchema = z
  .object({
    poolAddress: z.string().min(1),
    tokenXMint: z.string().min(1),
    tokenYMint: z.string().min(1),
    baseMint: z.string().min(1),
    quoteMint: z.string().min(1),
    strategy: z.string().min(1),
    rangeLowerBin: z.number().int(),
    rangeUpperBin: z.number().int(),
    initialActiveBin: z.number().int().nullable(),
    entryMetadata: PositionEntryMetadataSchema.optional(),
  })
  .strict();

function buildCompoundDeployTemplate(position: Position) {
  return CompoundDeployTemplateSchema.parse({
    poolAddress: position.poolAddress,
    tokenXMint: position.tokenXMint,
    tokenYMint: position.tokenYMint,
    baseMint: position.baseMint,
    quoteMint: position.quoteMint,
    strategy: position.strategy,
    rangeLowerBin: position.rangeLowerBin,
    rangeUpperBin: position.rangeUpperBin,
    initialActiveBin: position.activeBin,
    ...(position.entryMetadata === undefined
      ? {}
      : { entryMetadata: position.entryMetadata }),
  });
}

export interface ProcessClaimFeesActionInput {
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

function assertClaimAction(action: Action): asserts action is Action & {
  type: "CLAIM_FEES";
  positionId: string;
} {
  if (action.type !== "CLAIM_FEES" || action.positionId === null) {
    throw new Error(
      `Expected CLAIM_FEES action with positionId, received ${action.type}/${action.positionId}`,
    );
  }
}

function toClaimRequestedStatus(
  status: Position["status"],
): Position["status"] {
  switch (status) {
    case "OPEN":
      return transitionPositionStatus(
        transitionPositionStatus(status, "MANAGEMENT_REVIEW"),
        "CLAIM_REQUESTED",
      );
    case "MANAGEMENT_REVIEW":
    case "HOLD":
    case "PARTIAL_CLOSE_CONFIRMED":
      return transitionPositionStatus(status, "CLAIM_REQUESTED");
    default:
      throw new Error(
        `Position status ${status} cannot transition to CLAIM_REQUESTED`,
      );
  }
}

function buildClaimingPosition(input: {
  currentPosition: Position;
  actionId: string;
  reason: string;
  now: string;
}): Position {
  const requestedStatus = toClaimRequestedStatus(input.currentPosition.status);
  return PositionSchema.parse({
    ...input.currentPosition,
    status: transitionPositionStatus(requestedStatus, "CLAIMING"),
    lastSyncedAt: input.now,
    lastManagementDecision: "CLAIM_FEES",
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

export async function processClaimFeesAction(
  input: ProcessClaimFeesActionInput,
): Promise<QueueExecutionResult> {
  assertClaimAction(input.action);

  const payload = ClaimFeesActionRequestPayloadSchema.parse(
    input.action.requestPayload,
  );
  const now = nowTimestamp(input.now);
  const currentPosition = await input.stateRepository.get(
    input.action.positionId,
  );

  if (currentPosition === null) {
    throw new Error(
      `Claim submission requires local position ${input.action.positionId}`,
    );
  }

  assertClaimFeesRequestablePosition(currentPosition);

  let claimResult: z.infer<typeof ClaimFeesActionResultPayloadSchema> | null =
    null;

  try {
    claimResult = ClaimFeesActionResultPayloadSchema.parse(
      await input.dlmmGateway.claimFees({
        wallet: input.action.wallet,
        positionId: input.action.positionId,
      }),
    );
  } catch (error) {
    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "CLAIM_SUBMISSION_FAILED",
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
      error: errorMessage(error, "claim submission failed"),
    });
    throw error;
  }

  try {
    const claimingPosition = buildClaimingPosition({
      currentPosition,
      actionId: input.action.actionId,
      reason: payload.reason,
      now,
    });
    await input.stateRepository.upsert(claimingPosition);

    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "CLAIM_SUBMITTED",
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
        position: claimingPosition,
        claimResult,
      }),
      txIds: claimResult.txIds,
      resultStatus: "WAITING_CONFIRMATION",
      error: null,
    });

    return {
      nextStatus: "WAITING_CONFIRMATION",
      txIds: claimResult.txIds,
      resultPayload: toJournalRecord({
        ...claimResult,
        reason: payload.reason,
        autoSwapOutputMint: payload.autoSwapOutputMint ?? null,
        autoCompound:
          payload.autoCompound === undefined || payload.autoCompound === null
            ? null
            : {
                outputMint: payload.autoCompound.outputMint,
                phase: "PENDING_SWAP",
                deployTemplate: buildCompoundDeployTemplate(currentPosition),
              },
      }),
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
      // Best effort only; reconciliation can recover from action payload.
    }

    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "CLAIM_SUBMITTED_REQUIRES_RECONCILIATION",
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
        claimResult,
      }),
      txIds: claimResult.txIds,
      resultStatus: "WAITING_CONFIRMATION",
      error: errorMessage(error, "claim submission requires reconciliation"),
    });

    return {
      nextStatus: "WAITING_CONFIRMATION",
      txIds: claimResult.txIds,
      resultPayload: toJournalRecord({
        ...claimResult,
        reason: payload.reason,
        autoSwapOutputMint: payload.autoSwapOutputMint ?? null,
        autoCompound:
          payload.autoCompound === undefined || payload.autoCompound === null
            ? null
            : {
                outputMint: payload.autoCompound.outputMint,
                phase: "PENDING_SWAP",
                deployTemplate: buildCompoundDeployTemplate(currentPosition),
              },
      }),
      error: `Claim submitted but local persistence requires reconciliation: ${errorMessage(
        error,
        "unknown local persistence error",
      )}`,
    };
  }
}
