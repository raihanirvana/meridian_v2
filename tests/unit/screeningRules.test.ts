import { describe, expect, it } from "vitest";

import { type PortfolioState } from "../../src/domain/entities/PortfolioState.js";
import {
  evaluateScreeningHardFilters,
  screenAndScoreCandidates,
  type ScreeningPolicy,
} from "../../src/domain/rules/screeningRules.js";
import {
  buildDataFreshnessSnapshot,
  buildDlmmMicrostructureSnapshot,
  buildMarketFeatureSnapshot,
} from "../../src/domain/rules/poolFeatureRules.js";
import {
  type ScreeningCandidateInput,
  scoreCandidate,
} from "../../src/domain/scoring/candidateScore.js";

const now = "2026-04-21T00:00:00.000Z";
const SOL_MINT = "So11111111111111111111111111111111111111112";

function buildPortfolio(
  overrides: Partial<PortfolioState> = {},
): PortfolioState {
  return {
    walletBalance: 10,
    reservedBalance: 1,
    availableBalance: 9,
    openPositions: 1,
    pendingActions: 0,
    dailyRealizedPnl: 0,
    drawdownState: "NORMAL",
    circuitBreakerState: "OFF",
    exposureByToken: {},
    exposureByPool: {},
    ...overrides,
  };
}

function buildCandidate(
  overrides: Partial<ScreeningCandidateInput> = {},
): ScreeningCandidateInput {
  return {
    candidateId: "cand_001",
    poolAddress: "pool_001",
    symbolPair: "SOL-USDC",
    tokenXMint: "mint_sol",
    tokenYMint: "mint_usdc",
    marketCapUsd: 500_000,
    tvlUsd: 50_000,
    volumeUsd: 25_000,
    volumeConsistencyScore: 75,
    feeToTvlRatio: 0.12,
    feePerTvl24h: 0.03,
    organicScore: 80,
    holderCount: 1_200,
    binStep: 100,
    launchpad: null,
    deployerAddress: "deployer_ok",
    pairType: "volatile",
    topHolderPct: 18,
    botHolderPct: 4,
    bundleRiskPct: 6,
    washTradingRiskPct: 5,
    auditScore: 88,
    smartWalletCount: 6,
    smartMoneyConfidenceScore: 83,
    poolAgeHours: 96,
    narrativePenaltyScore: 10,
    marketFeatureSnapshot: buildMarketFeatureSnapshot({
      volume24hUsd: 25_000,
      fees24hUsd: 15,
      tvlUsd: 50_000,
      volatility1hPct: 5,
      trendStrength1h: 20,
      meanReversionScore: 70,
      organicVolumeScore: 80,
      washTradingRiskScore: 5,
    }),
    dlmmMicrostructureSnapshot: buildDlmmMicrostructureSnapshot({
      binStep: 100,
      activeBin: 1000,
      activeBinObservedAt: now,
      depthNearActiveUsd: 20_000,
      depthWithin10BinsUsd: 40_000,
      depthWithin25BinsUsd: 50_000,
      estimatedSlippageBpsForDefaultSize: 100,
      rangeStabilityScore: 70,
      now,
    }),
    dataFreshnessSnapshot: buildDataFreshnessSnapshot({
      now,
      screeningSnapshotAt: now,
      poolDetailFetchedAt: now,
      tokenIntelFetchedAt: now,
      chainSnapshotFetchedAt: now,
      hasActiveBin: true,
    }),
    ...overrides,
  };
}

const screeningPolicy = {
  timeframe: "5m",
  minMarketCapUsd: 150_000,
  maxMarketCapUsd: 10_000_000,
  minTvlUsd: 10_000,
  minVolumeUsd: 5_000,
  minFeeActiveTvlRatio: 0.05,
  minFeePerTvl24h: 0.01,
  minOrganic: 60,
  minHolderCount: 500,
  allowedBinSteps: [80, 100, 125],
  blockedLaunchpads: ["blocked_launchpad"],
  blockedTokenMints: ["blocked_token"],
  blockedDeployers: ["blocked_deployer"],
  allowedPairTypes: ["volatile", "stable"],
  maxTopHolderPct: 35,
  maxBotHolderPct: 20,
  maxBundleRiskPct: 20,
  maxWashTradingRiskPct: 20,
  rejectDuplicatePoolExposure: true,
  rejectDuplicateTokenExposure: true,
  shortlistLimit: 2,
} satisfies ScreeningPolicy;

