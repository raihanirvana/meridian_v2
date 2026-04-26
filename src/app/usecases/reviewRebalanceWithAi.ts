import { z } from "zod";

import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import {
  AiRebalanceDecisionSchema,
  RebalanceReviewInputSchema,
  type AiRebalanceDecision,
  type RebalanceReviewInput,
} from "../../domain/entities/RebalanceDecision.js";
import {
  AiRebalanceModeSchema,
  RebalanceDecisionValidationResultSchema,
  validateRebalanceDecision,
  type RebalanceDecisionValidationPolicy,
  type RebalanceDecisionValidationResult,
} from "../../domain/rules/rebalanceDecisionRules.js";
import { type Actor } from "../../domain/types/enums.js";
import { logger } from "../../infra/logging/logger.js";
import type { AiRebalancePlanner } from "../services/AiRebalancePlanner.js";
import type { LessonPromptService } from "../services/LessonPromptService.js";

const RebalanceReviewSourceSchema = z.enum([
  "DISABLED",
  "AI",
  "FALLBACK",
  "DETERMINISTIC",
]);

export const RebalanceReviewWithAiResultSchema = z
  .object({
    source: RebalanceReviewSourceSchema,
    decision: AiRebalanceDecisionSchema,
    validation: RebalanceDecisionValidationResultSchema,
    aiError: z.string().min(1).nullable(),
  })
  .strict();

export type RebalanceReviewSource = z.infer<typeof RebalanceReviewSourceSchema>;
export type RebalanceReviewWithAiResult = z.infer<
  typeof RebalanceReviewWithAiResultSchema
>;

export interface ReviewRebalanceWithAiInput {
  wallet: string;
  positionId: string;
  mode: "advisory" | "dry_run" | "constrained_action";
  review: RebalanceReviewInput;
  planner?: AiRebalancePlanner;
  validationPolicy?: Partial<RebalanceDecisionValidationPolicy>;
  lessonPromptService?: LessonPromptService;
  journalRepository?: JournalRepository;
  actor?: Actor;
  now?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deterministicHoldDecision(): AiRebalanceDecision {
  return AiRebalanceDecisionSchema.parse({
    action: "hold",
    confidence: 1,
    riskLevel: "medium",
    reason: ["AI rebalance planner unavailable; holding position"],
    rebalancePlan: null,
    rejectIf: [],
  });
}

async function appendJournal(input: {
  journalRepository?: JournalRepository;
  timestamp: string;
  actor: Actor;
  wallet: string;
  positionId: string;
  source: RebalanceReviewSource;
  review: RebalanceReviewInput;
  decision: AiRebalanceDecision;
  validation: RebalanceDecisionValidationResult;
  aiError: string | null;
}): Promise<void> {
  if (input.journalRepository === undefined) {
    return;
  }

  await input.journalRepository.append({
    timestamp: input.timestamp,
    eventType: "AI_REBALANCE_REVIEWED",
    actor: input.source === "AI" ? "ai" : input.actor,
    wallet: input.wallet,
    positionId: input.positionId,
    actionId: null,
    before: null,
    after: {
      source: input.source,
      review: input.review,
      decision: input.decision,
      validation: input.validation,
    },
    txIds: [],
    resultStatus: input.source,
    error: input.aiError,
  });

  await input.journalRepository.append({
    timestamp: input.timestamp,
    eventType: "REBALANCE_DECISION_VALIDATED",
    actor: "system",
    wallet: input.wallet,
    positionId: input.positionId,
    actionId: null,
    before: null,
    after: {
      allowed: input.validation.allowed,
      action: input.validation.action,
      reasonCodes: input.validation.reasonCodes,
      riskFlags: input.validation.riskFlags,
      rebalancePlan: input.validation.rebalancePlan,
    },
    txIds: [],
    resultStatus: input.validation.allowed ? "ALLOWED" : "BLOCKED",
    error: input.validation.allowed
      ? null
      : input.validation.riskFlags.join("; "),
  });
}

export async function reviewRebalanceWithAi(
  input: ReviewRebalanceWithAiInput,
): Promise<RebalanceReviewWithAiResult> {
  const mode = AiRebalanceModeSchema.parse(input.mode);
  const review = RebalanceReviewInputSchema.parse(input.review);
  const timestamp = input.now ?? new Date().toISOString();
  const actor = input.actor ?? "system";

  let source: RebalanceReviewSource = "DISABLED";
  let decision: AiRebalanceDecision = deterministicHoldDecision();
  let aiError: string | null = null;

  if (mode !== "advisory" && input.planner === undefined) {
    source = "FALLBACK";
  } else if (input.planner === undefined) {
    source = "DETERMINISTIC";
  } else {
    try {
      const lessonsPrompt = await input.lessonPromptService?.buildLessonsPrompt(
        {
          role: "MANAGER",
          includePoolMemory: {
            candidates: [
              {
                poolAddress: review.position.poolAddress,
              },
            ],
          },
        },
      );
      if (input.lessonPromptService === undefined) {
        throw new Error("LessonPromptService is required for AI rebalance");
      }
      const poolMemoryPrompt =
        lessonsPrompt?.includes("### POOL MEMORY") === true
          ? []
          : ["### POOL MEMORY", "No pool memory recorded for this pool yet."];
      decision = AiRebalanceDecisionSchema.parse(
        await input.planner.reviewRebalanceDecision({
          ...review,
          lessonContext: [
            "### LESSONS LEARNED",
            lessonsPrompt ?? "No historical lessons recorded yet.",
            ...poolMemoryPrompt,
            "### POSITION PERFORMANCE CONTEXT",
            `position_pnl_pct=${review.position.pnlPct}`,
            `range=${review.position.lowerBin}-${review.position.upperBin}`,
            `out_of_range_minutes=${review.position.outOfRangeMinutes}`,
          ].join("\n"),
        }),
      );
      source = "AI";
    } catch (error) {
      logger.warn(
        { err: error, eventType: "AI_LESSON_INJECTION_FAILED" },
        "AI rebalance review fallback to hold",
      );
      source = "FALLBACK";
      aiError = errorMessage(error);
      decision = deterministicHoldDecision();
    }
  }

  const validation = validateRebalanceDecision({
    decision,
    review,
    policy: input.validationPolicy ?? {},
  });

  await appendJournal({
    ...(input.journalRepository === undefined
      ? {}
      : { journalRepository: input.journalRepository }),
    timestamp,
    actor,
    wallet: input.wallet,
    positionId: input.positionId,
    source,
    review,
    decision,
    validation,
    aiError,
  });

  return RebalanceReviewWithAiResultSchema.parse({
    source,
    decision,
    validation,
    aiError,
  });
}
