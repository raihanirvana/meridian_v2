import { z } from "zod";

import { CloseReasonSchema, StrategySchema } from "../types/enums.js";
import { TimestampSchema } from "../types/schemas.js";

export const PoolDeploySchema = z
  .object({
    deployedAt: TimestampSchema,
    closedAt: TimestampSchema,
    pnlPct: z.number(),
    pnlUsd: z.number(),
    rangeEfficiencyPct: z.number().min(0).max(100),
    minutesHeld: z.number().int().min(0),
    closeReason: CloseReasonSchema,
    strategy: StrategySchema,
    volatilityAtDeploy: z.number(),
  })
  .strict();

export const PoolSnapshotSchema = z
  .object({
    ts: TimestampSchema,
    positionId: z.string().min(1),
    pnlPct: z.number(),
    pnlUsd: z.number(),
    inRange: z.boolean(),
    unclaimedFeesUsd: z.number().min(0),
    minutesOutOfRange: z.number().int().min(0),
    ageMinutes: z.number().int().min(0),
  })
  .strict();

export const PoolMemoryNoteSchema = z
  .object({
    note: z.string().min(1).max(500),
    addedAt: TimestampSchema,
  })
  .strict();

export const PoolMemoryEntrySchema = z
  .object({
    poolAddress: z.string().min(1),
    name: z.string().min(1),
    baseMint: z.string().min(1).nullable(),
    totalDeploys: z.number().int().min(0),
    deploys: PoolDeploySchema.array().max(50),
    avgPnlPct: z.number(),
    winRatePct: z.number().min(0).max(100),
    lastDeployedAt: TimestampSchema.nullable(),
    lastOutcome: z.enum(["profit", "loss"]).nullable(),
    notes: PoolMemoryNoteSchema.array(),
    snapshots: PoolSnapshotSchema.array().max(48),
    cooldownUntil: TimestampSchema.optional(),
  })
  .strict();

export type PoolDeploy = z.infer<typeof PoolDeploySchema>;
export type PoolSnapshot = z.infer<typeof PoolSnapshotSchema>;
export type PoolMemoryNote = z.infer<typeof PoolMemoryNoteSchema>;
export type PoolMemoryEntry = z.infer<typeof PoolMemoryEntrySchema>;
