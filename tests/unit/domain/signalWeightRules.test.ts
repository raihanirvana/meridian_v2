import { describe, expect, it } from "vitest";

import { createDefaultSignalWeights } from "../../../src/domain/entities/SignalWeights.js";
import { type PerformanceRecord } from "../../../src/domain/entities/PerformanceRecord.js";
import {
  MAX_SIGNAL_WEIGHT_CHANGE_PER_STEP,
  recalculateWeights,
} from "../../../src/domain/rules/signalWeightRules.js";

function buildPerformance(overrides: Partial<PerformanceRecord> = {}): PerformanceRecord {
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

describe("signal weight rules", () => {
  it("raises weight on strong positive correlation but by at most 20 percent", () => {
    const currentWeights = createDefaultSignalWeights();
    const result = recalculateWeights({
      performance: Array.from({ length: 10 }, (_, index) =>
        buildPerformance({
          positionId: `pos_${index}`,
          feeTvlRatio: 0.1 + index * 0.02,
          pnlPct: 1 + index * 2,
        })),
      currentWeights,
    });

    expect(result.changes.feeToTvl?.weight).toBeGreaterThan(1);
    expect((result.changes.feeToTvl?.weight ?? 1) - 1).toBeLessThanOrEqual(
      MAX_SIGNAL_WEIGHT_CHANGE_PER_STEP + 0.0001,
    );
  });

  it("does not recalibrate when sample size is below minimum", () => {
    const result = recalculateWeights({
      performance: Array.from({ length: 9 }, (_, index) =>
        buildPerformance({
          positionId: `pos_${index}`,
          feeTvlRatio: 0.1 + index * 0.01,
          pnlPct: 1 + index,
        })),
      currentWeights: createDefaultSignalWeights(),
    });

    expect(result.changes).toEqual({});
  });

  it("clamps weights to the configured floor and ceiling", () => {
    const highWeights = createDefaultSignalWeights();
    highWeights.feeToTvl.weight = 2.95;
    const highResult = recalculateWeights({
      performance: Array.from({ length: 10 }, (_, index) =>
        buildPerformance({
          positionId: `fee_${index}`,
          feeTvlRatio: 0.1 + index * 0.02,
          pnlPct: 1 + index * 2,
        })),
      currentWeights: highWeights,
    });

    const lowWeights = createDefaultSignalWeights();
    lowWeights.organicScore.weight = 0.11;
    const lowResult = recalculateWeights({
      performance: Array.from({ length: 10 }, (_, index) =>
        buildPerformance({
          positionId: `organic_${index}`,
          organicScore: 60 + index * 2,
          pnlPct: -1 - index * 2,
        })),
      currentWeights: lowWeights,
    });

    expect(highResult.changes.feeToTvl?.weight).toBeLessThanOrEqual(3);
    expect(lowResult.changes.organicScore?.weight).toBeGreaterThanOrEqual(0.1);
  });
});
