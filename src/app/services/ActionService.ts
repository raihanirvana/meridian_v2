import { createHash, randomUUID } from "node:crypto";

import { ActionSchema, type Action } from "../../domain/entities/Action.js";
import { type Actor, type ActionType } from "../../domain/types/enums.js";

export interface CreateQueuedActionInput {
  type: ActionType;
  wallet: string;
  positionId?: string | null;
  idempotencyKey: string;
  requestPayload: Record<string, unknown>;
  requestedBy: Actor;
  requestedAt?: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([leftKey], [rightKey]) => leftKey.localeCompare(rightKey),
  );

  return `{${entries
    .map(
      ([key, nestedValue]) =>
        `${JSON.stringify(key)}:${stableStringify(nestedValue)}`,
    )
    .join(",")}}`;
}

export function createIdempotencyKey(input: {
  wallet: string;
  type: ActionType;
  positionId?: string | null;
  requestPayload: Record<string, unknown>;
}): string {
  const fingerprint = createHash("sha256")
    .update(
      stableStringify({
        wallet: input.wallet,
        type: input.type,
        positionId: input.positionId ?? null,
        requestPayload: input.requestPayload,
      }),
    )
    .digest("hex")
    .slice(0, 24);

  const positionPart = input.positionId ?? "none";
  return `${input.wallet}:${input.type}:${positionPart}:${fingerprint}`;
}

export function createQueuedAction(input: CreateQueuedActionInput): Action {
  return ActionSchema.parse({
    actionId: randomUUID(),
    type: input.type,
    status: "QUEUED",
    wallet: input.wallet,
    positionId: input.positionId ?? null,
    idempotencyKey: input.idempotencyKey,
    requestPayload: input.requestPayload,
    resultPayload: null,
    txIds: [],
    error: null,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    requestedBy: input.requestedBy,
  });
}
