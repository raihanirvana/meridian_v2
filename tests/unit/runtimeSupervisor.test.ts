import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockDlmmGateway } from "../../src/adapters/dlmm/DlmmGateway.js";
import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { MockScreeningGateway } from "../../src/adapters/screening/ScreeningGateway.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import type { Candidate } from "../../src/domain/entities/Candidate.js";
import type { UserConfig } from "../../src/infra/config/configSchema.js";
import { createRuntimeStores } from "../../src/runtime/createRuntimeStores.js";
import { createRuntimeSupervisorFromUserConfig } from "../../src/runtime/createRuntimeSupervisor.js";

const tempDirs: string[] = [];

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

function buildScreeningPolicy() {
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
  } as const;
}

function buildUserConfig(overrides: Partial<UserConfig> = {}): UserConfig {
  return {
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
      minFeeActiveTvlRatio: 0.05,
      minFeePerTvl24h: 0.01,
      minOrganic: 60,
      minHolderCount: 500,
      allowedBinSteps: [80],
      blockedLaunchpads: [],
      intervalTimezone: "UTC",
      peakHours: [],
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
    ...overrides,
  };
}

function buildCandidate(): Candidate {
  return {
    candidateId: "cand_001",
    poolAddress: "pool_001",
    symbolPair: "ABC-SOL",
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
    hardFilterPassed: true,
    score: 80,
    scoreBreakdown: {},
    decision: "SHORTLISTED",
    decisionReason: "selected upstream",
    createdAt: "2026-04-22T10:00:00.000Z",
  };
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
      userConfig: {
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
          minFeeActiveTvlRatio: 0.05,
          minFeePerTvl24h: 0.01,
          minOrganic: 60,
          minHolderCount: 500,
          allowedBinSteps: [80],
          blockedLaunchpads: [],
          intervalTimezone: "UTC",
          peakHours: [],
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
        },
      },
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
      userConfig: {
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
          minFeeActiveTvlRatio: 0.05,
          minFeePerTvl24h: 0.01,
          minOrganic: 60,
          minHolderCount: 500,
          allowedBinSteps: [80],
          blockedLaunchpads: [],
          intervalTimezone: "UTC",
          peakHours: [],
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
        },
      },
      stores,
      gateways: {
        dlmmGateway: new MockDlmmGateway({
          getPosition: { type: "success", value: null },
          deployLiquidity: {
            type: "error",
            error: new Error("deploy should not run in dry run"),
          },
          closePosition: {
            type: "error",
            error: new Error("close should not run in dry run"),
          },
          claimFees: {
            type: "error",
            error: new Error("claim should not run in dry run"),
          },
          partialClosePosition: {
            type: "error",
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
      rangeLowerBin: 31,
      rangeUpperBin: 100,
      initialActiveBin: 100,
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
            type: "error",
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
            type: "error",
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
});
