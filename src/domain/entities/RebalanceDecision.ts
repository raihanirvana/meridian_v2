import { z } from "zod";

export const RebalancePlannerActionSchema = z.enum([
  "hold",
  "claim_only",
  "rebalance_same_pool",
  "exit",
]);

export const RebalanceRiskLevelSchema = z.enum(["low", "medium", "high"]);

export const RebalancePlanSchema = z
  .object({
    strategy: z.enum(["spot", "curve", "bid_ask"]),
    binsBelow: z.number().int().nonnegative(),
    binsAbove: z.number().int().nonnegative(),
    slippageBps: z.number().int().nonnegative(),
    maxPositionAgeMinutes: z.number().int().nonnegative(),
    stopLossPct: z.number().nonnegative(),
    takeProfitPct: z.number().nonnegative(),
    trailingStopPct: z.number().nonnegative(),
  })
  .strict();

export const AiRebalanceDecisionSchema = z
  .object({
    action: RebalancePlannerActionSchema,
    confidence: z.number().min(0).max(1),
    riskLevel: RebalanceRiskLevelSchema,
    reason: z.array(z.string().min(1)),
    rebalancePlan: RebalancePlanSchema.nullable(),
    rejectIf: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (
      decision.action === "rebalance_same_pool" &&
      decision.rebalancePlan === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rebalancePlan"],
        message: "must be present when action is rebalance_same_pool",
      });
    }

    if (
      decision.action !== "rebalance_same_pool" &&
      decision.rebalancePlan !== null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rebalancePlan"],
        message: "must be null unless action is rebalance_same_pool",
      });
    }
  });

export const RebalancePositionSnapshotSchema = z
  .object({
    positionId: z.string().min(1),
    poolAddress: z.string().min(1),
    strategy: z.string().min(1),
    lowerBin: z.number().int(),
    upperBin: z.number().int(),
    activeBinAtEntry: z.number().int().nullable(),
    currentActiveBin: z.number().int().nullable(),
    binStep: z.number().int().positive().nullable(),
    ageMinutes: z.number().int().nonnegative(),
    outOfRangeMinutes: z.number().int().nonnegative(),
    positionValueUsd: z.number().nonnegative(),
    unclaimedFeesUsd: z.number().nonnegative(),
    pnlPct: z.number(),
    rebalanceCount: z.number().int().nonnegative(),
    lastRebalanceAgeMinutes: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional(),
    partialCloseCount: z.number().int().nonnegative(),
  })
  .strict();

export const RebalancePoolSnapshotSchema = z
  .object({
    poolAddress: z.string().min(1),
    tvlUsd: z.number().nonnegative(),
    volume5mUsd: z.number().nonnegative(),
    volume15mUsd: z.number().nonnegative(),
    volume1hUsd: z.number().nonnegative(),
    volume24hUsd: z.number().nonnegative(),
    fees15mUsd: z.number().nonnegative(),
    fees1hUsd: z.number().nonnegative(),
    feeTvlRatio24h: z.number().nonnegative(),
    liquidityDepthNearActive: z.enum(["shallow", "medium", "deep", "unknown"]),
    priceChange5mPct: z.number(),
    priceChange15mPct: z.number(),
    priceChange1hPct: z.number(),
    volatility15m: z.number().nonnegative(),
    trendDirection: z.enum(["up", "down", "sideways", "unknown"]),
    trendStrength: z.enum(["weak", "medium", "strong", "unknown"]),
    meanReversionSignal: z.enum(["weak", "medium", "strong", "unknown"]),
    currentActiveBin: z.number().int().nullable(),
  })
  .strict();

export const RebalanceWalletRiskSnapshotSchema = z
  .object({
    dailyLossRemainingSol: z.number().nonnegative().nullable(),
    openPositions: z.number().int().nonnegative(),
    maxOpenPositions: z.number().int().positive(),
    maxRebalancesPerPosition: z.number().int().nonnegative(),
    maxPositionSol: z.number().positive().nullable(),
  })
  .strict();

export const RebalanceReviewInputSchema = z
  .object({
    position: RebalancePositionSnapshotSchema,
    pool: RebalancePoolSnapshotSchema,
    walletRisk: RebalanceWalletRiskSnapshotSchema,
    triggerReasons: z.array(z.string().min(1)),
    lessonContext: z.string().min(1).optional(),
  })
  .strict();

export type RebalancePlannerAction = z.infer<
  typeof RebalancePlannerActionSchema
>;
export type RebalancePlan = z.infer<typeof RebalancePlanSchema>;
export type AiRebalanceDecision = z.infer<typeof AiRebalanceDecisionSchema>;
export type RebalancePositionSnapshot = z.infer<
  typeof RebalancePositionSnapshotSchema
>;
export type RebalancePoolSnapshot = z.infer<typeof RebalancePoolSnapshotSchema>;
export type RebalanceWalletRiskSnapshot = z.infer<
  typeof RebalanceWalletRiskSnapshotSchema
>;
export type RebalanceReviewInput = z.infer<typeof RebalanceReviewInputSchema>;
