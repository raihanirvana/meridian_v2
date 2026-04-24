import { z } from "zod";

import { CandidateDecisionSchema } from "../types/enums.js";

const TimestampSchema = z.string().datetime();
const StrategyNameSchema = z.enum(["curve", "spot", "bid_ask", "none"]);

export const MarketFeatureSnapshotSchema = z
  .object({
    volume5mUsd: z.number().nonnegative(),
    volume15mUsd: z.number().nonnegative(),
    volume1hUsd: z.number().nonnegative(),
    volume24hUsd: z.number().nonnegative(),
    fees5mUsd: z.number().nonnegative(),
    fees15mUsd: z.number().nonnegative(),
    fees1hUsd: z.number().nonnegative(),
    fees24hUsd: z.number().nonnegative(),
    tvlUsd: z.number().nonnegative(),
    feeTvlRatio1h: z.number().nonnegative(),
    feeTvlRatio24h: z.number().nonnegative(),
    volumeTvlRatio1h: z.number().nonnegative(),
    volumeTvlRatio24h: z.number().nonnegative(),
    priceChange5mPct: z.number(),
    priceChange15mPct: z.number(),
    priceChange1hPct: z.number(),
    priceChange24hPct: z.number(),
    volatility5mPct: z.number().nonnegative(),
    volatility15mPct: z.number().nonnegative(),
    volatility1hPct: z.number().nonnegative(),
    trendStrength15m: z.number().min(0).max(100),
    trendStrength1h: z.number().min(0).max(100),
    meanReversionScore: z.number().min(0).max(100),
    washTradingRiskScore: z.number().min(0).max(100),
    organicVolumeScore: z.number().min(0).max(100),
  })
  .strict();

export const DlmmMicrostructureSnapshotSchema = z
  .object({
    binStep: z.number().int().positive(),
    activeBin: z.number().int().nullable(),
    activeBinSource: z.string().min(1),
    activeBinObservedAt: TimestampSchema.nullable(),
    activeBinAgeMs: z.number().int().nonnegative(),
    activeBinDriftFromDiscovery: z.number().int().nonnegative(),
    depthNearActiveUsd: z.number().nonnegative(),
    depthWithin10BinsUsd: z.number().nonnegative(),
    depthWithin25BinsUsd: z.number().nonnegative(),
    liquidityImbalancePct: z.number().min(0).max(100),
    spreadBps: z.number().nonnegative(),
    estimatedSlippageBpsForDefaultSize: z.number().nonnegative(),
    outOfRangeRiskScore: z.number().min(0).max(100),
    rangeStabilityScore: z.number().min(0).max(100),
  })
  .strict();

export const DataFreshnessSnapshotSchema = z
  .object({
    screeningSnapshotAt: TimestampSchema.nullable(),
    poolDetailFetchedAt: TimestampSchema.nullable(),
    tokenIntelFetchedAt: TimestampSchema.nullable(),
    chainSnapshotFetchedAt: TimestampSchema.nullable(),
    oldestRequiredSnapshotAgeMs: z.number().int().nonnegative(),
    isFreshEnoughForDeploy: z.boolean(),
  })
  .strict();

export const StrategySuitabilitySchema = z
  .object({
    curveScore: z.number().min(0).max(100),
    spotScore: z.number().min(0).max(100),
    bidAskScore: z.number().min(0).max(100),
    recommendedByRules: StrategyNameSchema,
    strategyRiskFlags: z.array(z.string().min(1)),
    reasonCodes: z.array(z.string().min(1)),
  })
  .strict();

