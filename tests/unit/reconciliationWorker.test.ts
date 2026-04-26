import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MockDlmmGateway,
  type MockDlmmGatewayBehaviors,
} from "../../src/adapters/dlmm/DlmmGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { runReconciliationWorker } from "../../src/app/workers/reconciliationWorker.js";
import { processDeployAction } from "../../src/app/usecases/processDeployAction.js";
import {
  requestDeploy,
  type DeployActionRequestPayload,
} from "../../src/app/usecases/requestDeploy.js";
import { processCloseAction } from "../../src/app/usecases/processCloseAction.js";
import { requestClose } from "../../src/app/usecases/requestClose.js";
import { processRebalanceAction } from "../../src/app/usecases/processRebalanceAction.js";
import {
  requestRebalance,
  type RebalanceActionRequestPayload,
} from "../../src/app/usecases/requestRebalance.js";
import { type Position } from "../../src/domain/entities/Position.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-reconcile-"),
  );
  tempDirs.push(directory);
  return directory;
}

const deployPayload: DeployActionRequestPayload = {
  poolAddress: "pool_001",
  tokenXMint: "mint_x",
  tokenYMint: "mint_y",
  baseMint: "mint_base",
  quoteMint: "mint_quote",
  amountBase: 1,
  amountQuote: 0.5,
  strategy: "bid_ask",
  rangeLowerBin: 10,
  rangeUpperBin: 20,
  initialActiveBin: 15,
  estimatedValueUsd: 100,
};

const rebalancePayload: RebalanceActionRequestPayload = {
  reason: "range drift",
  redeploy: {
    poolAddress: "pool_002",
    tokenXMint: "mint_x",
    tokenYMint: "mint_y",
    baseMint: "mint_base",
    quoteMint: "mint_quote",
    amountBase: 0.8,
    amountQuote: 0.4,
    strategy: "bid_ask",
    rangeLowerBin: 20,
    rangeUpperBin: 30,
    initialActiveBin: 24,
    estimatedValueUsd: 80,
  },
};

function buildOpenPosition(positionId: string): Position {
  return {
    positionId,
    poolAddress: deployPayload.poolAddress,
    tokenXMint: deployPayload.tokenXMint,
    tokenYMint: deployPayload.tokenYMint,
    baseMint: deployPayload.baseMint,
    quoteMint: deployPayload.quoteMint,
    wallet: "wallet_001",
    status: "OPEN",
    openedAt: "2026-04-20T00:00:00.000Z",
    lastSyncedAt: "2026-04-20T00:00:00.000Z",
    closedAt: null,
    deployAmountBase: deployPayload.amountBase,
    deployAmountQuote: deployPayload.amountQuote,
    currentValueBase: deployPayload.amountBase,
    currentValueUsd: deployPayload.estimatedValueUsd,
    feesClaimedBase: 0,
    feesClaimedUsd: 0,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    rebalanceCount: 0,
    partialCloseCount: 0,
    strategy: deployPayload.strategy,
    rangeLowerBin: deployPayload.rangeLowerBin,
    rangeUpperBin: deployPayload.rangeUpperBin,
    activeBin: deployPayload.initialActiveBin,
    outOfRangeSince: null,
    lastManagementDecision: null,
    lastManagementReason: null,
    lastWriteActionId: null,
    needsReconciliation: false,
  };
}

function buildCloseConfirmedPosition(positionId: string): Position {
  return {
    ...buildOpenPosition(positionId),
    status: "CLOSE_CONFIRMED",
    closedAt: "2026-04-20T00:05:00.000Z",
    currentValueBase: 0.1,
    currentValueUsd: 10,
    realizedPnlBase: 0.2,
    realizedPnlUsd: 20,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    lastSyncedAt: "2026-04-20T00:05:00.000Z",
  };
}

