import {
  CandidateScorePolicySchema,
  type CandidateScorePolicy,
} from "./candidateScore.js";
import type { ScreeningPolicy } from "../rules/screeningRules.js";

export function deriveDefaultCandidateScorePolicy(
  screeningPolicy: ScreeningPolicy,
): CandidateScorePolicy {
  return CandidateScorePolicySchema.parse({
    targetFeeToTvlRatio: Math.max(
      screeningPolicy.minFeeActiveTvlRatio * 2,
      0.1,
    ),
    targetVolumeUsd: Math.max(screeningPolicy.minVolumeUsd * 4, 20_000),
    targetTvlUsd: Math.max(screeningPolicy.minTvlUsd * 4, 40_000),
    targetHolderCount: Math.max(screeningPolicy.minHolderCount * 2, 1_000),
    targetPoolAgeHours: 72,
    targetSmartWalletCount: 5,
    overlapPenaltyPerPoolExposurePct: 1,
    overlapPenaltyPerTokenExposurePct: 0.5,
    launchpadPenaltyByName: {},
    weights: {
      feeToTvl: 1,
      volumeConsistency: 1,
      liquidityDepth: 1,
      organicScore: 1,
      holderQuality: 1,
      tokenAuditHealth: 1,
      smartMoney: 1,
      poolMaturity: 1,
      launchpadPenalty: 0.5,
      overlapPenalty: 1,
    },
  });
}
