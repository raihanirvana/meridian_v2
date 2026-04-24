import { z } from "zod";

import {
  createDefaultSignalWeights,
  SignalWeightsSchema,
  type SignalWeights,
} from "../entities/SignalWeights.js";
import { PortfolioStateSchema } from "../entities/PortfolioState.js";
import {
  DataFreshnessSnapshotSchema,
  DlmmMicrostructureSnapshotSchema,
  MarketFeatureSnapshotSchema,
} from "../entities/Candidate.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeAgainstTarget(value: number, target: number): number {
  if (target <= 0) {
    return 0;
  }

  return clamp((value / target) * 100, 0, 100);
}

export const ScreeningCandidateInputSchema = z
  .object({
    candidateId: z.string().min(1),
    poolAddress: z.string().min(1),
    symbolPair: z.string().min(1),
    tokenXMint: z.string().min(1),
    tokenYMint: z.string().min(1),
    marketCapUsd: z.number().nonnegative(),
    tvlUsd: z.number().nonnegative(),
    volumeUsd: z.number().nonnegative(),
    volumeTrendPct: z.number().optional(),
    volumeConsistencyScore: z.number().min(0).max(100),
    feeToTvlRatio: z.number().nonnegative(),
    organicScore: z.number().min(0).max(100),
    holderCount: z.number().int().nonnegative(),
    binStep: z.number().int().positive(),
    launchpad: z.string().min(1).nullable(),
    deployerAddress: z.string().min(1),
    pairType: z.string().min(1),
    topHolderPct: z.number().min(0).max(100),
    botHolderPct: z.number().min(0).max(100),
    bundleRiskPct: z.number().min(0).max(100),
    washTradingRiskPct: z.number().min(0).max(100),
    auditScore: z.number().min(0).max(100),
    smartWalletCount: z.number().int().nonnegative(),
    smartMoneyConfidenceScore: z.number().min(0).max(100),
    poolAgeHours: z.number().nonnegative(),
    tokenAgeHours: z.number().nonnegative().optional(),
    athDistancePct: z.number().max(0).optional(),
    feePerTvl24h: z.number().nonnegative().optional(),
    narrativeSummary: z.string().min(1).nullable().optional(),
    holderDistributionSummary: z.string().min(1).nullable().optional(),
    narrativePenaltyScore: z.number().min(0).max(100),
    marketFeatureSnapshot: MarketFeatureSnapshotSchema.optional(),
    dlmmMicrostructureSnapshot: DlmmMicrostructureSnapshotSchema.optional(),
    dataFreshnessSnapshot: DataFreshnessSnapshotSchema.optional(),
  })
  .strict();

export const CandidateScorePolicySchema = z
  .object({
    targetFeeToTvlRatio: z.number().positive(),
    targetVolumeUsd: z.number().positive(),
    targetTvlUsd: z.number().positive(),
    targetHolderCount: z.number().int().positive(),
    targetPoolAgeHours: z.number().positive(),
    targetSmartWalletCount: z.number().int().positive(),
    overlapPenaltyPerPoolExposurePct: z.number().nonnegative(),
    overlapPenaltyPerTokenExposurePct: z.number().nonnegative(),
    launchpadPenaltyByName: z.record(z.string(), z.number().min(0).max(100)),
    weights: z
      .object({
        feeToTvl: z.number().positive(),
        volumeConsistency: z.number().positive(),
        liquidityDepth: z.number().positive(),
        organicScore: z.number().positive(),
        holderQuality: z.number().positive(),
        tokenAuditHealth: z.number().positive(),
        smartMoney: z.number().positive(),
        poolMaturity: z.number().positive(),
        launchpadPenalty: z.number().positive(),
        overlapPenalty: z.number().positive(),
      })
      .strict(),
  })
  .strict();

export const CandidateScoreBreakdownSchema = z
  .object({
    feeToTvl: z.number(),
    volumeConsistency: z.number(),
    liquidityDepth: z.number(),
    organicScore: z.number(),
    holderQuality: z.number(),
    tokenAuditHealth: z.number(),
    smartMoney: z.number(),
    poolMaturity: z.number(),
    launchpadPenalty: z.number(),
    overlapPenalty: z.number(),
  })
  .strict();

export const CandidateScoreResultSchema = z
  .object({
    scoreTotal: z.number(),
    scoreBreakdown: CandidateScoreBreakdownSchema,
    riskFlags: z.array(z.string().min(1)),
  })
  .strict();

export type ScreeningCandidateInput = z.infer<
  typeof ScreeningCandidateInputSchema
>;
export type CandidateScorePolicy = z.infer<typeof CandidateScorePolicySchema>;
export type CandidateScoreBreakdown = z.infer<
  typeof CandidateScoreBreakdownSchema
>;
export type CandidateScoreResult = z.infer<typeof CandidateScoreResultSchema>;

function effectiveSignalMultiplier(
  signalWeights: SignalWeights,
  key: keyof SignalWeights,
): number {
  return signalWeights[key].weight;
}

