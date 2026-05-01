import { describe, expect, it } from "vitest";

import {
  classifyOutcome,
  deriveLesson,
  inferRoleTags,
  isSuspiciousUnitMix,
} from "../../src/domain/rules/lessonRules.js";
import { type PerformanceRecord } from "../../src/domain/entities/PerformanceRecord.js";

function buildPerformance(
  overrides: Partial<PerformanceRecord> = {},
): PerformanceRecord {
  return {
    positionId: "pos_001",
    wallet: "wallet_001",
    pool: "pool_001",
    poolName: "SOL-USDC",
    baseMint: "mint_base",
    strategy: "bid_ask",
    binStep: 100,
    binRangeLower: 10,
    binRangeUpper: 20,
    volatility: 12,
    feeTvlRatio: 1.2,
    organicScore: 80,
    amountSol: 1,
    initialValueUsd: 100,
    finalValueUsd: 95,
    feesEarnedUsd: 2,
    pnlUsd: -3,
    pnlPct: -3,
    rangeEfficiencyPct: 60,
    minutesHeld: 120,
    minutesInRange: 72,
    closeReason: "manual",
    deployedAt: "2026-04-22T00:00:00.000Z",
    closedAt: "2026-04-22T02:00:00.000Z",
    recordedAt: "2026-04-22T02:00:00.000Z",
    ...overrides,
  };
}

describe("lesson rules", () => {
  it("classifies outcome thresholds correctly", () => {
    expect(classifyOutcome(5)).toBe("good");
    expect(classifyOutcome(0)).toBe("neutral");
    expect(classifyOutcome(-5)).toBe("poor");
    expect(classifyOutcome(-5.01)).toBe("bad");
  });

  it("derives a preferred lesson for strong winners", () => {
    const lesson = deriveLesson(
      buildPerformance({
        pnlPct: 12,
        pnlUsd: 12,
        finalValueUsd: 112,
        rangeEfficiencyPct: 90,
        closeReason: "take_profit",
        closeReasonDetail: "Trailing take profit exit triggered",
      }),
      "2026-04-22T02:00:00.000Z",
      () => "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );

    expect(lesson).toEqual(
      expect.objectContaining({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        outcome: "good",
      }),
    );
    expect(lesson?.rule).toContain("PREFER:");
    expect(lesson?.rule).toContain(
      "close=take_profit (Trailing take profit exit triggered)",
    );
    expect(lesson?.rule).toContain("held=120m");
    expect(lesson?.rule).toContain("value=$100.00->$112.00");
    expect(lesson?.rule).toContain("fees=$2.00");
    expect(lesson?.rule).toContain("profit was protected");
  });

  it("returns null for neutral outcomes", () => {
    const lesson = deriveLesson(
      buildPerformance({
        pnlPct: 2,
        pnlUsd: 2,
      }),
      "2026-04-22T02:00:00.000Z",
      () => "01ARZ3NDEKTSV4RRFFQ69G5FB0",
    );

    expect(lesson).toBeNull();
  });

  it("derives an avoid lesson for bad out-of-range performance", () => {
    const lesson = deriveLesson(
      buildPerformance({
        pnlPct: -10,
        pnlUsd: -10,
        rangeEfficiencyPct: 20,
        closeReason: "out_of_range",
      }),
      "2026-04-22T02:00:00.000Z",
      () => "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    );

    expect(lesson?.outcome).toBe("bad");
    expect(lesson?.rule).toContain("AVOID:");
    expect(lesson?.rule).toContain("went OOR");
    expect(lesson?.rule).toContain("close=out_of_range");
  });

  it("derives a volume collapse lesson for bad collapse exits", () => {
    const lesson = deriveLesson(
      buildPerformance({
        pnlPct: -8,
        pnlUsd: -8,
        closeReason: "volume_collapse",
        rangeEfficiencyPct: 55,
      }),
      "2026-04-22T02:00:00.000Z",
      () => "01ARZ3NDEKTSV4RRFFQ69G5FB2",
    );

    expect(lesson?.outcome).toBe("bad");
    expect(lesson?.rule).toContain("volume collapse");
    expect(lesson?.rule).toContain("volume/fee durability failed");
  });

  it("derives a worked lesson for non-perfect but good winners", () => {
    const lesson = deriveLesson(
      buildPerformance({
        pnlPct: 6,
        pnlUsd: 6,
        rangeEfficiencyPct: 60,
      }),
      "2026-04-22T02:00:00.000Z",
      () => "01ARZ3NDEKTSV4RRFFQ69G5FB3",
    );

    expect(lesson?.outcome).toBe("good");
    expect(lesson?.rule).toContain("WORKED:");
  });

  it.each([
    "manual",
    "stop_loss",
    "take_profit",
    "out_of_range",
    "timeout",
    "operator",
    "rebalance",
  ] as const)("derives a failed lesson for poor %s exits", (closeReason) => {
    const lesson = deriveLesson(
      buildPerformance({
        pnlPct: -2,
        pnlUsd: -2,
        closeReason,
        rangeEfficiencyPct: 50,
      }),
      "2026-04-22T02:00:00.000Z",
      () => "01ARZ3NDEKTSV4RRFFQ69G5FB4",
    );

    expect(lesson?.outcome).toBe("poor");
    expect(lesson?.rule).toContain("FAILED:");
    expect(lesson?.rule).toContain(closeReason);
  });

  it("includes descriptive close reason detail in failed lessons", () => {
    const lesson = deriveLesson(
      buildPerformance({
        pnlPct: -8,
        pnlUsd: -8,
        closeReason: "rebalance",
        closeReasonDetail: "AI rebalance planner selected same-pool redeploy",
        rangeEfficiencyPct: 100,
      }),
      "2026-04-22T02:00:00.000Z",
      () => "01ARZ3NDEKTSV4RRFFQ69G5FB5",
    );

    expect(lesson?.rule).toContain(
      "close=rebalance (AI rebalance planner selected same-pool redeploy)",
    );
    expect(lesson?.rule).toContain(
      "do not treat same-pool redeploy as success unless realized PnL confirms it",
    );
  });

  it("infers role tags from efficiency, outcome, strategy, and volatility", () => {
    const tags = inferRoleTags(
      buildPerformance({
        pnlPct: -7,
        rangeEfficiencyPct: 25,
        closeReason: "volume_collapse",
        strategy: "curve",
        volatility: 17.2,
      }),
    );

    expect(tags).toEqual(
      expect.arrayContaining([
        "oor",
        "failed",
        "volume_collapse",
        "curve",
        "volatility_17",
      ]),
    );
  });

  it("detects suspicious unit mix records", () => {
    expect(
      isSuspiciousUnitMix(
        buildPerformance({
          amountSol: 2,
          initialValueUsd: 100,
          finalValueUsd: 2,
        }),
      ),
    ).toBe(true);
  });
});
