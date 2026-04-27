import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AmbiguousSubmissionError,
  type ClaimFeesResult,
  type ClosePositionRequest,
  type ClosePositionResult,
  type DeployLiquidityRequest,
  type DeployLiquidityResult,
  type DlmmGateway,
  type PartialClosePositionRequest,
  type PartialClosePositionResult,
  type PoolInfo,
  type WalletPositionsSnapshot,
} from "../../src/adapters/dlmm/DlmmGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { FileRuntimeControlStore } from "../../src/adapters/storage/RuntimeControlStore.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { type LessonHook } from "../../src/app/usecases/finalizeClose.js";
import { finalizeRebalance } from "../../src/app/usecases/finalizeRebalance.js";
import { processRebalanceAction } from "../../src/app/usecases/processRebalanceAction.js";
import {
  RebalanceActionRequestPayloadSchema,
  requestRebalance,
  type RebalanceActionRequestPayload,
} from "../../src/app/usecases/requestRebalance.js";
import { type Position } from "../../src/domain/entities/Position.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-rebalance-"),
  );
  tempDirs.push(directory);
  return directory;
}

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
    poolAddress: "pool_001",
    tokenXMint: "mint_x",
    tokenYMint: "mint_y",
    baseMint: "mint_base",
    quoteMint: "mint_quote",
    wallet: "wallet_001",
    status: "OPEN",
    openedAt: "2026-04-20T00:00:00.000Z",
    lastSyncedAt: "2026-04-20T00:00:00.000Z",
    closedAt: null,
    deployAmountBase: 1,
    deployAmountQuote: 0.5,
    currentValueBase: 1.2,
    currentValueUsd: 120,
    feesClaimedBase: 0.1,
    feesClaimedUsd: 10,
    realizedPnlBase: 0.2,
    realizedPnlUsd: 20,
    unrealizedPnlBase: 0.1,
    unrealizedPnlUsd: 10,
    rebalanceCount: 1,
    partialCloseCount: 0,
    strategy: "bid_ask",
    rangeLowerBin: 10,
    rangeUpperBin: 20,
    activeBin: 25,
    outOfRangeSince: "2026-04-19T23:00:00.000Z",
    lastManagementDecision: null,
    lastManagementReason: null,
    lastWriteActionId: null,
    needsReconciliation: false,
  };
}

function buildCloseConfirmedPosition(
  positionId: string,
  currentValueUsd = 120,
): Position {
  return {
    ...buildOpenPosition(positionId),
    status: "CLOSE_CONFIRMED",
    closedAt: "2026-04-20T00:05:00.000Z",
    currentValueBase: currentValueUsd / 100,
    currentValueUsd,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    lastSyncedAt: "2026-04-20T00:05:00.000Z",
  };
}

function buildRedeployedOpenPosition(positionId: string): Position {
  return {
    positionId,
    poolAddress: rebalancePayload.redeploy.poolAddress,
    tokenXMint: rebalancePayload.redeploy.tokenXMint,
    tokenYMint: rebalancePayload.redeploy.tokenYMint,
    baseMint: rebalancePayload.redeploy.baseMint,
    quoteMint: rebalancePayload.redeploy.quoteMint,
    wallet: "wallet_001",
    status: "OPEN",
    openedAt: "2026-04-20T00:08:00.000Z",
    lastSyncedAt: "2026-04-20T00:08:00.000Z",
    closedAt: null,
    deployAmountBase: rebalancePayload.redeploy.amountBase,
    deployAmountQuote: rebalancePayload.redeploy.amountQuote,
    currentValueBase: rebalancePayload.redeploy.amountBase,
    currentValueUsd: rebalancePayload.redeploy.estimatedValueUsd,
    feesClaimedBase: 0,
    feesClaimedUsd: 0,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    rebalanceCount: 2,
    partialCloseCount: 0,
    strategy: rebalancePayload.redeploy.strategy,
    rangeLowerBin: rebalancePayload.redeploy.rangeLowerBin,
    rangeUpperBin: rebalancePayload.redeploy.rangeUpperBin,
    activeBin: rebalancePayload.redeploy.initialActiveBin,
    outOfRangeSince: null,
    lastManagementDecision: "REBALANCE",
    lastManagementReason: rebalancePayload.reason,
    lastWriteActionId: null,
    needsReconciliation: false,
  };
}

