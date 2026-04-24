import { describe, expect, it } from "vitest";

import { type PerformanceRecord } from "../../../src/domain/entities/PerformanceRecord.js";
import {
  evolveThresholds,
  MAX_CHANGE_PER_STEP,
} from "../../../src/domain/rules/thresholdEvolutionRules.js";
import { type ScreeningPolicy } from "../../../src/domain/rules/screeningRules.js";

function buildPolicy(
  overrides: Partial<ScreeningPolicy> = {},
): ScreeningPolicy {
  return {
    timeframe: "5m",
    minMarketCapUsd: 150_000,
    maxMarketCapUsd: 10_000_000,
    minTvlUsd: 10_000,
    minVolumeUsd: 5_000,
    minFeeActiveTvlRatio: 0.1,
    minFeePerTvl24h: 0.01,
    minOrganic: 60,
    minHolderCount: 500,
    allowedBinSteps: [80, 100, 125],
    blockedLaunchpads: [],
    blockedTokenMints: [],
    blockedDeployers: [],
    allowedPairTypes: ["volatile", "stable"],
    maxTopHolderPct: 35,
    maxBotHolderPct: 20,
    maxBundleRiskPct: 20,
    maxWashTradingRiskPct: 20,
    rejectDuplicatePoolExposure: true,
    rejectDuplicateTokenExposure: true,
    shortlistLimit: 3,
    ...overrides,
  };
}

function buildPerformance(
  overrides: Partial<PerformanceRecord> = {},
): PerformanceRecord {
  return {
    positionId: "pos_001",
    wallet: "wallet_001",
    pool: "pool_001",
    poolName: "SOL-USDC",
    baseMint: "mint_sol",
    strategy: "bid_ask",
    binStep: 100,
    binRangeLower: 10,
    binRangeUpper: 20,
    volatility: 12,
    feeTvlRatio: 0.12,
    organicScore: 75,
    amountSol: 1,
    initialValueUsd: 100,
    finalValueUsd: 105,
    feesEarnedUsd: 2,
    pnlUsd: 5,
    pnlPct: 5,
    rangeEfficiencyPct: 80,
    minutesHeld: 120,
    minutesInRange: 96,
    closeReason: "take_profit",
    deployedAt: "2026-04-22T00:00:00.000Z",
    closedAt: "2026-04-22T02:00:00.000Z",
    recordedAt: "2026-04-22T02:00:00.000Z",
    ...overrides,
  };
}

describe("threshold evolution rules", () => {
  it("returns null when performance history is below minimum positions", () => {
    const result = evolveThresholds({
      performance: Array.from({ length: 4 }, (_, index) =>
        buildPerformance({ positionId: `pos_${index}` }),
      ),
      currentPolicy: buildPolicy(),
    });

    expect(result).toBeNull();
  });

  it("can still raise fee floor when winners alone show a clearly higher floor", () => {
    const result = evolveThresholds({
      performance: Array.from({ length: 5 }, (_, index) =>
        buildPerformance({
          positionId: `pos_${index}`,
          pnlUsd: 8 + index,
          pnlPct: 8 + index,
          feeTvlRatio: 0.14 + index * 0.01,
          organicScore: 78 + index,
        }),
      ),
      currentPolicy: buildPolicy(),
    });

    expect(result?.changes.minFeeActiveTvlRatio).toBeGreaterThan(0.1);
    expect(result?.rationale.minFeeActiveTvlRatio).toMatch(
      /lowest winner fee_tvl/i,
    );
  });

  it("raises minFeeActiveTvlRatio from mixed winner/loser performance", () => {
    const result = evolveThresholds({
      performance: [
        buildPerformance({ positionId: "w1", pnlPct: 10, feeTvlRatio: 0.3 }),
        buildPerformance({ positionId: "w2", pnlPct: 9, feeTvlRatio: 0.28 }),
        buildPerformance({ positionId: "w3", pnlPct: 8, feeTvlRatio: 0.32 }),
        buildPerformance({
          positionId: "l1",
          pnlPct: -8,
          pnlUsd: -8,
          feeTvlRatio: 0.07,
        }),
        buildPerformance({
          positionId: "l2",
          pnlPct: -7,
          pnlUsd: -7,
          feeTvlRatio: 0.08,
        }),
      ],
      currentPolicy: buildPolicy({ minFeeActiveTvlRatio: 0.1 }),
    });

    expect(result?.changes.minFeeActiveTvlRatio).toBeGreaterThan(0.1);
    expect(result?.rationale.minFeeActiveTvlRatio).toMatch(/raised floor/i);
  });

  it("raises minOrganic with integer rounding and clamp", () => {
    const result = evolveThresholds({
      performance: [
        buildPerformance({ positionId: "w1", pnlPct: 10, organicScore: 88 }),
        buildPerformance({ positionId: "w2", pnlPct: 9, organicScore: 86 }),
        buildPerformance({ positionId: "w3", pnlPct: 7, organicScore: 84 }),
        buildPerformance({
          positionId: "l1",
          pnlPct: -8,
          pnlUsd: -8,
          organicScore: 61,
        }),
        buildPerformance({
          positionId: "l2",
          pnlPct: -9,
          pnlUsd: -9,
          organicScore: 62,
        }),
      ],
      currentPolicy: buildPolicy({ minOrganic: 60 }),
    });

    expect(result?.changes.minOrganic).toBeTypeOf("number");
    expect(result?.changes.minOrganic).toBeGreaterThan(60);
    expect(result?.changes.minOrganic).toBeLessThanOrEqual(90);
    expect(Number.isInteger(result?.changes.minOrganic)).toBe(true);
  });

  it("caps each step to at most 20 percent nudge", () => {
    const current = 0.1;
    const result = evolveThresholds({
      performance: [
        buildPerformance({ positionId: "w1", pnlPct: 10, feeTvlRatio: 1.5 }),
        buildPerformance({ positionId: "w2", pnlPct: 11, feeTvlRatio: 1.6 }),
        buildPerformance({ positionId: "w3", pnlPct: 9, feeTvlRatio: 1.7 }),
        buildPerformance({
          positionId: "l1",
          pnlPct: -8,
          pnlUsd: -8,
          feeTvlRatio: 0.08,
        }),
        buildPerformance({
          positionId: "l2",
          pnlPct: -7,
          pnlUsd: -7,
          feeTvlRatio: 0.07,
        }),
      ],
      currentPolicy: buildPolicy({ minFeeActiveTvlRatio: current }),
    });

    const evolved = result?.changes.minFeeActiveTvlRatio ?? current;
    expect(evolved - current).toBeLessThanOrEqual(
      current * MAX_CHANGE_PER_STEP + 0.0001,
    );
  });
});
