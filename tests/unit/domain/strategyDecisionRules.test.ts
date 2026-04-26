import { describe, expect, it } from "vitest";

import type { StrategyReviewResult } from "../../../src/adapters/llm/AiStrategyReviewer.js";
import { CandidateSchema } from "../../../src/domain/entities/Candidate.js";
import {
  buildDataFreshnessSnapshot,
  buildDlmmMicrostructureSnapshot,
  buildMarketFeatureSnapshot,
} from "../../../src/domain/rules/poolFeatureRules.js";
import { validateStrategyDecision } from "../../../src/domain/rules/strategyDecisionRules.js";

const now = "2026-04-25T00:00:00.000Z";

function buildCandidate(
  overrides: Partial<Parameters<typeof CandidateSchema.parse>[0]> = {},
) {
  return CandidateSchema.parse({
    candidateId: "cand_001",
    poolAddress: "pool_001",
    symbolPair: "ABC-SOL",
    tokenXMint: "mint_abc",
    tokenYMint: "So11111111111111111111111111111111111111112",
    baseMint: "mint_abc",
    quoteMint: "So11111111111111111111111111111111111111112",
    screeningSnapshot: {},
    marketFeatureSnapshot: buildMarketFeatureSnapshot({
      volume24hUsd: 50_000,
      fees24hUsd: 50,
      tvlUsd: 100_000,
      organicVolumeScore: 85,
      washTradingRiskScore: 5,
    }),
    dlmmMicrostructureSnapshot: buildDlmmMicrostructureSnapshot({
      binStep: 80,
      activeBin: 1000,
      activeBinObservedAt: now,
      depthNearActiveUsd: 25_000,
      depthWithin10BinsUsd: 50_000,
      depthWithin25BinsUsd: 75_000,
      estimatedSlippageBpsForDefaultSize: 100,
      now,
    }),
    tokenRiskSnapshot: {},
    smartMoneySnapshot: {},
    dataFreshnessSnapshot: buildDataFreshnessSnapshot({
      now,
      screeningSnapshotAt: now,
      poolDetailFetchedAt: now,
      tokenIntelFetchedAt: now,
      chainSnapshotFetchedAt: now,
      hasActiveBin: true,
    }),
    strategySuitability: {
      curveScore: 40,
      spotScore: 75,
      bidAskScore: 65,
      recommendedByRules: "spot",
      strategyRiskFlags: [],
      reasonCodes: ["spot_fit_moderate_vol_depth"],
    },
    hardFilterPassed: true,
    score: 80,
    scoreBreakdown: {},
    decision: "SHORTLISTED",
    decisionReason: "selected upstream",
    createdAt: now,
    ...overrides,
  });
}

function buildAiReview(
  overrides: Partial<StrategyReviewResult> = {},
): StrategyReviewResult {
  return {
    poolAddress: "pool_001",
    decision: "deploy",
    recommendedStrategy: "spot",
    confidence: 0.9,
    riskLevel: "low",
    binsBelow: 40,
    binsAbove: 20,
    slippageBps: 200,
    maxPositionAgeMinutes: 240,
    stopLossPct: 5,
    takeProfitPct: 10,
    trailingStopPct: 2,
    reasons: ["ai_prefers_spot"],
    rejectIf: [],
    ...overrides,
  };
}

const configStrategy = {
  strategy: "bid_ask" as const,
  binsBelow: 69,
  binsAbove: 0,
  slippageBps: 300,
};