class RebalanceTestGateway implements DlmmGateway {
  public readonly positions = new Map<string, Position>();

  public reconciliationReadModel: "open_only" | undefined = undefined;

  public closeResult: ClosePositionResult = {
    actionType: "CLOSE",
    closedPositionId: "pos_old",
    txIds: ["tx_close_001"],
    releasedAmountBase: 1.2,
    releasedAmountQuote: 0.6,
    estimatedReleasedValueUsd: 120,
    releasedAmountSource: "post_tx",
  };

  public deployResult: DeployLiquidityResult = {
    actionType: "DEPLOY",
    positionId: "pos_new",
    txIds: ["tx_deploy_001"],
  };

  public readonly deployRequests: DeployLiquidityRequest[] = [];

  public closeError: Error | null = null;

  public deployError: Error | null = null;

  public async getPosition(positionId: string): Promise<Position | null> {
    return this.positions.get(positionId) ?? null;
  }

  public async deployLiquidity(
    request: DeployLiquidityRequest,
  ): Promise<DeployLiquidityResult> {
    this.deployRequests.push(request);
    if (this.deployError !== null) {
      throw this.deployError;
    }

    return this.deployResult;
  }

  public async simulateDeployLiquidity() {
    return { ok: true, reason: null };
  }

  public async closePosition(
    _request: ClosePositionRequest,
  ): Promise<ClosePositionResult> {
    if (this.closeError !== null) {
      throw this.closeError;
    }

    return this.closeResult;
  }

  public async simulateClosePosition() {
    return { ok: true, reason: null };
  }

  public async claimFees(): Promise<ClaimFeesResult> {
    return {
      actionType: "CLAIM_FEES",
      claimedBaseAmount: 0,
      txIds: ["tx_unused"],
    };
  }

  public async partialClosePosition(
    _request: PartialClosePositionRequest,
  ): Promise<PartialClosePositionResult> {
    return {
      actionType: "PARTIAL_CLOSE",
      closedPositionId: "unused",
      remainingPercentage: 50,
      txIds: ["tx_unused"],
    };
  }

  public async listPositionsForWallet(): Promise<WalletPositionsSnapshot> {
    return {
      wallet: "wallet_001",
      positions: [...this.positions.values()],
    };
  }

  public async getPoolInfo(): Promise<PoolInfo> {
    return {
      poolAddress: "pool_001",
      pairLabel: "SOL-USDC",
      binStep: 100,
      activeBin: 15,
    };
  }
}

class FailingClosedStateRepository extends StateRepository {
  public failClosedUpsert = false;

