import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockDlmmGateway } from "../../src/adapters/dlmm/DlmmGateway.js";
import { MockAiStrategyReviewer } from "../../src/adapters/llm/AiStrategyReviewer.js";
import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { MockScreeningGateway } from "../../src/adapters/screening/ScreeningGateway.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import {
  CandidateSchema,
  type Candidate,
} from "../../src/domain/entities/Candidate.js";
import {
  buildDataFreshnessSnapshot,
  buildDlmmMicrostructureSnapshot,
  buildMarketFeatureSnapshot,
} from "../../src/domain/rules/poolFeatureRules.js";
import type { ScreeningPolicy } from "../../src/domain/rules/screeningRules.js";
import type { UserConfig } from "../../src/infra/config/configSchema.js";
import { createRuntimeStores } from "../../src/runtime/createRuntimeStores.js";
import { createRuntimeSupervisorFromUserConfig } from "../../src/runtime/createRuntimeSupervisor.js";

const tempDirs: string[] = [];
const now = "2026-04-22T10:00:00.000Z";

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-supervisor-"),
  );
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function buildScreeningPolicy(): ScreeningPolicy {
  return {
    timeframe: "5m",
    minMarketCapUsd: 100_000,
    maxMarketCapUsd: 10_000_000,
    minTvlUsd: 10_000,
    minVolumeUsd: 500,
    minFeeActiveTvlRatio: 0.05,
    minFeePerTvl24h: 0.01,
    minOrganic: 60,
    minHolderCount: 500,
    allowedBinSteps: [80],
    blockedLaunchpads: [],
    blockedTokenMints: [],
    blockedDeployers: [],
    allowedPairTypes: ["volatile"],
    maxTopHolderPct: 30,
    maxBotHolderPct: 20,
    maxBundleRiskPct: 20,
    maxWashTradingRiskPct: 20,
    rejectDuplicatePoolExposure: true,
    rejectDuplicateTokenExposure: true,
    shortlistLimit: 5,
  };
}

type UserConfigOverrides = {
  [K in keyof UserConfig]?: Partial<UserConfig[K]>;
};

function buildUserConfig(overrides: UserConfigOverrides = {}): UserConfig {
  const base: UserConfig = {
    risk: {
      maxConcurrentPositions: 3,
      maxCapitalUsagePct: 70,
      minReserveUsd: 0.5,
      maxTokenExposurePct: 35,
      maxPoolExposurePct: 40,
      maxRebalancesPerPosition: 2,
      dailyLossLimitPct: 8,
      circuitBreakerCooldownMin: 180,
      maxNewDeploysPerHour: 2,
    },
    screening: {
      timeframe: "5m",
      minMarketCapUsd: 100_000,
      maxMarketCapUsd: 10_000_000,
      minTvlUsd: 10_000,
      minVolumeUsd: 500,
      minVolumeTrendPct: 0,
      minFeeActiveTvlRatio: 0.05,
      minFeePerTvl24h: 0.01,
      minOrganic: 60,
      minTokenAgeHours: 0,
      minHolderCount: 500,
      allowedBinSteps: [80],
      blockedLaunchpads: [],
      maxTopHolderPct: 35,
      maxBotHolderPct: 20,
      maxBundleRiskPct: 20,
      maxWashTradingRiskPct: 20,
      detailEnrichmentTopN: 5,
      detailRequestIntervalMs: 4_000,
      maxDetailRequestsPerCycle: 5,
      maxDetailRequestsPerWindow: 20,
      detailRequestWindowMs: 900_000,
      detailCooldownAfter429Ms: 900_000,
      requireDetailForDeploy: true,
      allowSnapshotOnlyWatch: true,
      intervalTimezone: "UTC",
      peakHours: [],
      requireFreshSnapshot: true,
      maxEstimatedSlippageBps: 300,
      maxStrategySnapshotAgeMs: 120_000,
      aiReviewPoolSize: 30,
      enrichmentConcurrency: 10,
    },
    management: {
      stopLossUsd: 50,
      maxHoldMinutes: 1440,
      maxOutOfRangeMinutes: 240,
      claimFeesThresholdUsd: 20,
      partialCloseEnabled: false,
      partialCloseProfitTargetUsd: 100,
      rebalanceEnabled: true,
    },
    ai: {
      mode: "disabled",
      strategyReviewEnabled: false,
      strategyReviewMode: "recommendation_only",
      allowAiStrategyForDeploy: false,
      minAiStrategyConfidence: 0.7,
      walletRiskMode: "small",
    },
    deploy: {
      defaultAmountSol: 0.25,
      minAmountSol: 0.1,
      autoDeployFromShortlist: false,
      maxAutoDeploysPerCycle: 1,
      strategy: "bid_ask",
      binsBelow: 69,
      binsAbove: 0,
      slippageBps: 300,
      maxActiveBinDrift: 3,
      maxBinsBelow: 120,
      maxBinsAbove: 120,
      maxSlippageBps: 300,
      requireFreshSnapshot: true,
      strategyFallbackMode: "config_static",
    },
    poolMemory: {
      snapshotsEnabled: false,
    },
    schedule: {
      screeningIntervalSec: 1800,
      managementIntervalSec: 600,
      reconciliationIntervalSec: 300,
      reportingIntervalSec: 3600,
    },
    darwin: {
      enabled: false,
    },
    notifications: {
      telegramEnabled: false,
      telegramOperatorCommandsEnabled: false,
    },
    reporting: {
      solMode: false,
      briefingEmoji: false,
    },
    claim: {
      autoSwapAfterClaim: false,
      swapOutputMint: "So11111111111111111111111111111111111111112",
      autoCompoundFees: false,
      compoundToSide: "quote",
    },
    runtime: {
      dryRun: true,
      logLevel: "info",
      operatorStdinEnabled: true,
    },
  };

  return {
    ...base,
    risk: { ...base.risk, ...overrides.risk },
    screening: { ...base.screening, ...overrides.screening },
    management: { ...base.management, ...overrides.management },
    ai: { ...base.ai, ...overrides.ai },
    deploy: { ...base.deploy, ...overrides.deploy },
    poolMemory: { ...base.poolMemory, ...overrides.poolMemory },
    schedule: { ...base.schedule, ...overrides.schedule },
    darwin: { ...base.darwin, ...overrides.darwin },
    notifications: { ...base.notifications, ...overrides.notifications },
    reporting: { ...base.reporting, ...overrides.reporting },
    claim: { ...base.claim, ...overrides.claim },
    runtime: { ...base.runtime, ...overrides.runtime },
  };
}

