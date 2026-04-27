import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AiStrategyReviewer,
  StrategyReviewResult,
} from "../../../src/adapters/llm/AiStrategyReviewer.js";
import { MockAiStrategyReviewer } from "../../../src/adapters/llm/AiStrategyReviewer.js";
import { JournalRepository } from "../../../src/adapters/storage/JournalRepository.js";
import type { LessonPromptService } from "../../../src/app/services/LessonPromptService.js";
import { reviewStrategyWithAi } from "../../../src/app/usecases/reviewStrategyWithAi.js";
import {
  CandidateSchema,
  type Candidate,
} from "../../../src/domain/entities/Candidate.js";
import {
  buildDataFreshnessSnapshot,
  buildDlmmMicrostructureSnapshot,
  buildMarketFeatureSnapshot,
} from "../../../src/domain/rules/poolFeatureRules.js";
import { scoreStrategySuitability } from "../../../src/domain/scoring/strategySuitabilityScore.js";

const stubLessonPromptService: LessonPromptService = {
  async buildLessonsPrompt() {
    return null;
  },
};

const tempDirs: string[] = [];
const now = "2026-04-22T12:00:00.000Z";

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-strategy-review-"),
  );
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function buildCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const marketFeatureSnapshot = buildMarketFeatureSnapshot({
    volume24hUsd: 250_000,
    fees24hUsd: 280,
    tvlUsd: 100_000,
    volatility1hPct: 12,
    trendStrength1h: 12,
    meanReversionScore: 92,
    organicVolumeScore: 90,
    washTradingRiskScore: 3,
  });
  const dlmmMicrostructureSnapshot = buildDlmmMicrostructureSnapshot({
    binStep: 100,
    activeBin: 1000,
    activeBinObservedAt: now,
    depthNearActiveUsd: 25_000,
    depthWithin10BinsUsd: 50_000,
    depthWithin25BinsUsd: 80_000,
    estimatedSlippageBpsForDefaultSize: 75,
    rangeStabilityScore: 80,
    now,
  });
  const dataFreshnessSnapshot = buildDataFreshnessSnapshot({
    now,
    screeningSnapshotAt: now,
    poolDetailFetchedAt: now,
    tokenIntelFetchedAt: now,
    chainSnapshotFetchedAt: now,
    hasActiveBin: true,
  });
  const strategySuitability = scoreStrategySuitability({
    marketFeatureSnapshot,
    dlmmMicrostructureSnapshot,
    dataFreshnessSnapshot,
  });

  return CandidateSchema.parse({
    candidateId: "cand_001",
    poolAddress: "pool_001",
    symbolPair: "ABC-SOL",
    tokenXMint: "mint_abc",
    tokenYMint: "mint_sol",
    baseMint: "mint_abc",
    quoteMint: "mint_sol",
    screeningSnapshot: {
      marketCapUsd: 500_000,
      tvlUsd: 100_000,
      volumeUsd: 250_000,
      volumeConsistencyScore: 80,
      feeToTvlRatio: 0.12,
      feePerTvl24h: 0.28,
      organicScore: 90,
      holderCount: 1_500,
      binStep: 100,
      pairType: "volatile",
      launchpad: null,
    },
    marketFeatureSnapshot,
    dlmmMicrostructureSnapshot,
    tokenRiskSnapshot: {
      deployerAddress: "deployer_ok",
      topHolderPct: 15,
      botHolderPct: 3,
      bundleRiskPct: 4,
      washTradingRiskPct: 3,
      auditScore: 90,
      tokenXMint: "mint_abc",
      tokenYMint: "mint_sol",
    },
    smartMoneySnapshot: {
      smartWalletCount: 8,
      confidenceScore: 85,
      poolAgeHours: 96,
      tokenAgeHours: 24,
      narrativePenaltyScore: 5,
    },
    dataFreshnessSnapshot,
    strategySuitability,
    hardFilterPassed: true,
    score: 88,
    scoreBreakdown: {
      feeToTvl: 90,
    },
    decision: "SHORTLISTED",
    decisionReason: "Selected into deterministic shortlist",
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
    recommendedStrategy: "bid_ask",
    confidence: 0.84,
    riskLevel: "medium",
    binsBelow: 69,
    binsAbove: 0,
    slippageBps: 250,
    maxPositionAgeMinutes: 720,
    stopLossPct: 5,
    takeProfitPct: 12,
    trailingStopPct: 2,
    reasons: ["volatile but mean-reverting"],
    rejectIf: ["active bin drifts"],
    ...overrides,
  };
}

