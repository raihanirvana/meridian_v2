import { describe, expect, it } from "vitest";

import {
  CandidateSchema,
  type Candidate,
} from "../../../src/domain/entities/Candidate.js";
import { refreshCandidateDeployReadiness } from "../../../src/domain/rules/deployReadinessRules.js";
import {
  buildDataFreshnessSnapshot,
  buildDlmmMicrostructureSnapshot,
  buildMarketFeatureSnapshot,
} from "../../../src/domain/rules/poolFeatureRules.js";

const discoveryAt = "2026-04-22T09:59:30.000Z";
const now = "2026-04-22T10:00:00.000Z";

function buildWatchOnlyCandidate(
  overrides: Partial<Parameters<typeof CandidateSchema.parse>[0]> = {},
): Candidate {
  return CandidateSchema.parse({
    candidateId: "cand_001",
    poolAddress: "pool_001",
    symbolPair: "ABC-SOL",
    tokenXMint: "mint_abc",
    tokenYMint: "So11111111111111111111111111111111111111112",
    baseMint: "mint_abc",
    quoteMint: "So11111111111111111111111111111111111111112",
    screeningSnapshot: {},
    marketFeatureSnapshot: buildMarketFeatureSnapshot({
      volume24hUsd: 50_000,
      fees24hUsd: 50,
      tvlUsd: 100_000,
      volatility1hPct: 5,
      organicVolumeScore: 85,
      washTradingRiskScore: 5,
    }),
    dlmmMicrostructureSnapshot: buildDlmmMicrostructureSnapshot({
      binStep: 80,
      activeBin: null,
      activeBinSource: "pool_discovery",
      depthNearActiveUsd: 25_000,
      depthWithin10BinsUsd: 50_000,
      depthWithin25BinsUsd: 75_000,
      estimatedSlippageBpsForDefaultSize: 100,
      now: discoveryAt,
    }),
    tokenRiskSnapshot: {},
    smartMoneySnapshot: {},
    dataFreshnessSnapshot: buildDataFreshnessSnapshot({
      now: discoveryAt,
      screeningSnapshotAt: discoveryAt,
      poolDetailFetchedAt: discoveryAt,
      tokenIntelFetchedAt: null,
      chainSnapshotFetchedAt: null,
      hasActiveBin: false,
    }),
    strategySuitability: {
      curveScore: 0,
      spotScore: 0,
      bidAskScore: 0,
      recommendedByRules: "none",
      strategyRiskFlags: ["stale_strategy_snapshot", "missing_active_bin"],
      reasonCodes: ["snapshot_not_fresh", "active_bin_unavailable"],
    },
    hardFilterPassed: true,
    score: 80,
    scoreBreakdown: {},
    decision: "SHORTLISTED",
    decisionReason: "selected upstream",
    createdAt: discoveryAt,
    ...overrides,
  });
}

describe("refreshCandidateDeployReadiness", () => {
  it("turns a watch-only candidate deploy-ready when DLMM supplies fresh active bin", () => {
    const result = refreshCandidateDeployReadiness({
      candidate: buildWatchOnlyCandidate(),
      poolInfo: {
        poolAddress: "pool_001",
        pairLabel: "ABC-SOL",
        binStep: 80,
        activeBin: 1000,
      },
      now,
      maxStrategySnapshotAgeMs: 120_000,
      requireTokenIntelForDeploy: false,
    });

    expect(result.deployReady).toBe(true);
    expect(result.reasonCodes).not.toContain("active_bin_unavailable");
    expect(result.riskFlags).toContain("token_intel_unavailable");
    expect(
      result.candidate.strategySuitability.strategyRiskFlags,
    ).not.toContain("token_intel_unavailable");
    expect(result.candidate.dlmmMicrostructureSnapshot).toMatchObject({
      activeBin: 1000,
      activeBinSource: "dlmm_gateway",
      activeBinObservedAt: now,
      activeBinAgeMs: 0,
    });
    expect(result.candidate.dataFreshnessSnapshot).toMatchObject({
      chainSnapshotFetchedAt: now,
      isFreshEnoughForDeploy: true,
    });
  });

  it("rejects missing token intel when policy requires it", () => {
    const result = refreshCandidateDeployReadiness({
      candidate: buildWatchOnlyCandidate(),
      poolInfo: {
        poolAddress: "pool_001",
        pairLabel: "ABC-SOL",
        binStep: 80,
        activeBin: 1000,
      },
      now,
      maxStrategySnapshotAgeMs: 120_000,
      requireTokenIntelForDeploy: true,
    });

    expect(result.deployReady).toBe(false);
    expect(result.reasonCodes).toContain("TOKEN_INTEL_NOT_FRESH_OR_MISSING");
    expect(result.riskFlags).toContain("token_intel_unavailable");
    expect(result.candidate.dataFreshnessSnapshot.isFreshEnoughForDeploy).toBe(
      false,
    );
  });

  it("rejects when fresh DLMM pool info cannot provide active bin", () => {
    const result = refreshCandidateDeployReadiness({
      candidate: buildWatchOnlyCandidate(),
      poolInfo: {
        poolAddress: "pool_001",
        pairLabel: "ABC-SOL",
        binStep: 80,
        activeBin: null,
      },
      now,
      maxStrategySnapshotAgeMs: 120_000,
      requireTokenIntelForDeploy: false,
    });

    expect(result.deployReady).toBe(false);
    expect(result.reasonCodes).toContain("active_bin_unavailable");
    expect(result.candidate.dlmmMicrostructureSnapshot.activeBin).toBeNull();
    expect(result.candidate.dataFreshnessSnapshot.isFreshEnoughForDeploy).toBe(
      false,
    );
  });

  it("rejects when deploy-critical pool detail is missing", () => {
    const result = refreshCandidateDeployReadiness({
      candidate: buildWatchOnlyCandidate({
        dataFreshnessSnapshot: buildDataFreshnessSnapshot({
          now: discoveryAt,
          screeningSnapshotAt: discoveryAt,
          poolDetailFetchedAt: null,
          tokenIntelFetchedAt: null,
          chainSnapshotFetchedAt: null,
          hasActiveBin: false,
        }),
      }),
      poolInfo: {
        poolAddress: "pool_001",
        pairLabel: "ABC-SOL",
        binStep: 80,
        activeBin: 1000,
      },
      now,
      maxStrategySnapshotAgeMs: 120_000,
      requireTokenIntelForDeploy: false,
    });

    expect(result.deployReady).toBe(false);
    expect(result.reasonCodes).toContain("DETAIL_NOT_FRESH_OR_MISSING");
    expect(result.riskFlags).toContain("detail_not_fresh_or_missing");
  });
});