  public override async upsert(position: Position): Promise<void> {
    if (this.failClosedUpsert && position.status === "CLOSED") {
      throw new Error("simulated crash before old-leg CLOSED state persisted");
    }

    await super.upsert(position);
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("rebalance flow", () => {
  it("routes ambiguous rebalance close submission to WAITING_CONFIRMATION + reconciliation", async () => {
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
    const gateway = new RebalanceTestGateway();
    gateway.closeError = new AmbiguousSubmissionError(
      "rebalance close submit timed out after broadcast",
      {
        operation: "CLOSE",
        positionId: "pos_old",
        txIds: ["tx_rebalance_close_maybe_sent"],
      },
    );

    await stateRepository.upsert(buildOpenPosition("pos_old"));

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old",
      payload: rebalancePayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    const queuedResult = await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get("pos_old");
    const events = await journalRepository.list();

    expect(queuedResult?.status).toBe("WAITING_CONFIRMATION");
    expect(persistedAction?.status).toBe("WAITING_CONFIRMATION");
    expect(persistedAction?.txIds).toEqual(["tx_rebalance_close_maybe_sent"]);
    expect(
      (
        persistedAction?.resultPayload as {
          closeResult?: {
            submissionAmbiguous?: boolean;
            submissionStatus?: string;
          };
        }
      )?.closeResult?.submissionAmbiguous,
    ).toBe(true);
    expect(
      (
        persistedAction?.resultPayload as {
          closeResult?: {
            submissionAmbiguous?: boolean;
            submissionStatus?: string;
          };
        }
      )?.closeResult?.submissionStatus,
    ).toBe("maybe_submitted");
    expect(persistedPosition?.status).toBe("RECONCILIATION_REQUIRED");
    expect(persistedPosition?.needsReconciliation).toBe(true);
    expect(events.map((event) => event.eventType)).toContain(
      "REBALANCE_CLOSE_SUBMISSION_AMBIGUOUS",
    );
    expect(events.map((event) => event.eventType)).not.toContain(
      "REBALANCE_CLOSE_SUBMISSION_FAILED",
    );
  });

  it("processes rebalance as close-finalize-redeploy and opens the new leg only after old leg is closed", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_old"));

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old",
      payload: rebalancePayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    const queuedResult = await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    expect(queuedResult?.status).toBe("WAITING_CONFIRMATION");
    expect((await stateRepository.get("pos_old"))?.status).toBe(
      "CLOSING_FOR_REBALANCE",
    );

    gateway.positions.set("pos_old", buildCloseConfirmedPosition("pos_old"));

    const firstFinalize = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(firstFinalize.outcome).toBe("REDEPLOY_SUBMITTED");
    expect(firstFinalize.action.status).toBe("WAITING_CONFIRMATION");
    expect(firstFinalize.oldPosition?.status).toBe("CLOSED");
    expect(firstFinalize.newPosition?.status).toBe("REDEPLOYING");
    expect(firstFinalize.newPosition?.positionId).toBe("pos_new");

    gateway.positions.set("pos_new", buildRedeployedOpenPosition("pos_new"));

    const secondFinalize = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:08:00.000Z",
    });

    const persistedAction = await actionRepository.get(action.actionId);
    const oldPosition = await stateRepository.get("pos_old");
    const newPosition = await stateRepository.get("pos_new");
    const journalEvents = await journalRepository.list();

    expect(secondFinalize.outcome).toBe("FINALIZED");
    expect(persistedAction?.status).toBe("DONE");
    expect(oldPosition?.status).toBe("CLOSED");
    expect(newPosition?.status).toBe("OPEN");
    expect(newPosition?.rebalanceCount).toBe(2);
    expect(journalEvents.map((event) => event.eventType)).toContain(
      "REBALANCE_FINALIZED",
    );
  });

