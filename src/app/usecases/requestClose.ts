import { z } from "zod";

import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { Position } from "../../domain/entities/Position.js";
import type { Actor } from "../../domain/types/enums.js";
import type { ActionQueue } from "../services/ActionQueue.js";
import { createIdempotencyKey } from "../services/ActionService.js";

export const CloseActionRequestPayloadSchema = z.object({
  reason: z.string().min(1),
});

export type CloseActionRequestPayload = z.infer<
  typeof CloseActionRequestPayloadSchema
>;

export interface RequestCloseInput {
  actionQueue: ActionQueue;
  stateRepository: StateRepository;
  wallet: string;
  positionId: string;
  payload: CloseActionRequestPayload;
  requestedBy: Actor;
  requestedAt?: string;
  idempotencyKey?: string;
  journalRepository?: JournalRepository;
}

const CLOSE_REQUESTABLE_STATUSES = new Set<Position["status"]>([
  "OPEN",
  "MANAGEMENT_REVIEW",
  "HOLD",
  "PARTIAL_CLOSE_CONFIRMED",
]);

function buildCloseJournalPayload(input: {
  actionId: string;
  positionId: string;
  status: string;
  idempotencyKey: string;
  requestPayload: CloseActionRequestPayload;
}): Record<string, unknown> {
  return {
    actionId: input.actionId,
    positionId: input.positionId,
    status: input.status,
    idempotencyKey: input.idempotencyKey,
    requestPayload: input.requestPayload,
  };
}

export function assertCloseRequestablePosition(position: Position): void {
  if (!CLOSE_REQUESTABLE_STATUSES.has(position.status)) {
    throw new Error(
      `Position ${position.positionId} is not close-requestable from status ${position.status}`,
    );
  }
}

export async function requestClose(input: RequestCloseInput) {
  const payload = CloseActionRequestPayloadSchema.parse(input.payload);
  const journalTimestamp = input.requestedAt ?? new Date().toISOString();
  const position = await input.stateRepository.get(input.positionId);

  if (position === null) {
    throw new Error(`Position not found for close request: ${input.positionId}`);
  }

  if (position.wallet !== input.wallet) {
    throw new Error(
      `Close request wallet mismatch for position ${input.positionId}: expected ${position.wallet}, received ${input.wallet}`,
    );
  }

  assertCloseRequestablePosition(position);

  const idempotencyKey =
    input.idempotencyKey ??
    createIdempotencyKey({
      wallet: input.wallet,
      type: "CLOSE",
      positionId: input.positionId,
      requestPayload: payload,
    });

  const action = await input.actionQueue.enqueue({
    type: "CLOSE",
    wallet: input.wallet,
    positionId: input.positionId,
    idempotencyKey,
    requestPayload: payload,
    requestedBy: input.requestedBy,
    ...(input.requestedAt === undefined
      ? {}
      : { requestedAt: input.requestedAt }),
  });

  if (input.journalRepository !== undefined) {
    await input.journalRepository.append({
      timestamp: journalTimestamp,
      eventType: "CLOSE_REQUEST_ACCEPTED",
      actor: action.requestedBy,
      wallet: action.wallet,
      positionId: action.positionId,
      actionId: action.actionId,
      before: null,
      after: buildCloseJournalPayload({
        actionId: action.actionId,
        positionId: input.positionId,
        status: action.status,
        idempotencyKey: action.idempotencyKey,
        requestPayload: payload,
      }),
      txIds: [],
      resultStatus: action.status,
      error: null,
    });
  }

  return action;
}
