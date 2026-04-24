import { describe, expect, it } from "vitest";

import {
  buildDataFreshnessSnapshot,
  buildDlmmMicrostructureSnapshot,
  buildMarketFeatureSnapshot,
} from "../../../src/domain/rules/poolFeatureRules.js";
import { scoreStrategySuitability } from "../../../src/domain/scoring/strategySuitabilityScore.js";

const now = "2026-04-21T00:00:00.000Z";

function baseDlmm(overrides = {}) {
  return buildDlmmMicrostructureSnapshot({
    binStep: 100,
    activeBin: 1000,
    activeBinObservedAt: now,
    depthNearActiveUsd: 25_000,
    depthWithin10BinsUsd: 50_000,
    depthWithin25BinsUsd: 80_000,
    estimatedSlippageBpsForDefaultSize: 75,
    rangeStabilityScore: 80,
    now,
    ...overrides,
  });
}

function fresh() {
  return buildDataFreshnessSnapshot({
    now,
    hasActiveBin: true,
  });
}

describe("strategy suitability scoring", () => {
  it("prefers curve for low-volatility sideways pools", () => {
    const result = scoreStrategySuitability({
      marketFeatureSnapshot: buildMarketFeatureSnapshot({
        volume24hUsd: 100_000,
        fees24hUsd: 120,
        tvlUsd: 80_000,
        volatility1hPct: 1.2,
        trendStrength1h: 8,
        meanReversionScore: 55,
        organicVolumeScore: 85,
        washTradingRiskScore: 2,
      }),
      dlmmMicrostructureSnapshot: baseDlmm(),
      dataFreshnessSnapshot: fresh(),
    });

    expect(result.recommendedByRules).toBe("curve");
    expect(result.curveScore).toBeGreaterThan(result.spotScore);
  });

  it("prefers spot for moderate volatility with healthy depth", () => {
    const result = scoreStrategySuitability({
      marketFeatureSnapshot: buildMarketFeatureSnapshot({
        volume24hUsd: 140_000,
        fees24hUsd: 160,
        tvlUsd: 90_000,
        volatility1hPct: 5,
        trendStrength1h: 18,
        meanReversionScore: 60,
        organicVolumeScore: 82,
        washTradingRiskScore: 4,
      }),
      dlmmMicrostructureSnapshot: baseDlmm(),
      dataFreshnessSnapshot: fresh(),
    });

    expect(result.recommendedByRules).toBe("spot");
    expect(result.spotScore).toBeGreaterThan(result.curveScore);
  });

  it("prefers bid_ask for volatile mean-reverting pools", () => {
    const result = scoreStrategySuitability({
      marketFeatureSnapshot: buildMarketFeatureSnapshot({
        volume24hUsd: 250_000,
        fees24hUsd: 280,
        tvlUsd: 100_000,
        volatility1hPct: 12,
        trendStrength1h: 12,
        meanReversionScore: 92,
        organicVolumeScore: 90,
        washTradingRiskScore: 3,
      }),
      dlmmMicrostructureSnapshot: baseDlmm(),
      dataFreshnessSnapshot: fresh(),
    });

    expect(result.recommendedByRules).toBe("bid_ask");
    expect(result.bidAskScore).toBeGreaterThan(result.spotScore);
  });

  it("rejects one-way pump or dump moves even when volume is high", () => {
    const result = scoreStrategySuitability({
      marketFeatureSnapshot: buildMarketFeatureSnapshot({
        volume24hUsd: 500_000,
        fees24hUsd: 500,
        tvlUsd: 120_000,
        priceChange15mPct: 18,
        priceChange1hPct: 35,
        volatility1hPct: 16,
        trendStrength1h: 95,
        meanReversionScore: 20,
        organicVolumeScore: 80,
        washTradingRiskScore: 4,
      }),
      dlmmMicrostructureSnapshot: baseDlmm(),
      dataFreshnessSnapshot: fresh(),
    });

    expect(result.recommendedByRules).toBe("none");
    expect(result.strategyRiskFlags).toContain("one_way_price_move");
  });
});
