import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { runManagementWorker } from "../../src/app/workers/managementWorker.js";
import { type Action } from "../../src/domain/entities/Action.js";
import { type Position } from "../../src/domain/entities/Position.js";
import { type ManagementPolicy } from "../../src/domain/rules/managementRules.js";
import { type PortfolioRiskPolicy } from "../../src/domain/rules/riskRules.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v2-mgmt-"));
  tempDirs.push(directory);
  return directory;
}

function buildPosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: "pos_001",
    poolAddress: "pool_001",
    tokenXMint: "mint_x",
    tokenYMint: "mint_y",
    baseMint: "mint_base",
    quoteMint: "mint_quote",
    wallet: "wallet_001",
    status: "OPEN",
    openedAt: "2026-04-21T00:00:00.000Z",
    lastSyncedAt: "2026-04-21T00:00:00.000Z",
    closedAt: null,
    deployAmountBase: 1,
    deployAmountQuote: 0.5,
    currentValueBase: 1,
    currentValueUsd: 20,
    feesClaimedBase: 0,
    feesClaimedUsd: 0,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    rebalanceCount: 0,
    partialCloseCount: 0,
    strategy: "bid_ask",
    rangeLowerBin: 10,
    rangeUpperBin: 20,
    activeBin: 15,
    outOfRangeSince: null,
    lastManagementDecision: null,
    lastManagementReason: null,
    lastWriteActionId: null,
    needsReconciliation: false,
    ...overrides,
  };
}

function buildDeployAction(overrides: Partial<Action> = {}): Action {
  return {
    actionId: "act_deploy",
    type: "DEPLOY",
    status: "DONE",
    wallet: "wallet_001",
    positionId: null,
    idempotencyKey: "wallet_001:DEPLOY:none:seed",
    requestPayload: {
      poolAddress: "pool_seed",
    },
    resultPayload: null,
    txIds: [],
    error: null,
    requestedAt: "2026-04-21T11:40:00.000Z",
    startedAt: "2026-04-21T11:40:01.000Z",
    completedAt: "2026-04-21T11:41:00.000Z",
    requestedBy: "system",
    ...overrides,
  };
}

function buildRiskPolicy(
  overrides: Partial<PortfolioRiskPolicy> = {},
): PortfolioRiskPolicy {
  return {
    maxConcurrentPositions: 3,
    maxCapitalUsagePct: 80,
    minReserveUsd: 10,
    maxTokenExposurePct: 45,
    maxPoolExposurePct: 45,
    maxRebalancesPerPosition: 2,
    dailyLossLimitPct: 8,
    circuitBreakerCooldownMin: 180,
    maxNewDeploysPerHour: 2,
    ...overrides,
  };
}

function buildManagementPolicy(
  overrides: Partial<ManagementPolicy> = {},
): ManagementPolicy {
  return {
    stopLossUsd: 50,
    maxHoldMinutes: 1440,
    maxOutOfRangeMinutes: 240,
    claimFeesThresholdUsd: 20,
    partialCloseEnabled: false,
    partialCloseProfitTargetUsd: 100,
    rebalanceEnabled: true,
    maxRebalancesPerPosition: 2,
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

describe("management worker", () => {
  it("dispatches CLOSE when management engine requests an emergency close", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(buildPosition());

    const result = await runManagementWorker({
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      managementPolicy: buildManagementPolicy(),
      signalProvider: () => ({
        forcedManualClose: true,
        severeTokenRisk: false,
        liquidityCollapse: false,
        severeNegativeYield: false,
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        dataIncomplete: false,
      }),
      journalRepository,
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.positionResults).toHaveLength(1);
    expect(result.positionResults[0]?.managementAction).toBe("CLOSE");
    expect(result.positionResults[0]?.status).toBe("DISPATCHED");

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("CLOSE");
  });

  it("dispatches REBALANCE even when recent deploys are at the limit", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(
      buildPosition({
        activeBin: 30,
        outOfRangeSince: "2026-04-21T06:00:00.000Z",
      }),
    );
    await actionRepository.upsert(buildDeployAction({ actionId: "act_d1" }));
    await actionRepository.upsert(
      buildDeployAction({
        actionId: "act_d2",
        requestedAt: "2026-04-21T11:50:00.000Z",
      }),
    );

    const result = await runManagementWorker({
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy({
        maxNewDeploysPerHour: 2,
      }),
      managementPolicy: buildManagementPolicy({
        claimFeesThresholdUsd: 999,
        maxOutOfRangeMinutes: 0,
      }),
      signalProvider: () => ({
        forcedManualClose: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        severeNegativeYield: false,
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: true,
        dataIncomplete: false,
      }),
      rebalancePlanner: () => ({
        reason: "range invalid and improvement expected",
        redeploy: {
          poolAddress: "pool_new",
          tokenXMint: "mint_x",
          tokenYMint: "mint_y",
          baseMint: "mint_base",
          quoteMint: "mint_quote",
          amountBase: 1,
          amountQuote: 0.5,
          strategy: "bid_ask",
          rangeLowerBin: 25,
          rangeUpperBin: 35,
          initialActiveBin: 30,
          estimatedValueUsd: 20,
        },
      }),
      journalRepository,
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.positionResults[0]?.managementAction).toBe("REBALANCE");
    expect(result.positionResults[0]?.status).toBe("DISPATCHED");

    const actions = await actionRepository.list();
    expect(actions.some((action) => action.type === "REBALANCE")).toBe(true);
    expect(result.portfolioState?.circuitBreakerState).toBe("OFF");
  });

  it("skips unsupported management actions like CLAIM_FEES without enqueueing work", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(buildPosition());

    const result = await runManagementWorker({
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      managementPolicy: buildManagementPolicy({
        claimFeesThresholdUsd: 10,
      }),
      signalProvider: () => ({
        forcedManualClose: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        severeNegativeYield: false,
        claimableFeesUsd: 25,
        expectedRebalanceImprovement: false,
        dataIncomplete: false,
      }),
      journalRepository,
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.positionResults[0]?.managementAction).toBe("CLAIM_FEES");
    expect(result.positionResults[0]?.status).toBe("SKIPPED_UNSUPPORTED");

    await expect(actionRepository.list()).resolves.toHaveLength(0);
  });
});
