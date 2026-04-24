import { describe, expect, it } from "vitest";

import { type PortfolioState } from "../../src/domain/entities/PortfolioState.js";
import {
  evaluateScreeningHardFilters,
  screenAndScoreCandidates,
} from "../../src/domain/rules/screeningRules.js";
import { type ScreeningCandidateInput } from "../../src/domain/scoring/candidateScore.js";

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
} as const;

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
      createdAt: "2026-04-21T00:00:00.000Z",
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
});
