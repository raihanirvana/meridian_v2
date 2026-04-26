import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { FilePerformanceRepository } from "../../src/adapters/storage/PerformanceRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { MockNotifierGateway } from "../../src/adapters/telegram/NotifierGateway.js";
import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { runReportingWorker } from "../../src/app/workers/reportingWorker.js";
import { type Action } from "../../src/domain/entities/Action.js";
import { type PerformanceRecord } from "../../src/domain/entities/PerformanceRecord.js";
import { type Position } from "../../src/domain/entities/Position.js";
import { FileSchedulerMetadataStore } from "../../src/infra/scheduler/SchedulerMetadataStore.js";
import type { NotifierGateway } from "../../src/adapters/telegram/NotifierGateway.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-reporting-"),
  );
  tempDirs.push(directory);
  return directory;
}

function buildReconPosition(): Position {
  return {
    positionId: "pos_recon",
    poolAddress: "pool_recon",
    tokenXMint: "mint_x",
    tokenYMint: "mint_y",
    baseMint: "mint_x",
    quoteMint: "mint_y",
    wallet: "wallet_001",
    status: "RECONCILIATION_REQUIRED",
    openedAt: "2026-04-22T08:00:00.000Z",
    lastSyncedAt: "2026-04-22T08:00:00.000Z",
    closedAt: null,
    deployAmountBase: 1,
    deployAmountQuote: 1,
    currentValueBase: 1,
    currentValueUsd: 100,
    feesClaimedBase: 0,
    feesClaimedUsd: 0,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: -0.1,
    unrealizedPnlUsd: -5,
    rebalanceCount: 0,
    partialCloseCount: 0,
    strategy: "bid_ask",
    rangeLowerBin: 10,
    rangeUpperBin: 20,
    activeBin: 5,
    outOfRangeSince: "2026-04-22T09:00:00.000Z",
    lastManagementDecision: null,
    lastManagementReason: null,
    lastWriteActionId: null,
    needsReconciliation: true,
  };
}

function buildStuckAction(): Action {
  return {
    actionId: "act_stuck",
    type: "CLOSE",
    status: "WAITING_CONFIRMATION",
    wallet: "wallet_001",
    positionId: "pos_recon",
    idempotencyKey: "wallet_001:close:act_stuck",
    requestPayload: {
      reason: "stop_loss",
    },
    resultPayload: null,
    txIds: ["tx_001"],
    error: null,
    requestedAt: "2026-04-22T08:00:00.000Z",
    startedAt: "2026-04-22T08:05:00.000Z",
    completedAt: null,
    requestedBy: "system",
  };
}

