import { z } from "zod";

import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { Position } from "../../domain/entities/Position.js";
import type { Actor } from "../../domain/types/enums.js";
import type { ActionQueue } from "../services/ActionQueue.js";
import { createIdempotencyKey } from "../services/ActionService.js";

import {
  DeployActionRequestPayloadSchema,
  type DeployActionRequestPayload,
} from "./requestDeploy.js";

export const RebalanceActionRequestPayloadSchema = z.object({
  reason: z.string().min(1),
  redeploy: DeployActionRequestPayloadSchema,
});

export type RebalanceActionRequestPayload = z.infer<
  typeof RebalanceActionRequestPayloadSchema
>;

export interface RequestRebalanceInput {
  actionQueue: ActionQueue;
  stateRepository: StateRepository;
  wallet: string;
  positionId: string;
  payload: RebalanceActionRequestPayload;
  requestedBy: Actor;
  requestedAt?: string;
  idempotencyKey?: string;
  journalRepository?: JournalRepository;
}

const REBALANCE_REQUESTABLE_STATUSES = new Set<Position["status"]>([
  "OPEN",
  "MANAGEMENT_REVIEW",
  "HOLD",
]);

function buildRebalanceJournalPayload(input: {
  actionId: string;
  positionId: string;
  status: string;
  idempotencyKey: string;
  requestPayload: RebalanceActionRequestPayload;
}): Record<string, unknown> {
  return {
    actionId: input.actionId,
    positionId: input.positionId,
    status: input.status,
    idempotencyKey: input.idempotencyKey,
    requestPayload: input.requestPayload,
  };
}

export function assertRebalanceRequestablePosition(position: Position): void {
  if (!REBALANCE_REQUESTABLE_STATUSES.has(position.status)) {
    throw new Error(
      `Position ${position.positionId} is not rebalance-requestable from status ${position.status}`,
    );
  }
}

export function deriveRebalanceCapitalRequirement(
  redeploy: DeployActionRequestPayload,
): number {
  return Math.max(redeploy.estimatedValueUsd, 0);
}

export async function requestRebalance(input: RequestRebalanceInput) {
  const payload = RebalanceActionRequestPayloadSchema.parse(input.payload);
  const journalTimestamp = input.requestedAt ?? new Date().toISOString();
  const position = await input.stateRepository.get(input.positionId);

  if (position === null) {
    throw new Error(
      `Position not found for rebalance request: ${input.positionId}`,
    );
  }

  if (position.wallet !== input.wallet) {
    throw new Error(
      `Rebalance request wallet mismatch for position ${input.positionId}: expected ${position.wallet}, received ${input.wallet}`,
    );
  }

  assertRebalanceRequestablePosition(position);

  const idempotencyKey =
    input.idempotencyKey ??
    createIdempotencyKey({
      wallet: input.wallet,
      type: "REBALANCE",
      positionId: input.positionId,
      requestPayload: payload,
    });

  const action = await input.actionQueue.enqueue({
    type: "REBALANCE",
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
      eventType: "REBALANCE_REQUEST_ACCEPTED",
      actor: action.requestedBy,
      wallet: action.wallet,
      positionId: action.positionId,
      actionId: action.actionId,
      before: null,
      after: buildRebalanceJournalPayload({
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
