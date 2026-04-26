import { z } from "zod";

import { PositionStatusSchema, StrategySchema } from "../types/enums.js";

const TimestampSchema = z.string().datetime();

const REQUIRES_OPENED_AT_STATUSES = new Set([
  "OPEN",
  "MANAGEMENT_REVIEW",
  "HOLD",
  "CLAIM_REQUESTED",
  "CLAIMING",
  "CLAIM_CONFIRMED",
  "PARTIAL_CLOSE_REQUESTED",
  "PARTIAL_CLOSING",
  "PARTIAL_CLOSE_CONFIRMED",
  "REBALANCE_REQUESTED",
  "CLOSING_FOR_REBALANCE",
  "CLOSE_REQUESTED",
  "CLOSING",
  "CLOSE_CONFIRMED",
  "CLOSED",
]);

const RECONCILIATION_STATUSES = new Set([
  "RECONCILIATION_REQUIRED",
  "RECONCILING",
]);

export const PositionEntryMetadataSchema = z
  .object({
    poolName: z.string().min(1).optional(),
    binStep: z.number().int().positive().optional(),
    activeBinAtEntry: z.number().int().optional(),
    poolTvlUsd: z.number().nonnegative().optional(),
    volume5mUsd: z.number().nonnegative().optional(),
    volume15mUsd: z.number().nonnegative().optional(),
    volume1hUsd: z.number().nonnegative().optional(),
    volume24hUsd: z.number().nonnegative().optional(),
    fees15mUsd: z.number().nonnegative().optional(),
    fees1hUsd: z.number().nonnegative().optional(),
    feeTvlRatio24h: z.number().nonnegative().optional(),
    priceChange5mPct: z.number().optional(),
    priceChange15mPct: z.number().optional(),
    priceChange1hPct: z.number().optional(),
    volatility15mPct: z.number().nonnegative().optional(),
    liquidityDepthNearActive: z
      .enum(["shallow", "medium", "deep", "unknown"])
      .optional(),
    trendDirection: z.enum(["up", "down", "sideways", "unknown"]).optional(),
    trendStrength: z.enum(["weak", "medium", "strong", "unknown"]).optional(),
    meanReversionSignal: z
      .enum(["weak", "medium", "strong", "unknown"])
      .optional(),
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
    currentValueQuote: z.number().nonnegative().optional(),
    currentValueUsd: z.number().nonnegative(),
    feesClaimedBase: z.number().nonnegative(),
    feesClaimedUsd: z.number().nonnegative(),
    realizedPnlBase: z.number(),
    realizedPnlUsd: z.number(),
    unrealizedPnlBase: z.number(),
    unrealizedPnlUsd: z.number(),
    peakPnlPct: z.number().nullable().optional(),
    peakPnlRecordedAt: TimestampSchema.nullable().optional(),
    lastRebalanceAt: TimestampSchema.nullable().optional(),
    rebalanceCount: z.number().int().nonnegative(),
    partialCloseCount: z.number().int().nonnegative(),
    strategy: StrategySchema,
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

    if (
      REQUIRES_OPENED_AT_STATUSES.has(position.status) &&
      position.openedAt === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openedAt"],
        message: `must be set when status is ${position.status}`,
      });
    }

    const activeBinKnownAndOutOfRange =
      position.activeBin !== null &&
      (position.activeBin < position.rangeLowerBin ||
        position.activeBin > position.rangeUpperBin);
    if (activeBinKnownAndOutOfRange && position.outOfRangeSince === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outOfRangeSince"],
        message: "must be set when activeBin is outside the current range",
      });
    }

    if (
      RECONCILIATION_STATUSES.has(position.status) &&
      !position.needsReconciliation
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["needsReconciliation"],
        message: `must be true when status is ${position.status}`,
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