describe("validateStrategyDecision", () => {
  it("rejects AI deploy recommendation when candidate score is below threshold", () => {
    const decision = validateStrategyDecision({
      candidate: buildCandidate({ score: 40 }),
      mode: "guarded_auto",
      aiReview: buildAiReview(),
      configStrategy,
      policy: {
        minCandidateScore: 55,
        strategyFallbackMode: "reject",
      },
    });

    expect(decision.rejected).toBe(true);
    expect(decision.reasonCodes).toContain("candidate_score_below_minimum");
  });

  it("rejects bid_ask when the candidate shows one-way price movement", () => {
    const candidate = buildCandidate({
      marketFeatureSnapshot: {
        ...buildMarketFeatureSnapshot({
          volume24hUsd: 50_000,
          fees24hUsd: 50,
          tvlUsd: 100_000,
          organicVolumeScore: 85,
          washTradingRiskScore: 5,
        }),
        priceChange15mPct: 18,
      },
      strategySuitability: {
        curveScore: 10,
        spotScore: 30,
        bidAskScore: 70,
        recommendedByRules: "none",
        strategyRiskFlags: [],
        reasonCodes: [],
      },
    });

    const decision = validateStrategyDecision({
      candidate,
      mode: "guarded_auto",
      aiReview: buildAiReview({ recommendedStrategy: "bid_ask" }),
      configStrategy,
      policy: {
        strategyFallbackMode: "reject",
      },
    });

    expect(decision.rejected).toBe(true);
    expect(decision.riskFlags).toContain("bid_ask_one_way_trend");
  });

  it("rejects AI curve when volatility is too high", () => {
    const candidate = buildCandidate({
      marketFeatureSnapshot: {
        ...buildMarketFeatureSnapshot({
          volume24hUsd: 50_000,
          fees24hUsd: 50,
          tvlUsd: 100_000,
          organicVolumeScore: 85,
          washTradingRiskScore: 5,
        }),
        volatility1hPct: 12,
      },
    });

    const decision = validateStrategyDecision({
      candidate,
      mode: "guarded_auto",
      aiReview: buildAiReview({ recommendedStrategy: "curve" }),
      configStrategy,
      policy: {
        strategyFallbackMode: "reject",
      },
    });

    expect(decision.rejected).toBe(true);
    expect(decision.riskFlags).toContain("curve_high_volatility");
  });

  it("falls back or rejects AI bins that exceed policy limits", () => {
    const decision = validateStrategyDecision({
      candidate: buildCandidate(),
      mode: "guarded_auto",
      aiReview: buildAiReview({ binsBelow: 150 }),
      configStrategy,
      policy: {
        maxBinsBelow: 120,
        strategyFallbackMode: "reject",
      },
    });

    expect(decision.rejected).toBe(true);
    expect(decision.riskFlags).toContain("bins_below_above_limit");
  });

  it("rejects AI deploy recommendations without positive slippage", () => {
    const decision = validateStrategyDecision({
      candidate: buildCandidate(),
      mode: "guarded_auto",
      aiReview: buildAiReview({ slippageBps: 0 }),
      configStrategy,
      policy: {
        strategyFallbackMode: "reject",
      },
    });

    expect(decision.rejected).toBe(true);
    expect(decision.riskFlags).toContain("missing_deploy_slippage");
  });

  it("rejects AI deploy recommendations without positive exit controls", () => {
    const decision = validateStrategyDecision({
      candidate: buildCandidate(),
      mode: "guarded_auto",
      aiReview: buildAiReview({
        maxPositionAgeMinutes: 0,
        stopLossPct: 0,
        takeProfitPct: 0,
      }),
      configStrategy,
      policy: {
        strategyFallbackMode: "reject",
      },
    });

    expect(decision.rejected).toBe(true);
    expect(decision.riskFlags).toEqual(
      expect.arrayContaining([
        "missing_deploy_max_position_age",
        "missing_deploy_stop_loss",
        "missing_deploy_take_profit",
      ]),
    );
  });

  it("uses config static strategy in recommendation_only mode", () => {
    const decision = validateStrategyDecision({
      candidate: buildCandidate(),
      mode: "recommendation_only",
      aiReview: buildAiReview({ recommendedStrategy: "spot" }),
      configStrategy,
      policy: {
        strategyFallbackMode: "reject",
      },
    });

    expect(decision.rejected).toBe(false);
    expect(decision.source).toBe("CONFIG_STATIC");
    expect(decision.strategy).toBe("bid_ask");
    expect(decision.reasonCodes).toContain("ai_recommendation_recorded_only");
  });

  it("rejects guarded auto when DLMM simulation failed", () => {
    const decision = validateStrategyDecision({
      candidate: buildCandidate(),
      mode: "guarded_auto",
      aiReview: buildAiReview(),
      configStrategy,
      simulationPassed: false,
      simulationError: "range out of bounds",
      policy: {
        strategyFallbackMode: "reject",
      },
    });

    expect(decision.rejected).toBe(true);
    expect(decision.reasonCodes).toContain("dlmm_simulation_failed");
  });

  it("rejects guarded auto when fresh active bin drift exceeds the configured limit", () => {
    const decision = validateStrategyDecision({
      candidate: buildCandidate(),
      mode: "guarded_auto",
      aiReview: buildAiReview(),
      configStrategy,
      simulationPassed: true,
      freshActiveBin: 1008,
      policy: {
        maxActiveBinDrift: 3,
        strategyFallbackMode: "reject",
      },
    });

    expect(decision.rejected).toBe(true);
    expect(decision.reasonCodes).toContain(
      "fresh_active_bin_drift_above_limit",
    );
  });

  it("rejects deploy when detail is required but pool detail is missing", () => {
    const decision = validateStrategyDecision({
      candidate: buildCandidate({
        dataFreshnessSnapshot: buildDataFreshnessSnapshot({
          now,
          screeningSnapshotAt: now,
          poolDetailFetchedAt: null,
          tokenIntelFetchedAt: now,
          chainSnapshotFetchedAt: now,
          hasActiveBin: true,
        }),
      }),
      mode: "guarded_auto",
      aiReview: buildAiReview(),
      configStrategy,
      policy: {
        requireDetailForDeploy: true,
        strategyFallbackMode: "reject",
      },
    });

    expect(decision.rejected).toBe(true);
    expect(decision.reasonCodes).toContain("DETAIL_NOT_FRESH_OR_MISSING");
    expect(decision.riskFlags).toContain("detail_not_fresh_or_missing");
  });
});
