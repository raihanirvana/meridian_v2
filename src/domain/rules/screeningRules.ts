import { z } from "zod";

import { CandidateSchema, type Candidate } from "../entities/Candidate.js";
import { PortfolioStateSchema } from "../entities/PortfolioState.js";
import { scoreCandidate, CandidateScorePolicySchema, ScreeningCandidateInputSchema } from "../scoring/candidateScore.js";

export const ScreeningPolicySchema = z
  .object({
    minMarketCapUsd: z.number().positive(),
    maxMarketCapUsd: z.number().positive(),
    minTvlUsd: z.number().positive(),
    minVolumeUsd: z.number().positive(),
    minFeeToTvlRatio: z.number().positive(),
    minOrganicScore: z.number().min(0).max(100),
    minHolderCount: z.number().int().positive(),
    allowedBinSteps: z.array(z.number().int().positive()).min(1),
    blockedLaunchpads: z.array(z.string().min(1)),
    blockedTokenMints: z.array(z.string().min(1)),
    blockedDeployers: z.array(z.string().min(1)),
    allowedPairTypes: z.array(z.string().min(1)).min(1),
    maxTopHolderPct: z.number().min(0).max(100),
    maxBotHolderPct: z.number().min(0).max(100),
    maxBundleRiskPct: z.number().min(0).max(100),
    maxWashTradingRiskPct: z.number().min(0).max(100),
    rejectDuplicatePoolExposure: z.boolean(),
    rejectDuplicateTokenExposure: z.boolean(),
    shortlistLimit: z.number().int().positive(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.maxMarketCapUsd < policy.minMarketCapUsd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxMarketCapUsd"],
        message: "must be greater than or equal to minMarketCapUsd",
      });
    }
  });

export const HardFilterEvaluationSchema = z
  .object({
    hardFilterPassed: z.boolean(),
    decision: z.enum(["REJECTED_HARD_FILTER", "PASSED_HARD_FILTER", "REJECTED_EXPOSURE"]),
    decisionReason: z.string().min(1),
    rejectionReasons: z.array(z.string().min(1)),
  })
  .strict();

export const ScreenAndScoreCandidatesResultSchema = z
  .object({
    candidates: CandidateSchema.array(),
    shortlist: CandidateSchema.array(),
  })
  .strict();

export type ScreeningPolicy = z.infer<typeof ScreeningPolicySchema>;
export type HardFilterEvaluation = z.infer<typeof HardFilterEvaluationSchema>;
export type ScreenAndScoreCandidatesResult = z.infer<
  typeof ScreenAndScoreCandidatesResultSchema
>;

