import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
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
import { finalizeRebalance } from "../../src/app/usecases/finalizeRebalance.js";
import { processRebalanceAction } from "../../src/app/usecases/processRebalanceAction.js";
import {
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

  public closeResult: ClosePositionResult = {
    actionType: "CLOSE",
    closedPositionId: "pos_old",
    txIds: ["tx_close_001"],
  };

  public deployResult: DeployLiquidityResult = {
    actionType: "DEPLOY",
    positionId: "pos_new",
    txIds: ["tx_deploy_001"],
  };

  public deployError: Error | null = null;

  public async getPosition(positionId: string): Promise<Position | null> {
    return this.positions.get(positionId) ?? null;
  }

  public async deployLiquidity(
    _request: DeployLiquidityRequest,
  ): Promise<DeployLiquidityResult> {
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

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("rebalance flow", () => {
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

  it("aborts rebalance if closed capital is below the redeploy requirement", async () => {
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

    gateway.positions.set(
      "pos_low_capital",
      buildCloseConfirmedPosition("pos_low_capital", 40),
    );

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
});
