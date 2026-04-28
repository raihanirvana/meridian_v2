import { describe, expect, it } from "vitest";

import type { JournalRepository } from "../../../src/adapters/storage/JournalRepository.js";
import type {
  AiRebalanceDecision,
  RebalanceReviewInput,
} from "../../../src/domain/entities/RebalanceDecision.js";
import { reviewRebalanceWithAi } from "../../../src/app/usecases/reviewRebalanceWithAi.js";

const now = "2026-04-25T00:00:00.000Z";

function buildReview(): RebalanceReviewInput {
  return {
    position: {
      positionId: "pos_001",
      poolAddress: "pool_001",
      strategy: "bid_ask",
      lowerBin: 1000,
      upperBin: 1060,
      activeBinAtEntry: 1030,
      currentActiveBin: 1063,
      binStep: 80,
      ageMinutes: 18,
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
      currentActiveBin: 1063,
    },
    walletRisk: {
      dailyLossRemainingSol: 0.25,
      openPositions: 2,
      maxOpenPositions: 3,
      maxRebalancesPerPosition: 2,
      maxPositionSol: 0.05,
    },
    triggerReasons: ["position out of range for 6 minutes"],
  };
}

function buildDecision(
  overrides: Partial<AiRebalanceDecision> = {},
): AiRebalanceDecision {
  return {
    action: "rebalance_same_pool",
    confidence: 0.88,
    riskLevel: "medium",
    reason: ["Pool remains healthy and position is out of range"],
    rebalancePlan: {
      strategy: "spot",
      binsBelow: 40,
      binsAbove: 20,
      slippageBps: 100,
      maxPositionAgeMinutes: 30,
      stopLossPct: 1,
      takeProfitPct: 2,
      trailingStopPct: 0.5,
    },
    rejectIf: ["activeBinDrift > 3 before submit"],
    ...overrides,
  };
}

describe("reviewRebalanceWithAi", () => {
  it("validates an AI rebalance decision", async () => {
    const result = await reviewRebalanceWithAi({
      wallet: "wallet_001",
      positionId: "pos_001",
      mode: "constrained_action",
      review: buildReview(),
      planner: {
        async reviewRebalanceDecision(input) {
          expect(input.lessonContext).toContain("### LESSONS LEARNED");
          expect(input.lessonContext).toContain("### POOL MEMORY");
          return buildDecision();
        },
      },
      lessonPromptService: {
        async buildLessonsPrompt(promptInput) {
          expect(promptInput.includePoolMemory?.candidates).toEqual([
            { poolAddress: "pool_001" },
          ]);
          return [
            "Prefer stable manager lessons.",
            "### POOL MEMORY",
            "- pool_001: 2 deploy(s), avg PnL 4.20%",
          ].join("\n");
        },
      },
      validationPolicy: {
        closeSimulationPassed: true,
        redeploySimulationPassed: true,
      },
      now,
    });

    expect(result.source).toBe("AI");
    expect(result.validation.allowed).toBe(true);
    expect(result.validation.action).toBe("rebalance_same_pool");
  });

  it("falls back to hold when the AI planner fails", async () => {
    const result = await reviewRebalanceWithAi({
      wallet: "wallet_001",
      positionId: "pos_001",
      mode: "constrained_action",
      review: buildReview(),
      planner: {
        async reviewRebalanceDecision() {
          throw new Error("llm unavailable");
        },
      },
      lessonPromptService: {
        async buildLessonsPrompt() {
          return "Prefer stable manager lessons.";
        },
      },
      now,
    });

    expect(result.source).toBe("FALLBACK");
    expect(result.decision.action).toBe("hold");
    expect(result.aiError).toBe("llm unavailable");
  });

  it("returns a validated result when rebalance review journal append fails", async () => {
    const failingJournal = {
      async append() {
        throw new Error("journal unavailable");
      },
    } as unknown as JournalRepository;

    const result = await reviewRebalanceWithAi({
      wallet: "wallet_001",
      positionId: "pos_001",
      mode: "constrained_action",
      review: buildReview(),
      planner: {
        async reviewRebalanceDecision() {
          return buildDecision();
        },
      },
      lessonPromptService: {
        async buildLessonsPrompt() {
          return "Prefer stable manager lessons.";
        },
      },
      journalRepository: failingJournal,
      validationPolicy: {
        closeSimulationPassed: true,
        redeploySimulationPassed: true,
      },
      now,
    });

    expect(result.source).toBe("AI");
    expect(result.validation.allowed).toBe(true);
  });
});
