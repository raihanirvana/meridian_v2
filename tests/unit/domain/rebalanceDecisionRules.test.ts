import { describe, expect, it } from "vitest";

import type {
  AiRebalanceDecision,
  RebalanceReviewInput,
} from "../../../src/domain/entities/RebalanceDecision.js";
import {
  deriveRebalanceTriggerSnapshot,
  validateRebalanceDecision,
} from "../../../src/domain/rules/rebalanceDecisionRules.js";

function buildReview(
  overrides: Partial<RebalanceReviewInput> = {},
): RebalanceReviewInput {
  return {
    position: {
      positionId: "pos_001",
      poolAddress: "pool_001",
      strategy: "spot",
      lowerBin: 1000,
      upperBin: 1060,
      activeBinAtEntry: 1030,
      currentActiveBin: 1057,
      binStep: 80,
      ageMinutes: 20,
      outOfRangeMinutes: 6,
      positionValueUsd: 52.4,
      unclaimedFeesUsd: 0.42,
      pnlPct: 0.8,
      rebalanceCount: 0,
      partialCloseCount: 0,
    },
    pool: {
      poolAddress: "pool_001",
      tvlUsd: 180_000,
      volume5mUsd: 12_000,
      volume15mUsd: 52_000,
      volume1hUsd: 210_000,
      volume24hUsd: 950_000,
      fees15mUsd: 260,
      fees1hUsd: 1_100,
      feeTvlRatio24h: 0.018,
      liquidityDepthNearActive: "medium",
      priceChange5mPct: 1.1,
      priceChange15mPct: 2.4,
      priceChange1hPct: 4.8,
      volatility15m: 0.032,
      trendDirection: "up",
      trendStrength: "medium",
      meanReversionSignal: "weak",
      currentActiveBin: 1058,
    },
    walletRisk: {
      dailyLossRemainingSol: 0.25,
      openPositions: 2,
      maxOpenPositions: 3,
      maxRebalancesPerPosition: 2,
      maxPositionSol: 0.05,
    },
    triggerReasons: ["position out of range for 6 minutes"],
    ...overrides,
  };
}

function buildDecision(
  overrides: Partial<AiRebalanceDecision> = {},
): AiRebalanceDecision {
  return {
    action: "rebalance_same_pool",
    confidence: 0.86,
    riskLevel: "medium",
    reason: ["Position is stale but pool remains healthy"],
    rebalancePlan: {
      strategy: "spot",
      binsBelow: 25,
      binsAbove: 35,
      slippageBps: 100,
      maxPositionAgeMinutes: 30,
      stopLossPct: 1,
      takeProfitPct: 1.8,
      trailingStopPct: 0.5,
    },
    rejectIf: ["activeBinDrift > 3 before submit"],
    ...overrides,
  };
}

describe("rebalance decision rules", () => {
  it("allows a safe same-pool rebalance plan", () => {
    const result = validateRebalanceDecision({
      decision: buildDecision(),
      review: buildReview(),
      policy: {
        minTvlUsd: 100_000,
        maxActiveBinDrift: 3,
        closeSimulationPassed: true,
        redeploySimulationPassed: true,
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.action).toBe("rebalance_same_pool");
  });

  it("rejects high-risk AI rebalance unless the action is exit", () => {
    const result = validateRebalanceDecision({
      decision: buildDecision({ riskLevel: "high" }),
      review: buildReview(),
    });

    expect(result.allowed).toBe(false);
    expect(result.riskFlags).toContain("ai_rebalance_high_risk");
  });

  it("rejects high-risk claim-only because the risky position would remain open", () => {
    const result = validateRebalanceDecision({
      decision: buildDecision({
        action: "claim_only",
        riskLevel: "high",
        rebalancePlan: null,
      }),
      review: buildReview(),
    });

    expect(result.allowed).toBe(false);
    expect(result.riskFlags).toContain("ai_rebalance_high_risk");
  });

  it("rejects bins and slippage outside policy limits", () => {
    const result = validateRebalanceDecision({
      decision: buildDecision({
        rebalancePlan: {
          strategy: "bid_ask",
          binsBelow: 120,
          binsAbove: 10,
          slippageBps: 200,
          maxPositionAgeMinutes: 30,
          stopLossPct: 1,
          takeProfitPct: 2,
          trailingStopPct: 0.5,
        },
      }),
      review: buildReview(),
      policy: {
        maxRebalanceBinsBelow: 90,
        maxRebalanceSlippageBps: 150,
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.riskFlags).toEqual(
      expect.arrayContaining([
        "rebalance_bins_below_above_limit",
        "rebalance_slippage_above_limit",
      ]),
    );
  });

  it("rejects same-pool rebalance when required simulations were not supplied", () => {
    const result = validateRebalanceDecision({
      decision: buildDecision(),
      review: buildReview(),
      policy: {
        requireRebalanceSimulation: true,
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.riskFlags).toEqual(
      expect.arrayContaining([
        "rebalance_close_simulation_failed",
        "rebalance_redeploy_simulation_failed",
      ]),
    );
  });

  it("enforces rebalance cooldown when a position has already rebalanced", () => {
    const result = validateRebalanceDecision({
      decision: buildDecision(),
      review: buildReview({
        position: {
          ...buildReview().position,
          rebalanceCount: 1,
          lastRebalanceAgeMinutes: 5,
        },
      }),
      policy: {
        rebalanceCooldownMinutes: 20,
        closeSimulationPassed: true,
        redeploySimulationPassed: true,
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.riskFlags).toContain("rebalance_cooldown_active");
  });

  it("uses stable reason codes for allowed decisions", () => {
    const result = validateRebalanceDecision({
      decision: buildDecision({
        reason: ["free-form AI sentence should stay out of reasonCodes"],
      }),
      review: buildReview(),
      policy: {
        closeSimulationPassed: true,
        redeploySimulationPassed: true,
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.reasonCodes).toEqual([
      "ai_rebalance_rebalance_same_pool_allowed",
    ]);
  });

  it("detects out-of-range duration and near-edge triggers", () => {
    const review = buildReview();
    const triggers = deriveRebalanceTriggerSnapshot({
      position: review.position,
      pool: review.pool,
      maxOutOfRangeMinutes: 5,
      rebalanceEdgeThresholdPct: 0.1,
      minPositionAgeMinutesBeforeRebalance: 8,
    });

    expect(triggers).toEqual(
      expect.arrayContaining(["out_of_range_duration", "near_range_edge"]),
    );
  });
});
