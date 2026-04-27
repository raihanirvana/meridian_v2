import { z } from "zod";

import { CandidateSchema } from "../../domain/entities/Candidate.js";
import { PositionSchema } from "../../domain/entities/Position.js";
import {
  AiRebalanceDecisionSchema,
  RebalanceReviewInputSchema,
  type AiRebalanceDecision,
  type RebalanceReviewInput,
} from "../../domain/entities/RebalanceDecision.js";
import { type MockBehavior, resolveMockBehavior } from "../mockBehavior.js";

export const CandidateRankingInputSchema = z
  .object({
    candidates: CandidateSchema.array(),
    systemPrompt: z.string().min(1).nullable(),
  })
  .strict();

export const CandidateRankingResultSchema = z
  .object({
    rankedCandidateIds: z.array(z.string().min(1)),
    reasoning: z.string().min(1),
  })
  .strict();

export const ManagementExplanationInputSchema = z
  .object({
    positionId: z.string().min(1),
    proposedAction: z.enum([
      "HOLD",
      "CLAIM_FEES",
      "PARTIAL_CLOSE",
      "REBALANCE",
      "CLOSE",
      "RECONCILE_ONLY",
    ]),
    positionSnapshot: PositionSchema,
    triggerReasons: z.array(z.string().min(1)),
    systemPrompt: z.string().min(1).nullable(),
  })
  .strict();

export const ManagementExplanationResultSchema = z
  .object({
    action: z.enum([
      "HOLD",
      "CLAIM_FEES",
      "PARTIAL_CLOSE",
      "REBALANCE",
      "CLOSE",
      "RECONCILE_ONLY",
    ]),
    reasoning: z.string().min(1),
  })
  .strict();

export type CandidateRankingResult = z.infer<
  typeof CandidateRankingResultSchema
>;
export type CandidateRankingInput = z.infer<typeof CandidateRankingInputSchema>;
export type ManagementExplanationInput = z.infer<
  typeof ManagementExplanationInputSchema
>;
export type ManagementExplanationResult = z.infer<
  typeof ManagementExplanationResultSchema
>;

export interface LlmRequestOptions {
  signal?: AbortSignal;
}

export interface LlmGateway {
  rankCandidates(
    input: CandidateRankingInput,
    options?: LlmRequestOptions,
  ): Promise<CandidateRankingResult>;
  explainManagementDecision(
    input: ManagementExplanationInput,
    options?: LlmRequestOptions,
  ): Promise<ManagementExplanationResult>;
  reviewRebalanceDecision?(
    input: RebalanceReviewInput,
    options?: LlmRequestOptions,
  ): Promise<AiRebalanceDecision>;
}

export interface MockLlmGatewayBehaviors {
  rankCandidates: MockBehavior<CandidateRankingResult>;
  explainManagementDecision: MockBehavior<ManagementExplanationResult>;
  reviewRebalanceDecision?: MockBehavior<AiRebalanceDecision>;
}

export class MockLlmGateway implements LlmGateway {
  public constructor(private readonly behaviors: MockLlmGatewayBehaviors) {}

  public async rankCandidates(
    input: CandidateRankingInput,
    _options?: LlmRequestOptions,
  ): Promise<CandidateRankingResult> {
    CandidateRankingInputSchema.parse(input);
    return CandidateRankingResultSchema.parse(
      await resolveMockBehavior(this.behaviors.rankCandidates),
    );
  }

  public async explainManagementDecision(
    input: ManagementExplanationInput,
    _options?: LlmRequestOptions,
  ): Promise<ManagementExplanationResult> {
    ManagementExplanationInputSchema.parse(input);
    return ManagementExplanationResultSchema.parse(
      await resolveMockBehavior(this.behaviors.explainManagementDecision),
    );
  }

  public async reviewRebalanceDecision(
    input: RebalanceReviewInput,
    _options?: LlmRequestOptions,
  ): Promise<AiRebalanceDecision> {
    RebalanceReviewInputSchema.parse(input);
    if (this.behaviors.reviewRebalanceDecision === undefined) {
      throw new Error(
        "reviewRebalanceDecision mock behavior is not configured",
      );
    }

    return AiRebalanceDecisionSchema.parse(
      await resolveMockBehavior(this.behaviors.reviewRebalanceDecision),
    );
  }
}