export function scoreCandidate(input: {
  candidate: ScreeningCandidateInput;
  portfolio: z.infer<typeof PortfolioStateSchema>;
  policy: CandidateScorePolicy;
  signalWeights?: SignalWeights;
}): CandidateScoreResult {
  const candidate = ScreeningCandidateInputSchema.parse(input.candidate);
  const portfolio = PortfolioStateSchema.parse(input.portfolio);
  const policy = CandidateScorePolicySchema.parse(input.policy);
  const signalWeights =
    input.signalWeights === undefined
      ? createDefaultSignalWeights()
      : SignalWeightsSchema.parse(input.signalWeights);

  const poolExposurePct = portfolio.exposureByPool[candidate.poolAddress] ?? 0;
  const tokenExposurePct = Math.max(
    portfolio.exposureByToken[candidate.tokenXMint] ?? 0,
    portfolio.exposureByToken[candidate.tokenYMint] ?? 0,
  );

  const holderQuality = clamp(
    100 - candidate.topHolderPct * 1.4 - candidate.botHolderPct * 0.8,
    0,
    100,
  );
  const tokenAuditHealth = clamp(
    candidate.auditScore -
      candidate.bundleRiskPct * 0.5 -
      candidate.washTradingRiskPct * 0.5,
    0,
    100,
  );
  const smartMoney = clamp(
    candidate.smartMoneyConfidenceScore * 0.7 +
      normalizeAgainstTarget(
        candidate.smartWalletCount,
        policy.targetSmartWalletCount,
      ) *
        0.3,
    0,
    100,
  );
  const launchpadPenaltyScore = clamp(
    policy.launchpadPenaltyByName[candidate.launchpad ?? ""] ??
      candidate.narrativePenaltyScore,
    0,
    100,
  );
  const overlapPenaltyScore = clamp(
    poolExposurePct * policy.overlapPenaltyPerPoolExposurePct +
      tokenExposurePct * policy.overlapPenaltyPerTokenExposurePct,
    0,
    100,
  );

  const breakdown = CandidateScoreBreakdownSchema.parse({
    feeToTvl: round(
      normalizeAgainstTarget(
        candidate.feeToTvlRatio,
        policy.targetFeeToTvlRatio,
      ),
    ),
    volumeConsistency: round(candidate.volumeConsistencyScore),
    liquidityDepth: round(
      normalizeAgainstTarget(candidate.tvlUsd, policy.targetTvlUsd),
    ),
    organicScore: round(candidate.organicScore),
    holderQuality: round(holderQuality),
    tokenAuditHealth: round(tokenAuditHealth),
    smartMoney: round(smartMoney),
    poolMaturity: round(
      normalizeAgainstTarget(candidate.poolAgeHours, policy.targetPoolAgeHours),
    ),
    launchpadPenalty: round(100 - launchpadPenaltyScore),
    overlapPenalty: round(100 - overlapPenaltyScore),
  });

  const weights = {
    feeToTvl:
      policy.weights.feeToTvl *
      effectiveSignalMultiplier(signalWeights, "feeToTvl"),
    volumeConsistency:
      policy.weights.volumeConsistency *
      effectiveSignalMultiplier(signalWeights, "volumeConsistency"),
    liquidityDepth:
      policy.weights.liquidityDepth *
      effectiveSignalMultiplier(signalWeights, "liquidityDepth"),
    organicScore:
      policy.weights.organicScore *
      effectiveSignalMultiplier(signalWeights, "organicScore"),
    holderQuality:
      policy.weights.holderQuality *
      effectiveSignalMultiplier(signalWeights, "holderQuality"),
    tokenAuditHealth:
      policy.weights.tokenAuditHealth *
      effectiveSignalMultiplier(signalWeights, "tokenAuditHealth"),
    smartMoney:
      policy.weights.smartMoney *
      effectiveSignalMultiplier(signalWeights, "smartMoney"),
    poolMaturity:
      policy.weights.poolMaturity *
      effectiveSignalMultiplier(signalWeights, "poolMaturity"),
    launchpadPenalty:
      policy.weights.launchpadPenalty *
      effectiveSignalMultiplier(signalWeights, "launchpadPenalty"),
    overlapPenalty:
      policy.weights.overlapPenalty *
      effectiveSignalMultiplier(signalWeights, "overlapPenalty"),
  } as const;
  const totalWeight =
    weights.feeToTvl +
    weights.volumeConsistency +
    weights.liquidityDepth +
    weights.organicScore +
    weights.holderQuality +
    weights.tokenAuditHealth +
    weights.smartMoney +
    weights.poolMaturity +
    weights.launchpadPenalty +
    weights.overlapPenalty;

  const weightedTotal =
    breakdown.feeToTvl * weights.feeToTvl +
    breakdown.volumeConsistency * weights.volumeConsistency +
    breakdown.liquidityDepth * weights.liquidityDepth +
    breakdown.organicScore * weights.organicScore +
    breakdown.holderQuality * weights.holderQuality +
    breakdown.tokenAuditHealth * weights.tokenAuditHealth +
    breakdown.smartMoney * weights.smartMoney +
    breakdown.poolMaturity * weights.poolMaturity +
    breakdown.launchpadPenalty * weights.launchpadPenalty +
    breakdown.overlapPenalty * weights.overlapPenalty;

  const riskFlags: string[] = [];
  if (candidate.topHolderPct >= 30) {
    riskFlags.push("high_top_holder_concentration");
  }
  if (candidate.botHolderPct >= 20) {
    riskFlags.push("elevated_bot_holder_ratio");
  }
  if (candidate.bundleRiskPct >= 20) {
    riskFlags.push("elevated_bundle_risk");
  }
  if (candidate.washTradingRiskPct >= 20) {
    riskFlags.push("elevated_wash_trading_risk");
  }
  if (poolExposurePct > 0 || tokenExposurePct > 0) {
    riskFlags.push("overlap_with_existing_exposure");
  }
  if (candidate.launchpad !== null && launchpadPenaltyScore >= 40) {
    riskFlags.push("launchpad_or_narrative_penalty");
  }
  if (candidate.volumeUsd < policy.targetVolumeUsd) {
    riskFlags.push("below_target_volume");
  }

  return CandidateScoreResultSchema.parse({
    scoreTotal: round(weightedTotal / totalWeight),
    scoreBreakdown: breakdown,
    riskFlags,
  });
}
