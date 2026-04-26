import { z } from "zod";

import {
  AiStrategyReviewInputSchema,
  StrategyReviewResultSchema,
  type AiStrategyBotContext,
  type AiStrategyReviewer,
  type StrategyReviewResult,
} from "../../adapters/llm/AiStrategyReviewer.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import {
  CandidateSchema,
  type Candidate,
} from "../../domain/entities/Candidate.js";
import {
  AiModeSchema,
  type UserConfig,
} from "../../infra/config/configSchema.js";
import { logger } from "../../infra/logging/logger.js";
import type { LessonPromptService } from "../services/LessonPromptService.js";

const StrategyReviewSourceSchema = z.enum([
  "DISABLED",
  "DETERMINISTIC",
  "AI",
  "FALLBACK",
]);

export const StrategyReviewWithAiItemSchema = z
  .object({
    candidateId: z.string().min(1),
    poolAddress: z.string().min(1),
    source: StrategyReviewSourceSchema,
    review: StrategyReviewResultSchema,
    aiError: z.string().min(1).nullable(),
  })
  .strict();

export const StrategyReviewWithAiResultSchema = z
  .object({
    reviewedAt: z.string().datetime(),
    reviews: StrategyReviewWithAiItemSchema.array(),
  })
  .strict();

export type StrategyReviewSource = z.infer<typeof StrategyReviewSourceSchema>;
export type StrategyReviewWithAiItem = z.infer<
  typeof StrategyReviewWithAiItemSchema
>;
export type StrategyReviewWithAiResult = z.infer<
  typeof StrategyReviewWithAiResultSchema
>;

