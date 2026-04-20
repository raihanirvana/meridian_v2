import { z } from "zod";

import { CandidateDecisionSchema } from "../types/enums.js";

const TimestampSchema = z.string().datetime();

export const CandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    poolAddress: z.string().min(1),
    symbolPair: z.string().min(1),
    screeningSnapshot: z.record(z.string(), z.unknown()),
    tokenRiskSnapshot: z.record(z.string(), z.unknown()),
    smartMoneySnapshot: z.record(z.string(), z.unknown()),
    hardFilterPassed: z.boolean(),
    score: z.number(),
    scoreBreakdown: z.record(z.string(), z.number()),
    decision: CandidateDecisionSchema,
    decisionReason: z.string().min(1),
    createdAt: TimestampSchema,
  })
  .strict();

export type Candidate = z.infer<typeof CandidateSchema>;
