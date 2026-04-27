import { z } from "zod";

import {
  ActionStatusSchema,
  ActionTypeSchema,
  ActorSchema,
} from "../types/enums.js";

const TimestampSchema = z.string().datetime();

export const ActionSchema = z
  .object({
    actionId: z.string().min(1),
    type: ActionTypeSchema,
    status: ActionStatusSchema,
    wallet: z.string().min(1),
    positionId: z.string().min(1).nullable(),
    idempotencyKey: z.string().min(1),
    requestPayload: z.record(z.string(), z.unknown()),
    resultPayload: z.record(z.string(), z.unknown()).nullable(),
    txIds: z.array(z.string().min(1)),
    error: z.string().min(1).nullable(),
    requestedAt: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
    requestedBy: ActorSchema,
  })
  .superRefine((action, ctx) => {
    const positionScopedActionTypes = new Set([
      "CLOSE",
      "PARTIAL_CLOSE",
      "CLAIM_FEES",
      "REBALANCE",
      "CANCEL_REBALANCE",
    ]);
    const terminalStatuses = new Set([
      "DONE",
      "FAILED",
      "ABORTED",
      "TIMED_OUT",
    ]);

    if (terminalStatuses.has(action.status) && action.completedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: `must be set when status is ${action.status}`,
      });
    }

    if (!terminalStatuses.has(action.status) && action.completedAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: `must be null when status is ${action.status}`,
      });
    }

    const startedStatuses = new Set([
      "RUNNING",
      "WAITING_CONFIRMATION",
      "RECONCILING",
      "DONE",
      "FAILED",
      "TIMED_OUT",
      "RETRY_QUEUED",
    ]);

    if (startedStatuses.has(action.status) && action.startedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startedAt"],
        message: `must be set when status is ${action.status}`,
      });
    }

    if (action.type === "DEPLOY" && action.positionId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["positionId"],
        message: "must be null when type is DEPLOY",
      });
    }

    if (
      positionScopedActionTypes.has(action.type) &&
      action.positionId === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["positionId"],
        message: `must be set when type is ${action.type}`,
      });
    }
  })
  .strict();

export type Action = z.infer<typeof ActionSchema>;