describe("reviewStrategyWithAi", () => {
  it("parses valid AI output and stores an audit journal event", async () => {
    const directory = await makeTempDir();
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });

    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      reviewer: new MockAiStrategyReviewer({
        reviewCandidateStrategy: {
          type: "success",
          value: buildAiReview(),
        },
      }),
      journalRepository,
      now: () => now,
    });

    expect(result.reviews[0]?.source).toBe("AI");
    expect(result.reviews[0]?.review.recommendedStrategy).toBe("bid_ask");
    const journal = await journalRepository.list();
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "AI_STRATEGY_REVIEWED",
          actor: "ai",
          resultStatus: "AI",
        }),
      ]),
    );
  });

  it("returns reviews even when strategy review journal append fails", async () => {
    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      reviewer: new MockAiStrategyReviewer({
        reviewCandidateStrategy: {
          type: "success",
          value: buildAiReview(),
        },
      }),
      journalRepository: {
        async append() {
          throw new Error("journal unavailable");
        },
      } as JournalRepository,
      now: () => now,
    });

    expect(result.reviews[0]?.source).toBe("AI");
    expect(result.reviews[0]?.review.recommendedStrategy).toBe("bid_ask");
  });

  it("sends the top deterministic candidates as one batch so AI can rerank deploy priorities", async () => {
    const seenBatchInputs: unknown[] = [];
    const candidateA = buildCandidate({
      candidateId: "cand_a",
      poolAddress: "pool_a",
      symbolPair: "AAA-SOL",
    });
    const candidateB = buildCandidate({
      candidateId: "cand_b",
      poolAddress: "pool_b",
      symbolPair: "BBB-SOL",
    });
    const reviewer: AiStrategyReviewer = {
      async reviewCandidateStrategy() {
        throw new Error("single review should not be called for batch review");
      },
      async reviewCandidateStrategies(input) {
        seenBatchInputs.push(input);
        return [
          buildAiReview({
            poolAddress: "pool_b",
            recommendedStrategy: "spot",
            binsBelow: 30,
            binsAbove: 30,
            reasons: ["best risk-adjusted candidate"],
          }),
          buildAiReview({
            poolAddress: "pool_a",
            decision: "watch",
            recommendedStrategy: "none",
            confidence: 0.9,
            riskLevel: "medium",
            binsBelow: 0,
            binsAbove: 0,
            slippageBps: 0,
            maxPositionAgeMinutes: 0,
            stopLossPct: 0,
            takeProfitPct: 0,
            trailingStopPct: 0,
            reasons: ["watch until volume stabilizes"],
          }),
        ];
      },
    };

    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [candidateA, candidateB],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      reviewer,
      botContext: {
        walletRiskMode: "small",
        maxPositionSol: 0.05,
        dailyLossRemainingSol: 0.3,
        allowedStrategies: ["curve", "spot", "bid_ask"],
      },
      now: () => now,
    });

    expect(seenBatchInputs).toHaveLength(1);
    expect(result.reviews.map((review) => review.poolAddress)).toEqual([
      "pool_b",
      "pool_a",
    ]);
    expect(result.reviews[0]?.review.decision).toBe("deploy");
    expect(result.reviews[1]?.review.decision).toBe("watch");
  });

  it("falls back when AI returns an invalid strategy enum", async () => {
    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      reviewer: new MockAiStrategyReviewer({
        reviewCandidateStrategy: {
          type: "success",
          value: {
            ...buildAiReview(),
            recommendedStrategy: "grid",
          } as unknown as StrategyReviewResult,
        },
      }),
      now: () => now,
    });

    expect(result.reviews[0]?.source).toBe("FALLBACK");
    expect(result.reviews[0]?.review.recommendedStrategy).toBe("bid_ask");
  });

  it("falls back when AI returns deploy with no concrete strategy", async () => {
    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      reviewer: new MockAiStrategyReviewer({
        reviewCandidateStrategy: {
          type: "success",
          value: buildAiReview({
            decision: "deploy",
            recommendedStrategy: "none",
          }),
        },
      }),
      now: () => now,
    });

    expect(result.reviews[0]?.source).toBe("FALLBACK");
    expect(result.reviews[0]?.aiError).toContain(
      "deploy decisions must recommend a concrete strategy",
    );
  });

  it("falls back when batch AI returns duplicate pool reviews", async () => {
    const candidateA = buildCandidate({
      candidateId: "cand_a",
      poolAddress: "pool_a",
      symbolPair: "AAA-SOL",
    });
    const candidateB = buildCandidate({
      candidateId: "cand_b",
      poolAddress: "pool_b",
      symbolPair: "BBB-SOL",
    });

    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [candidateA, candidateB],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      reviewer: {
        async reviewCandidateStrategy() {
          throw new Error("single review should not run");
        },
        async reviewCandidateStrategies() {
          return [
            buildAiReview({ poolAddress: "pool_a" }),
            buildAiReview({ poolAddress: "pool_a" }),
          ];
        },
      },
      now: () => now,
    });

    expect(result.reviews).toHaveLength(2);
    expect(result.reviews.every((review) => review.source === "FALLBACK")).toBe(
      true,
    );
    expect(result.reviews[0]?.aiError).toContain("duplicate poolAddress");
  });

  it("falls back when batch AI returns an extra pool review", async () => {
    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      reviewer: {
        async reviewCandidateStrategy() {
          throw new Error("single review should not run");
        },
        async reviewCandidateStrategies() {
          return [
            buildAiReview(),
            buildAiReview({ poolAddress: "pool_extra" }),
          ];
        },
      },
      now: () => now,
    });

    expect(result.reviews[0]?.source).toBe("FALLBACK");
    expect(result.reviews[0]?.aiError).toContain("unexpected poolAddress");
  });

  it("downgrades low-confidence AI deploy recommendations to watch", async () => {
    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      minConfidence: 0.7,
      reviewer: new MockAiStrategyReviewer({
        reviewCandidateStrategy: {
          type: "success",
          value: buildAiReview({
            confidence: 0.4,
          }),
        },
      }),
      now: () => now,
    });

    expect(result.reviews[0]?.source).toBe("AI");
    expect(result.reviews[0]?.review.decision).toBe("watch");
    expect(result.reviews[0]?.review.rejectIf).toContain(
      "confidence_below_minimum",
    );
  });

  it("rejects high-risk AI deploy recommendations even when confidence is high", async () => {
    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      minConfidence: 0.7,
      reviewer: new MockAiStrategyReviewer({
        reviewCandidateStrategy: {
          type: "success",
          value: buildAiReview({
            confidence: 0.95,
            riskLevel: "high",
          }),
        },
      }),
      now: () => now,
    });

    expect(result.reviews[0]?.source).toBe("AI");
    expect(result.reviews[0]?.review.decision).toBe("reject");
    expect(result.reviews[0]?.review.recommendedStrategy).toBe("none");
    expect(result.reviews[0]?.review.rejectIf).toContain("risk_level_high");
  });

  it("times out AI review and falls back deterministically", async () => {
    const slowReviewer: AiStrategyReviewer = {
      async reviewCandidateStrategy() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return buildAiReview();
      },
    };

    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      reviewer: slowReviewer,
      timeoutMs: 1,
      now: () => now,
    });

    expect(result.reviews[0]?.source).toBe("FALLBACK");
    expect(result.reviews[0]?.aiError).toContain("timed out");
  });

  it("times out lesson prompt build and falls back deterministically", async () => {
    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      timeoutMs: 10,
      lessonPromptService: {
        async buildLessonsPrompt() {
          return new Promise<string | null>(() => undefined);
        },
      },
      reviewer: new MockAiStrategyReviewer({
        reviewCandidateStrategy: {
          type: "success",
          value: buildAiReview(),
        },
      }),
      now: () => now,
    });

    expect(result.reviews[0]?.source).toBe("FALLBACK");
    expect(result.reviews[0]?.aiError).toBe("AI_LESSON_INJECTION_FAILED");
  });

  it("does not call AI for candidates that failed hard filters", async () => {
    const reviewCandidateStrategy = vi.fn(async () => buildAiReview());
    const candidate = buildCandidate({
      hardFilterPassed: false,
      decision: "REJECTED_HARD_FILTER",
      decisionReason: "strategy snapshot is stale",
      strategySuitability: {
        curveScore: 0,
        spotScore: 0,
        bidAskScore: 0,
        recommendedByRules: "none",
        strategyRiskFlags: ["stale_strategy_snapshot"],
        reasonCodes: ["snapshot_not_fresh"],
      },
    });

    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [candidate],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      reviewer: {
        reviewCandidateStrategy,
      },
      now: () => now,
    });

    expect(reviewCandidateStrategy).not.toHaveBeenCalled();
    expect(result.reviews[0]?.source).toBe("DETERMINISTIC");
    expect(result.reviews[0]?.review.decision).toBe("reject");
  });

  it("injects lessons and pool memory into the system prompt", async () => {
    const seenPrompts: string[] = [];
    const reviewer: AiStrategyReviewer = {
      async reviewCandidateStrategy(input) {
        seenPrompts.push(input.systemPrompt ?? "");
        return buildAiReview();
      },
    };
    const lessonAware: LessonPromptService = {
      async buildLessonsPrompt(promptInput) {
        expect(promptInput.role).toBe("SCREENER");
        expect(promptInput.includePoolMemory?.candidates[0]?.poolAddress).toBe(
          "pool_001",
        );
        return [
          "- avoid pool_001 when volume drops",
          "### POOL MEMORY",
          "- pool_001: previous win rate 60%",
        ].join("\n");
      },
    };

    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      lessonPromptService: lessonAware,
      reviewer,
      now: () => now,
    });

    expect(result.reviews[0]?.source).toBe("AI");
    expect(seenPrompts[0]).toContain("### LESSONS LEARNED");
    expect(seenPrompts[0]).toContain("avoid pool_001 when volume drops");
    expect(seenPrompts[0]).toContain("pool_001: previous win rate 60%");
  });

  it("falls back deterministically and journals AI_LESSON_INJECTION_FAILED when lesson loading throws", async () => {
    const directory = await makeTempDir();
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const reviewCandidateStrategy = vi.fn(async () => buildAiReview());

    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      lessonPromptService: {
        async buildLessonsPrompt(): Promise<string | null> {
          throw new Error("lesson repo corrupt");
        },
      },
      reviewer: { reviewCandidateStrategy },
      journalRepository,
      now: () => now,
    });

    expect(reviewCandidateStrategy).not.toHaveBeenCalled();
    expect(result.reviews[0]?.source).toBe("FALLBACK");
    expect(result.reviews[0]?.aiError).toBe("AI_LESSON_INJECTION_FAILED");
    const journal = await journalRepository.list();
    expect(
      journal.some((event) => event.eventType === "AI_LESSON_INJECTION_FAILED"),
    ).toBe(true);
  });

  it("does not call AI and falls back when lessonPromptService is missing in advisory mode", async () => {
    const reviewCandidateStrategy = vi.fn(async () => buildAiReview());

    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      reviewer: { reviewCandidateStrategy },
      now: () => now,
    });

    expect(reviewCandidateStrategy).not.toHaveBeenCalled();
    expect(result.reviews[0]?.source).toBe("FALLBACK");
  });

  it("survives non-JSON or vendor parsing failures without crashing", async () => {
    const result = await reviewStrategyWithAi({
      wallet: "wallet_001",
      candidates: [buildCandidate()],
      aiMode: "advisory",
      lessonPromptService: stubLessonPromptService,
      reviewer: {
        async reviewCandidateStrategy() {
          throw new Error("LLM response is not valid JSON");
        },
      },
      now: () => now,
    });

    expect(result.reviews[0]?.source).toBe("FALLBACK");
    expect(result.reviews[0]?.aiError).toBe("LLM response is not valid JSON");
  });
});