function buildGateway(
  overrides: Partial<MockDlmmGatewayBehaviors>,
): MockDlmmGateway {
  return new MockDlmmGateway({
    getPosition: overrides.getPosition ?? { type: "success", value: null },
    deployLiquidity: overrides.deployLiquidity ?? {
      type: "success",
      value: {
        actionType: "DEPLOY",
        positionId: "unused",
        txIds: ["tx_unused"],
      },
    },
    closePosition: overrides.closePosition ?? {
      type: "success",
      value: {
        actionType: "CLOSE",
        closedPositionId: "unused",
        txIds: ["tx_unused"],
      },
    },
    claimFees: overrides.claimFees ?? {
      type: "success",
      value: {
        actionType: "CLAIM_FEES",
        claimedBaseAmount: 0,
        txIds: ["tx_unused"],
      },
    },
    partialClosePosition: overrides.partialClosePosition ?? {
      type: "success",
      value: {
        actionType: "PARTIAL_CLOSE",
        closedPositionId: "unused",
        remainingPercentage: 50,
        txIds: ["tx_unused"],
      },
    },
    listPositionsForWallet: overrides.listPositionsForWallet ?? {
      type: "success",
      value: {
        wallet: "wallet_001",
        positions: [],
      },
    },
    getPoolInfo: overrides.getPoolInfo ?? {
      type: "success",
      value: {
        poolAddress: "pool_001",
        pairLabel: "SOL-USDC",
        binStep: 100,
        activeBin: 15,
      },
    },
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("reconciliation worker", () => {
  it("marks a missing local snapshot position as RECONCILIATION_REQUIRED instead of CLOSED", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    await stateRepository.upsert(buildOpenPosition("pos_missing"));

    const result = await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        listPositionsForWallet: {
          type: "success",
          value: {
            wallet: "wallet_001",
            positions: [],
          },
        },
      }),
      journalRepository,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    const persistedPosition = await stateRepository.get("pos_missing");

    expect(persistedPosition?.status).toBe("RECONCILIATION_REQUIRED");
    expect(persistedPosition?.needsReconciliation).toBe(true);
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "POSITION",
          entityId: "pos_missing",
          outcome: "REQUIRES_RETRY",
        }),
      ]),
    );
  });

  it("does not write live snapshot sync or missing-position state while dry-run is enabled", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    await stateRepository.upsert(buildOpenPosition("pos_missing_dry"));

    const result = await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        listPositionsForWallet: {
          type: "success",
          value: {
            wallet: "wallet_001",
            positions: [],
          },
        },
      }),
      journalRepository,
      dryRun: true,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    const persistedPosition = await stateRepository.get("pos_missing_dry");
    const journalEvents = await journalRepository.list();

    expect(persistedPosition?.status).toBe("OPEN");
    expect(persistedPosition?.needsReconciliation).toBe(false);
    expect(journalEvents).toHaveLength(0);
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "POSITION",
          entityId: "pos_missing_dry",
          outcome: "REQUIRES_RETRY",
          detail: "Dry-run skipped snapshot reconciliation write",
        }),
      ]),
    );
  });

  it("syncs open local positions from live wallet snapshots before management reads them", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    await stateRepository.upsert(buildOpenPosition("pos_live_sync"));

    const liveSnapshot: Position = {
      ...buildOpenPosition("pos_live_sync"),
      currentValueUsd: 75,
      feesClaimedUsd: 3,
      unrealizedPnlUsd: -25,
      rangeLowerBin: 11,
      rangeUpperBin: 21,
      activeBin: 9,
      outOfRangeSince: "2026-04-20T00:10:00.000Z",
      lastSyncedAt: "2026-04-20T00:10:00.000Z",
    };

    const result = await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        listPositionsForWallet: {
          type: "success",
          value: {
            wallet: "wallet_001",
            positions: [liveSnapshot],
          },
        },
      }),
      journalRepository,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    const persistedPosition = await stateRepository.get("pos_live_sync");

    expect(persistedPosition?.status).toBe("OPEN");
    expect(persistedPosition?.currentValueUsd).toBe(75);
    expect(persistedPosition?.feesClaimedUsd).toBe(3);
    expect(persistedPosition?.unrealizedPnlUsd).toBe(-25);
    expect(persistedPosition?.rangeLowerBin).toBe(11);
    expect(persistedPosition?.rangeUpperBin).toBe(21);
    expect(persistedPosition?.activeBin).toBe(9);
    expect(persistedPosition?.outOfRangeSince).toBe("2026-04-20T00:10:00.000Z");
    expect(persistedPosition?.needsReconciliation).toBe(false);
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "POSITION",
          entityId: "pos_live_sync",
          outcome: "RECONCILED_OK",
          detail: "Local open position synced from live DLMM snapshot",
        }),
      ]),
    );
  });

  it("recovers a deploy action stuck in WAITING_CONFIRMATION into timeout reconciliation state", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });
    const gateway = buildGateway({
      getPosition: { type: "success", value: null },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_pending",
          txIds: ["tx_pending"],
        },
      },
      listPositionsForWallet: {
        type: "success",
        value: {
          wallet: "wallet_001",
          positions: [],
        },
      },
    });

    const action = await requestDeploy({
      actionQueue,
      journalRepository,
      wallet: "wallet_001",
      payload: deployPayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processDeployAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:01:00.000Z",
      }),
    );

    const result = await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get("pos_pending");

    expect(persistedAction?.status).toBe("TIMED_OUT");
    expect(persistedPosition?.status).toBe("RECONCILIATION_REQUIRED");
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "ACTION",
          entityId: action.actionId,
          outcome: "MANUAL_REVIEW_REQUIRED",
        }),
      ]),
    );
  });

  it("recovers startup while close confirmation is still pending and finalizes the close when chain state is ready", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });
    await stateRepository.upsert(buildOpenPosition("pos_close_pending"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_close_pending",
      payload: {
        reason: "startup recovery close",
      },
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_close_pending",
              txIds: ["tx_close_pending"],
            },
          },
        }),
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const recoveryGateway = buildGateway({
      getPosition: {
        type: "success",
        value: buildCloseConfirmedPosition("pos_close_pending"),
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "pos_close_pending",
          txIds: ["tx_close_pending"],
        },
      },
      listPositionsForWallet: {
        type: "success",
        value: {
          wallet: "wallet_001",
          positions: [],
        },
      },
    });

    const result = await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: recoveryGateway,
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get("pos_close_pending");

    expect(persistedAction?.status).toBe("DONE");
    expect(persistedPosition?.status).toBe("CLOSED");
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "ACTION",
          entityId: action.actionId,
          outcome: "RECONCILED_OK",
        }),
      ]),
    );
  });

  it("marks rebalance timeout recovery as MANUAL_REVIEW_REQUIRED because the action is already terminal", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });
    await stateRepository.upsert(buildOpenPosition("pos_rebalance_pending"));

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_rebalance_pending",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_rebalance_pending",
              txIds: ["tx_rebalance_pending"],
            },
          },
        }),
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const result = await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: { type: "success", value: null },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "pos_rebalance_pending",
            txIds: ["tx_rebalance_pending"],
          },
        },
        listPositionsForWallet: {
          type: "success",
          value: {
            wallet: "wallet_001",
            positions: [],
          },
        },
      }),
      journalRepository,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get(
      "pos_rebalance_pending",
    );

    expect(persistedAction?.status).toBe("TIMED_OUT");
    expect(persistedPosition?.status).toBe("RECONCILIATION_REQUIRED");
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "ACTION",
          entityId: action.actionId,
          outcome: "MANUAL_REVIEW_REQUIRED",
        }),
      ]),
    );
  });

  it("skips waiting-confirmation action recovery in dry-run mode", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });
    const gateway = buildGateway({
      getPosition: { type: "success", value: null },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_dry_waiting",
          txIds: ["tx_dry_waiting"],
        },
      },
      listPositionsForWallet: {
        type: "success",
        value: {
          wallet: "wallet_001",
          positions: [],
        },
      },
    });

    const action = await requestDeploy({
      actionQueue,
      journalRepository,
      wallet: "wallet_001",
      payload: deployPayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processDeployAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:01:00.000Z",
      }),
    );

    const result = await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "fail",
          error: new Error("dry-run recovery should not query confirmation"),
        },
        listPositionsForWallet: {
          type: "success",
          value: {
            wallet: "wallet_001",
            positions: [],
          },
        },
      }),
      journalRepository,
      dryRun: true,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    const persistedAction = await actionRepository.get(action.actionId);

    expect(persistedAction?.status).toBe("WAITING_CONFIRMATION");
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "ACTION",
          entityId: action.actionId,
          outcome: "REQUIRES_RETRY",
          detail:
            "Dry-run reconciliation skipped WAITING_CONFIRMATION recovery to prevent live writes",
        }),
      ]),
    );
  });
});
