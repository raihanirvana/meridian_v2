import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSignalWeightsStore } from "../../src/adapters/storage/SignalWeightsStore.js";
import { DefaultSignalWeightsProvider } from "../../src/app/services/SignalWeightsProvider.js";
import { type PortfolioState } from "../../src/domain/entities/PortfolioState.js";
import { screenAndScoreCandidates } from "../../src/domain/rules/screeningRules.js";
import { type ScreeningCandidateInput } from "../../src/domain/scoring/candidateScore.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-screening-darwin-"),
  );
  tempDirs.push(directory);
  return directory;
}

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

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("screening uses darwin weights", () => {
  it("changes scoring output when recalibrated weights are enabled", async () => {
    const directory = await makeTempDir();
    const signalWeightsStore = new FileSignalWeightsStore({
      filePath: path.join(directory, "signal-weights.json"),
    });
    const provider = new DefaultSignalWeightsProvider({
      darwinEnabled: true,
      signalWeightsStore,
    });

    const candidate = buildCandidate({
      feeToTvlRatio: 0.18,
      organicScore: 62,
    });

    const before = screenAndScoreCandidates({
      candidates: [candidate],
      portfolio,
      screeningPolicy,
      scoringPolicy,
      createdAt: "2026-04-22T12:00:00.000Z",
      signalWeights: await provider.resolveSignalWeights(),
    });

    const nextWeights = await signalWeightsStore.load();
    nextWeights.feeToTvl = {
      weight: 1.8,
      sampleSize: 10,
      lastAdjustedAt: "2026-04-22T12:05:00.000Z",
    };
    await signalWeightsStore.replace(nextWeights);

    const after = screenAndScoreCandidates({
      candidates: [candidate],
      portfolio,
      screeningPolicy,
      scoringPolicy,
      createdAt: "2026-04-22T12:05:00.000Z",
      signalWeights: await provider.resolveSignalWeights(),
    });

    expect(after.candidates[0]?.score).toBeGreaterThan(
      before.candidates[0]?.score ?? 0,
    );
  }, 10_000);
});
