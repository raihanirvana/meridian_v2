import { z } from "zod";

import {
  DataFreshnessSnapshotSchema,
  DlmmMicrostructureSnapshotSchema,
  MarketFeatureSnapshotSchema,
  StrategySuitabilitySchema,
  type StrategySuitability,
} from "../entities/Candidate.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function closeness(value: number, target: number, tolerance: number): number {
  if (tolerance <= 0) {
    return 0;
  }

  return clamp(100 - (Math.abs(value - target) / tolerance) * 100, 0, 100);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export const StrategySuitabilityInputSchema = z
  .object({
    marketFeatureSnapshot: MarketFeatureSnapshotSchema,
    dlmmMicrostructureSnapshot: DlmmMicrostructureSnapshotSchema,
    dataFreshnessSnapshot: DataFreshnessSnapshotSchema,
    maxEstimatedSlippageBps: z.number().positive().default(300),
    minDepthNearActiveUsd: z.number().nonnegative().default(5_000),
  })
  .strict();

export type StrategySuitabilityInput = z.input<
  typeof StrategySuitabilityInputSchema
>;

export function scoreStrategySuitability(
  input: StrategySuitabilityInput,
): StrategySuitability {
  const parsed = StrategySuitabilityInputSchema.parse(input);
  const market = parsed.marketFeatureSnapshot;
  const dlmm = parsed.dlmmMicrostructureSnapshot;
  const freshness = parsed.dataFreshnessSnapshot;
  const strategyRiskFlags: string[] = [];
  const reasonCodes: string[] = [];

  if (!freshness.isFreshEnoughForDeploy) {
    strategyRiskFlags.push("stale_strategy_snapshot");
    reasonCodes.push("snapshot_not_fresh");
  }
  if (dlmm.activeBin === null) {
    strategyRiskFlags.push("missing_active_bin");
    reasonCodes.push("active_bin_unavailable");
  }
  if (
    dlmm.estimatedSlippageBpsForDefaultSize > parsed.maxEstimatedSlippageBps
  ) {
    strategyRiskFlags.push("estimated_slippage_above_limit");
    reasonCodes.push("slippage_too_high");
  }
  if (dlmm.depthNearActiveUsd < parsed.minDepthNearActiveUsd) {
    strategyRiskFlags.push("depth_near_active_too_shallow");
    reasonCodes.push("depth_too_shallow");
  }
  if (
    Math.abs(market.priceChange15mPct) >= 15 ||
    Math.abs(market.priceChange1hPct) >= 25
  ) {
    strategyRiskFlags.push("one_way_price_move");
    reasonCodes.push("pump_or_dump_move");
  }

  const lowVolScore = closeness(market.volatility1hPct, 1.5, 4);
  const moderateVolScore = closeness(market.volatility1hPct, 5, 7);
  const highVolScore = closeness(market.volatility1hPct, 12, 12);
  const sidewaysScore = clamp(100 - market.trendStrength1h, 0, 100);
  const depthScore = clamp(
    (dlmm.depthWithin10BinsUsd / Math.max(parsed.minDepthNearActiveUsd, 1)) *
      100,
    0,
    100,
  );
  const safeSlippageScore = clamp(
    100 -
      (dlmm.estimatedSlippageBpsForDefaultSize /
        parsed.maxEstimatedSlippageBps) *
        100,
    0,
    100,
  );
  const organicScore = clamp(
    (market.organicVolumeScore + (100 - market.washTradingRiskScore)) / 2,
    0,
    100,
  );
  const meanReversionScore = clamp(market.meanReversionScore, 0, 100);
  const stabilityScore = clamp(dlmm.rangeStabilityScore, 0, 100);

  const curveScore = round(
    lowVolScore * 0.3 +
      sidewaysScore * 0.25 +
      stabilityScore * 0.2 +
      depthScore * 0.15 +
      safeSlippageScore * 0.1,
  );
  const spotScore = round(
    moderateVolScore * 0.3 +
      sidewaysScore * 0.2 +
      depthScore * 0.2 +
      safeSlippageScore * 0.15 +
      organicScore * 0.15,
  );
  const bidAskScore = round(
    highVolScore * 0.25 +
      meanReversionScore * 0.3 +
      organicScore * 0.2 +
      depthScore * 0.15 +
      safeSlippageScore * 0.1 -
      market.trendStrength1h * 0.25,
  );

  if (curveScore >= 65) {
    reasonCodes.push("curve_fit_low_vol_sideways");
  }
  if (spotScore >= 65) {
    reasonCodes.push("spot_fit_moderate_vol_depth");
  }
  if (bidAskScore >= 65) {
    reasonCodes.push("bid_ask_fit_mean_reversion");
  }

  const criticalReject =
    strategyRiskFlags.includes("stale_strategy_snapshot") ||
    strategyRiskFlags.includes("missing_active_bin") ||
    strategyRiskFlags.includes("estimated_slippage_above_limit") ||
    strategyRiskFlags.includes("depth_near_active_too_shallow") ||
    strategyRiskFlags.includes("one_way_price_move");
  const scores = {
    curve: clamp(curveScore, 0, 100),
    spot: clamp(spotScore, 0, 100),
    bid_ask: clamp(bidAskScore, 0, 100),
  };
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] as
    | ["curve" | "spot" | "bid_ask", number]
    | undefined;
  const recommendedByRules =
    criticalReject || best === undefined || best[1] < 55 ? "none" : best[0];

  if (recommendedByRules === "none" && reasonCodes.length === 0) {
    reasonCodes.push("no_strategy_fit_above_threshold");
  }

  return StrategySuitabilitySchema.parse({
    curveScore: scores.curve,
    spotScore: scores.spot,
    bidAskScore: scores.bid_ask,
    recommendedByRules,
    strategyRiskFlags,
    reasonCodes,
  });
}
