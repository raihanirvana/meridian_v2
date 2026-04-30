import { z } from "zod";

import { CandidateSchema } from "../../domain/entities/Candidate.js";
import { type MockBehavior, resolveMockBehavior } from "../mockBehavior.js";

export const AiStrategyBotContextSchema = z
  .object({
    walletRiskMode: z.string().min(1).optional(),
    maxPositionSol: z.number().positive().optional(),
    maxSlippageBps: z.number().positive().optional(),
    maxActiveBinDrift: z.number().int().nonnegative().optional(),
    maxOpenPositions: z.number().int().positive().optional(),
    dailyLossRemainingSol: z.number().nonnegative().optional(),
    currentlyOpenPositions: z.number().int().nonnegative().optional(),
    requireTokenIntelForDeploy: z.boolean().optional(),
    allowedStrategies: z.array(z.enum(["curve", "spot", "bid_ask"])).optional(),
  })
  .strict();

export const StrategyReviewResultSchema = z
  .object({
    poolAddress: z.string().min(1),
    decision: z.enum(["deploy", "watch", "reject"]),
    recommendedStrategy: z.enum(["curve", "spot", "bid_ask", "none"]),
    confidence: z.number().min(0).max(1),
    riskLevel: z.enum(["low", "medium", "high"]),
    binsBelow: z.number().int().nonnegative(),
    binsAbove: z.number().int().nonnegative(),
    slippageBps: z.number().int().nonnegative(),
    maxPositionAgeMinutes: z.number().int().nonnegative(),
    stopLossPct: z.number().nonnegative(),
    takeProfitPct: z.number().nonnegative(),
    trailingStopPct: z.number().nonnegative(),
    reasons: z.array(z.string().min(1)),
    rejectIf: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === "deploy" && value.recommendedStrategy === "none") {
      ctx.addIssue({
        code: "custom",
        path: ["recommendedStrategy"],
        message: "deploy decisions must recommend a concrete strategy",
      });
    }

    if (value.decision === "reject" && value.recommendedStrategy !== "none") {
      ctx.addIssue({
        code: "custom",
        path: ["recommendedStrategy"],
        message: "reject decisions must use recommendedStrategy none",
      });
    }
  });

export const AiStrategyReviewInputSchema = z
  .object({
    candidate: CandidateSchema,
    systemPrompt: z.string().min(1).nullable(),
    botContext: AiStrategyBotContextSchema.optional(),
  })
  .strict();

export const AiStrategyBatchReviewInputSchema = z
  .object({
    candidates: CandidateSchema.array().min(1),
    systemPrompt: z.string().min(1).nullable(),
    botContext: AiStrategyBotContextSchema.optional(),
  })
  .strict();

export const StrategyReviewBatchResultSchema =
  StrategyReviewResultSchema.array();

export type StrategyReviewResult = z.infer<typeof StrategyReviewResultSchema>;
export type AiStrategyReviewInput = z.infer<typeof AiStrategyReviewInputSchema>;
export type AiStrategyBatchReviewInput = z.infer<
  typeof AiStrategyBatchReviewInputSchema
>;
export type AiStrategyBotContext = z.infer<typeof AiStrategyBotContextSchema>;

export interface AiStrategyReviewer {
  reviewCandidateStrategy(
    input: AiStrategyReviewInput,
  ): Promise<StrategyReviewResult>;
  reviewCandidateStrategies?(
    input: AiStrategyBatchReviewInput,
  ): Promise<StrategyReviewResult[]>;
}

export interface MockAiStrategyReviewerBehaviors {
  reviewCandidateStrategy: MockBehavior<StrategyReviewResult>;
  reviewCandidateStrategies?: MockBehavior<StrategyReviewResult[]>;
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

  public async reviewCandidateStrategies(
    input: AiStrategyBatchReviewInput,
  ): Promise<StrategyReviewResult[]> {
    AiStrategyBatchReviewInputSchema.parse(input);
    if (this.behaviors.reviewCandidateStrategies === undefined) {
      const results: StrategyReviewResult[] = [];
      for (const candidate of input.candidates) {
        results.push(
          await this.reviewCandidateStrategy({
            candidate,
            systemPrompt: input.systemPrompt,
            ...(input.botContext === undefined
              ? {}
              : { botContext: input.botContext }),
          }),
        );
      }
      return results;
    }

    return StrategyReviewBatchResultSchema.parse(
      await resolveMockBehavior(this.behaviors.reviewCandidateStrategies),
    );
  }
}