function buildCandidate(): Candidate {
  return CandidateSchema.parse({
    candidateId: "cand_001",
    poolAddress: "pool_001",
    symbolPair: "ABC-SOL",
    tokenXMint: "mint_abc",
    tokenYMint: "So11111111111111111111111111111111111111112",
    baseMint: "mint_abc",
    quoteMint: "So11111111111111111111111111111111111111112",
    screeningSnapshot: {
      marketCapUsd: 500_000,
      tvlUsd: 50_000,
      volumeUsd: 25_000,
      volumeConsistencyScore: 75,
      feeToTvlRatio: 0.12,
      feePerTvl24h: 0.03,
      organicScore: 80,
      holderCount: 1_200,
      binStep: 80,
      pairType: "volatile",
      launchpad: null,
    },
    marketFeatureSnapshot: buildMarketFeatureSnapshot({
      volume24hUsd: 25_000,
      fees24hUsd: 15,
      tvlUsd: 50_000,
      organicVolumeScore: 80,
      washTradingRiskScore: 5,
    }),
    dlmmMicrostructureSnapshot: buildDlmmMicrostructureSnapshot({
      binStep: 80,
      activeBin: 1000,
      activeBinObservedAt: now,
      depthNearActiveUsd: 20_000,
      depthWithin10BinsUsd: 40_000,
      depthWithin25BinsUsd: 50_000,
      estimatedSlippageBpsForDefaultSize: 100,
      now,
    }),
    tokenRiskSnapshot: {
      deployerAddress: "deployer_ok",
      topHolderPct: 18,
      botHolderPct: 4,
      bundleRiskPct: 6,
      washTradingRiskPct: 5,
      auditScore: 88,
      tokenXMint: "mint_abc",
      tokenYMint: "So11111111111111111111111111111111111111112",
    },
    smartMoneySnapshot: {
      smartWalletCount: 6,
      confidenceScore: 83,
      poolAgeHours: 96,
      tokenAgeHours: 24,
      narrativePenaltyScore: 10,
    },
    dataFreshnessSnapshot: buildDataFreshnessSnapshot({
      now,
      screeningSnapshotAt: now,
      poolDetailFetchedAt: now,
      tokenIntelFetchedAt: now,
      chainSnapshotFetchedAt: now,
      hasActiveBin: true,
    }),
    hardFilterPassed: true,
    score: 80,
    scoreBreakdown: {},
    decision: "SHORTLISTED",
    decisionReason: "selected upstream",
    createdAt: now,
  });
}

