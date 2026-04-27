import { z } from "zod";

import {
  CandidateSchema,
  defaultDataFreshnessSnapshot,
  defaultDlmmMicrostructureSnapshot,
  defaultMarketFeatureSnapshot,
  type Candidate,
  type DataFreshnessSnapshot,
  type DlmmMicrostructureSnapshot,
  type MarketFeatureSnapshot,
} from "../entities/Candidate.js";
import { type PoolMemoryEntry } from "../entities/PoolMemory.js";
import { PortfolioStateSchema } from "../entities/PortfolioState.js";
import { type SignalWeights } from "../entities/SignalWeights.js";
import {
  buildDataFreshnessSnapshot,
  buildDlmmMicrostructureSnapshot,
  buildMarketFeatureSnapshot,
} from "./poolFeatureRules.js";
import {
  scoreCandidate,
  CandidateScorePolicySchema,
  ScreeningCandidateInputSchema,
} from "../scoring/candidateScore.js";
import { scoreStrategySuitability } from "../scoring/strategySuitabilityScore.js";

export const ScreeningPolicySchema = z
  .object({
    timeframe: z.enum(["5m", "1h", "24h"]),
    minMarketCapUsd: z.number().positive(),
    maxMarketCapUsd: z.number().positive(),
    minTvlUsd: z.number().positive(),
    minVolumeUsd: z.number().positive(),
    minVolumeTrendPct: z.number().optional(),
    minFeeActiveTvlRatio: z.number().positive(),
    minFeePerTvl24h: z.number().nonnegative(),
    minOrganic: z.number().min(0).max(100),
    minTokenAgeHours: z.number().nonnegative().optional(),
    maxTokenAgeHours: z.number().nonnegative().optional(),
    athFilterPct: z.number().min(-100).max(0).optional(),
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
    requireFreshSnapshot: z.boolean().optional(),
    maxEstimatedSlippageBps: z.number().positive().optional(),
    maxStrategySnapshotAgeMs: z.number().int().positive().optional(),
    aiReviewPoolSize: z.number().int().positive().optional(),
    detailEnrichmentTopN: z.number().int().nonnegative().optional(),
    detailRequestIntervalMs: z.number().int().nonnegative().optional(),
    maxDetailRequestsPerCycle: z.number().int().nonnegative().optional(),
    maxDetailRequestsPerWindow: z.number().int().positive().optional(),
    detailRequestWindowMs: z.number().int().positive().optional(),
    detailCooldownAfter429Ms: z.number().int().positive().optional(),
    requireDetailForDeploy: z.boolean().optional(),
    allowSnapshotOnlyWatch: z.boolean().optional(),
    intervalTimezone: z.string().min(1).optional(),
    peakHours: z
      .array(
        z
          .object({
            start: z.string().min(1),
            end: z.string().min(1),
            intervalSec: z.number().int().positive(),
          })
          .strict(),
      )
      .optional(),
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

    if (
      policy.minTokenAgeHours !== undefined &&
      policy.maxTokenAgeHours !== undefined &&
      policy.maxTokenAgeHours < policy.minTokenAgeHours
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxTokenAgeHours"],
        message: "must be greater than or equal to minTokenAgeHours",
      });
    }
  });

export const HardFilterEvaluationSchema = z
  .object({
    hardFilterPassed: z.boolean(),
    decision: z.enum([
      "REJECTED_HARD_FILTER",
      "PASSED_HARD_FILTER",
      "REJECTED_EXPOSURE",
      "REJECTED_COOLDOWN",
    ]),
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

function deriveMarketFeatureSnapshot(
  candidate: z.infer<typeof ScreeningCandidateInputSchema>,
): MarketFeatureSnapshot {
  return (
    candidate.marketFeatureSnapshot ??
    buildMarketFeatureSnapshot({
      volume24hUsd: candidate.volumeUsd,
      fees24hUsd:
        candidate.feePerTvl24h === undefined
          ? (candidate.feeToTvlRatio / 100) * candidate.tvlUsd
          : (candidate.feePerTvl24h / 100) * candidate.tvlUsd,
      tvlUsd: candidate.tvlUsd,
      organicVolumeScore: candidate.organicScore,
      washTradingRiskScore: candidate.washTradingRiskPct,
    })
  );
}

function deriveDlmmMicrostructureSnapshot(
  candidate: z.infer<typeof ScreeningCandidateInputSchema>,
  createdAt: string,
): DlmmMicrostructureSnapshot {
  return (
    candidate.dlmmMicrostructureSnapshot ??
    buildDlmmMicrostructureSnapshot({
      binStep: candidate.binStep,
      activeBin: null,
      activeBinSource: "unavailable",
      activeBinObservedAt: null,
      depthNearActiveUsd: candidate.tvlUsd,
      depthWithin10BinsUsd: candidate.tvlUsd,
      depthWithin25BinsUsd: candidate.tvlUsd,
      estimatedSlippageBpsForDefaultSize: 0,
      rangeStabilityScore: 50,
      now: createdAt,
    })
  );
}

function deriveDataFreshnessSnapshot(input: {
  candidate: z.infer<typeof ScreeningCandidateInputSchema>;
  dlmm: DlmmMicrostructureSnapshot;
  createdAt: string;
  maxAgeMs?: number;
}): DataFreshnessSnapshot {
  return (
    input.candidate.dataFreshnessSnapshot ??
    buildDataFreshnessSnapshot({
      now: input.createdAt,
      ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }),
      hasActiveBin: input.dlmm.activeBin !== null,
    })
  );
}