export function evaluateScreeningHardFilters(input: {
  candidate: z.infer<typeof ScreeningCandidateInputSchema>;
  portfolio: z.infer<typeof PortfolioStateSchema>;
  policy: ScreeningPolicy;
}): HardFilterEvaluation {
  const candidate = ScreeningCandidateInputSchema.parse(input.candidate);
  const portfolio = PortfolioStateSchema.parse(input.portfolio);
  const policy = ScreeningPolicySchema.parse(input.policy);

  const rejectionReasons: string[] = [];

  if (candidate.marketCapUsd < policy.minMarketCapUsd) {
    rejectionReasons.push("market cap below minimum");
  }
  if (candidate.marketCapUsd > policy.maxMarketCapUsd) {
    rejectionReasons.push("market cap above maximum");
  }
  if (candidate.tvlUsd < policy.minTvlUsd) {
    rejectionReasons.push("tvl below minimum");
  }
  if (candidate.volumeUsd < policy.minVolumeUsd) {
    rejectionReasons.push("volume below minimum");
  }
  if (candidate.feeToTvlRatio < policy.minFeeToTvlRatio) {
    rejectionReasons.push("fee-to-tvl ratio below minimum");
  }
  if (candidate.organicScore < policy.minOrganicScore) {
    rejectionReasons.push("organic score below minimum");
  }
  if (candidate.holderCount < policy.minHolderCount) {
    rejectionReasons.push("holder count below minimum");
  }
  if (!policy.allowedBinSteps.includes(candidate.binStep)) {
    rejectionReasons.push("bin step not allowed");
  }
  if (
    candidate.launchpad !== null &&
    policy.blockedLaunchpads.includes(candidate.launchpad)
  ) {
    rejectionReasons.push("launchpad is blocked");
  }
  if (
    policy.blockedTokenMints.includes(candidate.tokenXMint) ||
    policy.blockedTokenMints.includes(candidate.tokenYMint)
  ) {
    rejectionReasons.push("token mint is blocked");
  }
  if (policy.blockedDeployers.includes(candidate.deployerAddress)) {
    rejectionReasons.push("deployer is blocked");
  }
  if (candidate.topHolderPct > policy.maxTopHolderPct) {
    rejectionReasons.push("top holder concentration above maximum");
  }
  if (candidate.botHolderPct > policy.maxBotHolderPct) {
    rejectionReasons.push("bot holder ratio above maximum");
  }
  if (candidate.bundleRiskPct > policy.maxBundleRiskPct) {
    rejectionReasons.push("bundle risk above maximum");
  }
  if (candidate.washTradingRiskPct > policy.maxWashTradingRiskPct) {
    rejectionReasons.push("wash trading risk above maximum");
  }
  if (!policy.allowedPairTypes.includes(candidate.pairType)) {
    rejectionReasons.push("pair type not allowed");
  }

  const duplicatePoolExposure =
    policy.rejectDuplicatePoolExposure &&
    (portfolio.exposureByPool[candidate.poolAddress] ?? 0) > 0;
  const duplicateTokenExposure =
    policy.rejectDuplicateTokenExposure &&
    ((portfolio.exposureByToken[candidate.tokenXMint] ?? 0) > 0 ||
      (portfolio.exposureByToken[candidate.tokenYMint] ?? 0) > 0);

  if (duplicatePoolExposure) {
    return HardFilterEvaluationSchema.parse({
      hardFilterPassed: false,
      decision: "REJECTED_EXPOSURE",
      decisionReason: "Duplicate pool exposure is not allowed",
      rejectionReasons: ["duplicate pool exposure"],
    });
  }

  if (duplicateTokenExposure) {
    return HardFilterEvaluationSchema.parse({
      hardFilterPassed: false,
      decision: "REJECTED_EXPOSURE",
      decisionReason: "Duplicate token exposure is not allowed",
      rejectionReasons: ["duplicate token exposure"],
    });
  }

  if (rejectionReasons.length > 0) {
    return HardFilterEvaluationSchema.parse({
      hardFilterPassed: false,
      decision: "REJECTED_HARD_FILTER",
      decisionReason: rejectionReasons[0] ?? "hard filter rejection",
      rejectionReasons,
    });
  }

  return HardFilterEvaluationSchema.parse({
    hardFilterPassed: true,
    decision: "PASSED_HARD_FILTER",
    decisionReason: "Passed all hard filters",
    rejectionReasons: [],
  });
}

