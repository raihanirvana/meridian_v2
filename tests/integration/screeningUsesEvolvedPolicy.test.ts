import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileRuntimePolicyStore } from "../../src/adapters/config/RuntimePolicyStore.js";
import { DefaultPolicyProvider } from "../../src/app/services/PolicyProvider.js";
import { type PortfolioState } from "../../src/domain/entities/PortfolioState.js";
import { screenAndScoreCandidates } from "../../src/domain/rules/screeningRules.js";
import { type ScreeningCandidateInput } from "../../src/domain/scoring/candidateScore.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v2-screening-evolved-"));
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
    tempDirs.splice(0, tempDirs.length).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("screening uses evolved policy", () => {
  it("rejects a candidate that previously passed after evolved fee floor is applied", async () => {
    const directory = await makeTempDir();
    const basePolicy = {
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
    const runtimePolicyStore = new FileRuntimePolicyStore({
      filePath: path.join(directory, "policy-overrides.json"),
      basePolicy,
    });
    const policyProvider = new DefaultPolicyProvider({
      basePolicy,
      runtimePolicyStore,
    });
    const candidate = buildCandidate({
      feeToTvlRatio: 0.09,
    });

    const before = screenAndScoreCandidates({
      candidates: [candidate],
      portfolio,
      screeningPolicy: await policyProvider.resolveScreeningPolicy(),
      scoringPolicy,
      createdAt: "2026-04-22T12:00:00.000Z",
    });
    expect(before.candidates[0]?.hardFilterPassed).toBe(true);

    await runtimePolicyStore.applyOverrides({
      minFeeActiveTvlRatio: 0.1,
    });

    const after = screenAndScoreCandidates({
      candidates: [candidate],
      portfolio,
      screeningPolicy: await policyProvider.resolveScreeningPolicy(),
      scoringPolicy,
      createdAt: "2026-04-22T12:05:00.000Z",
    });

    expect(after.candidates[0]?.hardFilterPassed).toBe(false);
    expect(after.candidates[0]?.decision).toBe("REJECTED_HARD_FILTER");
  });
});
