import { z } from "zod";

import {
  CandidateSchema,
  type Candidate,
} from "../entities/Candidate.js";
import { scoreStrategySuitability } from "../scoring/strategySuitabilityScore.js";

import {
  buildDataFreshnessSnapshot,
  buildDlmmMicrostructureSnapshot,
} from "./poolFeatureRules.js";

export const DeployReadinessResultSchema = z
  .object({
    candidate: CandidateSchema,
    deployReady: z.boolean(),
    reasonCodes: z.array(z.string().min(1)),
    riskFlags: z.array(z.string().min(1)),
  })
  .strict();

export type DeployReadinessResult = z.infer<
  typeof DeployReadinessResultSchema
>;

export type DeployReadinessPoolInfo = {
  poolAddress: string;
  pairLabel: string;
  binStep: number;
  activeBin: number | null;
};

export function refreshCandidateDeployReadiness(input: {
  candidate: Candidate;
  poolInfo: DeployReadinessPoolInfo;
  now: string;
  maxStrategySnapshotAgeMs: number;
  requireTokenIntelForDeploy: boolean;
}): DeployReadinessResult {
  const candidate = CandidateSchema.parse(input.candidate);
  const parsedNow = z.string().datetime().parse(input.now);
  const reasonCodes: string[] = [];
  const riskFlags: string[] = [];
  const blockingRiskFlags: string[] = [];

  if (candidate.dataFreshnessSnapshot.poolDetailFetchedAt === null) {
    reasonCodes.push("DETAIL_NOT_FRESH_OR_MISSING");
    riskFlags.push("detail_not_fresh_or_missing");
    blockingRiskFlags.push("detail_not_fresh_or_missing");
  }

  if (input.poolInfo.activeBin === null) {
    reasonCodes.push("active_bin_unavailable");
    riskFlags.push("missing_active_bin");
    blockingRiskFlags.push("missing_active_bin");
  }

  if (candidate.dataFreshnessSnapshot.tokenIntelFetchedAt === null) {
    riskFlags.push("token_intel_unavailable");
    if (input.requireTokenIntelForDeploy) {
      reasonCodes.push("TOKEN_INTEL_NOT_FRESH_OR_MISSING");
      blockingRiskFlags.push("token_intel_unavailable");
    }
  }

  const previousDlmm = candidate.dlmmMicrostructureSnapshot;
  const dlmmMicrostructureSnapshot = buildDlmmMicrostructureSnapshot({
    binStep: input.poolInfo.binStep,
    activeBin: input.poolInfo.activeBin,
    activeBinSource:
      input.poolInfo.activeBin === null ? "unavailable" : "dlmm_gateway",
    activeBinObservedAt: input.poolInfo.activeBin === null ? null : parsedNow,
    activeBinDriftFromDiscovery:
      previousDlmm.activeBin === null || input.poolInfo.activeBin === null
        ? 0
        : Math.abs(input.poolInfo.activeBin - previousDlmm.activeBin),
    depthNearActiveUsd: previousDlmm.depthNearActiveUsd,
    depthWithin10BinsUsd: previousDlmm.depthWithin10BinsUsd,
    depthWithin25BinsUsd: previousDlmm.depthWithin25BinsUsd,
    liquidityImbalancePct: previousDlmm.liquidityImbalancePct,
    spreadBps: previousDlmm.spreadBps,
    estimatedSlippageBpsForDefaultSize:
      previousDlmm.estimatedSlippageBpsForDefaultSize,
    outOfRangeRiskScore: previousDlmm.outOfRangeRiskScore,
    rangeStabilityScore: previousDlmm.rangeStabilityScore,
    now: parsedNow,
  });

  const dataFreshnessSnapshot = buildDataFreshnessSnapshot({
    now: parsedNow,
    screeningSnapshotAt: candidate.dataFreshnessSnapshot.screeningSnapshotAt,
    poolDetailFetchedAt: candidate.dataFreshnessSnapshot.poolDetailFetchedAt,
    tokenIntelFetchedAt: candidate.dataFreshnessSnapshot.tokenIntelFetchedAt,
    chainSnapshotFetchedAt: parsedNow,
    maxAgeMs: input.maxStrategySnapshotAgeMs,
    hasActiveBin: input.poolInfo.activeBin !== null,
    requireTokenIntel: input.requireTokenIntelForDeploy,
  });

  const scoredSuitability = scoreStrategySuitability({
    marketFeatureSnapshot: candidate.marketFeatureSnapshot,
    dlmmMicrostructureSnapshot,
    dataFreshnessSnapshot,
  });
  const strategySuitability = {
    ...scoredSuitability,
    strategyRiskFlags: [
      ...new Set([
        ...scoredSuitability.strategyRiskFlags,
        ...blockingRiskFlags,
      ]),
    ],
    reasonCodes: [
      ...new Set([...scoredSuitability.reasonCodes, ...reasonCodes]),
    ],
  };

  const refreshedCandidate = CandidateSchema.parse({
    ...candidate,
    dlmmMicrostructureSnapshot,
    dataFreshnessSnapshot,
    strategySuitability,
  });
  const deployReady =
    dataFreshnessSnapshot.isFreshEnoughForDeploy && reasonCodes.length === 0;

  return DeployReadinessResultSchema.parse({
    candidate: refreshedCandidate,
    deployReady,
    reasonCodes: [...new Set(reasonCodes)],
    riskFlags: [...new Set(riskFlags)],
  });
}
