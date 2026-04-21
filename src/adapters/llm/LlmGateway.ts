import { z } from "zod";

import type { Candidate } from "../../domain/entities/Candidate.js";
import { PositionSchema } from "../../domain/entities/Position.js";
import {
  type MockBehavior,
  resolveMockBehavior,
} from "../mockBehavior.js";

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
export type ManagementExplanationInput = z.infer<
  typeof ManagementExplanationInputSchema
>;
export type ManagementExplanationResult = z.infer<
  typeof ManagementExplanationResultSchema
>;

export interface LlmGateway {
  rankCandidates(candidates: Candidate[]): Promise<CandidateRankingResult>;
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
    _candidates: Candidate[],
  ): Promise<CandidateRankingResult> {
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