function buildPerformanceRecord(
  overrides: Partial<PerformanceRecord> = {},
): PerformanceRecord {
  return {
    positionId: "pos_profit",
    wallet: "wallet_001",
    pool: "pool_profit",
    poolName: "SOL-USDC",
    baseMint: "mint_sol",
    strategy: "bid_ask",
    binStep: 100,
    binRangeLower: 10,
    binRangeUpper: 20,
    volatility: 12,
    feeTvlRatio: 0.2,
    organicScore: 80,
    amountSol: 1,
    initialValueUsd: 100,
    finalValueUsd: 125,
    feesEarnedUsd: 5,
    pnlUsd: 25,
    pnlPct: 25,
    rangeEfficiencyPct: 80,
    minutesHeld: 120,
    minutesInRange: 100,
    closeReason: "take_profit",
    deployedAt: "2026-04-22T01:00:00.000Z",
    closedAt: "2026-04-22T03:00:00.000Z",
    recordedAt: "2026-04-22T03:00:00.000Z",
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

describe("reporting worker", () => {
  it("generates alerts for stuck actions and pending reconciliation", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    await stateRepository.upsert(buildReconPosition());
    await actionRepository.upsert(buildStuckAction());

    const notifierGateway = new MockNotifierGateway({
      sendMessage: {
        type: "success",
        value: {
          delivered: true,
          channel: "telegram",
          recipient: "chat_001",
        },
      },
      sendAlert: {
        type: "success",
        value: {
          delivered: true,
          channel: "telegram",
          recipient: "chat_001",
        },
      },
    });

    const result = await runReportingWorker({
      wallet: "wallet_001",
      stateRepository,
      actionRepository,
      notifierGateway,
      alertRecipient: "chat_001",
      now: () => "2026-04-22T09:00:00.000Z",
    });

    expect(result.skippedBecauseAlreadyRunning).toBe(false);
    expect(result.report.health).toBe("UNSAFE");
    expect(result.report.alerts.map((alert) => alert.kind).sort()).toEqual([
      "PENDING_RECONCILIATION",
      "STUCK_ACTION",
    ]);
    expect(result.deliveredAlerts).toHaveLength(2);
  });

  it("shares scheduler metadata and skips duplicate manual fire while already running", async () => {
    const directory = await makeTempDir();
    const schedulerMetadataStore = new FileSchedulerMetadataStore({
      filePath: path.join(directory, "scheduler.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });

    await schedulerMetadataStore.tryStartRun({
      worker: "reporting",
      triggerSource: "manual",
      startedAt: "2026-04-22T10:00:00.000Z",
      intervalSec: 300,
    });

    const result = await runReportingWorker({
      wallet: "wallet_001",
      stateRepository,
      actionRepository,
      schedulerMetadataStore,
      triggerSource: "manual",
      intervalSec: 300,
      now: () => "2026-04-22T10:00:01.000Z",
    });

    expect(result.skippedBecauseAlreadyRunning).toBe(true);
    const workerState = await schedulerMetadataStore.get("reporting");
    expect(workerState.status).toBe("RUNNING");
    expect(workerState.manualRunCount).toBe(1);
  });

  it("emits a daily profit target alert and SOL display data when the target is reached", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const performanceRepository = new FilePerformanceRepository({
      filePath: path.join(directory, "lessons.json"),
    });
    await performanceRepository.append(buildPerformanceRecord());

    const result = await runReportingWorker({
      wallet: "wallet_001",
      stateRepository,
      actionRepository,
      performanceRepository,
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 50,
            asOf: "2026-04-22T09:00:00.000Z",
          },
        },
      }),
      dailyProfitTargetSol: 0.4,
      solMode: true,
      now: () => "2026-04-22T09:00:00.000Z",
    });

    expect(result.report.displayMode).toBe("SOL");
    expect(result.report.dailyPnlSol).toBe(0.5);
    expect(result.report.dailyProfitTargetReached).toBe(true);
    expect(result.report.alerts.map((alert) => alert.kind)).toContain(
      "DAILY_PROFIT_TARGET",
    );
  });

  it("degrades reporting when SOL price is unavailable", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const performanceRepository = new FilePerformanceRepository({
      filePath: path.join(directory, "lessons.json"),
    });
    await performanceRepository.append(buildPerformanceRecord());

    const result = await runReportingWorker({
      wallet: "wallet_001",
      stateRepository,
      actionRepository,
      performanceRepository,
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "fail",
          error: new Error("price api unavailable"),
        },
      }),
      dailyProfitTargetSol: 0.4,
      solMode: true,
      now: () => "2026-04-22T09:00:00.000Z",
    });

    expect(result.report.solPriceUsd).toBeNull();
    expect(result.report.dailyPnlUsd).toBe(25);
    expect(result.report.dailyPnlSol).toBeNull();
    expect(result.report.dailyProfitTargetReached).toBe(false);
    expect(result.report.alerts.map((alert) => alert.kind)).toContain(
      "PRICE_UNAVAILABLE",
    );
    expect(result.report.issues).toContain(
      "PRICE_UNAVAILABLE: SOL price unavailable",
    );
  });

  it("continues delivering later alerts when one notification fails", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    await stateRepository.upsert(buildReconPosition());
    await actionRepository.upsert(buildStuckAction());

    let attempts = 0;
    const notifierGateway: NotifierGateway = {
      async sendMessage() {
        throw new Error("unused");
      },
      async sendAlert(input) {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("telegram unavailable");
        }
        return {
          delivered: true,
          channel: "telegram",
          recipient: input.recipient,
        };
      },
    };

    const result = await runReportingWorker({
      wallet: "wallet_001",
      stateRepository,
      actionRepository,
      notifierGateway,
      alertRecipient: "chat_001",
      now: () => "2026-04-22T09:00:00.000Z",
    });

    expect(result.report.alerts).toHaveLength(2);
    expect(result.deliveredAlerts).toHaveLength(1);
    expect(attempts).toBe(2);
  });
});
