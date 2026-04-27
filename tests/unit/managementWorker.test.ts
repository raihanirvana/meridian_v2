import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockDlmmGateway } from "../../src/adapters/dlmm/DlmmGateway.js";
import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { FilePoolMemoryRepository } from "../../src/adapters/storage/PoolMemoryRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { runManagementWorker } from "../../src/app/workers/managementWorker.js";
import { type Action } from "../../src/domain/entities/Action.js";
import { type Position } from "../../src/domain/entities/Position.js";
import type { RebalanceReviewInput } from "../../src/domain/entities/RebalanceDecision.js";
import { type ManagementPolicy } from "../../src/domain/rules/managementRules.js";
import { type PortfolioRiskPolicy } from "../../src/domain/rules/riskRules.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-mgmt-"),
  );
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

function buildClaimFeesAction(overrides: Partial<Action> = {}): Action {
  return {
    actionId: "act_claim",
    type: "CLAIM_FEES",
    status: "QUEUED",
    wallet: "wallet_001",
    positionId: "pos_001",
    idempotencyKey: "wallet_001:CLAIM_FEES:pos_001:seed",
    requestPayload: {
      reason: "seed claim",
    },
    resultPayload: null,
    txIds: [],
    error: null,
    requestedAt: "2026-04-21T11:55:00.000Z",
    startedAt: null,
    completedAt: null,
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
    trailingTakeProfitEnabled: false,
    trailingTriggerPct: 3,
    trailingDropPct: 1.5,
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
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
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

  it("blocks management CLOSE enqueue when the position already has a pending write action", async () => {
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
    await actionRepository.upsert(buildClaimFeesAction());

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

    expect(result.positionResults[0]?.managementAction).toBe("CLOSE");
    expect(result.positionResults[0]?.status).toBe("BLOCKED_BY_RISK");
    expect(result.positionResults[0]?.actionId).toBeNull();

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("CLAIM_FEES");

    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("MANAGEMENT_CLOSE_SKIPPED_PENDING_ACTION");
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

  it("records pool snapshots during management cycles when enabled", async () => {
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
    const poolMemoryRepository = new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(
      buildPosition({
        unrealizedPnlUsd: 12,
        currentValueUsd: 112,
        activeBin: 25,
        outOfRangeSince: "2026-04-21T11:30:00.000Z",
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
      riskPolicy: buildRiskPolicy(),
      managementPolicy: buildManagementPolicy(),
      signalProvider: () => ({
        forcedManualClose: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        severeNegativeYield: false,
        claimableFeesUsd: 3.5,
        expectedRebalanceImprovement: false,
        dataIncomplete: false,
      }),
      journalRepository,
      poolMemoryRepository,
      poolMemorySnapshotsEnabled: true,
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.positionResults[0]?.status).toBe("NO_ACTION");

    const poolEntry = await poolMemoryRepository.get("pool_001");
    expect(poolEntry?.snapshots).toHaveLength(1);
    expect(poolEntry?.snapshots[0]).toMatchObject({
      ts: "2026-04-21T12:00:00.000Z",
      positionId: "pos_001",
      pnlUsd: 12,
      unclaimedFeesUsd: 3.5,
      inRange: false,
      minutesOutOfRange: 30,
      ageMinutes: 720,
    });
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("POOL_MEMORY_UPDATED");
  });

  it("dispatches CLAIM_FEES when management engine requests fee claiming", async () => {
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
      claimConfig: {
        autoSwapAfterClaim: false,
        swapOutputMint: "So11111111111111111111111111111111111111112",
        autoCompoundFees: false,
        compoundToSide: "quote",
      },
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
    expect(result.positionResults[0]?.status).toBe("DISPATCHED");

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("CLAIM_FEES");
  });

  it("blocks management CLAIM_FEES enqueue when the position already has a pending write action", async () => {
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
    await actionRepository.upsert(buildClaimFeesAction());

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
      claimConfig: {
        autoSwapAfterClaim: false,
        swapOutputMint: "So11111111111111111111111111111111111111112",
        autoCompoundFees: false,
        compoundToSide: "quote",
      },
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
    expect(result.positionResults[0]?.status).toBe("BLOCKED_BY_RISK");
    expect(result.positionResults[0]?.actionId).toBeNull();

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("CLAIM_FEES");

    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("MANAGEMENT_CLAIM_SKIPPED_PENDING_ACTION");
  });

  it("continues evaluating management actions when pool memory snapshot recording fails", async () => {
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
      journalRepository,
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
      poolMemorySnapshotsEnabled: true,
      poolMemoryRepository: {
        async get() {
          return null;
        },
        async upsert() {
          throw new Error("pool memory unavailable");
        },
        async listAll() {
          return [];
        },
        async addNote() {
          throw new Error("unused");
        },
        async setCooldown() {
          throw new Error("unused");
        },
      },
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.positionResults[0]?.managementAction).toBe("CLOSE");
    expect(result.positionResults[0]?.status).toBe("DISPATCHED");
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("POOL_MEMORY_SNAPSHOT_FAILED");
  });

  it("persists peak pnl state and later closes on trailing retrace", async () => {
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
        lastSyncedAt: "2026-04-21T12:00:00.000Z",
        currentValueUsd: 110,
        unrealizedPnlUsd: 10,
      }),
    );

    await runManagementWorker({
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
        trailingTakeProfitEnabled: true,
        trailingTriggerPct: 8,
        trailingDropPct: 2,
        claimFeesThresholdUsd: 999,
      }),
      signalProvider: () => ({
        forcedManualClose: false,
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

    const persistedPeak = await stateRepository.get("pos_001");
    expect(persistedPeak?.peakPnlPct).toBe(10);

    await stateRepository.upsert({
      ...buildPosition({
        lastSyncedAt: "2026-04-21T12:05:00.000Z",
        currentValueUsd: 107,
        unrealizedPnlUsd: 7,
      }),
      peakPnlPct: persistedPeak?.peakPnlPct ?? null,
      peakPnlRecordedAt: persistedPeak?.peakPnlRecordedAt ?? null,
    });

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
            asOf: "2026-04-21T12:05:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:05:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      managementPolicy: buildManagementPolicy({
        trailingTakeProfitEnabled: true,
        trailingTriggerPct: 8,
        trailingDropPct: 2,
        claimFeesThresholdUsd: 999,
      }),
      signalProvider: () => ({
        forcedManualClose: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        severeNegativeYield: false,
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        dataIncomplete: false,
      }),
      journalRepository,
      now: () => "2026-04-21T12:05:00.000Z",
    });

    expect(result.positionResults[0]?.managementAction).toBe("CLOSE");
    expect(result.positionResults[0]?.status).toBe("DISPATCHED");
  });

  it("does not refresh peak or trigger trailing take profit from stale snapshot data", async () => {
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
        lastSyncedAt: "2026-04-21T11:30:00.000Z",
        currentValueUsd: 103,
        unrealizedPnlUsd: 3,
        peakPnlPct: 10,
        peakPnlRecordedAt: "2026-04-21T11:00:00.000Z",
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
            asOf: "2026-04-21T12:05:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:05:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      managementPolicy: buildManagementPolicy({
        trailingTakeProfitEnabled: true,
        trailingTriggerPct: 8,
        trailingDropPct: 2,
        claimFeesThresholdUsd: 999,
        rebalanceEnabled: false,
      }),
      signalProvider: () => ({
        forcedManualClose: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        severeNegativeYield: false,
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        dataIncomplete: false,
      }),
      journalRepository,
      now: () => "2026-04-21T12:05:00.000Z",
    });

    expect(result.positionResults[0]?.managementAction).toBe("HOLD");
    expect(result.positionResults[0]?.status).toBe("NO_ACTION");

    const persisted = await stateRepository.get("pos_001");
    expect(persisted?.peakPnlPct).toBe(10);
    expect(persisted?.peakPnlRecordedAt).toBe("2026-04-21T11:00:00.000Z");

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(0);
  });

  it("falls back to RECONCILE_ONLY for one position when signal provider fails and continues the cycle", async () => {
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

    await stateRepository.upsert(buildPosition({ positionId: "pos_001" }));
    await stateRepository.upsert(
      buildPosition({
        positionId: "pos_002",
        activeBin: 30,
        outOfRangeSince: "2026-04-21T06:00:00.000Z",
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
      riskPolicy: buildRiskPolicy(),
      managementPolicy: buildManagementPolicy({
        claimFeesThresholdUsd: 999,
        maxOutOfRangeMinutes: 0,
      }),
      signalProvider: ({ position }) => {
        if (position.positionId === "pos_001") {
          throw new Error("signals unavailable");
        }

        return {
          forcedManualClose: false,
          severeTokenRisk: false,
          liquidityCollapse: false,
          severeNegativeYield: false,
          claimableFeesUsd: 0,
          expectedRebalanceImprovement: true,
          dataIncomplete: false,
        };
      },
      rebalancePlanner: () => ({
        reason: "rebalance",
        redeploy: {
          poolAddress: "pool_002_new",
          tokenXMint: "mint_base",
          tokenYMint: "mint_quote",
          strategy: "bid_ask",
          baseMint: "mint_base",
          quoteMint: "mint_quote",
          amountBase: 1,
          amountQuote: 0.5,
          rangeLowerBin: 8,
          rangeUpperBin: 22,
          initialActiveBin: 15,
          estimatedValueUsd: 25,
        },
      }),
      journalRepository,
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.positionResults).toHaveLength(2);
    expect(result.positionResults[0]?.positionId).toBe("pos_001");
    expect(result.positionResults[0]?.managementAction).toBe("RECONCILE_ONLY");
    expect(result.positionResults[0]?.status).toBe("RECONCILE_ONLY");
    expect(result.positionResults[1]?.positionId).toBe("pos_002");
    expect(result.positionResults[1]?.managementAction).toBe("REBALANCE");
    expect(result.positionResults[1]?.status).toBe("DISPATCHED");

    const events = await journalRepository.list();
    expect(events.map((event) => event.eventType)).toContain(
      "MANAGEMENT_SIGNAL_PROVIDER_FAILED",
    );

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("REBALANCE");
  });

  it("builds AI rebalance review from entry pool metadata and fresh pool info", async () => {
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
    let capturedReview: RebalanceReviewInput | null = null;

    await stateRepository.upsert(
      buildPosition({
        activeBin: 30,
        rangeLowerBin: 10,
        rangeUpperBin: 20,
        outOfRangeSince: "2026-04-21T11:50:00.000Z",
        entryMetadata: {
          poolName: "TOKEN/SOL",
          binStep: 80,
          activeBinAtEntry: 15,
          poolTvlUsd: 180_000,
          volume5mUsd: 12_000,
          volume15mUsd: 52_000,
          volume1hUsd: 210_000,
          volume24hUsd: 950_000,
          fees15mUsd: 260,
          fees1hUsd: 1_100,
          feeTvlRatio24h: 0.018,
          priceChange5mPct: 1.1,
          priceChange15mPct: 2.4,
          priceChange1hPct: 4.8,
          volatility15mPct: 0.032,
          liquidityDepthNearActive: "medium",
          trendDirection: "up",
          trendStrength: "medium",
          meanReversionSignal: "weak",
        },
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
      dlmmGateway: new MockDlmmGateway({
        getPosition: { type: "success", value: null },
        deployLiquidity: {
          type: "success",
          value: { actionType: "DEPLOY", positionId: "pos_new", txIds: [] },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "pos_001",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 0,
            txIds: [],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "pos_001",
            remainingPercentage: 50,
            txIds: [],
          },
        },
        listPositionsForWallet: {
          type: "success",
          value: { wallet: "wallet_001", positions: [] },
        },
        getPoolInfo: {
          type: "success",
          value: {
            poolAddress: "pool_001",
            pairLabel: "TOKEN/SOL",
            binStep: 80,
            activeBin: 33,
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      managementPolicy: buildManagementPolicy({
        aiRebalanceEnabled: true,
        aiRebalanceMode: "dry_run",
        claimFeesThresholdUsd: 999,
        maxOutOfRangeMinutes: 0,
      }),
      signalProvider: () => ({
        forcedManualClose: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        severeNegativeYield: false,
        claimableFeesUsd: 0.42,
        expectedRebalanceImprovement: true,
        dataIncomplete: false,
      }),
      aiRebalancePlanner: {
        async reviewRebalanceDecision(review) {
          capturedReview = review;
          return {
            action: "rebalance_same_pool",
            confidence: 0.9,
            riskLevel: "medium",
            reason: ["healthy pool"],
            rebalancePlan: {
              strategy: "spot",
              binsBelow: 20,
              binsAbove: 20,
              slippageBps: 100,
              maxPositionAgeMinutes: 30,
              stopLossPct: 1,
              takeProfitPct: 2,
              trailingStopPct: 0.5,
            },
            rejectIf: [],
          };
        },
      },
      lessonPromptService: {
        async buildLessonsPrompt() {
          return null;
        },
      },
      journalRepository,
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.positionResults[0]?.status).toBe("DRY_RUN");
    expect(capturedReview).not.toBeNull();
    const review = capturedReview as unknown as RebalanceReviewInput;
    expect(review.position.activeBinAtEntry).toBe(15);
    expect(review.position.currentActiveBin).toBe(30);
    expect(review.pool.currentActiveBin).toBe(33);
    expect(review.pool.tvlUsd).toBe(180_000);
    expect(review.pool.volume24hUsd).toBe(950_000);
    expect(review.pool.fees1hUsd).toBe(1_100);
  });

  it("blocks constrained AI rebalance when redeploy simulation fails", async () => {
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
        rangeLowerBin: 10,
        rangeUpperBin: 20,
        outOfRangeSince: "2026-04-21T11:50:00.000Z",
        currentValueUsd: 120,
        entryMetadata: {
          binStep: 80,
          activeBinAtEntry: 15,
          poolTvlUsd: 180_000,
          liquidityDepthNearActive: "medium",
        },
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
      dlmmGateway: new MockDlmmGateway({
        getPosition: { type: "success", value: null },
        deployLiquidity: {
          type: "success",
          value: { actionType: "DEPLOY", positionId: "pos_new", txIds: [] },
        },
        simulateDeployLiquidity: {
          type: "success",
          value: { ok: false, reason: "redeploy simulation failed" },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "pos_001",
            txIds: [],
          },
        },
        simulateClosePosition: {
          type: "success",
          value: { ok: true, reason: null },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 0,
            txIds: [],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "pos_001",
            remainingPercentage: 50,
            txIds: [],
          },
        },
        listPositionsForWallet: {
          type: "success",
          value: { wallet: "wallet_001", positions: [] },
        },
        getPoolInfo: {
          type: "success",
          value: {
            poolAddress: "pool_001",
            pairLabel: "TOKEN/SOL",
            binStep: 80,
            activeBin: 30,
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      managementPolicy: buildManagementPolicy({
        aiRebalanceEnabled: true,
        aiRebalanceMode: "constrained_action",
        claimFeesThresholdUsd: 999,
        maxOutOfRangeMinutes: 0,
        minRebalancePoolTvlUsd: 100_000,
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
      aiRebalancePlanner: {
        async reviewRebalanceDecision() {
          return {
            action: "rebalance_same_pool",
            confidence: 0.9,
            riskLevel: "medium",
            reason: ["healthy pool"],
            rebalancePlan: {
              strategy: "spot",
              binsBelow: 20,
              binsAbove: 20,
              slippageBps: 100,
              maxPositionAgeMinutes: 30,
              stopLossPct: 1,
              takeProfitPct: 2,
              trailingStopPct: 0.5,
            },
            rejectIf: [],
          };
        },
      },
      rebalancePlanner: () => ({
        reason: "ai same-pool rebalance",
        redeploy: {
          poolAddress: "pool_001",
          tokenXMint: "mint_x",
          tokenYMint: "mint_y",
          baseMint: "mint_base",
          quoteMint: "mint_quote",
          amountBase: 1,
          amountQuote: 0.5,
          strategy: "spot",
          rangeLowerBin: 10,
          rangeUpperBin: 50,
          initialActiveBin: 30,
          estimatedValueUsd: 120,
        },
      }),
      lessonPromptService: {
        async buildLessonsPrompt() {
          return null;
        },
      },
      journalRepository,
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.positionResults[0]?.status).toBe("BLOCKED_BY_RISK");
    expect(result.positionResults[0]?.triggerReasons).toContain(
      "rebalance_redeploy_simulation_failed",
    );
    await expect(actionRepository.list()).resolves.toHaveLength(0);
    const events = await journalRepository.list();
    expect(events.map((event) => event.eventType)).toContain(
      "REBALANCE_PREFLIGHT_SIMULATED",
    );
  });
});
