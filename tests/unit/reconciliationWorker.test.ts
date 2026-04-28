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

  it("does not mutate local positions when a wallet snapshot belongs to another wallet", async () => {
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
    await stateRepository.upsert(buildOpenPosition("pos_wrong_wallet_snapshot"));

    const result = await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        listPositionsForWallet: {
          type: "success",
          value: {
            wallet: "wallet_other",
            positions: [],
          },
        },
      }),
      journalRepository,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    const persistedPosition = await stateRepository.get(
      "pos_wrong_wallet_snapshot",
    );
    expect(persistedPosition?.status).toBe("OPEN");
    expect(result.records).toEqual([
      expect.objectContaining({
        scope: "POSITION",
        entityId: "wallet_001",
        wallet: "wallet_001",
        outcome: "MANUAL_REVIEW_REQUIRED",
        detail: expect.stringMatching(/requested wallet wallet_001/i),
      }),
    ]);
    await expect(journalRepository.list()).resolves.toEqual([]);
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
    expect(persistedPosition?.feesClaimedUsd).toBe(0);
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

  it("RECONCILIATION_REQUIRED + live snapshot OPEN -> local OPEN", async () => {
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
    const localPosition: Position = {
      ...buildOpenPosition("pos_self_heal"),
      status: "RECONCILIATION_REQUIRED",
      needsReconciliation: true,
      lastWriteActionId: "act_ambiguous",
    };
    const liveSnapshot: Position = {
      ...buildOpenPosition("pos_self_heal"),
      currentValueUsd: 95,
      unrealizedPnlUsd: -5,
      lastSyncedAt: "2026-04-20T00:10:00.000Z",
    };
    await stateRepository.upsert(localPosition);

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

    const persistedPosition = await stateRepository.get("pos_self_heal");
    const journal = await journalRepository.list();

    expect(persistedPosition?.status).toBe("OPEN");
    expect(persistedPosition?.needsReconciliation).toBe(false);
    expect(persistedPosition?.currentValueUsd).toBe(95);
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "POSITION",
          entityId: "pos_self_heal",
          outcome: "RECONCILED_OK",
          detail:
            "Local reconciliation-required position restored from live DLMM snapshot",
        }),
      ]),
    );
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "POSITION_RECONCILED_FROM_LIVE_SNAPSHOT",
          resultStatus: "OPEN",
        }),
      ]),
    );
  });

  it("uses positionLock while reconciling live wallet snapshots", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    await stateRepository.upsert(buildOpenPosition("pos_lock_sync"));

    const lockedPositionIds: string[] = [];
    const positionLock = {
      withLock: async <T>(positionId: string, work: () => Promise<T>) => {
        lockedPositionIds.push(positionId);
        return work();
      },
    };

    await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        listPositionsForWallet: {
          type: "success",
          value: {
            wallet: "wallet_001",
            positions: [
              {
                ...buildOpenPosition("pos_lock_sync"),
                currentValueUsd: 110,
              },
            ],
          },
        },
      }),
      positionLock: positionLock as never,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    expect(lockedPositionIds).toContain("pos_lock_sync");
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
        allowRiskGuardBypass: true,
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

  it("REBALANCE action RECONCILING + new live OPEN -> resume/finalize, not FAILED", async () => {
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
    await stateRepository.upsert(buildOpenPosition("pos_old_reconciling"));

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old_reconciling",
      payload: rebalancePayload,
      requestedBy: "system",
        allowRiskGuardBypass: true,
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_old_reconciling",
              txIds: ["tx_rebalance_reconcile"],
            },
          },
        }),
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const persistedWaitingAction = await actionRepository.get(action.actionId);

    await actionRepository.upsert({
      ...persistedWaitingAction!,
      status: "RECONCILING",
      completedAt: null,
      resultPayload: {
        phase: "REDEPLOY_SUBMITTED",
        closeResult: {
          actionType: "CLOSE",
          closedPositionId: "pos_old_reconciling",
          txIds: ["tx_rebalance_reconcile"],
          submissionStatus: "submitted",
          releasedAmountBase: 0.8,
          releasedAmountQuote: 0.4,
          estimatedReleasedValueUsd: 80,
          releasedAmountSource: "post_tx",
        },
        closeAccounting: {
          releasedAmountBase: 0.8,
          releasedAmountQuote: 0.4,
          estimatedReleasedValueUsd: 80,
          releasedAmountSource: "post_tx",
          sourceConfidence: "post_tx",
        },
        closedPositionId: "pos_old_reconciling",
        availableCapitalUsd: 80,
        performanceSnapshot: buildOpenPosition("pos_old_reconciling"),
        redeployResult: {
          actionType: "DEPLOY",
          positionId: "pos_new",
          txIds: ["tx_redeploy_live"],
          submissionStatus: "submitted",
        },
        redeployRequest: rebalancePayload.redeploy,
      },
    });

    await stateRepository.upsert({
      ...buildOpenPosition("pos_old_reconciling"),
      status: "CLOSED",
      closedAt: "2026-04-20T00:05:00.000Z",
      currentValueBase: 0,
      currentValueUsd: 0,
      unrealizedPnlBase: 0,
      unrealizedPnlUsd: 0,
      needsReconciliation: false,
      lastWriteActionId: action.actionId,
    });

    const confirmedNewPosition: Position = {
      ...buildOpenPosition("pos_new"),
      poolAddress: rebalancePayload.redeploy.poolAddress,
      rangeLowerBin: rebalancePayload.redeploy.rangeLowerBin,
      rangeUpperBin: rebalancePayload.redeploy.rangeUpperBin,
      activeBin: rebalancePayload.redeploy.initialActiveBin,
      currentValueUsd: rebalancePayload.redeploy.estimatedValueUsd,
    };

    await stateRepository.upsert({
      ...confirmedNewPosition,
      lastWriteActionId: action.actionId,
    });

    const result = await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: confirmedNewPosition,
        },
        listPositionsForWallet: {
          type: "success",
          value: {
            wallet: "wallet_001",
            positions: [confirmedNewPosition],
          },
        },
      }),
      journalRepository,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedNewPosition = await stateRepository.get("pos_new");

    expect(persistedAction?.status).toBe("DONE");
    expect(persistedAction?.status).not.toBe("FAILED");
    expect(persistedNewPosition?.status).toBe("OPEN");
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "ACTION",
          entityId: action.actionId,
          outcome: "RECONCILED_OK",
          detail:
            "Rebalance reconciling recovery reconstructed a live OPEN redeploy leg and finalized the action",
        }),
      ]),
    );
  });

  it("REBALANCE action RECONCILING + unconfirmed redeploy -> manual review instead of throwing", async () => {
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

    await stateRepository.upsert(buildOpenPosition("pos_old_unconfirmed"));

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old_unconfirmed",
      payload: rebalancePayload,
      requestedBy: "system",
      allowRiskGuardBypass: true,
    });

    await actionRepository.upsert({
      ...action,
      status: "RECONCILING",
      startedAt: action.requestedAt,
      completedAt: null,
      txIds: ["tx_redeploy_unconfirmed"],
      resultPayload: {
        phase: "REDEPLOY_SUBMITTED",
        closeResult: {
          actionType: "CLOSE",
          closedPositionId: "pos_old_unconfirmed",
          txIds: ["tx_close_unconfirmed"],
          submissionStatus: "submitted",
          releasedAmountBase: 0.8,
          releasedAmountQuote: 0.4,
          estimatedReleasedValueUsd: 80,
          releasedAmountSource: "post_tx",
        },
        closeAccounting: {
          releasedAmountBase: 0.8,
          releasedAmountQuote: 0.4,
          estimatedReleasedValueUsd: 80,
          releasedAmountSource: "post_tx",
          sourceConfidence: "post_tx",
        },
        closedPositionId: "pos_old_unconfirmed",
        availableCapitalUsd: 80,
        performanceSnapshot: buildOpenPosition("pos_old_unconfirmed"),
        redeployResult: {
          actionType: "DEPLOY",
          positionId: "pos_new_unconfirmed",
          txIds: ["tx_redeploy_unconfirmed"],
          submissionStatus: "submitted",
        },
        redeployRequest: rebalancePayload.redeploy,
      },
    });

    await stateRepository.upsert({
      ...buildOpenPosition("pos_old_unconfirmed"),
      status: "CLOSED",
      closedAt: "2026-04-20T00:05:00.000Z",
      currentValueBase: 0,
      currentValueUsd: 0,
      unrealizedPnlBase: 0,
      unrealizedPnlUsd: 0,
      needsReconciliation: false,
      lastWriteActionId: action.actionId,
    });
    await stateRepository.upsert({
      ...buildOpenPosition("pos_new_unconfirmed"),
      poolAddress: rebalancePayload.redeploy.poolAddress,
      status: "REDEPLOYING",
      rangeLowerBin: rebalancePayload.redeploy.rangeLowerBin,
      rangeUpperBin: rebalancePayload.redeploy.rangeUpperBin,
      activeBin: rebalancePayload.redeploy.initialActiveBin,
      currentValueUsd: rebalancePayload.redeploy.estimatedValueUsd,
      lastWriteActionId: action.actionId,
    });

    const result = await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: { type: "success", value: null },
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
    const persistedNewPosition = await stateRepository.get(
      "pos_new_unconfirmed",
    );

    expect(persistedAction?.status).toBe("FAILED");
    expect(persistedAction?.error).toMatch(/manual reconciliation required/i);
    expect(persistedNewPosition?.status).toBe("RECONCILIATION_REQUIRED");
    expect(persistedNewPosition?.needsReconciliation).toBe(true);
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "ACTION",
          entityId: action.actionId,
          outcome: "MANUAL_REVIEW_REQUIRED",
          detail:
            "Rebalance reconciling recovery could not confirm redeploy; action downgraded for manual reconciliation",
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

  it("keeps reconciliation outcome RECONCILED_OK when reconstructed rebalance journal fails", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
    });
    await stateRepository.upsert(buildOpenPosition("pos_old_reconciling_warn"));

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_old_reconciling_warn",
      payload: rebalancePayload,
      requestedBy: "system",
      allowRiskGuardBypass: true,
    });

    await actionRepository.upsert({
      ...action,
      status: "RECONCILING",
      startedAt: action.requestedAt,
      completedAt: null,
      txIds: ["tx_redeploy_live"],
      resultPayload: {
        phase: "REDEPLOY_SUBMITTED",
        closeResult: {
          actionType: "CLOSE",
          closedPositionId: "pos_old_reconciling_warn",
          txIds: ["tx_rebalance_reconcile"],
          submissionStatus: "submitted",
          releasedAmountBase: 0.8,
          releasedAmountQuote: 0.4,
          estimatedReleasedValueUsd: 80,
          releasedAmountSource: "post_tx",
        },
        closeAccounting: {
          releasedAmountBase: 0.8,
          releasedAmountQuote: 0.4,
          estimatedReleasedValueUsd: 80,
          releasedAmountSource: "post_tx",
          sourceConfidence: "post_tx",
        },
        closedPositionId: "pos_old_reconciling_warn",
        availableCapitalUsd: 80,
        performanceSnapshot: buildOpenPosition("pos_old_reconciling_warn"),
        redeployResult: {
          actionType: "DEPLOY",
          positionId: "pos_new_warn",
          txIds: ["tx_redeploy_live"],
          submissionStatus: "submitted",
        },
        redeployRequest: rebalancePayload.redeploy,
      },
    });

    await stateRepository.upsert({
      ...buildOpenPosition("pos_old_reconciling_warn"),
      status: "CLOSED",
      closedAt: "2026-04-20T00:05:00.000Z",
      currentValueBase: 0,
      currentValueUsd: 0,
      unrealizedPnlBase: 0,
      unrealizedPnlUsd: 0,
      needsReconciliation: false,
      lastWriteActionId: action.actionId,
    });

    const confirmedNewPosition: Position = {
      ...buildOpenPosition("pos_new_warn"),
      poolAddress: rebalancePayload.redeploy.poolAddress,
      rangeLowerBin: rebalancePayload.redeploy.rangeLowerBin,
      rangeUpperBin: rebalancePayload.redeploy.rangeUpperBin,
      activeBin: rebalancePayload.redeploy.initialActiveBin,
      currentValueUsd: rebalancePayload.redeploy.estimatedValueUsd,
    };

    const failingJournal = {
      async append(event: { eventType: string }) {
        if (event.eventType === "REBALANCE_FINALIZED_RECONSTRUCTED") {
          throw new Error("journal unavailable");
        }
      },
    } as unknown as JournalRepository;

    const result = await runReconciliationWorker({
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: confirmedNewPosition,
        },
        listPositionsForWallet: {
          type: "success",
          value: {
            wallet: "wallet_001",
            positions: [confirmedNewPosition],
          },
        },
      }),
      journalRepository: failingJournal,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    expect((await actionRepository.get(action.actionId))?.status).toBe("DONE");
    expect((await stateRepository.get("pos_new_warn"))?.status).toBe("OPEN");
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
});
