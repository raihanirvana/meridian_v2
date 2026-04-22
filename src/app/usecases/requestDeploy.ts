import { z } from "zod";

import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { RuntimeControlStore } from "../../adapters/storage/RuntimeControlStore.js";
import type { Action } from "../../domain/entities/Action.js";
import { PositionEntryMetadataSchema } from "../../domain/entities/Position.js";
import type { Actor } from "../../domain/types/enums.js";
import type { ActionQueue } from "../services/ActionQueue.js";
import { createIdempotencyKey } from "../services/ActionService.js";

export const DeployActionRequestPayloadSchema = z
  .object({
    poolAddress: z.string().min(1),
    tokenXMint: z.string().min(1),
    tokenYMint: z.string().min(1),
    baseMint: z.string().min(1),
    quoteMint: z.string().min(1),
    amountBase: z.number().nonnegative(),
    amountQuote: z.number().nonnegative(),
    strategy: z.string().min(1),
    rangeLowerBin: z.number().int(),
    rangeUpperBin: z.number().int(),
    initialActiveBin: z.number().int().nullable(),
    estimatedValueUsd: z.number().nonnegative(),
    entryMetadata: PositionEntryMetadataSchema.optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.rangeLowerBin >= payload.rangeUpperBin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rangeUpperBin"],
        message: "must be greater than rangeLowerBin",
      });
    }
  });

export type DeployActionRequestPayload = z.infer<
  typeof DeployActionRequestPayloadSchema
>;

export interface RequestDeployInput {
  actionQueue: ActionQueue;
  wallet: string;
  payload: DeployActionRequestPayload;
  requestedBy: Actor;
  requestedAt?: string;
  idempotencyKey?: string;
  journalRepository?: JournalRepository;
  runtimeControlStore?: RuntimeControlStore;
}

function buildDeployJournalPayload(action: Action): Record<string, unknown> {
  return {
    actionId: action.actionId,
    type: action.type,
    status: action.status,
    requestPayload: action.requestPayload,
    idempotencyKey: action.idempotencyKey,
  };
}

export async function requestDeploy(input: RequestDeployInput): Promise<Action> {
  const payload = DeployActionRequestPayloadSchema.parse(input.payload);
  const journalTimestamp = input.requestedAt ?? new Date().toISOString();
  if (
    input.runtimeControlStore !== undefined &&
    (await input.runtimeControlStore.snapshot()).stopAllDeploys.active
  ) {
    throw new Error("manual circuit breaker is active; deploy requests are blocked");
  }
  const idempotencyKey =
    input.idempotencyKey ??
    createIdempotencyKey({
      wallet: input.wallet,
      type: "DEPLOY",
      positionId: null,
      requestPayload: payload,
    });

  const action = await input.actionQueue.enqueue({
    type: "DEPLOY",
    wallet: input.wallet,
    positionId: null,
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
      eventType: "DEPLOY_REQUEST_ACCEPTED",
      actor: action.requestedBy,
      wallet: action.wallet,
      positionId: action.positionId,
      actionId: action.actionId,
      before: null,
      after: buildDeployJournalPayload(action),
      txIds: [],
      resultStatus: action.status,
      error: null,
    });
  }

  return action;
}
