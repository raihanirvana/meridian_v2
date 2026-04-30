import { z } from "zod";

import {
  CandidateSchema,
  DataFreshnessSnapshotSchema,
  DlmmMicrostructureSnapshotSchema,
  MarketFeatureSnapshotSchema,
  type Candidate,
} from "../../domain/entities/Candidate.js";
import { type MockBehavior, resolveMockBehavior } from "../mockBehavior.js";

export const ListCandidatesRequestSchema = z.object({
  limit: z.number().int().positive(),
  timeframe: z.enum(["5m", "1h", "24h"]).default("24h"),
});

export const GetCandidateDetailsOptionsSchema = z
  .object({
    timeframe: z.enum(["5m", "1h", "24h"]).optional(),
  })
  .strict();

export const CandidateDetailsSchema = z.object({
  poolAddress: z.string().min(1),
  pairLabel: z.string().min(1),
  feeToTvlRatio: z.number().nonnegative(),
  feePerTvl24h: z.number().nonnegative().optional(),
  volumeTrendPct: z.number().optional(),
  organicScore: z.number().min(0).max(100),
  holderCount: z.number().int().nonnegative(),
  tokenAgeHours: z.number().nonnegative().optional(),
  athDistancePct: z.number().max(0).optional(),
  marketFeatureSnapshot: MarketFeatureSnapshotSchema.optional(),
  dlmmMicrostructureSnapshot: DlmmMicrostructureSnapshotSchema.optional(),
  dataFreshnessSnapshot: DataFreshnessSnapshotSchema.optional(),
  narrativeSummary: z.string().min(1).nullable().optional(),
  holderDistributionSummary: z.string().min(1).nullable().optional(),
});

export type ListCandidatesRequest = z.infer<typeof ListCandidatesRequestSchema>;
export type GetCandidateDetailsOptions = z.infer<
  typeof GetCandidateDetailsOptionsSchema
>;
export type CandidateInput = z.input<typeof CandidateSchema>;
export type CandidateDetails = z.infer<typeof CandidateDetailsSchema>;
export type CandidateDetailsInput = z.input<typeof CandidateDetailsSchema>;

export interface ScreeningGateway {
  listCandidates(request: ListCandidatesRequest): Promise<Candidate[]>;
  getCandidateDetails(
    poolAddress: string,
    options?: GetCandidateDetailsOptions,
  ): Promise<CandidateDetails>;
}

export interface MockScreeningGatewayBehaviors {
  listCandidates: MockBehavior<CandidateInput[]>;
  getCandidateDetails: MockBehavior<CandidateDetailsInput>;
}

export class MockScreeningGateway implements ScreeningGateway {
  public constructor(
    private readonly behaviors: MockScreeningGatewayBehaviors,
  ) {}

  public async listCandidates(
    request: ListCandidatesRequest,
  ): Promise<Candidate[]> {
    ListCandidatesRequestSchema.parse(request);
    return CandidateSchema.array().parse(
      await resolveMockBehavior(this.behaviors.listCandidates),
    );
  }

  public async getCandidateDetails(
    _poolAddress: string,
    options: GetCandidateDetailsOptions = {},
  ): Promise<CandidateDetails> {
    GetCandidateDetailsOptionsSchema.parse(options);
    return CandidateDetailsSchema.parse(
      await resolveMockBehavior(this.behaviors.getCandidateDetails),
    );
  }
}