describe("runtime supervisor", () => {
  it("boots from file-backed stores and updates shared scheduler metadata across ticks", async () => {
    const directory = await makeTempDir();
    const stores = createRuntimeStores({
      dataDir: directory,
      baseScreeningPolicy: buildScreeningPolicy(),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    const supervisor = createRuntimeSupervisorFromUserConfig({
      wallet: "wallet_001",
      userConfig: buildUserConfig(),
      stores,
      gateways: {
        dlmmGateway: new MockDlmmGateway({
          getPosition: { type: "success", value: null },
          deployLiquidity: {
            type: "success",
            value: {
              actionType: "DEPLOY",
              positionId: "pos_001",
              txIds: ["tx_deploy"],
            },
          },
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close"],
            },
          },
          claimFees: {
            type: "success",
            value: {
              actionType: "CLAIM_FEES",
              claimedBaseAmount: 0,
              txIds: ["tx_claim"],
            },
          },
          partialClosePosition: {
            type: "success",
            value: {
              actionType: "PARTIAL_CLOSE",
              closedPositionId: "pos_001",
              remainingPercentage: 50,
              txIds: ["tx_partial"],
            },
          },
          listPositionsForWallet: {
            type: "success",
            value: {
              wallet: "wallet_001",
              positions: [],
            },
          },
          getPoolInfo: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "SOL/USDC",
              binStep: 80,
              activeBin: 10,
            },
          },
        }),
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 10,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 100,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
      },
      signalProvider: () => ({
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        severeNegativeYield: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        forcedManualClose: false,
        dataIncomplete: false,
        circuitBreakerState: "OFF",
      }),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    const startup = await supervisor.runStartupRecovery();
    const management = await supervisor.runManagementTick("manual");
    const reporting = await supervisor.runReportingTick("manual");
    const processedActions = await supervisor.runActionQueueTick();

    expect(startup.status).toBe("HEALTHY");
    expect(management.positionResults).toEqual([]);
    expect(reporting.report.health).toBe("HEALTHY");
    expect(processedActions).toEqual([]);

    const managementWorker =
      await stores.schedulerMetadataStore.get("management");
    const reportingWorker =
      await stores.schedulerMetadataStore.get("reporting");

    expect(managementWorker.status).toBe("SUCCEEDED");
    expect(managementWorker.manualRunCount).toBe(1);
    expect(reportingWorker.status).toBe("SUCCEEDED");
    expect(reportingWorker.manualRunCount).toBe(1);
  });

  it("does not process queued write actions while runtime dryRun is enabled", async () => {
    const directory = await makeTempDir();
    const stores = createRuntimeStores({
      dataDir: directory,
      baseScreeningPolicy: buildScreeningPolicy(),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    await stores.actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: "dry-run-deploy",
      requestedBy: "operator",
      requestedAt: "2026-04-22T10:00:00.000Z",
      requestPayload: {
        poolAddress: "pool_001",
        tokenXMint: "mint_x",
        tokenYMint: "mint_y",
        baseMint: "mint_x",
        quoteMint: "mint_y",
        amountBase: 1,
        amountQuote: 0,
        strategy: "spot",
        rangeLowerBin: 10,
        rangeUpperBin: 20,
        initialActiveBin: 15,
        estimatedValueUsd: 100,
      },
    });

    const supervisor = createRuntimeSupervisorFromUserConfig({
      wallet: "wallet_001",
      userConfig: buildUserConfig(),
      stores,
      gateways: {
        dlmmGateway: new MockDlmmGateway({
          getPosition: { type: "success", value: null },
          deployLiquidity: {
            type: "fail",
            error: new Error("deploy should not run in dry run"),
          },
          closePosition: {
            type: "fail",
            error: new Error("close should not run in dry run"),
          },
          claimFees: {
            type: "fail",
            error: new Error("claim should not run in dry run"),
          },
          partialClosePosition: {
            type: "fail",
            error: new Error("partial close should not run in dry run"),
          },
          listPositionsForWallet: {
            type: "success",
            value: {
              wallet: "wallet_001",
              positions: [],
            },
          },
          getPoolInfo: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "SOL/USDC",
              binStep: 80,
              activeBin: 10,
            },
          },
        }),
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 10,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 100,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
      },
      signalProvider: () => ({
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        severeNegativeYield: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        forcedManualClose: false,
        dataIncomplete: false,
        circuitBreakerState: "OFF",
      }),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    const processedActions = await supervisor.runActionQueueTick();
    const queuedActions = await stores.actionRepository.listByStatuses([
      "QUEUED",
    ]);

    expect(processedActions).toEqual([]);
    expect(queuedActions).toHaveLength(1);
    expect(queuedActions[0]?.idempotencyKey).toBe("dry-run-deploy");
  });

  it("queues an auto deploy action from the top screening shortlist when enabled", async () => {
    const directory = await makeTempDir();
    const stores = createRuntimeStores({
      dataDir: directory,
      baseScreeningPolicy: buildScreeningPolicy(),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    const userConfig = buildUserConfig({
      deploy: {
        defaultAmountSol: 0.25,
        minAmountSol: 0.1,
        autoDeployFromShortlist: true,
        maxAutoDeploysPerCycle: 1,
        strategy: "bid_ask",
        binsBelow: 69,
        binsAbove: 0,
        slippageBps: 300,
      },
      runtime: {
        dryRun: false,
        logLevel: "info",
        operatorStdinEnabled: true,
      },
    });

    const supervisor = createRuntimeSupervisorFromUserConfig({
      wallet: "wallet_001",
      userConfig,
      stores,
      gateways: {
        screeningGateway: new MockScreeningGateway({
          listCandidates: {
            type: "success",
            value: [buildCandidate()],
          },
          getCandidateDetails: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              feeToTvlRatio: 0.12,
              feePerTvl24h: 0.03,
              volumeTrendPct: 10,
              organicScore: 80,
              holderCount: 1_200,
            },
          },
        }),
        dlmmGateway: new MockDlmmGateway({
          getPosition: { type: "success", value: null },
          deployLiquidity: {
            type: "success",
            value: {
              actionType: "DEPLOY",
              positionId: "pos_001",
              txIds: ["tx_deploy"],
            },
          },
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close"],
            },
          },
          claimFees: {
            type: "success",
            value: {
              actionType: "CLAIM_FEES",
              claimedBaseAmount: 0,
              txIds: ["tx_claim"],
            },
          },
          partialClosePosition: {
            type: "success",
            value: {
              actionType: "PARTIAL_CLOSE",
              closedPositionId: "pos_001",
              remainingPercentage: 50,
              txIds: ["tx_partial"],
            },
          },
          listPositionsForWallet: {
            type: "success",
            value: {
              wallet: "wallet_001",
              positions: [],
            },
          },
          getPoolInfo: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              binStep: 80,
              activeBin: 1000,
            },
          },
        }),
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 10,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 100,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
      },
      signalProvider: () => ({
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        severeNegativeYield: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        forcedManualClose: false,
        dataIncomplete: false,
        circuitBreakerState: "OFF",
      }),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    await supervisor.runScreeningTick("manual", 45);

    const queuedActions = await stores.actionRepository.listByStatuses([
      "QUEUED",
    ]);
    const screeningWorker =
      await stores.schedulerMetadataStore.get("screening");

    expect(screeningWorker.intervalSec).toBe(45);
    expect(screeningWorker.nextDueAt).toBe("2026-04-22T10:00:45.000Z");
    expect(queuedActions).toHaveLength(1);
    expect(queuedActions[0]?.type).toBe("DEPLOY");
    expect(queuedActions[0]?.requestedBy).toBe("system");
    expect(queuedActions[0]?.requestPayload).toMatchObject({
      poolAddress: "pool_001",
      tokenXMint: "mint_abc",
      tokenYMint: "So11111111111111111111111111111111111111112",
      amountBase: 0,
      amountQuote: 0.25,
      strategy: "bid_ask",
      rangeLowerBin: 931,
      rangeUpperBin: 1000,
      initialActiveBin: 1000,
      estimatedValueUsd: 25,
    });
  });

  it("blocks auto deploy from shortlist when portfolio risk guardrails reject it", async () => {
    const directory = await makeTempDir();
    const stores = createRuntimeStores({
      dataDir: directory,
      baseScreeningPolicy: buildScreeningPolicy(),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    const userConfig = buildUserConfig({
      risk: {
        maxConcurrentPositions: 3,
        maxCapitalUsagePct: 1,
        minReserveUsd: 0.5,
        maxTokenExposurePct: 35,
        maxPoolExposurePct: 40,
        maxRebalancesPerPosition: 2,
        dailyLossLimitPct: 8,
        circuitBreakerCooldownMin: 180,
        maxNewDeploysPerHour: 2,
      },
      deploy: {
        defaultAmountSol: 0.25,
        minAmountSol: 0.1,
        autoDeployFromShortlist: true,
        maxAutoDeploysPerCycle: 1,
        strategy: "bid_ask",
        binsBelow: 69,
        binsAbove: 0,
        slippageBps: 300,
      },
      runtime: {
        dryRun: false,
        logLevel: "info",
        operatorStdinEnabled: true,
      },
    });

    const supervisor = createRuntimeSupervisorFromUserConfig({
      wallet: "wallet_001",
      userConfig,
      stores,
      gateways: {
        screeningGateway: new MockScreeningGateway({
          listCandidates: {
            type: "success",
            value: [buildCandidate()],
          },
          getCandidateDetails: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              feeToTvlRatio: 0.12,
              feePerTvl24h: 0.03,
              volumeTrendPct: 10,
              organicScore: 80,
              holderCount: 1_200,
            },
          },
        }),
        dlmmGateway: new MockDlmmGateway({
          getPosition: { type: "success", value: null },
          deployLiquidity: {
            type: "fail",
            error: new Error("deploy should not run when risk guard blocks"),
          },
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close"],
            },
          },
          claimFees: {
            type: "success",
            value: {
              actionType: "CLAIM_FEES",
              claimedBaseAmount: 0,
              txIds: ["tx_claim"],
            },
          },
          partialClosePosition: {
            type: "success",
            value: {
              actionType: "PARTIAL_CLOSE",
              closedPositionId: "pos_001",
              remainingPercentage: 50,
              txIds: ["tx_partial"],
            },
          },
          listPositionsForWallet: {
            type: "success",
            value: {
              wallet: "wallet_001",
              positions: [],
            },
          },
          getPoolInfo: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              binStep: 80,
              activeBin: 1000,
            },
          },
        }),
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 10,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 100,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
      },
      signalProvider: () => ({
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        severeNegativeYield: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        forcedManualClose: false,
        dataIncomplete: false,
        circuitBreakerState: "OFF",
      }),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    await supervisor.runScreeningTick("manual");

    expect(await stores.actionRepository.listByStatuses(["QUEUED"])).toEqual(
      [],
    );
    expect(
      (await stores.journalRepository.list()).map((event) => event.eventType),
    ).toContain("DEPLOY_REQUEST_BLOCKED_BY_RISK");
  });

  it("does not enqueue auto deploy actions while runtime dryRun is enabled", async () => {
    const directory = await makeTempDir();
    const stores = createRuntimeStores({
      dataDir: directory,
      baseScreeningPolicy: buildScreeningPolicy(),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    const userConfig = buildUserConfig({
      deploy: {
        defaultAmountSol: 0.25,
        minAmountSol: 0.1,
        autoDeployFromShortlist: true,
        maxAutoDeploysPerCycle: 1,
        strategy: "bid_ask",
        binsBelow: 69,
        binsAbove: 0,
        slippageBps: 300,
      },
    });

    const supervisor = createRuntimeSupervisorFromUserConfig({
      wallet: "wallet_001",
      userConfig,
      stores,
      gateways: {
        screeningGateway: new MockScreeningGateway({
          listCandidates: {
            type: "success",
            value: [buildCandidate()],
          },
          getCandidateDetails: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              feeToTvlRatio: 0.12,
              feePerTvl24h: 0.03,
              volumeTrendPct: 10,
              organicScore: 80,
              holderCount: 1_200,
            },
          },
        }),
        dlmmGateway: new MockDlmmGateway({
          getPosition: { type: "success", value: null },
          deployLiquidity: {
            type: "fail",
            error: new Error("deploy should not run during screening dry-run"),
          },
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close"],
            },
          },
          claimFees: {
            type: "success",
            value: {
              actionType: "CLAIM_FEES",
              claimedBaseAmount: 0,
              txIds: ["tx_claim"],
            },
          },
          partialClosePosition: {
            type: "success",
            value: {
              actionType: "PARTIAL_CLOSE",
              closedPositionId: "pos_001",
              remainingPercentage: 50,
              txIds: ["tx_partial"],
            },
          },
          listPositionsForWallet: {
            type: "success",
            value: {
              wallet: "wallet_001",
              positions: [],
            },
          },
          getPoolInfo: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              binStep: 80,
              activeBin: 1000,
            },
          },
        }),
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 10,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 100,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
      },
      signalProvider: () => ({
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        severeNegativeYield: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        forcedManualClose: false,
        dataIncomplete: false,
        circuitBreakerState: "OFF",
      }),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    await supervisor.runScreeningTick("manual");

    const queuedActions = await stores.actionRepository.listByStatuses([
      "QUEUED",
    ]);
    const journal = await stores.journalRepository.list();
    expect(queuedActions).toHaveLength(0);
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "AUTO_DEPLOY_FROM_SHORTLIST",
          resultStatus: "DRY_RUN",
        }),
      ]),
    );
  });

  it("writes a dry-run report comparing config, deterministic, AI, and final strategy decisions", async () => {
    const directory = await makeTempDir();
    const stores = createRuntimeStores({
      dataDir: directory,
      baseScreeningPolicy: buildScreeningPolicy(),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    const userConfig = buildUserConfig({
      ai: {
        mode: "advisory",
        strategyReviewEnabled: true,
        strategyReviewMode: "dry_run_payload",
        allowAiStrategyForDeploy: false,
        minAiStrategyConfidence: 0.7,
      },
      deploy: {
        defaultAmountSol: 0.25,
        minAmountSol: 0.1,
        autoDeployFromShortlist: true,
        maxAutoDeploysPerCycle: 1,
        strategy: "bid_ask",
        binsBelow: 69,
        binsAbove: 0,
        slippageBps: 300,
        maxActiveBinDrift: 3,
        maxBinsBelow: 120,
        maxBinsAbove: 120,
        maxSlippageBps: 300,
        requireFreshSnapshot: true,
        strategyFallbackMode: "config_static",
      },
    });

    const supervisor = createRuntimeSupervisorFromUserConfig({
      wallet: "wallet_001",
      userConfig,
      stores,
      gateways: {
        aiStrategyReviewer: new MockAiStrategyReviewer({
          reviewCandidateStrategy: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              decision: "deploy",
              recommendedStrategy: "spot",
              confidence: 0.92,
              riskLevel: "low",
              binsBelow: 12,
              binsAbove: 8,
              slippageBps: 150,
              maxPositionAgeMinutes: 240,
              stopLossPct: 5,
              takeProfitPct: 10,
              trailingStopPct: 2,
              reasons: ["ai_prefers_tighter_spot_range"],
              rejectIf: [],
            },
          },
        }),
        screeningGateway: new MockScreeningGateway({
          listCandidates: {
            type: "success",
            value: [buildCandidate()],
          },
          getCandidateDetails: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              feeToTvlRatio: 0.12,
              feePerTvl24h: 0.03,
              volumeTrendPct: 10,
              organicScore: 80,
              holderCount: 1_200,
            },
          },
        }),
        dlmmGateway: new MockDlmmGateway({
          getPosition: { type: "success", value: null },
          deployLiquidity: {
            type: "fail",
            error: new Error("deploy should not run during dry-run"),
          },
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close"],
            },
          },
          claimFees: {
            type: "success",
            value: {
              actionType: "CLAIM_FEES",
              claimedBaseAmount: 0,
              txIds: ["tx_claim"],
            },
          },
          partialClosePosition: {
            type: "success",
            value: {
              actionType: "PARTIAL_CLOSE",
              closedPositionId: "pos_001",
              remainingPercentage: 50,
              txIds: ["tx_partial"],
            },
          },
          listPositionsForWallet: {
            type: "success",
            value: {
              wallet: "wallet_001",
              positions: [],
            },
          },
          getPoolInfo: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              binStep: 80,
              activeBin: 1000,
            },
          },
        }),
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 10,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 100,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
      },
      signalProvider: () => ({
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        severeNegativeYield: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        forcedManualClose: false,
        dataIncomplete: false,
        circuitBreakerState: "OFF",
      }),
      lessonPromptService: {
        async buildLessonsPrompt() {
          return null;
        },
      },
      now: () => "2026-04-22T10:00:00.000Z",
    });

    await supervisor.runScreeningTick("manual");

    const journal = await stores.journalRepository.list();
    const strategyDecision = journal.find(
      (event) => event.eventType === "STRATEGY_DECISION_VALIDATED",
    );
    const autoDeploy = journal.find(
      (event) =>
        event.eventType === "AUTO_DEPLOY_FROM_SHORTLIST" &&
        event.resultStatus === "DRY_RUN",
    );

    expect(strategyDecision?.after).toMatchObject({
      configStaticStrategy: {
        strategy: "bid_ask",
        binsBelow: 69,
      },
      aiStrategy: {
        source: "AI",
        recommendedStrategy: "spot",
      },
      finalStrategyDecision: {
        source: "AI",
        strategy: "spot",
        binsBelow: 12,
        binsAbove: 8,
      },
    });
    expect(autoDeploy?.after).toMatchObject({
      requestPayload: {
        strategy: "spot",
        rangeLowerBin: 988,
        rangeUpperBin: 1008,
        slippageBps: 150,
      },
    });
  });

  it("blocks dry_run_payload mode from queueing live deploys when runtime dryRun is false", async () => {
    const directory = await makeTempDir();
    const stores = createRuntimeStores({
      dataDir: directory,
      baseScreeningPolicy: buildScreeningPolicy(),
      now: () => now,
    });
    const userConfig = buildUserConfig({
      ai: {
        mode: "advisory",
        strategyReviewEnabled: true,
        strategyReviewMode: "dry_run_payload",
        allowAiStrategyForDeploy: true,
      },
      deploy: {
        autoDeployFromShortlist: true,
      },
      runtime: {
        dryRun: false,
      },
    });

    const supervisor = createRuntimeSupervisorFromUserConfig({
      wallet: "wallet_001",
      userConfig,
      stores,
      gateways: {
        screeningGateway: new MockScreeningGateway({
          listCandidates: {
            type: "success",
            value: [buildCandidate()],
          },
          getCandidateDetails: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              feeToTvlRatio: 0.12,
              feePerTvl24h: 0.03,
              volumeTrendPct: 10,
              organicScore: 80,
              holderCount: 1_200,
            },
          },
        }),
        dlmmGateway: new MockDlmmGateway({
          getPosition: { type: "success", value: null },
          deployLiquidity: {
            type: "fail",
            error: new Error("deploy should not run in dry_run_payload"),
          },
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close"],
            },
          },
          claimFees: {
            type: "success",
            value: {
              actionType: "CLAIM_FEES",
              claimedBaseAmount: 0,
              txIds: ["tx_claim"],
            },
          },
          partialClosePosition: {
            type: "success",
            value: {
              actionType: "PARTIAL_CLOSE",
              closedPositionId: "pos_001",
              remainingPercentage: 50,
              txIds: ["tx_partial"],
            },
          },
          listPositionsForWallet: {
            type: "success",
            value: {
              wallet: "wallet_001",
              positions: [],
            },
          },
          getPoolInfo: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              binStep: 80,
              activeBin: 1000,
            },
          },
        }),
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 10,
              asOf: now,
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 100,
              asOf: now,
            },
          },
        }),
      },
      signalProvider: () => ({
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        severeNegativeYield: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        forcedManualClose: false,
        dataIncomplete: false,
        circuitBreakerState: "OFF",
      }),
      lessonPromptService: {
        async buildLessonsPrompt() {
          return null;
        },
      },
      now: () => now,
    });

    await supervisor.runScreeningTick("manual");

    const queuedActions = await stores.actionRepository.listByStatuses([
      "QUEUED",
    ]);
    const journal = await stores.journalRepository.list();
    expect(queuedActions).toHaveLength(0);
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "AUTO_DEPLOY_FROM_SHORTLIST",
          resultStatus: "BLOCKED",
          error: "dry_run_payload mode requires runtime.dryRun=true",
        }),
      ]),
    );
  });

  it("blocks guarded auto deploy when pre-queue DLMM simulation fails", async () => {
    const directory = await makeTempDir();
    const stores = createRuntimeStores({
      dataDir: directory,
      baseScreeningPolicy: buildScreeningPolicy(),
      now: () => "2026-04-22T10:00:00.000Z",
    });
    const userConfig = buildUserConfig({
      ai: {
        mode: "advisory",
        strategyReviewEnabled: true,
        strategyReviewMode: "guarded_auto",
        allowAiStrategyForDeploy: true,
        minAiStrategyConfidence: 0.7,
        walletRiskMode: "small",
      },
      deploy: {
        defaultAmountSol: 0.25,
        minAmountSol: 0.1,
        autoDeployFromShortlist: true,
        maxAutoDeploysPerCycle: 1,
        strategy: "bid_ask",
        binsBelow: 69,
        binsAbove: 0,
        slippageBps: 300,
        maxActiveBinDrift: 3,
        maxBinsBelow: 120,
        maxBinsAbove: 120,
        maxSlippageBps: 300,
        requireFreshSnapshot: true,
        strategyFallbackMode: "reject",
      },
      runtime: {
        dryRun: false,
        logLevel: "info",
        operatorStdinEnabled: true,
      },
    });

    const supervisor = createRuntimeSupervisorFromUserConfig({
      wallet: "wallet_001",
      userConfig,
      stores,
      gateways: {
        aiStrategyReviewer: new MockAiStrategyReviewer({
          reviewCandidateStrategy: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              decision: "deploy",
              recommendedStrategy: "spot",
              confidence: 0.92,
              riskLevel: "low",
              binsBelow: 12,
              binsAbove: 8,
              slippageBps: 150,
              maxPositionAgeMinutes: 240,
              stopLossPct: 5,
              takeProfitPct: 10,
              trailingStopPct: 2,
              reasons: ["ai_prefers_tighter_spot_range"],
              rejectIf: [],
            },
          },
        }),
        screeningGateway: new MockScreeningGateway({
          listCandidates: {
            type: "success",
            value: [buildCandidate()],
          },
          getCandidateDetails: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              feeToTvlRatio: 0.12,
              feePerTvl24h: 0.03,
              volumeTrendPct: 10,
              organicScore: 80,
              holderCount: 1_200,
            },
          },
        }),
        dlmmGateway: new MockDlmmGateway({
          getPosition: { type: "success", value: null },
          deployLiquidity: {
            type: "fail",
            error: new Error("deploy should not be queued after sim failure"),
          },
          simulateDeployLiquidity: {
            type: "success",
            value: {
              ok: false,
              reason: "range crosses inactive liquidity",
            },
          },
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close"],
            },
          },
          claimFees: {
            type: "success",
            value: {
              actionType: "CLAIM_FEES",
              claimedBaseAmount: 0,
              txIds: ["tx_claim"],
            },
          },
          partialClosePosition: {
            type: "success",
            value: {
              actionType: "PARTIAL_CLOSE",
              closedPositionId: "pos_001",
              remainingPercentage: 50,
              txIds: ["tx_partial"],
            },
          },
          listPositionsForWallet: {
            type: "success",
            value: {
              wallet: "wallet_001",
              positions: [],
            },
          },
          getPoolInfo: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              binStep: 80,
              activeBin: 1000,
            },
          },
        }),
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 10,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 100,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
      },
      signalProvider: () => ({
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        severeNegativeYield: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        forcedManualClose: false,
        dataIncomplete: false,
        circuitBreakerState: "OFF",
      }),
      lessonPromptService: {
        async buildLessonsPrompt() {
          return null;
        },
      },
      now: () => "2026-04-22T10:00:00.000Z",
    });

    await supervisor.runScreeningTick("manual");

    const queuedActions = await stores.actionRepository.listByStatuses([
      "QUEUED",
    ]);
    const journal = await stores.journalRepository.list();
    const strategyDecision = journal.find(
      (event) => event.eventType === "STRATEGY_DECISION_VALIDATED",
    );

    expect(queuedActions).toHaveLength(0);
    expect(strategyDecision?.after).toMatchObject({
      simulation: {
        ok: false,
        reason: "range crosses inactive liquidity",
        stage: "pre_queue",
      },
      finalStrategyDecision: {
        rejected: true,
        reasonCodes: expect.arrayContaining(["dlmm_simulation_failed"]),
      },
    });
  });

  it("does not use a stale portfolio snapshot to queue multiple auto deploys in one live cycle", async () => {
    const directory = await makeTempDir();
    const stores = createRuntimeStores({
      dataDir: directory,
      baseScreeningPolicy: buildScreeningPolicy(),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    const firstCandidate = buildCandidate();
    const secondCandidate: Candidate = {
      ...buildCandidate(),
      candidateId: "cand_002",
      poolAddress: "pool_002",
      symbolPair: "DEF-SOL",
    };
    const userConfig = buildUserConfig({
      deploy: {
        defaultAmountSol: 0.25,
        minAmountSol: 0.1,
        autoDeployFromShortlist: true,
        maxAutoDeploysPerCycle: 2,
        strategy: "bid_ask",
        binsBelow: 69,
        binsAbove: 0,
        slippageBps: 300,
        maxActiveBinDrift: 3,
        maxBinsBelow: 120,
        maxBinsAbove: 120,
        maxSlippageBps: 300,
        requireFreshSnapshot: true,
        strategyFallbackMode: "config_static",
      },
      runtime: {
        dryRun: false,
        logLevel: "info",
        operatorStdinEnabled: true,
      },
    });

    const supervisor = createRuntimeSupervisorFromUserConfig({
      wallet: "wallet_001",
      userConfig,
      stores,
      gateways: {
        screeningGateway: new MockScreeningGateway({
          listCandidates: {
            type: "success",
            value: [firstCandidate, secondCandidate],
          },
          getCandidateDetails: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              feeToTvlRatio: 0.12,
              feePerTvl24h: 0.03,
              volumeTrendPct: 10,
              organicScore: 80,
              holderCount: 1_200,
            },
          },
        }),
        dlmmGateway: new MockDlmmGateway({
          getPosition: { type: "success", value: null },
          deployLiquidity: {
            type: "fail",
            error: new Error("deploy should not run during screening"),
          },
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close"],
            },
          },
          claimFees: {
            type: "success",
            value: {
              actionType: "CLAIM_FEES",
              claimedBaseAmount: 0,
              txIds: ["tx_claim"],
            },
          },
          partialClosePosition: {
            type: "success",
            value: {
              actionType: "PARTIAL_CLOSE",
              closedPositionId: "pos_001",
              remainingPercentage: 50,
              txIds: ["tx_partial"],
            },
          },
          listPositionsForWallet: {
            type: "success",
            value: {
              wallet: "wallet_001",
              positions: [],
            },
          },
          getPoolInfo: {
            type: "success",
            value: {
              poolAddress: "pool_001",
              pairLabel: "ABC-SOL",
              binStep: 80,
              activeBin: 100,
            },
          },
        }),
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 10,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 100,
              asOf: "2026-04-22T10:00:00.000Z",
            },
          },
        }),
      },
      signalProvider: () => ({
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        severeNegativeYield: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        forcedManualClose: false,
        dataIncomplete: false,
        circuitBreakerState: "OFF",
      }),
      now: () => "2026-04-22T10:00:00.000Z",
    });

    await supervisor.runScreeningTick("manual");

    const queuedActions = await stores.actionRepository.listByStatuses([
      "QUEUED",
    ]);
    const blockedRiskEvents = (await stores.journalRepository.list()).filter(
      (event) => event.eventType === "DEPLOY_REQUEST_BLOCKED_BY_RISK",
    );

    expect(queuedActions).toHaveLength(1);
    expect(blockedRiskEvents.at(-1)?.error).toContain(
      "wallet already has an active write action",
    );
  });
});