export const defaultMarketFeatureSnapshot = () =>
  MarketFeatureSnapshotSchema.parse({
    volume5mUsd: 0,
    volume15mUsd: 0,
    volume1hUsd: 0,
    volume24hUsd: 0,
    fees5mUsd: 0,
    fees15mUsd: 0,
    fees1hUsd: 0,
    fees24hUsd: 0,
    tvlUsd: 0,
    feeTvlRatio1h: 0,
    feeTvlRatio24h: 0,
    volumeTvlRatio1h: 0,
    volumeTvlRatio24h: 0,
    priceChange5mPct: 0,
    priceChange15mPct: 0,
    priceChange1hPct: 0,
    priceChange24hPct: 0,
    volatility5mPct: 0,
    volatility15mPct: 0,
    volatility1hPct: 0,
    trendStrength15m: 0,
    trendStrength1h: 0,
    meanReversionScore: 0,
    washTradingRiskScore: 0,
    organicVolumeScore: 0,
  });

export const defaultDlmmMicrostructureSnapshot = () =>
  DlmmMicrostructureSnapshotSchema.parse({
    binStep: 1,
    activeBin: null,
    activeBinSource: "unavailable",
    activeBinObservedAt: null,
    activeBinAgeMs: 0,
    activeBinDriftFromDiscovery: 0,
    depthNearActiveUsd: 0,
    depthWithin10BinsUsd: 0,
    depthWithin25BinsUsd: 0,
    liquidityImbalancePct: 0,
    spreadBps: 0,
    estimatedSlippageBpsForDefaultSize: 0,
    outOfRangeRiskScore: 100,
    rangeStabilityScore: 0,
  });

export const defaultDataFreshnessSnapshot = () =>
  DataFreshnessSnapshotSchema.parse({
    screeningSnapshotAt: null,
    poolDetailFetchedAt: null,
    tokenIntelFetchedAt: null,
    chainSnapshotFetchedAt: null,
    oldestRequiredSnapshotAgeMs: 0,
    isFreshEnoughForDeploy: false,
  });

export const defaultStrategySuitability = () =>
  StrategySuitabilitySchema.parse({
    curveScore: 0,
    spotScore: 0,
    bidAskScore: 0,
    recommendedByRules: "none",
    strategyRiskFlags: ["missing_strategy_features"],
    reasonCodes: ["strategy_features_unavailable"],
  });

export const CandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    poolAddress: z.string().min(1),
    symbolPair: z.string().min(1),
    tokenXMint: z.string().min(1).nullable().default(null),
    tokenYMint: z.string().min(1).nullable().default(null),
    baseMint: z.string().min(1).nullable().default(null),
    quoteMint: z.string().min(1).nullable().default(null),
    screeningSnapshot: z.record(z.string(), z.unknown()),
    marketFeatureSnapshot: MarketFeatureSnapshotSchema.default(
      defaultMarketFeatureSnapshot,
    ),
    dlmmMicrostructureSnapshot: DlmmMicrostructureSnapshotSchema.default(
      defaultDlmmMicrostructureSnapshot,
    ),
    tokenRiskSnapshot: z.record(z.string(), z.unknown()),
    smartMoneySnapshot: z.record(z.string(), z.unknown()),
    dataFreshnessSnapshot: DataFreshnessSnapshotSchema.default(
      defaultDataFreshnessSnapshot,
    ),
    strategySuitability: StrategySuitabilitySchema.default(
      defaultStrategySuitability,
    ),
    aiStrategyDecision: z
      .record(z.string(), z.unknown())
      .nullable()
      .default(null),
    finalStrategyDecision: z
      .record(z.string(), z.unknown())
      .nullable()
      .default(null),
    hardFilterPassed: z.boolean(),
    score: z.number(),
    scoreBreakdown: z.record(z.string(), z.number()),
    decision: CandidateDecisionSchema,
    decisionReason: z.string().min(1),
    createdAt: TimestampSchema,
    lastReviewedAt: TimestampSchema.nullable().default(null),
  })
  .strict();

export type Candidate = z.infer<typeof CandidateSchema>;
export type MarketFeatureSnapshot = z.infer<typeof MarketFeatureSnapshotSchema>;
export type DlmmMicrostructureSnapshot = z.infer<
  typeof DlmmMicrostructureSnapshotSchema
>;
export type DataFreshnessSnapshot = z.infer<typeof DataFreshnessSnapshotSchema>;
export type StrategySuitability = z.infer<typeof StrategySuitabilitySchema>;
