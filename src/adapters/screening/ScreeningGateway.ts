import { z } from "zod";

import type { Candidate } from "../../domain/entities/Candidate.js";
import {
  type MockBehavior,
  resolveMockBehavior,
} from "../mockBehavior.js";

export const ListCandidatesRequestSchema = z.object({
  limit: z.number().int().positive(),
});

export const CandidateDetailsSchema = z.object({
  poolAddress: z.string().min(1),
  pairLabel: z.string().min(1),
  feeToTvlRatio: z.number().nonnegative(),
  organicScore: z.number().min(0).max(100),
  holderCount: z.number().int().nonnegative(),
});

export type ListCandidatesRequest = z.infer<typeof ListCandidatesRequestSchema>;
export type CandidateDetails = z.infer<typeof CandidateDetailsSchema>;

export interface ScreeningGateway {
  listCandidates(request: ListCandidatesRequest): Promise<Candidate[]>;
  getCandidateDetails(poolAddress: string): Promise<CandidateDetails>;
}

export interface MockScreeningGatewayBehaviors {
  listCandidates: MockBehavior<Candidate[]>;
  getCandidateDetails: MockBehavior<CandidateDetails>;
}

export class MockScreeningGateway implements ScreeningGateway {
  public constructor(private readonly behaviors: MockScreeningGatewayBehaviors) {}

  public async listCandidates(
    request: ListCandidatesRequest,
  ): Promise<Candidate[]> {
    ListCandidatesRequestSchema.parse(request);
    return resolveMockBehavior(this.behaviors.listCandidates);
  }

  public async getCandidateDetails(
    _poolAddress: string,
  ): Promise<CandidateDetails> {
    return CandidateDetailsSchema.parse(
      await resolveMockBehavior(this.behaviors.getCandidateDetails),
    );
  }
}