  it("routes ambiguous redeploy submission to confirmation instead of aborting after the old leg closes", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_old"));

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old",
      payload: rebalancePayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    gateway.positions.set("pos_old", buildCloseConfirmedPosition("pos_old"));
    gateway.deployError = new AmbiguousSubmissionError(
      "redeploy submit timed out after broadcast",
      {
        operation: "DEPLOY",
        positionId: "pos_new",
        txIds: ["tx_redeploy_maybe_sent"],
      },
    );

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    const persistedAction = await actionRepository.get(action.actionId);
    const newPosition = await stateRepository.get("pos_new");

    expect(finalized.outcome).toBe("REDEPLOY_SUBMITTED");
    expect(persistedAction?.status).toBe("WAITING_CONFIRMATION");
    expect(newPosition?.status).toBe("RECONCILIATION_REQUIRED");
    expect(newPosition?.needsReconciliation).toBe(true);
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("REBALANCE_REDEPLOY_SUBMISSION_AMBIGUOUS");
  });

  it("requires reconciliation when confirmed redeploy identity does not match the request", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_old"));

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old",
      payload: rebalancePayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    gateway.positions.set("pos_old", buildCloseConfirmedPosition("pos_old"));

    const firstFinalize = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(firstFinalize.outcome).toBe("REDEPLOY_SUBMITTED");

    gateway.positions.set("pos_new", {
      ...buildRedeployedOpenPosition("pos_new"),
      poolAddress: "pool_unexpected",
    });

    const secondFinalize = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:08:00.000Z",
    });

    const persistedAction = await actionRepository.get(action.actionId);
    const newPosition = await stateRepository.get("pos_new");

    expect(secondFinalize.outcome).toBe("TIMED_OUT");
    expect(persistedAction?.status).toBe("TIMED_OUT");
    expect(newPosition?.status).toBe("RECONCILIATION_REQUIRED");
    expect(persistedAction?.error).toMatch(/poolAddress mismatch/);
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("REBALANCE_REDEPLOY_IDENTITY_MISMATCH");
  });

  it("redeploys with post-close token amounts instead of the stale request amounts", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_actual_amounts"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_actual_amounts",
      txIds: ["tx_close_actual_amounts"],
      releasedAmountBase: 1.37,
      releasedAmountQuote: 22.5,
      estimatedReleasedValueUsd: 123,
      releasedAmountSource: "post_tx",
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_actual_amounts",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
      }),
    );

    gateway.positions.set(
      "pos_actual_amounts",
      buildCloseConfirmedPosition("pos_actual_amounts", 999),
    );

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("REDEPLOY_SUBMITTED");
    expect(gateway.deployRequests).toHaveLength(1);
    expect(gateway.deployRequests[0]?.amountBase).toBe(1.37);
    expect(gateway.deployRequests[0]?.amountQuote).toBe(22.5);
    expect(finalized.newPosition?.deployAmountBase).toBe(1.37);
    expect(finalized.newPosition?.deployAmountQuote).toBe(22.5);
    expect(finalized.newPosition?.currentValueUsd).toBe(123);
  });

  it("continues old-leg learning and redeploy when rebalance close was already persisted closed", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_old"));

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old",
      payload: rebalancePayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const performanceSnapshot = buildCloseConfirmedPosition("pos_old");
    await stateRepository.upsert({
      ...performanceSnapshot,
      status: "CLOSED",
      currentValueBase: 0,
      currentValueUsd: 0,
      unrealizedPnlBase: 0,
      unrealizedPnlUsd: 0,
    });
    const waitingAction = await actionRepository.get(action.actionId);
    if (waitingAction === null || waitingAction.resultPayload === null) {
      throw new Error("expected waiting rebalance action");
    }
    await actionRepository.upsert({
      ...waitingAction,
      resultPayload: {
        ...waitingAction.resultPayload,
        closeAccounting: {},
        closedPositionId: "pos_old",
        availableCapitalUsd: 120,
        performanceSnapshot,
      },
    });

    let learnedSnapshotValueUsd: number | null = null;
    const lessonHook: LessonHook = async (input) => {
      learnedSnapshotValueUsd =
        input.performanceSnapshotPosition?.currentValueUsd ??
        input.position.currentValueUsd;
    };

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      lessonHook,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("REDEPLOY_SUBMITTED");
    expect(finalized.oldPosition?.status).toBe("CLOSED");
    expect(gateway.deployRequests).toHaveLength(1);
    expect(learnedSnapshotValueUsd).toBe(120);
  });

  it("persists old-leg performance snapshot before writing CLOSED state", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new FailingClosedStateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_old"));

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old",
      payload: rebalancePayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    gateway.positions.set("pos_old", buildCloseConfirmedPosition("pos_old"));
    stateRepository.failClosedUpsert = true;

    await expect(
      finalizeRebalance({
        actionId: action.actionId,
        actionRepository,
        stateRepository,
        dlmmGateway: gateway,
        journalRepository,
        now: () => "2026-04-20T00:05:00.000Z",
      }),
    ).rejects.toThrow("simulated crash");

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPayload = persistedAction?.resultPayload;
    const persistedOldPosition = await stateRepository.get("pos_old");

    expect(persistedPayload?.["performanceSnapshot"]).toMatchObject({
      positionId: "pos_old",
      currentValueUsd: 120,
      status: "CLOSE_CONFIRMED",
    });
    expect(persistedPayload?.["closedPositionId"]).toBe("pos_old");
    expect(persistedOldPosition?.status).toBe("CLOSING_FOR_REBALANCE");
  });

  it("uses close-confirmed USD when post-close USD estimate is zero", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_zero_usd_estimate"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_zero_usd_estimate",
      txIds: ["tx_close_zero_usd_estimate"],
      releasedAmountBase: 1.37,
      releasedAmountQuote: 0.75,
      estimatedReleasedValueUsd: 0,
      releasedAmountSource: "post_tx",
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_zero_usd_estimate",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
      }),
    );

    gateway.positions.set(
      "pos_zero_usd_estimate",
      buildCloseConfirmedPosition("pos_zero_usd_estimate", 120),
    );

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    const persistedAction = await actionRepository.get(action.actionId);
    const resultPayload = persistedAction?.resultPayload as
      | { redeployRequest?: { estimatedValueUsd?: number } }
      | null
      | undefined;

    expect(finalized.outcome).toBe("REDEPLOY_SUBMITTED");
    expect(gateway.deployRequests).toHaveLength(1);
    expect(finalized.newPosition?.currentValueUsd).toBe(120);
    expect(resultPayload?.redeployRequest?.estimatedValueUsd).toBe(120);
  });

  it("aborts redeploy when a requested token side is missing from post-close settlement", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_missing_quote"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_missing_quote",
      txIds: ["tx_close_missing_quote"],
      releasedAmountBase: 1.37,
      estimatedReleasedValueUsd: 120,
      releasedAmountSource: "post_tx",
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_missing_quote",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
      }),
    );

    gateway.positions.set(
      "pos_missing_quote",
      buildCloseConfirmedPosition("pos_missing_quote", 120),
    );

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("REBALANCE_ABORTED");
    expect(finalized.action.error).toMatch(
      /quote token settlement amount is missing/i,
    );
    expect(gateway.deployRequests).toHaveLength(0);
  });

  it("aborts redeploy when post-close token settlement amounts are unavailable", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_unavailable_amounts"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_unavailable_amounts",
      txIds: ["tx_close_unavailable_amounts"],
      releasedAmountSource: "unavailable",
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_unavailable_amounts",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
      }),
    );

    gateway.positions.set(
      "pos_unavailable_amounts",
      buildCloseConfirmedPosition("pos_unavailable_amounts", 120),
    );

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("REBALANCE_ABORTED");
    expect(finalized.action.status).toBe("FAILED");
    expect(finalized.action.error).toMatch(
      /settlement amounts are unavailable/i,
    );
    expect(gateway.deployRequests).toHaveLength(0);
    expect(finalized.newPosition).toBeNull();
  });

  it("marks rebalance TIMED_OUT when the old close leg never confirms", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_timeout"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_timeout",
      txIds: ["tx_close_timeout"],
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_timeout",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
      }),
    );

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    expect(finalized.outcome).toBe("TIMED_OUT");
    expect(finalized.action.status).toBe("TIMED_OUT");
    expect(finalized.oldPosition?.status).toBe("RECONCILIATION_REQUIRED");
    expect(finalized.newPosition).toBeNull();
  });

  it("blocks manual rebalance requests when the manual circuit breaker is active", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
    });
    const runtimeControlStore = new FileRuntimeControlStore({
      filePath: path.join(directory, "runtime-control.json"),
    });

    await stateRepository.upsert(buildOpenPosition("pos_manual_block"));
    await runtimeControlStore.tripStopAllDeploys({
      updatedAt: "2026-04-20T00:00:00.000Z",
      reason: "panic",
    });

    await expect(
      requestRebalance({
        actionQueue,
        stateRepository,
        wallet: "wallet_001",
        positionId: "pos_manual_block",
        payload: rebalancePayload,
        requestedBy: "operator",
        runtimeControlStore,
      }),
    ).rejects.toThrow(/manual circuit breaker is active/i);
  });

  it("aborts queued rebalance before close submission when the manual circuit breaker is active", async () => {
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
    const runtimeControlStore = new FileRuntimeControlStore({
      filePath: path.join(directory, "runtime-control.json"),
    });
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_queue_block"));
    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_queue_block",
      payload: rebalancePayload,
      requestedBy: "system",
    });
    await runtimeControlStore.tripStopAllDeploys({
      updatedAt: "2026-04-20T00:01:00.000Z",
      reason: "panic",
    });

    const queuedResult = await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        runtimeControlStore,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    expect(queuedResult?.status).toBe("ABORTED");
    expect((await actionRepository.get(action.actionId))?.status).toBe(
      "ABORTED",
    );
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("REBALANCE_BLOCKED_MANUAL_CIRCUIT_BREAKER");
  });

  it("resumes rebalance redeploy confirmation when the new OPEN leg was committed before the action finished", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_old_resume"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_old_resume",
      txIds: ["tx_close_resume"],
      releasedAmountBase: 1.2,
      releasedAmountQuote: 0.6,
      estimatedReleasedValueUsd: 120,
      releasedAmountSource: "post_tx",
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old_resume",
      payload: rebalancePayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    gateway.positions.set(
      "pos_old_resume",
      buildCloseConfirmedPosition("pos_old_resume"),
    );

    const firstFinalize = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(firstFinalize.outcome).toBe("REDEPLOY_SUBMITTED");

    const confirmedNewPosition = buildRedeployedOpenPosition("pos_new");
    gateway.positions.set("pos_new", confirmedNewPosition);

    await stateRepository.upsert({
      ...confirmedNewPosition,
      lastWriteActionId: action.actionId,
    });

    const resumed = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:08:00.000Z",
    });

    expect(resumed.outcome).toBe("FINALIZED");
    expect(resumed.action.status).toBe("DONE");
    expect(resumed.newPosition?.status).toBe("OPEN");
    expect((await actionRepository.get(action.actionId))?.status).toBe("DONE");
    expect((await stateRepository.get("pos_new"))?.status).toBe("OPEN");
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("REBALANCE_FINALIZED");
  });

  it("aborts rebalance if the closed leg releases no usable token amounts", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_low_capital"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_low_capital",
      txIds: ["tx_close_low_capital"],
      releasedAmountBase: 0,
      releasedAmountQuote: 0,
      estimatedReleasedValueUsd: 40,
      releasedAmountSource: "post_tx",
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_low_capital",
      payload: rebalancePayload,
      requestedBy: "operator",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
      }),
    );

    gateway.positions.set("pos_low_capital", {
      ...buildCloseConfirmedPosition("pos_low_capital", 0),
      currentValueBase: 0,
    });

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    const journalEvents = await journalRepository.list();

    expect(finalized.outcome).toBe("REBALANCE_ABORTED");
    expect(finalized.action.status).toBe("FAILED");
    expect(finalized.oldPosition?.status).toBe("CLOSED");
    expect(finalized.newPosition).toBeNull();
    expect(await stateRepository.get("pos_new")).toBeNull();
    expect(journalEvents.map((event) => event.eventType)).toContain(
      "REBALANCE_ABORTED",
    );
  });

  it("aborts rebalance if redeploy submission fails after the old leg is closed", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_redeploy_fail"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_redeploy_fail",
      txIds: ["tx_close_redeploy_fail"],
      releasedAmountBase: 1.2,
      releasedAmountQuote: 0.6,
      estimatedReleasedValueUsd: 120,
      releasedAmountSource: "post_tx",
    };
    gateway.deployError = new Error("redeploy unavailable");

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_redeploy_fail",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
      }),
    );

    gateway.positions.set(
      "pos_redeploy_fail",
      buildCloseConfirmedPosition("pos_redeploy_fail"),
    );

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("REBALANCE_ABORTED");
    expect(finalized.action.status).toBe("FAILED");
    expect(finalized.oldPosition?.status).toBe("CLOSED");
    expect(finalized.newPosition).toBeNull();
    expect(await stateRepository.get("pos_new")).toBeNull();
  });

  it("aborts redeploy leg when manual circuit breaker is activated after the old leg closes", async () => {
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
    const runtimeControlStore = new FileRuntimeControlStore({
      filePath: path.join(directory, "runtime-control.json"),
    });
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_redeploy_block"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_redeploy_block",
      txIds: ["tx_close_block"],
      releasedAmountBase: 1.2,
      releasedAmountQuote: 0.6,
      estimatedReleasedValueUsd: 120,
      releasedAmountSource: "post_tx",
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_redeploy_block",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    gateway.positions.set(
      "pos_redeploy_block",
      buildCloseConfirmedPosition("pos_redeploy_block"),
    );
    await runtimeControlStore.tripStopAllDeploys({
      updatedAt: "2026-04-20T00:04:00.000Z",
      reason: "panic",
    });

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      runtimeControlStore,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("REBALANCE_ABORTED");
    expect(finalized.action.status).toBe("FAILED");
    expect(finalized.oldPosition?.status).toBe("CLOSED");
    expect(finalized.newPosition).toBeNull();
  });

  it("finalizes ambiguous close RECONCILIATION_REQUIRED + open_only null as CLOSED and continues redeploy", async () => {
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
    const gateway = new RebalanceTestGateway();
    gateway.closeError = new AmbiguousSubmissionError(
      "rebalance close submit timed out",
      {
        operation: "CLOSE",
        positionId: "pos_amb_close",
        txIds: ["tx_amb_close"],
      },
    );
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_amb_close",
      txIds: ["tx_amb_close"],
      releasedAmountBase: 1.2,
      releasedAmountQuote: 0.6,
      estimatedReleasedValueUsd: 120,
      releasedAmountSource: "post_tx",
    };

    await stateRepository.upsert(buildOpenPosition("pos_amb_close"));

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_amb_close",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const afterProcess = await stateRepository.get("pos_amb_close");
    expect(afterProcess?.status).toBe("RECONCILIATION_REQUIRED");

    // Inject post-close settlement amounts into the action payload to simulate
    // the case where the close TX settled and amounts were recovered later.
    const waitingAction = await actionRepository.get(action.actionId);
    if (waitingAction?.resultPayload === null || waitingAction?.resultPayload === undefined) {
      throw new Error("expected waiting rebalance action with payload");
    }
    await actionRepository.upsert({
      ...waitingAction,
      resultPayload: {
        ...waitingAction.resultPayload,
        closeResult: {
          ...(waitingAction.resultPayload as Record<string, unknown>)["closeResult"] as object,
          releasedAmountBase: 1.2,
          releasedAmountQuote: 0.6,
          estimatedReleasedValueUsd: 120,
          releasedAmountSource: "post_tx",
        },
      },
    });

    const openOnlyGateway = new RebalanceTestGateway();
    openOnlyGateway.reconciliationReadModel = "open_only";
    openOnlyGateway.closeError = null;
    openOnlyGateway.deployResult = gateway.deployResult;

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: openOnlyGateway,
      journalRepository,
      now: () => "2026-04-20T00:06:00.000Z",
    });

    const oldPosition = await stateRepository.get("pos_amb_close");
    expect(finalized.outcome).toBe("REDEPLOY_SUBMITTED");
    expect(oldPosition?.status).toBe("CLOSED");
    expect(openOnlyGateway.deployRequests).toHaveLength(1);
  });

  it("does not attempt CLOSED → CLOSE_CONFIRMED when retrying an already-closed old leg", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_retry_closed"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_retry_closed",
      txIds: ["tx_close_retry"],
      releasedAmountBase: 1.2,
      releasedAmountQuote: 0.6,
      estimatedReleasedValueUsd: 120,
      releasedAmountSource: "post_tx",
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_retry_closed",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    await stateRepository.upsert({
      ...buildOpenPosition("pos_retry_closed"),
      status: "CLOSED",
      closedAt: "2026-04-20T00:04:00.000Z",
      currentValueBase: 0,
      currentValueUsd: 0,
      unrealizedPnlBase: 0,
      unrealizedPnlUsd: 0,
    });

    const finalized = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:06:00.000Z",
    });

    expect(finalized.outcome).toBe("REDEPLOY_SUBMITTED");
    const oldPos = await stateRepository.get("pos_retry_closed");
    expect(oldPos?.status).toBe("CLOSED");
  });

  it("finalizes REDEPLOY_SUBMITTED when pending is RECONCILIATION_REQUIRED and confirmed is OPEN", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_old_recon"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_old_recon",
      txIds: ["tx_close_recon"],
      releasedAmountBase: 1.2,
      releasedAmountQuote: 0.6,
      estimatedReleasedValueUsd: 120,
      releasedAmountSource: "post_tx",
    };
    gateway.deployResult = {
      actionType: "DEPLOY",
      positionId: "pos_new_recon",
      txIds: ["tx_deploy_recon"],
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old_recon",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    gateway.positions.set("pos_old_recon", buildCloseConfirmedPosition("pos_old_recon"));

    const firstFinalize = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(firstFinalize.outcome).toBe("REDEPLOY_SUBMITTED");

    const pendingPos = await stateRepository.get("pos_new_recon");
    if (pendingPos === null) throw new Error("pending position missing");

    await stateRepository.upsert({
      ...pendingPos,
      status: "RECONCILIATION_REQUIRED",
      needsReconciliation: true,
    });

    gateway.positions.set("pos_new_recon", buildRedeployedOpenPosition("pos_new_recon"));

    const secondFinalize = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:08:00.000Z",
    });

    expect(secondFinalize.outcome).toBe("FINALIZED");
    expect(secondFinalize.action.status).toBe("DONE");
    const newPos = await stateRepository.get("pos_new_recon");
    expect(newPos?.status).toBe("OPEN");
  });

  it("rejects redeploy confirmation when baseMint or quoteMint does not match the pending position", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_old_bq"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_old_bq",
      txIds: ["tx_close_bq"],
      releasedAmountBase: 1.2,
      releasedAmountQuote: 0.6,
      estimatedReleasedValueUsd: 120,
      releasedAmountSource: "post_tx",
    };
    gateway.deployResult = {
      actionType: "DEPLOY",
      positionId: "pos_new_bq",
      txIds: ["tx_deploy_bq"],
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old_bq",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    gateway.positions.set("pos_old_bq", buildCloseConfirmedPosition("pos_old_bq"));

    const firstFinalize = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(firstFinalize.outcome).toBe("REDEPLOY_SUBMITTED");

    gateway.positions.set("pos_new_bq", {
      ...buildRedeployedOpenPosition("pos_new_bq"),
      baseMint: rebalancePayload.redeploy.quoteMint,
      quoteMint: rebalancePayload.redeploy.baseMint,
    });

    const secondFinalize = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:08:00.000Z",
    });

    expect(secondFinalize.outcome).toBe("TIMED_OUT");
    expect(secondFinalize.action.status).toBe("TIMED_OUT");
    expect(secondFinalize.action.error).toMatch(/baseMint mismatch|quoteMint mismatch/i);
  });

  it("close accounting includes released amounts from closeResult proceeds", async () => {
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
    const gateway = new RebalanceTestGateway();

    await stateRepository.upsert(buildOpenPosition("pos_accounting"));
    gateway.closeResult = {
      actionType: "CLOSE",
      closedPositionId: "pos_accounting",
      txIds: ["tx_close_accounting"],
      releasedAmountBase: 1.2,
      releasedAmountQuote: 50,
      estimatedReleasedValueUsd: 120,
      releasedAmountSource: "post_tx",
    };

    const action = await requestRebalance({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_accounting",
      payload: rebalancePayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    gateway.positions.set("pos_accounting", buildCloseConfirmedPosition("pos_accounting"));

    await finalizeRebalance({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: gateway,
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    const finalAction = await actionRepository.get(action.actionId);
    const closeAccounting = (
      finalAction?.resultPayload as {
        closeAccounting?: { releasedAmountBase?: number; releasedAmountQuote?: number; releasedAmountSource?: string };
      }
    )?.closeAccounting;

    expect(closeAccounting?.releasedAmountBase).toBe(1.2);
    expect(closeAccounting?.releasedAmountQuote).toBe(50);
    expect(closeAccounting?.releasedAmountSource).toBe("post_tx");
  });

  it("rejects rebalance payload with unknown fields when schema is strict", () => {
    expect(() =>
      (
        RebalanceActionRequestPayloadSchema as { parse: (v: unknown) => unknown }
      ).parse({
        reason: "range drift",
        redeploy: rebalancePayload.redeploy,
        unknownField: "this should be rejected",
      }),
    ).toThrow();
  });

  it("rejects requestRebalance with riskGuard null and no explicit bypass", async () => {
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

    await stateRepository.upsert(buildOpenPosition("pos_risk_bypass"));

    await expect(
      requestRebalance({
        actionQueue,
        stateRepository,
        journalRepository,
        wallet: "wallet_001",
        positionId: "pos_risk_bypass",
        payload: rebalancePayload,
        requestedBy: "system",
        riskGuard: null,
      }),
    ).rejects.toThrow(/allowRiskGuardBypass/);
  });
});
