import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { MockNotifierGateway } from "../../src/adapters/telegram/NotifierGateway.js";
import { runReportingWorker } from "../../src/app/workers/reportingWorker.js";
import { type Action } from "../../src/domain/entities/Action.js";
import { type Position } from "../../src/domain/entities/Position.js";
import { FileSchedulerMetadataStore } from "../../src/infra/scheduler/SchedulerMetadataStore.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v2-reporting-"));
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

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
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
});
