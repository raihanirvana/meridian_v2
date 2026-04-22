import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockDlmmGateway } from "../../src/adapters/dlmm/DlmmGateway.js";
import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import { createRuntimeStores } from "../../src/runtime/createRuntimeStores.js";
import { createRuntimeSupervisorFromUserConfig } from "../../src/runtime/createRuntimeSupervisor.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v2-supervisor-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
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

    const managementWorker = await stores.schedulerMetadataStore.get("management");
    const reportingWorker = await stores.schedulerMetadataStore.get("reporting");

    expect(managementWorker.status).toBe("SUCCEEDED");
    expect(managementWorker.manualRunCount).toBe(1);
    expect(reportingWorker.status).toBe("SUCCEEDED");
    expect(reportingWorker.manualRunCount).toBe(1);
  });
});