const scoringPolicy = {
  targetFeeToTvlRatio: 0.1,
  targetVolumeUsd: 20_000,
  targetTvlUsd: 40_000,
  targetHolderCount: 1_000,
  targetPoolAgeHours: 72,
  targetSmartWalletCount: 5,
  overlapPenaltyPerPoolExposurePct: 1,
  overlapPenaltyPerTokenExposurePct: 0.5,
  launchpadPenaltyByName: {
    meme_launchpad: 40,
  },
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
} as const;

describe("screening rules", () => {
  it("rejects candidates that fail hard filters", () => {
    const result = evaluateScreeningHardFilters({
      candidate: buildCandidate({
        organicScore: 40,
        washTradingRiskPct: 35,
      }),
      portfolio: buildPortfolio(),
      policy: screeningPolicy,
    });

    expect(result.hardFilterPassed).toBe(false);
    expect(result.decision).toBe("REJECTED_HARD_FILTER");
    expect(result.rejectionReasons).toEqual(
      expect.arrayContaining([
        "organic score below minimum",
        "wash trading risk above maximum",
      ]),
    );
  });

  it("rejects candidates with duplicate exposure conflicts before scoring", () => {
    const result = evaluateScreeningHardFilters({
      candidate: buildCandidate({
        poolAddress: "pool_conflict",
        tokenXMint: "mint_conflict",
        organicScore: 40,
      }),
      portfolio: buildPortfolio({
        exposureByPool: {
          pool_conflict: 10,
        },
        exposureByToken: {
          mint_conflict: 20,
        },
      }),
      policy: screeningPolicy,
    });

    expect(result.hardFilterPassed).toBe(false);
    expect(result.decision).toBe("REJECTED_EXPOSURE");
    expect(result.decisionReason).toMatch(/duplicate pool exposure/i);
    expect(result.rejectionReasons).toEqual(
      expect.arrayContaining([
        "organic score below minimum",
        "duplicate pool exposure",
      ]),
    );
  });

  it("does not treat shared SOL quote exposure as a duplicate token conflict", () => {
    const result = evaluateScreeningHardFilters({
      candidate: buildCandidate({
        symbolPair: "NEW-SOL",
        tokenXMint: "mint_new",
        tokenYMint: SOL_MINT,
      }),
      portfolio: buildPortfolio({
        exposureByToken: {
          [SOL_MINT]: 35,
        },
      }),
      policy: screeningPolicy,
    });

    expect(result.hardFilterPassed).toBe(true);
    expect(result.rejectionReasons).not.toContain("duplicate token exposure");
  });

  it("normalizes duplicate exposure rejections when building candidate entities", () => {
    const result = screenAndScoreCandidates({
      candidates: [
        buildCandidate({
          candidateId: "cand_conflict",
          poolAddress: "pool_conflict",
          tokenXMint: "mint_conflict",
        }),
      ],
      portfolio: buildPortfolio({
        exposureByPool: {
          pool_conflict: 10,
        },
        exposureByToken: {
          mint_conflict: 20,
        },
      }),
      screeningPolicy,
      scoringPolicy,
      createdAt: now,
    });

    expect(result.candidates[0]?.hardFilterPassed).toBe(false);
    expect(result.candidates[0]?.decision).toBe("REJECTED_HARD_FILTER");
    expect(result.candidates[0]?.decisionReason).toMatch(
      /duplicate pool exposure/i,
    );
    expect(result.shortlist).toHaveLength(0);
  });

  it("builds a deterministic shortlist ordered by score", () => {
    const result = screenAndScoreCandidates({
      candidates: [
        buildCandidate({
          candidateId: "cand_best",
          poolAddress: "pool_best",
          symbolPair: "SOL-USDC",
          feeToTvlRatio: 0.14,
          feePerTvl24h: 0.04,
          volumeConsistencyScore: 90,
          organicScore: 88,
          smartMoneyConfidenceScore: 90,
        }),
        buildCandidate({
          candidateId: "cand_mid",
          poolAddress: "pool_mid",
          symbolPair: "BONK-SOL",
          feeToTvlRatio: 0.09,
          feePerTvl24h: 0.03,
          volumeConsistencyScore: 70,
          organicScore: 72,
          smartMoneyConfidenceScore: 74,
        }),
        buildCandidate({
          candidateId: "cand_low",
          poolAddress: "pool_low",
          symbolPair: "JUP-SOL",
          feeToTvlRatio: 0.07,
          feePerTvl24h: 0.02,
          volumeConsistencyScore: 60,
          organicScore: 65,
          smartMoneyConfidenceScore: 60,
          poolAgeHours: 24,
        }),
      ],
      portfolio: buildPortfolio(),
      screeningPolicy,
      scoringPolicy,
      createdAt: now,
    });

    expect(result.shortlist.map((candidate) => candidate.candidateId)).toEqual([
      "cand_best",
      "cand_mid",
    ]);
    expect(
      result.shortlist.every(
        (candidate) => candidate.decision === "SHORTLISTED",
      ),
    ).toBe(true);
    expect(
      result.candidates.find(
        (candidate) => candidate.candidateId === "cand_low",
      )?.decision,
    ).toBe("PASSED_HARD_FILTER");
    expect(result.shortlist[0]?.score).toBeGreaterThan(
      result.shortlist[1]?.score ?? 0,
    );
  });

  it("blocks candidates by token age, ath distance, and 24h fee-per-tvl floor", () => {
    const result = evaluateScreeningHardFilters({
      candidate: buildCandidate({
        tokenAgeHours: 0.5,
        athDistancePct: -5,
        feePerTvl24h: 0.001,
      }),
      portfolio: buildPortfolio(),
      policy: {
        ...screeningPolicy,
        minTokenAgeHours: 1,
        maxTokenAgeHours: 720,
        athFilterPct: -20,
        minFeePerTvl24h: 0.01,
      },
    });

    expect(result.hardFilterPassed).toBe(false);
    expect(result.rejectionReasons).toEqual(
      expect.arrayContaining([
        "token age below minimum",
        "price is too close to ath",
        "24h fee-per-tvl below minimum",
      ]),
    );
  });

  it("rejects candidates with stale or missing active-bin strategy snapshots", () => {
    const result = evaluateScreeningHardFilters({
      candidate: buildCandidate({
        dlmmMicrostructureSnapshot: buildDlmmMicrostructureSnapshot({
          binStep: 100,
          activeBin: null,
          activeBinObservedAt: null,
          now,
        }),
        dataFreshnessSnapshot: buildDataFreshnessSnapshot({
          now,
          hasActiveBin: false,
        }),
      }),
      portfolio: buildPortfolio(),
      policy: screeningPolicy,
    });

    expect(result.hardFilterPassed).toBe(false);
    expect(result.rejectionReasons).toEqual(
      expect.arrayContaining([
        "strategy snapshot is stale",
        "active bin unavailable",
      ]),
    );
  });

  it("allows snapshot-only watch candidates when deploy still requires fresh detail", () => {
    const result = evaluateScreeningHardFilters({
      candidate: buildCandidate({
        dlmmMicrostructureSnapshot: buildDlmmMicrostructureSnapshot({
          binStep: 100,
          activeBin: null,
          activeBinObservedAt: null,
          now,
        }),
        dataFreshnessSnapshot: buildDataFreshnessSnapshot({
          now,
          screeningSnapshotAt: now,
          poolDetailFetchedAt: now,
          tokenIntelFetchedAt: null,
          chainSnapshotFetchedAt: now,
          hasActiveBin: false,
        }),
      }),
      portfolio: buildPortfolio(),
      policy: {
        ...screeningPolicy,
        requireFreshSnapshot: true,
        requireDetailForDeploy: true,
        allowSnapshotOnlyWatch: true,
      },
    });

    expect(result.hardFilterPassed).toBe(true);
    expect(result.rejectionReasons).not.toContain("strategy snapshot is stale");
    expect(result.rejectionReasons).not.toContain("active bin unavailable");
  });

  it("rejects candidates when estimated DLMM slippage is above the deploy limit", () => {
    const result = evaluateScreeningHardFilters({
      candidate: buildCandidate({
        dlmmMicrostructureSnapshot: buildDlmmMicrostructureSnapshot({
          binStep: 100,
          activeBin: 1000,
          activeBinObservedAt: now,
          depthNearActiveUsd: 20_000,
          estimatedSlippageBpsForDefaultSize: 450,
          now,
        }),
      }),
      portfolio: buildPortfolio(),
      policy: {
        ...screeningPolicy,
        maxEstimatedSlippageBps: 300,
      },
    });

    expect(result.hardFilterPassed).toBe(false);
    expect(result.rejectionReasons).toContain(
      "estimated slippage above maximum",
    );
  });

  it("keeps cooldown candidates visible as rejected instead of dropping them", () => {
    const result = screenAndScoreCandidates({
      candidates: [
        buildCandidate({
          candidateId: "cand_cooldown",
          poolAddress: "pool_cooldown",
        }),
        buildCandidate({
          candidateId: "cand_open",
          poolAddress: "pool_open",
        }),
      ],
      portfolio: buildPortfolio(),
      screeningPolicy,
      scoringPolicy,
      poolMemoryMap: {
        pool_cooldown: {
          cooldownUntil: "2026-04-21T01:00:00.000Z",
        },
      },
      createdAt: now,
      now,
    });

    expect(result.candidates.map((candidate) => candidate.candidateId)).toEqual(
      ["cand_cooldown", "cand_open"],
    );
    expect(
      result.candidates.find(
        (candidate) => candidate.candidateId === "cand_cooldown",
      )?.decision,
    ).toBe("REJECTED_COOLDOWN");
    expect(result.shortlist.map((candidate) => candidate.candidateId)).toEqual([
      "cand_open",
    ]);
  });

  it("includes hard-filter rejection reasons alongside cooldown reason", () => {
    const result = screenAndScoreCandidates({
      candidates: [
        buildCandidate({
          candidateId: "cand_blocked_cooldown",
          poolAddress: "pool_blocked_cooldown",
          tokenXMint: "blocked_token",
          tokenYMint: "mint_usdc",
        }),
      ],
      portfolio: buildPortfolio(),
      screeningPolicy: {
        ...screeningPolicy,
        blockedTokenMints: ["blocked_token"],
      },
      scoringPolicy,
      poolMemoryMap: {
        pool_blocked_cooldown: {
          cooldownUntil: "2026-04-21T01:00:00.000Z",
        },
      },
      createdAt: now,
      now,
    });

    const candidate = result.candidates.find(
      (c) => c.candidateId === "cand_blocked_cooldown",
    );
    expect(candidate?.decision).toBe("REJECTED_COOLDOWN");
    expect(candidate?.decisionReason).toMatch(/cooldown/i);
    expect(
      result.candidates
        .find((c) => c.candidateId === "cand_blocked_cooldown")
        ?.hardFilterPassed,
    ).toBe(false);
  });

  it("derives baseMint/quoteMint from preferredQuoteMints when explicit base/quote is absent", () => {
    const result = screenAndScoreCandidates({
      candidates: [
        buildCandidate({
          candidateId: "cand_preferred_quote",
          poolAddress: "pool_preferred_quote",
          tokenXMint: "mint_usdc",
          tokenYMint: "mint_meme",
          preferredQuoteMints: ["mint_usdc"],
        }),
      ],
      portfolio: buildPortfolio(),
      screeningPolicy,
      scoringPolicy,
      createdAt: now,
    });

    const candidate = result.candidates.find(
      (c) => c.candidateId === "cand_preferred_quote",
    );
    expect(candidate?.baseMint).toBe("mint_meme");
    expect(candidate?.quoteMint).toBe("mint_usdc");
  });

  it("uses explicit baseMint/quoteMint from input when provided", () => {
    const result = screenAndScoreCandidates({
      candidates: [
        buildCandidate({
          candidateId: "cand_explicit_base_quote",
          poolAddress: "pool_explicit_base_quote",
          tokenXMint: "mint_usdc",
          tokenYMint: "mint_meme",
          baseMint: "mint_meme",
          quoteMint: "mint_usdc",
        }),
      ],
      portfolio: buildPortfolio(),
      screeningPolicy,
      scoringPolicy,
      createdAt: now,
    });

    const candidate = result.candidates.find(
      (c) => c.candidateId === "cand_explicit_base_quote",
    );
    expect(candidate?.baseMint).toBe("mint_meme");
    expect(candidate?.quoteMint).toBe("mint_usdc");
  });

  it("does not apply empty-string launchpad penalties to null launchpad candidates", () => {
    const result = screenAndScoreCandidates({
      candidates: [
        buildCandidate({
          candidateId: "cand_null_launchpad",
          launchpad: null,
          narrativePenaltyScore: 10,
        }),
      ],
      portfolio: buildPortfolio(),
      screeningPolicy,
      scoringPolicy: {
        ...scoringPolicy,
        launchpadPenaltyByName: {
          "": 100,
        },
      },
      createdAt: now,
    });

    expect(result.candidates[0]?.scoreBreakdown.launchpadPenalty).toBe(90);
  });

  it("below_target_volume flag only fires when volume is materially below target (>20% gap)", () => {
    const portfolio = buildPortfolio();
    const policy = {
      ...scoringPolicy,
      targetVolumeUsd: 20_000,
    } as const;

    const withinTolerance = scoreCandidate({
      candidate: buildCandidate({ volumeUsd: 17_000 }),
      portfolio,
      policy,
    });
    expect(withinTolerance.riskFlags).not.toContain("below_target_volume");

    const atThreshold = scoreCandidate({
      candidate: buildCandidate({ volumeUsd: 15_999 }),
      portfolio,
      policy,
    });
    expect(atThreshold.riskFlags).toContain("below_target_volume");

    const materiallyBelow = scoreCandidate({
      candidate: buildCandidate({ volumeUsd: 10_000 }),
      portfolio,
      policy,
    });
    expect(materiallyBelow.riskFlags).toContain("below_target_volume");
  });
});
