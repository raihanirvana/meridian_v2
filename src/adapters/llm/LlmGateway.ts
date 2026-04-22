import { z } from "zod";

import { CandidateSchema } from "../../domain/entities/Candidate.js";
import { PositionSchema } from "../../domain/entities/Position.js";
import {
  type MockBehavior,
  resolveMockBehavior,
} from "../mockBehavior.js";

export const CandidateRankingInputSchema = z.object({
  candidates: CandidateSchema.array(),
  systemPrompt: z.string().min(1).nullable(),
}).strict();

export const CandidateRankingResultSchema = z.object({
  rankedCandidateIds: z.array(z.string().min(1)),
  reasoning: z.string().min(1),
}).strict();

export const ManagementExplanationInputSchema = z.object({
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
}).strict();

export const ManagementExplanationResultSchema = z.object({
  action: z.enum([
    "HOLD",
    "CLAIM_FEES",
    "PARTIAL_CLOSE",
    "REBALANCE",
    "CLOSE",
    "RECONCILE_ONLY",
  ]),
  reasoning: z.string().min(1),
}).strict();

export type CandidateRankingResult = z.infer<typeof CandidateRankingResultSchema>;
export type CandidateRankingInput = z.infer<typeof CandidateRankingInputSchema>;
export type ManagementExplanationInput = z.infer<
  typeof ManagementExplanationInputSchema
>;
export type ManagementExplanationResult = z.infer<
  typeof ManagementExplanationResultSchema
>;

export interface LlmGateway {
  rankCandidates(input: CandidateRankingInput): Promise<CandidateRankingResult>;
  explainManagementDecision(
    input: ManagementExplanationInput,
  ): Promise<ManagementExplanationResult>;
}

export interface MockLlmGatewayBehaviors {
  rankCandidates: MockBehavior<CandidateRankingResult>;
  explainManagementDecision: MockBehavior<ManagementExplanationResult>;
}

export class MockLlmGateway implements LlmGateway {
  public constructor(private readonly behaviors: MockLlmGatewayBehaviors) {}

  public async rankCandidates(
    input: CandidateRankingInput,
  ): Promise<CandidateRankingResult> {
    CandidateRankingInputSchema.parse(input);
    return CandidateRankingResultSchema.parse(
      await resolveMockBehavior(this.behaviors.rankCandidates),
    );
  }

  public async explainManagementDecision(
    input: ManagementExplanationInput,
  ): Promise<ManagementExplanationResult> {
    ManagementExplanationInputSchema.parse(input);
    return ManagementExplanationResultSchema.parse(
      await resolveMockBehavior(this.behaviors.explainManagementDecision),
    );
  }
}
