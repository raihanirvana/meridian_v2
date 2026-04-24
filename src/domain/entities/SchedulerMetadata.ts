import { z } from "zod";

import { TimestampSchema } from "../types/schemas.js";

export const SchedulerWorkerNameSchema = z.enum([
  "screening",
  "management",
  "reconciliation",
  "reporting",
]);

export const SchedulerTriggerSourceSchema = z.enum([
  "cron",
  "manual",
  "startup",
]);

export const SchedulerWorkerRunStatusSchema = z.enum([
  "IDLE",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED_ALREADY_RUNNING",
]);

export const SchedulerWorkerStateSchema = z
  .object({
    worker: SchedulerWorkerNameSchema,
    status: SchedulerWorkerRunStatusSchema,
    lastTriggerSource: SchedulerTriggerSourceSchema.nullable(),
    lastStartedAt: TimestampSchema.nullable(),
    lastCompletedAt: TimestampSchema.nullable(),
    lastError: z.string().min(1).nullable(),
    runCount: z.number().int().nonnegative(),
    manualRunCount: z.number().int().nonnegative(),
    intervalSec: z.number().int().positive().nullable(),
    nextDueAt: TimestampSchema.nullable(),
  })
  .strict();

export const SchedulerMetadataSchema = z
  .object({
    workers: z
      .object({
        screening: SchedulerWorkerStateSchema,
        management: SchedulerWorkerStateSchema,
        reconciliation: SchedulerWorkerStateSchema,
        reporting: SchedulerWorkerStateSchema,
      })
      .strict(),
  })
  .strict();

export type SchedulerWorkerName = z.infer<typeof SchedulerWorkerNameSchema>;
export type SchedulerTriggerSource = z.infer<
  typeof SchedulerTriggerSourceSchema
>;
export type SchedulerWorkerRunStatus = z.infer<
  typeof SchedulerWorkerRunStatusSchema
>;
export type SchedulerWorkerState = z.infer<typeof SchedulerWorkerStateSchema>;
export type SchedulerMetadata = z.infer<typeof SchedulerMetadataSchema>;

export function createDefaultSchedulerWorkerState(
  worker: SchedulerWorkerName,
): SchedulerWorkerState {
  return SchedulerWorkerStateSchema.parse({
    worker,
    status: "IDLE",
    lastTriggerSource: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    runCount: 0,
    manualRunCount: 0,
    intervalSec: null,
    nextDueAt: null,
  });
}

export function createDefaultSchedulerMetadata(): SchedulerMetadata {
  return SchedulerMetadataSchema.parse({
    workers: {
      screening: createDefaultSchedulerWorkerState("screening"),
      management: createDefaultSchedulerWorkerState("management"),
      reconciliation: createDefaultSchedulerWorkerState("reconciliation"),
      reporting: createDefaultSchedulerWorkerState("reporting"),
    },
  });
}
