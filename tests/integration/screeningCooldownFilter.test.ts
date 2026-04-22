import { describe, expect, it } from "vitest";

import { type PortfolioState } from "../../src/domain/entities/PortfolioState.js";
import { screenAndScoreCandidates } from "../../src/domain/rules/screeningRules.js";
import { type ScreeningCandidateInput } from "../../src/domain/scoring/candidateScore.js";

const portfolio: PortfolioState = {
  walletBalance: 10,
  reservedBalance: 1,
  availableBalance: 9,
  openPositions: 0,
  pendingActions: 0,
  dailyRealizedPnl: 0,
  drawdownState: "NORMAL",
  circuitBreakerState: "OFF",
  exposureByToken: {},
  exposureByPool: {},
};

const screeningPolicy = {
  minMarketCapUsd: 150_000,
  maxMarketCapUsd: 10_000_000,
  minTvlUsd: 10_000,
  minVolumeUsd: 5_000,
  minFeeActiveTvlRatio: 0.05,
  minOrganic: 60,
  minHolderCount: 500,
  allowedBinSteps: [80, 100, 125],
  blockedLaunchpads: [],
  blockedTokenMints: [],
  blockedDeployers: [],
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
} as const;

function buildCandidate(overrides: Partial<ScreeningCandidateInput> = {}): ScreeningCandidateInput {
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
    feeToTvlRatio: 0.09,
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

describe("screening cooldown filter", () => {
  it("removes candidates whose pools are still in cooldown", () => {
    const result = screenAndScoreCandidates({
      candidates: [
        buildCandidate({
          candidateId: "cand_on_cooldown",
          poolAddress: "pool_cooldown",
        }),
        buildCandidate({
          candidateId: "cand_open",
          poolAddress: "pool_open",
        }),
      ],
      portfolio,
      screeningPolicy,
      scoringPolicy,
      poolMemoryMap: {
        pool_cooldown: {
          cooldownUntil: "2026-04-22T13:00:00.000Z",
        },
        pool_open: {
          cooldownUntil: "2026-04-22T11:00:00.000Z",
        },
      },
      now: "2026-04-22T12:00:00.000Z",
      createdAt: "2026-04-22T12:00:00.000Z",
    });

    expect(result.candidates.map((candidate) => candidate.candidateId)).toEqual([
      "cand_open",
    ]);
  });
});