function buildCandidateEntity(input: {
  candidate: z.infer<typeof ScreeningCandidateInputSchema>;
  hardFilter: HardFilterEvaluation;
  createdAt: string;
  score?: number;
  scoreBreakdown?: Record<string, number>;
  decision?: Candidate["decision"];
  decisionReason?: string;
}): Candidate {
  return CandidateSchema.parse({
    candidateId: input.candidate.candidateId,
    poolAddress: input.candidate.poolAddress,
    symbolPair: input.candidate.symbolPair,
    screeningSnapshot: {
      marketCapUsd: input.candidate.marketCapUsd,
      tvlUsd: input.candidate.tvlUsd,
      volumeUsd: input.candidate.volumeUsd,
      volumeConsistencyScore: input.candidate.volumeConsistencyScore,
      feeToTvlRatio: input.candidate.feeToTvlRatio,
      organicScore: input.candidate.organicScore,
      holderCount: input.candidate.holderCount,
      binStep: input.candidate.binStep,
      pairType: input.candidate.pairType,
      launchpad: input.candidate.launchpad,
    },
    tokenRiskSnapshot: {
      deployerAddress: input.candidate.deployerAddress,
      topHolderPct: input.candidate.topHolderPct,
      botHolderPct: input.candidate.botHolderPct,
      bundleRiskPct: input.candidate.bundleRiskPct,
      washTradingRiskPct: input.candidate.washTradingRiskPct,
      auditScore: input.candidate.auditScore,
      tokenXMint: input.candidate.tokenXMint,
      tokenYMint: input.candidate.tokenYMint,
    },
    smartMoneySnapshot: {
      smartWalletCount: input.candidate.smartWalletCount,
      confidenceScore: input.candidate.smartMoneyConfidenceScore,
      poolAgeHours: input.candidate.poolAgeHours,
      narrativePenaltyScore: input.candidate.narrativePenaltyScore,
    },
    hardFilterPassed: input.hardFilter.hardFilterPassed,
    score: input.score ?? 0,
    scoreBreakdown: input.scoreBreakdown ?? {},
    decision: input.decision ?? input.hardFilter.decision,
    decisionReason: input.decisionReason ?? input.hardFilter.decisionReason,
    createdAt: input.createdAt,
  });
}

export function screenAndScoreCandidates(input: {
  candidates: Array<z.infer<typeof ScreeningCandidateInputSchema>>;
  portfolio: z.infer<typeof PortfolioStateSchema>;
  screeningPolicy: ScreeningPolicy;
  scoringPolicy: z.infer<typeof CandidateScorePolicySchema>;
  createdAt?: string;
}): ScreenAndScoreCandidatesResult {
  const candidates = ScreeningCandidateInputSchema.array().parse(input.candidates);
  const portfolio = PortfolioStateSchema.parse(input.portfolio);
  const screeningPolicy = ScreeningPolicySchema.parse(input.screeningPolicy);
  const scoringPolicy = CandidateScorePolicySchema.parse(input.scoringPolicy);
  const createdAt = input.createdAt ?? new Date().toISOString();

  const evaluatedCandidates = candidates.map((candidate) => {
    const hardFilter = evaluateScreeningHardFilters({
      candidate,
      portfolio,
      policy: screeningPolicy,
    });

    if (!hardFilter.hardFilterPassed) {
      return buildCandidateEntity({
        candidate,
        hardFilter,
        createdAt,
      });
    }

    const score = scoreCandidate({
      candidate,
      portfolio,
      policy: scoringPolicy,
    });

    return buildCandidateEntity({
      candidate,
      hardFilter,
      createdAt,
      score: score.scoreTotal,
      scoreBreakdown: score.scoreBreakdown,
      decision: "PASSED_HARD_FILTER",
      decisionReason: "Passed hard filters and scored deterministically",
    });
  });

  const shortlist = evaluatedCandidates
    .filter((candidate) => candidate.hardFilterPassed)
    .sort((left, right) => {
      const scoreOrder = right.score - left.score;
      if (scoreOrder !== 0) {
        return scoreOrder;
      }

      const pairOrder = left.symbolPair.localeCompare(right.symbolPair);
      if (pairOrder !== 0) {
        return pairOrder;
      }

      return left.candidateId.localeCompare(right.candidateId);
    })
    .slice(0, screeningPolicy.shortlistLimit)
    .map((candidate) =>
      CandidateSchema.parse({
        ...candidate,
        decision: "SHORTLISTED",
        decisionReason: "Selected into deterministic shortlist",
      }),
    );

  const shortlistedIds = new Set(shortlist.map((candidate) => candidate.candidateId));
  const finalCandidates = evaluatedCandidates.map((candidate) => {
    if (!shortlistedIds.has(candidate.candidateId)) {
      return candidate;
    }

    return shortlist.find((item) => item.candidateId === candidate.candidateId) ?? candidate;
  });

  return ScreenAndScoreCandidatesResultSchema.parse({
    candidates: finalCandidates,
    shortlist,
  });
}
