import { z } from "zod";

import { PositionStatusSchema } from "../types/enums.js";

const TimestampSchema = z.string().datetime();

export const PositionEntryMetadataSchema = z
  .object({
    poolName: z.string().min(1).optional(),
    binStep: z.number().int().positive().optional(),
    volatility: z.number().nonnegative().optional(),
    feeTvlRatio: z.number().nonnegative().optional(),
    organicScore: z.number().nonnegative().optional(),
    amountSol: z.number().nonnegative().optional(),
  })
  .strict();

export const PositionSchema = z
  .object({
    positionId: z.string().min(1),
    poolAddress: z.string().min(1),
    tokenXMint: z.string().min(1),
    tokenYMint: z.string().min(1),
    baseMint: z.string().min(1),
    quoteMint: z.string().min(1),
    wallet: z.string().min(1),
    status: PositionStatusSchema,
    openedAt: TimestampSchema.nullable(),
    lastSyncedAt: TimestampSchema.nullable(),
    closedAt: TimestampSchema.nullable(),
    deployAmountBase: z.number().nonnegative(),
    deployAmountQuote: z.number().nonnegative(),
    currentValueBase: z.number().nonnegative(),
    currentValueUsd: z.number().nonnegative(),
    feesClaimedBase: z.number().nonnegative(),
    feesClaimedUsd: z.number().nonnegative(),
    realizedPnlBase: z.number(),
    realizedPnlUsd: z.number(),
    unrealizedPnlBase: z.number(),
    unrealizedPnlUsd: z.number(),
    peakPnlPct: z.number().nullable().optional(),
    peakPnlRecordedAt: TimestampSchema.nullable().optional(),
    rebalanceCount: z.number().int().nonnegative(),
    partialCloseCount: z.number().int().nonnegative(),
    strategy: z.string().min(1),
    rangeLowerBin: z.number().int(),
    rangeUpperBin: z.number().int(),
    activeBin: z.number().int().nullable(),
    outOfRangeSince: TimestampSchema.nullable(),
    lastManagementDecision: z.string().min(1).nullable(),
    lastManagementReason: z.string().min(1).nullable(),
    lastWriteActionId: z.string().min(1).nullable(),
    needsReconciliation: z.boolean(),
    entryMetadata: PositionEntryMetadataSchema.optional(),
  })
  .superRefine((position, ctx) => {
    if (position.status === "CLOSED" && position.closedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closedAt"],
        message: "must be set when status is CLOSED",
      });
    }

    if (position.status === "OPEN" && position.openedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openedAt"],
        message: "must be set when status is OPEN",
      });
    }

    if (position.rangeLowerBin >= position.rangeUpperBin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rangeUpperBin"],
        message: "must be greater than rangeLowerBin",
      });
    }

    const activeBinInRange =
      position.activeBin !== null &&
      position.activeBin >= position.rangeLowerBin &&
      position.activeBin <= position.rangeUpperBin;
    if (activeBinInRange && position.outOfRangeSince !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outOfRangeSince"],
        message: "must be null when activeBin is inside the current range",
      });
    }

    if (
      position.peakPnlPct !== undefined &&
      position.peakPnlPct !== null &&
      position.peakPnlRecordedAt === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["peakPnlRecordedAt"],
        message: "must be present when peakPnlPct is set",
      });
    }
  })
  .strict();

export type Position = z.infer<typeof PositionSchema>;
export type PositionEntryMetadata = z.infer<typeof PositionEntryMetadataSchema>;
