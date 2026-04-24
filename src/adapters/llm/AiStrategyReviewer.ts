import { z } from "zod";

import { CandidateSchema } from "../../domain/entities/Candidate.js";
import { type MockBehavior, resolveMockBehavior } from "../mockBehavior.js";

export const StrategyReviewResultSchema = z
  .object({
    poolAddress: z.string().min(1),
    decision: z.enum(["deploy", "watch", "reject"]),
    recommendedStrategy: z.enum(["curve", "spot", "bid_ask", "none"]),
    confidence: z.number().min(0).max(1),
    riskLevel: z.enum(["low", "medium", "high"]),
    binsBelow: z.number().int().nonnegative(),
    binsAbove: z.number().int().nonnegative(),
    slippageBps: z.number().int().positive(),
    maxPositionAgeMinutes: z.number().int().positive(),
    stopLossPct: z.number().positive(),
    takeProfitPct: z.number().positive(),
    trailingStopPct: z.number().positive(),
    reasons: z.array(z.string().min(1)),
    rejectIf: z.array(z.string().min(1)),
  })
  .strict();

export const AiStrategyReviewInputSchema = z
  .object({
    candidate: CandidateSchema,
    systemPrompt: z.string().min(1).nullable(),
  })
  .strict();

export type StrategyReviewResult = z.infer<typeof StrategyReviewResultSchema>;
export type AiStrategyReviewInput = z.infer<typeof AiStrategyReviewInputSchema>;

export interface AiStrategyReviewer {
  reviewCandidateStrategy(
    input: AiStrategyReviewInput,
  ): Promise<StrategyReviewResult>;
}

export interface MockAiStrategyReviewerBehaviors {
  reviewCandidateStrategy: MockBehavior<StrategyReviewResult>;
}

export class MockAiStrategyReviewer implements AiStrategyReviewer {
  public constructor(
    private readonly behaviors: MockAiStrategyReviewerBehaviors,
  ) {}

  public async reviewCandidateStrategy(
    input: AiStrategyReviewInput,
  ): Promise<StrategyReviewResult> {
    AiStrategyReviewInputSchema.parse(input);
    return StrategyReviewResultSchema.parse(
      await resolveMockBehavior(this.behaviors.reviewCandidateStrategy),
    );
  }
}