export interface ReviewStrategyWithAiInput {
  wallet: string;
  candidates: Candidate[];
  aiMode: UserConfig["ai"]["mode"];
  reviewer?: AiStrategyReviewer;
  journalRepository?: JournalRepository;
  lessonPromptService?: LessonPromptService;
  minConfidence?: number;
  timeoutMs?: number;
  defaults?: {
    binsBelow?: number;
    binsAbove?: number;
    slippageBps?: number;
    maxPositionAgeMinutes?: number;
    stopLossPct?: number;
    takeProfitPct?: number;
    trailingStopPct?: number;
  };
  botContext?: AiStrategyBotContext;
  now?: () => string;
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`AI strategy review timed out after ${timeoutMs}ms`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(timeoutError(timeoutMs));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultReviewParams(input: ReviewStrategyWithAiInput) {
  return {
    binsBelow: input.defaults?.binsBelow ?? 69,
    binsAbove: input.defaults?.binsAbove ?? 0,
    slippageBps: input.defaults?.slippageBps ?? 300,
    maxPositionAgeMinutes: input.defaults?.maxPositionAgeMinutes ?? 1440,
    stopLossPct: input.defaults?.stopLossPct ?? 5,
    takeProfitPct: input.defaults?.takeProfitPct ?? 10,
    trailingStopPct: input.defaults?.trailingStopPct ?? 2,
  };
}

function deterministicReview(
  candidate: Candidate,
  input: ReviewStrategyWithAiInput,
): StrategyReviewResult {
  const defaults = defaultReviewParams(input);
  const recommendedStrategy = candidate.hardFilterPassed
    ? candidate.strategySuitability.recommendedByRules
    : "none";
  const hasRiskFlags =
    candidate.strategySuitability.strategyRiskFlags.length > 0;

  return StrategyReviewResultSchema.parse({
    poolAddress: candidate.poolAddress,
    decision:
      !candidate.hardFilterPassed || recommendedStrategy === "none"
        ? "reject"
        : "watch",
    recommendedStrategy,
    confidence: !candidate.hardFilterPassed ? 1 : 0.65,
    riskLevel: !candidate.hardFilterPassed || hasRiskFlags ? "high" : "medium",
    binsBelow: defaults.binsBelow,
    binsAbove: defaults.binsAbove,
    slippageBps: defaults.slippageBps,
    maxPositionAgeMinutes: defaults.maxPositionAgeMinutes,
    stopLossPct: defaults.stopLossPct,
    takeProfitPct: defaults.takeProfitPct,
    trailingStopPct: defaults.trailingStopPct,
    reasons: [
      candidate.hardFilterPassed
        ? `deterministic strategy fit: ${recommendedStrategy}`
        : candidate.decisionReason,
      ...candidate.strategySuitability.reasonCodes,
    ],
    rejectIf: candidate.hardFilterPassed
      ? candidate.strategySuitability.strategyRiskFlags
      : ["hard_filter_failed", candidate.decisionReason],
  });
}

function enforceLowConfidencePolicy(input: {
  review: StrategyReviewResult;
  minConfidence: number;
}): StrategyReviewResult {
  if (
    input.review.decision !== "deploy" ||
    input.review.confidence >= input.minConfidence
  ) {
    return input.review;
  }

  return StrategyReviewResultSchema.parse({
    ...input.review,
    decision: "watch",
    reasons: [
      ...input.review.reasons,
      `downgraded_from_deploy_because_confidence_below_${input.minConfidence}`,
    ],
    rejectIf: [...input.review.rejectIf, "confidence_below_minimum"],
  });
}

function enforceStrategyReviewSafety(input: {
  review: StrategyReviewResult;
  minConfidence: number;
}): StrategyReviewResult {
  let review = input.review;

  if (review.decision === "deploy" && review.riskLevel === "high") {
    review = StrategyReviewResultSchema.parse({
      ...review,
      decision: "reject",
      recommendedStrategy: "none",
      reasons: [...review.reasons, "rejected_because_risk_level_high"],
      rejectIf: [...review.rejectIf, "risk_level_high"],
    });
  }

  return enforceLowConfidencePolicy({
    review,
    minConfidence: input.minConfidence,
  });
}

function validateBatchReviewSet(input: {
  expectedPools: string[];
  aiReviews: StrategyReviewResult[];
}): void {
  const expected = new Set(input.expectedPools);
  const seen = new Set<string>();

  for (const review of input.aiReviews) {
    if (!expected.has(review.poolAddress)) {
      throw new Error(
        `AI strategy review returned unexpected poolAddress ${review.poolAddress}`,
      );
    }

    if (seen.has(review.poolAddress)) {
      throw new Error(
        `AI strategy review returned duplicate poolAddress ${review.poolAddress}`,
      );
    }

    seen.add(review.poolAddress);
  }

  for (const poolAddress of expected) {
    if (!seen.has(poolAddress)) {
      throw new Error(`AI strategy review omitted poolAddress ${poolAddress}`);
    }
  }
}

function buildSystemPrompt(lessonsPrompt: string | null): string {
  const lines = [
    "You are an AI strategy reviewer for Meteora DLMM candidates.",
    "Capital preservation is more important than APY.",
    "Hard rejects must never be ignored.",
    "Use curve only for low-volatility sideways or stable-ish pools.",
    "Use spot for moderate-volatility non-directional pools.",
    "Use bid_ask only for volatile mean-reverting pools.",
    "If confidence is low, return watch or reject, not deploy.",
    "You may recommend one strategy only: curve, spot, bid_ask, or none.",
    "Use curve for low-volatility sideways pools.",
    "Use spot for moderate-volatility pools with stable volume and no strong directional trend.",
    "Use bid_ask only for high-volume, high-volatility, mean-reverting pools with sufficient depth.",
    "Reject suspicious token risk, shallow liquidity, stale data, excessive price movement, or unrealistic fee/TVL.",
    "If confidence is below the requested minimum, decision must be watch or reject.",
    "If riskLevel is high, decision must be reject.",
    "You do not have write permission. You only produce recommendation JSON.",
    "",
    "### LESSONS LEARNED",
    lessonsPrompt ?? "No historical lessons recorded yet.",
  ];
  return lines.join("\n");
}

async function appendLessonInjectionFailedJournal(input: {
  journalRepository: JournalRepository | undefined;
  timestamp: string;
  wallet: string;
  error: unknown;
}): Promise<void> {
  if (input.journalRepository === undefined) {
    return;
  }

  await input.journalRepository.append({
    timestamp: input.timestamp,
    eventType: "AI_LESSON_INJECTION_FAILED",
    actor: "system",
    wallet: input.wallet,
    positionId: null,
    actionId: null,
    before: null,
    after: {
      stage: "strategy_review",
    },
    txIds: [],
    resultStatus: "FAILED",
    error: errorMessage(input.error),
  });
}

async function appendJournal(input: {
  journalRepository?: JournalRepository;
  timestamp: string;
  wallet: string;
  item: StrategyReviewWithAiItem;
}): Promise<void> {
  if (input.journalRepository === undefined) {
    return;
  }

  await input.journalRepository.append({
    timestamp: input.timestamp,
    eventType: "AI_STRATEGY_REVIEWED",
    actor: input.item.source === "AI" ? "ai" : "system",
    wallet: input.wallet,
    positionId: null,
    actionId: null,
    before: null,
    after: {
      candidateId: input.item.candidateId,
      poolAddress: input.item.poolAddress,
      source: input.item.source,
      review: input.item.review,
    },
    txIds: [],
    resultStatus: input.item.source,
    error: input.item.aiError,
  });
}

async function appendReviewJournal(input: {
  journalRepository: JournalRepository | undefined;
  timestamp: string;
  wallet: string;
  item: StrategyReviewWithAiItem;
}): Promise<void> {
  await appendJournal({
    ...(input.journalRepository === undefined
      ? {}
      : { journalRepository: input.journalRepository }),
    timestamp: input.timestamp,
    wallet: input.wallet,
    item: input.item,
  });
}

export async function reviewStrategyWithAi(
  input: ReviewStrategyWithAiInput,
): Promise<StrategyReviewWithAiResult> {
  const candidates = CandidateSchema.array().parse(input.candidates);
  const aiMode = AiModeSchema.parse(input.aiMode);
  const reviewedAt = input.now?.() ?? new Date().toISOString();
  const minConfidence = input.minConfidence ?? 0.7;
  const timeoutMs = input.timeoutMs ?? 500;
  const reviews: StrategyReviewWithAiItem[] = [];
  const shouldUseAi = aiMode !== "disabled" && input.reviewer !== undefined;

  async function appendItem(item: StrategyReviewWithAiItem): Promise<void> {
    reviews.push(item);
    await appendReviewJournal({
      journalRepository: input.journalRepository,
      timestamp: reviewedAt,
      wallet: input.wallet,
      item,
    });
  }

  const hardFilterFailed = candidates.filter(
    (candidate) => !candidate.hardFilterPassed,
  );
  for (const candidate of hardFilterFailed) {
    await appendItem(
      StrategyReviewWithAiItemSchema.parse({
        candidateId: candidate.candidateId,
        poolAddress: candidate.poolAddress,
        source: "DETERMINISTIC",
        review: deterministicReview(candidate, input),
        aiError: null,
      }),
    );
  }

  const aiEligibleCandidates = candidates.filter(
    (candidate) => candidate.hardFilterPassed,
  );

  let lessonsPrompt: string | null = null;
  let lessonInjectionFailed = false;
  if (shouldUseAi && aiEligibleCandidates.length > 0) {
    if (input.lessonPromptService === undefined) {
      lessonInjectionFailed = true;
      await appendLessonInjectionFailedJournal({
        journalRepository: input.journalRepository,
        timestamp: reviewedAt,
        wallet: input.wallet,
        error: new Error(
          "LessonPromptService is required for AI strategy review",
        ),
      });
    } else {
      try {
        lessonsPrompt = await input.lessonPromptService.buildLessonsPrompt({
          role: "SCREENER",
          includePoolMemory: {
            candidates: aiEligibleCandidates.map((candidate) => ({
              poolAddress: candidate.poolAddress,
            })),
          },
        });
      } catch (error) {
        lessonInjectionFailed = true;
        logger.warn(
          { err: error, eventType: "AI_LESSON_INJECTION_FAILED" },
          "AI strategy review fallback to deterministic result because lesson injection failed",
        );
        await appendLessonInjectionFailedJournal({
          journalRepository: input.journalRepository,
          timestamp: reviewedAt,
          wallet: input.wallet,
          error,
        });
      }
    }
  }

  if (lessonInjectionFailed) {
    for (const candidate of aiEligibleCandidates) {
      await appendItem(
        StrategyReviewWithAiItemSchema.parse({
          candidateId: candidate.candidateId,
          poolAddress: candidate.poolAddress,
          source: "FALLBACK",
          review: deterministicReview(candidate, input),
          aiError: "AI_LESSON_INJECTION_FAILED",
        }),
      );
    }

    return StrategyReviewWithAiResultSchema.parse({
      reviewedAt,
      reviews: candidates
        .map((candidate) =>
          reviews.find(
            (review) => review.candidateId === candidate.candidateId,
          ),
        )
        .filter(
          (review): review is StrategyReviewWithAiItem => review !== undefined,
        ),
    });
  }

  if (
    shouldUseAi &&
    input.reviewer?.reviewCandidateStrategies !== undefined &&
    aiEligibleCandidates.length > 0
  ) {
    try {
      const aiReviews = await withTimeout(
        input.reviewer.reviewCandidateStrategies({
          candidates: aiEligibleCandidates,
          systemPrompt: buildSystemPrompt(lessonsPrompt),
          ...(input.botContext === undefined
            ? {}
            : { botContext: input.botContext }),
        }),
        timeoutMs,
      );
      validateBatchReviewSet({
        expectedPools: aiEligibleCandidates.map(
          (candidate) => candidate.poolAddress,
        ),
        aiReviews,
      });

      const candidateByPool = new Map(
        aiEligibleCandidates.map((candidate) => [
          candidate.poolAddress,
          candidate,
        ]),
      );
      for (const aiReview of aiReviews) {
        const candidate = candidateByPool.get(aiReview.poolAddress);
        if (candidate === undefined) {
          continue;
        }
        await appendItem(
          StrategyReviewWithAiItemSchema.parse({
            candidateId: candidate.candidateId,
            poolAddress: candidate.poolAddress,
            source: "AI",
            review: enforceStrategyReviewSafety({
              review: StrategyReviewResultSchema.parse(aiReview),
              minConfidence,
            }),
            aiError: null,
          }),
        );
      }

      return StrategyReviewWithAiResultSchema.parse({
        reviewedAt,
        reviews,
      });
    } catch (error) {
      logger.warn(
        { err: error },
        "AI batch strategy review fallback to deterministic result",
      );
      for (const candidate of aiEligibleCandidates) {
        await appendItem(
          StrategyReviewWithAiItemSchema.parse({
            candidateId: candidate.candidateId,
            poolAddress: candidate.poolAddress,
            source: "FALLBACK",
            review: deterministicReview(candidate, input),
            aiError: errorMessage(error),
          }),
        );
      }

      return StrategyReviewWithAiResultSchema.parse({
        reviewedAt,
        reviews: candidates
          .map((candidate) =>
            reviews.find(
              (review) => review.candidateId === candidate.candidateId,
            ),
          )
          .filter(
            (review): review is StrategyReviewWithAiItem =>
              review !== undefined,
          ),
      });
    }
  }

  for (const candidate of aiEligibleCandidates) {
    let item: StrategyReviewWithAiItem;
    if (!shouldUseAi || input.reviewer === undefined) {
      item = StrategyReviewWithAiItemSchema.parse({
        candidateId: candidate.candidateId,
        poolAddress: candidate.poolAddress,
        source: aiMode === "disabled" ? "DISABLED" : "DETERMINISTIC",
        review: deterministicReview(candidate, input),
        aiError: null,
      });
      await appendItem(item);
      continue;
    }

    try {
      const aiReview = StrategyReviewResultSchema.parse(
        await withTimeout(
          input.reviewer.reviewCandidateStrategy(
            AiStrategyReviewInputSchema.parse({
              candidate,
              systemPrompt: buildSystemPrompt(lessonsPrompt),
              ...(input.botContext === undefined
                ? {}
                : { botContext: input.botContext }),
            }),
          ),
          timeoutMs,
        ),
      );
      if (aiReview.poolAddress !== candidate.poolAddress) {
        throw new Error("AI strategy review returned a different poolAddress");
      }

      item = StrategyReviewWithAiItemSchema.parse({
        candidateId: candidate.candidateId,
        poolAddress: candidate.poolAddress,
        source: "AI",
        review: enforceStrategyReviewSafety({
          review: aiReview,
          minConfidence,
        }),
        aiError: null,
      });
    } catch (error) {
      logger.warn(
        { err: error, candidateId: candidate.candidateId },
        "AI strategy review fallback to deterministic result",
      );
      item = StrategyReviewWithAiItemSchema.parse({
        candidateId: candidate.candidateId,
        poolAddress: candidate.poolAddress,
        source: "FALLBACK",
        review: deterministicReview(candidate, input),
        aiError: errorMessage(error),
      });
    }

    await appendItem(item);
  }

  return StrategyReviewWithAiResultSchema.parse({
    reviewedAt,
    reviews: candidates
      .map((candidate) =>
        reviews.find((review) => review.candidateId === candidate.candidateId),
      )
      .filter(
        (review): review is StrategyReviewWithAiItem => review !== undefined,
      ),
  });
}