function enrichStrategyFeatureInput(
  candidate: z.infer<typeof ScreeningCandidateInputSchema>,
  policy: ScreeningPolicy,
  createdAt: string,
): z.infer<typeof ScreeningCandidateInputSchema> {
  const marketFeatureSnapshot = deriveMarketFeatureSnapshot(candidate);
  const dlmmMicrostructureSnapshot = deriveDlmmMicrostructureSnapshot(
    candidate,
    createdAt,
  );
  const dataFreshnessSnapshot = deriveDataFreshnessSnapshot({
    candidate,
    dlmm: dlmmMicrostructureSnapshot,
    createdAt,
    ...(policy.maxStrategySnapshotAgeMs === undefined
      ? {}
      : { maxAgeMs: policy.maxStrategySnapshotAgeMs }),
  });

  return ScreeningCandidateInputSchema.parse({
    ...candidate,
    marketFeatureSnapshot,
    dlmmMicrostructureSnapshot,
    dataFreshnessSnapshot,
  });
}

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
  if (policy.minVolumeTrendPct !== undefined) {
    if (candidate.volumeTrendPct === undefined) {
      rejectionReasons.push("volume trend unavailable");
    } else if (candidate.volumeTrendPct < policy.minVolumeTrendPct) {
      rejectionReasons.push("volume trend below minimum");
    }
  }
  if (candidate.feeToTvlRatio < policy.minFeeActiveTvlRatio) {
    rejectionReasons.push("fee-to-tvl ratio below minimum");
  }
  if (policy.minFeePerTvl24h > 0) {
    if (candidate.feePerTvl24h === undefined) {
      rejectionReasons.push("24h fee-per-tvl unavailable");
    } else if (candidate.feePerTvl24h < policy.minFeePerTvl24h) {
      rejectionReasons.push("24h fee-per-tvl below minimum");
    }
  }
  if (candidate.organicScore < policy.minOrganic) {
    rejectionReasons.push("organic score below minimum");
  }
  if (policy.minTokenAgeHours !== undefined) {
    if (candidate.tokenAgeHours === undefined) {
      rejectionReasons.push("token age unavailable");
    } else if (candidate.tokenAgeHours < policy.minTokenAgeHours) {
      rejectionReasons.push("token age below minimum");
    }
  }
  if (policy.maxTokenAgeHours !== undefined) {
    if (candidate.tokenAgeHours === undefined) {
      rejectionReasons.push("token age unavailable");
    } else if (candidate.tokenAgeHours > policy.maxTokenAgeHours) {
      rejectionReasons.push("token age above maximum");
    }
  }
  if (policy.athFilterPct !== undefined) {
    if (candidate.athDistancePct === undefined) {
      rejectionReasons.push("ath distance unavailable");
    } else if (candidate.athDistancePct > policy.athFilterPct) {
      rejectionReasons.push("price is too close to ath");
    }
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
  const marketFeatureSnapshot =
    candidate.marketFeatureSnapshot ?? defaultMarketFeatureSnapshot();
  const dlmmMicrostructureSnapshot =
    candidate.dlmmMicrostructureSnapshot ?? defaultDlmmMicrostructureSnapshot();
  const dataFreshnessSnapshot =
    candidate.dataFreshnessSnapshot ?? defaultDataFreshnessSnapshot();
  if (
    (policy.requireFreshSnapshot ?? true) &&
    !dataFreshnessSnapshot.isFreshEnoughForDeploy
  ) {
    rejectionReasons.push("strategy snapshot is stale");
  }
  if (
    (policy.requireFreshSnapshot ?? true) &&
    dlmmMicrostructureSnapshot.activeBin === null
  ) {
    rejectionReasons.push("active bin unavailable");
  }
  if (
    dlmmMicrostructureSnapshot.estimatedSlippageBpsForDefaultSize >
    (policy.maxEstimatedSlippageBps ?? 300)
  ) {
    rejectionReasons.push("estimated slippage above maximum");
  }
  if (
    marketFeatureSnapshot.washTradingRiskScore > policy.maxWashTradingRiskPct
  ) {
    rejectionReasons.push("feature wash trading risk above maximum");
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
      rejectionReasons: [...rejectionReasons, "duplicate pool exposure"],
    });
  }

  if (duplicateTokenExposure) {
    return HardFilterEvaluationSchema.parse({
      hardFilterPassed: false,
      decision: "REJECTED_EXPOSURE",
      decisionReason: "Duplicate token exposure is not allowed",
      rejectionReasons: [...rejectionReasons, "duplicate token exposure"],
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

function deriveBaseMintAndQuoteMint(candidate: {
  tokenXMint: string;
  tokenYMint: string;
  baseMint?: string | undefined;
  quoteMint?: string | undefined;
  preferredQuoteMints?: string[] | undefined;
}): { baseMint: string; quoteMint: string } {
  if (candidate.baseMint !== undefined && candidate.quoteMint !== undefined) {
    return { baseMint: candidate.baseMint, quoteMint: candidate.quoteMint };
  }

  const preferredQuoteMints = candidate.preferredQuoteMints ?? [];
  if (preferredQuoteMints.includes(candidate.tokenYMint)) {
    return { baseMint: candidate.tokenXMint, quoteMint: candidate.tokenYMint };
  }
  if (preferredQuoteMints.includes(candidate.tokenXMint)) {
    return { baseMint: candidate.tokenYMint, quoteMint: candidate.tokenXMint };
  }

  return { baseMint: candidate.tokenXMint, quoteMint: candidate.tokenYMint };
}

function buildCandidateEntity(input: {
  candidate: z.infer<typeof ScreeningCandidateInputSchema>;
  hardFilter: HardFilterEvaluation;
  createdAt: string;
  screeningPolicy: ScreeningPolicy;
  score?: number;
  scoreBreakdown?: Record<string, number>;
  decision?: Candidate["decision"];
  decisionReason?: string;
}): Candidate {
  const marketFeatureSnapshot = deriveMarketFeatureSnapshot(input.candidate);
  const dlmmMicrostructureSnapshot = deriveDlmmMicrostructureSnapshot(
    input.candidate,
    input.createdAt,
  );
  const dataFreshnessSnapshot = deriveDataFreshnessSnapshot({
    candidate: input.candidate,
    dlmm: dlmmMicrostructureSnapshot,
    createdAt: input.createdAt,
    ...(input.screeningPolicy.maxStrategySnapshotAgeMs === undefined
      ? {}
      : { maxAgeMs: input.screeningPolicy.maxStrategySnapshotAgeMs }),
  });
  const strategySuitability = scoreStrategySuitability({
    marketFeatureSnapshot,
    dlmmMicrostructureSnapshot,
    dataFreshnessSnapshot,
    maxEstimatedSlippageBps:
      input.screeningPolicy.maxEstimatedSlippageBps ?? 300,
  });

  const { baseMint, quoteMint } = deriveBaseMintAndQuoteMint({
    ...input.candidate,
    preferredQuoteMints: input.candidate.preferredQuoteMints ?? [
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    ],
  });

  return CandidateSchema.parse({
    candidateId: input.candidate.candidateId,
    poolAddress: input.candidate.poolAddress,
    symbolPair: input.candidate.symbolPair,
    tokenXMint: input.candidate.tokenXMint,
    tokenYMint: input.candidate.tokenYMint,
    baseMint,
    quoteMint,
    screeningSnapshot: {
      marketCapUsd: input.candidate.marketCapUsd,
      tvlUsd: input.candidate.tvlUsd,
      volumeUsd: input.candidate.volumeUsd,
      volumeTrendPct: input.candidate.volumeTrendPct,
      volumeConsistencyScore: input.candidate.volumeConsistencyScore,
      feeToTvlRatio: input.candidate.feeToTvlRatio,
      feePerTvl24h: input.candidate.feePerTvl24h,
      organicScore: input.candidate.organicScore,
      holderCount: input.candidate.holderCount,
      binStep: input.candidate.binStep,
      pairType: input.candidate.pairType,
      launchpad: input.candidate.launchpad,
      athDistancePct: input.candidate.athDistancePct,
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
      tokenAgeHours: input.candidate.tokenAgeHours,
      narrativeSummary: input.candidate.narrativeSummary ?? null,
      holderDistributionSummary:
        input.candidate.holderDistributionSummary ?? null,
      narrativePenaltyScore: input.candidate.narrativePenaltyScore,
    },
    marketFeatureSnapshot,
    dlmmMicrostructureSnapshot,
    dataFreshnessSnapshot,
    strategySuitability,
    hardFilterPassed: input.hardFilter.hardFilterPassed,
    score: input.score ?? 0,
    scoreBreakdown: input.scoreBreakdown ?? {},
    decision: input.decision ?? input.hardFilter.decision,
    decisionReason: input.decisionReason ?? input.hardFilter.decisionReason,
    createdAt: input.createdAt,
  });
}

function isCandidateCoolingDown(input: {
  poolAddress: string;
  poolMemoryMap?: Record<string, Pick<PoolMemoryEntry, "cooldownUntil">>;
  now: string;
}): boolean {
  const cooldownUntil = input.poolMemoryMap?.[input.poolAddress]?.cooldownUntil;
  if (cooldownUntil === undefined) {
    return false;
  }

  const nowMs = Date.parse(input.now);
  const cooldownMs = Date.parse(cooldownUntil);
  if (Number.isNaN(nowMs) || Number.isNaN(cooldownMs)) {
    return false;
  }

  return cooldownMs > nowMs;
}

export function screenAndScoreCandidates(input: {
  candidates: Array<z.infer<typeof ScreeningCandidateInputSchema>>;
  portfolio: z.infer<typeof PortfolioStateSchema>;
  screeningPolicy: ScreeningPolicy;
  scoringPolicy: z.infer<typeof CandidateScorePolicySchema>;
  signalWeights?: SignalWeights;
  poolMemoryMap?: Record<string, Pick<PoolMemoryEntry, "cooldownUntil">>;
  createdAt?: string;
  now?: string;
}): ScreenAndScoreCandidatesResult {
  const parsedCandidates = ScreeningCandidateInputSchema.array().parse(
    input.candidates,
  );
  const portfolio = PortfolioStateSchema.parse(input.portfolio);
  const screeningPolicy = ScreeningPolicySchema.parse(input.screeningPolicy);
  const scoringPolicy = CandidateScorePolicySchema.parse(input.scoringPolicy);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const now = input.now ?? createdAt;
  const candidates = parsedCandidates;

  const evaluatedCandidates = candidates.map((candidate) => {
    const featureEnrichedCandidate = enrichStrategyFeatureInput(
      candidate,
      screeningPolicy,
      createdAt,
    );

    const hardFilter = evaluateScreeningHardFilters({
      candidate: featureEnrichedCandidate,
      portfolio,
      policy: screeningPolicy,
    });

    if (
      isCandidateCoolingDown({
        poolAddress: featureEnrichedCandidate.poolAddress,
        ...(input.poolMemoryMap === undefined
          ? {}
          : { poolMemoryMap: input.poolMemoryMap }),
        now,
      })
    ) {
      return buildCandidateEntity({
        candidate: featureEnrichedCandidate,
        hardFilter: {
          hardFilterPassed: false,
          decision: "REJECTED_COOLDOWN",
          decisionReason: "Pool cooldown is active",
          rejectionReasons: [
            ...hardFilter.rejectionReasons,
            "pool cooldown active",
          ],
        },
        createdAt,
        screeningPolicy,
      });
    }

    if (!hardFilter.hardFilterPassed) {
      return buildCandidateEntity({
        candidate: featureEnrichedCandidate,
        hardFilter,
        createdAt,
        screeningPolicy,
      });
    }

    const score = scoreCandidate({
      candidate: featureEnrichedCandidate,
      portfolio,
      policy: scoringPolicy,
      ...(input.signalWeights === undefined
        ? {}
        : { signalWeights: input.signalWeights }),
    });

    return buildCandidateEntity({
      candidate: featureEnrichedCandidate,
      hardFilter,
      createdAt,
      screeningPolicy,
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

  const shortlistedIds = new Set(
    shortlist.map((candidate) => candidate.candidateId),
  );
  const finalCandidates = evaluatedCandidates.map((candidate) => {
    if (!shortlistedIds.has(candidate.candidateId)) {
      return candidate;
    }

    return (
      shortlist.find((item) => item.candidateId === candidate.candidateId) ??
      candidate
    );
  });

  return ScreenAndScoreCandidatesResultSchema.parse({
    candidates: finalCandidates,
    shortlist,
  });
}
