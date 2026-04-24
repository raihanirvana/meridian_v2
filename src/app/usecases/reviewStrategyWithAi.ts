import { z } from "zod";

import {
  AiStrategyReviewInputSchema,
  StrategyReviewResultSchema,
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

function buildSystemPrompt(): string {
  return [
    "You are an AI strategy reviewer for Meteora DLMM candidates.",
    "Capital preservation is more important than APY.",
    "Hard rejects must never be ignored.",
    "Use curve only for low-volatility sideways or stable-ish pools.",
    "Use spot for moderate-volatility non-directional pools.",
    "Use bid_ask only for volatile mean-reverting pools.",
    "If confidence is low, return watch or reject, not deploy.",
    "You do not have write permission. You only produce recommendation JSON.",
  ].join("\n");
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

  for (const candidate of candidates) {
    let item: StrategyReviewWithAiItem;
    if (!candidate.hardFilterPassed) {
      item = StrategyReviewWithAiItemSchema.parse({
        candidateId: candidate.candidateId,
        poolAddress: candidate.poolAddress,
        source: "DETERMINISTIC",
        review: deterministicReview(candidate, input),
        aiError: null,
      });
      reviews.push(item);
      await appendReviewJournal({
        journalRepository: input.journalRepository,
        timestamp: reviewedAt,
        wallet: input.wallet,
        item,
      });
      continue;
    }

    if (!shouldUseAi || input.reviewer === undefined) {
      item = StrategyReviewWithAiItemSchema.parse({
        candidateId: candidate.candidateId,
        poolAddress: candidate.poolAddress,
        source: aiMode === "disabled" ? "DISABLED" : "DETERMINISTIC",
        review: deterministicReview(candidate, input),
        aiError: null,
      });
      reviews.push(item);
      await appendReviewJournal({
        journalRepository: input.journalRepository,
        timestamp: reviewedAt,
        wallet: input.wallet,
        item,
      });
      continue;
    }

    try {
      const aiReview = StrategyReviewResultSchema.parse(
        await withTimeout(
          input.reviewer.reviewCandidateStrategy(
            AiStrategyReviewInputSchema.parse({
              candidate,
              systemPrompt: buildSystemPrompt(),
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
        review: enforceLowConfidencePolicy({
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

    reviews.push(item);
    await appendReviewJournal({
      journalRepository: input.journalRepository,
      timestamp: reviewedAt,
      wallet: input.wallet,
      item,
    });
  }

  return StrategyReviewWithAiResultSchema.parse({
    reviewedAt,
    reviews,
  });
}
