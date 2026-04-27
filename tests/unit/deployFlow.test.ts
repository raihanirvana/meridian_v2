import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AmbiguousSubmissionError,
  DeployLiquidityRequestSchema,
  MockDlmmGateway,
} from "../../src/adapters/dlmm/DlmmGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { FileRuntimeControlStore } from "../../src/adapters/storage/RuntimeControlStore.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { type FileSystemAdapter } from "../../src/adapters/storage/FileStore.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import {
  confirmDeployAction,
  processDeployAction,
} from "../../src/app/usecases/processDeployAction.js";
import {
  requestDeploy,
  type DeployActionRequestPayload,
} from "../../src/app/usecases/requestDeploy.js";
import { type Position } from "../../src/domain/entities/Position.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-deploy-"),
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
  entryMetadata: {
    poolName: "SOL-USDC",
    binStep: 100,
    volatility: 12,
    feeTvlRatio: 0.14,
    organicScore: 78,
    amountSol: 1.5,
  },
};

function buildConfirmedPosition(positionId: string): Position {
  return {
    positionId,
    poolAddress: deployPayload.poolAddress,
    tokenXMint: deployPayload.tokenXMint,
    tokenYMint: deployPayload.tokenYMint,
    baseMint: deployPayload.baseMint,
    quoteMint: deployPayload.quoteMint,
    wallet: "wallet_001",
    status: "OPEN",
    openedAt: "2026-04-20T01:05:00.000Z",
    lastSyncedAt: "2026-04-20T01:05:00.000Z",
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

function buildGatewayPosition(
  positionId: string,
  status: Position["status"],
): Position {
  return {
    ...buildConfirmedPosition(positionId),
    status,
    openedAt: status === "OPEN" ? "2026-04-20T01:05:00.000Z" : null,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("deploy flow", () => {
  it("DeployLiquidityRequestSchema rejects invalid strategy", () => {
    expect(() =>
      DeployLiquidityRequestSchema.parse({
        ...deployPayload,
        wallet: "wallet_001",
        strategy: "random",
      } as never),
    ).toThrow();
  });

  it("DeployLiquidityRequestSchema rejects amountBase=0 and amountQuote=0", () => {
    expect(() =>
      DeployLiquidityRequestSchema.parse({
        ...deployPayload,
        wallet: "wallet_001",
        amountBase: 0,
        amountQuote: 0,
      }),
    ).toThrow(/amountBase or amountQuote must be greater than zero/i);
  });

  it("DeployLiquidityRequestSchema rejects rangeLowerBin >= rangeUpperBin", () => {
    expect(() =>
      DeployLiquidityRequestSchema.parse({
        ...deployPayload,
        wallet: "wallet_001",
        rangeLowerBin: 20,
        rangeUpperBin: 20,
      }),
    ).toThrow(/must be greater than rangeLowerBin/i);
  });

  it("rejects deploy requests when both amountBase and amountQuote are zero", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    await expect(
      requestDeploy({
        actionQueue,
        wallet: "wallet_001",
        payload: {
          ...deployPayload,
          amountBase: 0,
          amountQuote: 0,
        },
        requestedBy: "system",
      }),
    ).rejects.toThrow(/amountBase or amountQuote must be greater than zero/i);
  });

  it("rejects non-canonical strategy values at the gateway boundary", async () => {
    const gateway = new MockDlmmGateway({
      getPosition: { type: "success", value: null },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_invalid_strategy",
          txIds: ["tx_invalid_strategy"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
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
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
        },
      },
    });

    await expect(
      gateway.deployLiquidity({
        ...(deployPayload as unknown as Record<string, unknown>),
        wallet: "wallet_001",
        strategy: "random",
      } as never),
    ).rejects.toThrow();
  });

  it("rejects invalid deploy bin ranges at the gateway boundary", async () => {
    const gateway = new MockDlmmGateway({
      getPosition: { type: "success", value: null },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_invalid_range",
          txIds: ["tx_invalid_range"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
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
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
        },
      },
    });

    await expect(
      gateway.deployLiquidity({
        ...deployPayload,
        wallet: "wallet_001",
        rangeLowerBin: 20,
        rangeUpperBin: 20,
      }),
    ).rejects.toThrow(/must be greater than rangeLowerBin/i);
  });

  it("processes a deploy from request to confirmed OPEN position", async () => {
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
    const dlmmGateway = new MockDlmmGateway({
      getPosition: {
        type: "success",
        value: buildConfirmedPosition("pos_001"),
      },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_001",
          txIds: ["tx_001"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "pos_001",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "pos_001",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
        },
      },
      listPositionsForWallet: {
        type: "success",
        value: {
          wallet: "wallet_001",
          positions: [buildConfirmedPosition("pos_001")],
        },
      },
      getPoolInfo: {
        type: "success",
        value: {
          poolAddress: "pool_001",
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
        },
      },
    });

    const action = await requestDeploy({
      actionQueue,
      journalRepository,
      wallet: "wallet_001",
      payload: deployPayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T01:00:00.000Z",
    });

    const queuedResult = await actionQueue.processNext((queuedAction) =>
      processDeployAction({
        action: queuedAction,
        dlmmGateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T01:01:00.000Z",
      }),
    );

    expect(queuedResult?.status).toBe("WAITING_CONFIRMATION");

    const pendingPosition = await stateRepository.get("pos_001");
    expect(pendingPosition?.status).toBe("DEPLOYING");
    expect(pendingPosition?.openedAt).toBeNull();
    expect(pendingPosition?.currentValueQuote).toBe(deployPayload.amountQuote);

    const confirmation = await confirmDeployAction({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway,
      journalRepository,
      now: () => "2026-04-20T01:05:00.000Z",
    });

    expect(confirmation.outcome).toBe("CONFIRMED");
    expect(confirmation.action.status).toBe("DONE");
    expect(confirmation.position?.status).toBe("OPEN");
    expect(confirmation.position?.lastWriteActionId).toBe(action.actionId);

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get("pos_001");
    const journalEvents = await journalRepository.list();

    expect(persistedAction?.status).toBe("DONE");
    expect(persistedPosition?.status).toBe("OPEN");
    expect(persistedPosition?.currentValueQuote).toBe(
      deployPayload.amountQuote,
    );
    expect(persistedPosition?.entryMetadata).toEqual(
      deployPayload.entryMetadata,
    );
    expect(journalEvents.map((event) => event.eventType)).toContain(
      "DEPLOY_CONFIRMED",
    );
  });

  it("rejects new deploy requests while manual circuit breaker is active", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const runtimeControlStore = new FileRuntimeControlStore({
      filePath: path.join(directory, "runtime-controls.json"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await runtimeControlStore.tripStopAllDeploys({
      reason: "panic",
      updatedAt: "2026-04-20T01:00:00.000Z",
    });

    await expect(
      requestDeploy({
        actionQueue,
        journalRepository,
        runtimeControlStore,
        wallet: "wallet_001",
        payload: deployPayload,
        requestedBy: "system",
        requestedAt: "2026-04-20T01:00:00.000Z",
      }),
    ).rejects.toThrow(/manual circuit breaker/i);
  });

  it("aborts queued deploy processing while manual circuit breaker is active", async () => {
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
    const runtimeControlStore = new FileRuntimeControlStore({
      filePath: path.join(directory, "runtime-controls.json"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });
    const dlmmGateway = new MockDlmmGateway({
      getPosition: {
        type: "success",
        value: buildConfirmedPosition("pos_001"),
      },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_001",
          txIds: ["tx_001"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "pos_001",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "pos_001",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
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
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
        },
      },
    });

    const action = await requestDeploy({
      actionQueue,
      journalRepository,
      wallet: "wallet_001",
      payload: deployPayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T01:00:00.000Z",
    });

    await runtimeControlStore.tripStopAllDeploys({
      reason: "panic",
      updatedAt: "2026-04-20T01:00:30.000Z",
    });

    const queuedResult = await actionQueue.processNext((queuedAction) =>
      processDeployAction({
        action: queuedAction,
        dlmmGateway,
        stateRepository,
        journalRepository,
        runtimeControlStore,
        now: () => "2026-04-20T01:01:00.000Z",
      }),
    );

    expect(queuedResult?.status).toBe("ABORTED");
    expect(queuedResult?.error).toMatch(/manual circuit breaker/i);
    expect(await stateRepository.get("pos_001")).toBeNull();
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("DEPLOY_BLOCKED_MANUAL_CIRCUIT_BREAKER");
    expect((await actionRepository.get(action.actionId))?.status).toBe(
      "ABORTED",
    );
  });

  it("sets outOfRangeSince when a confirmed deploy is already outside the configured range", async () => {
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
    const dlmmGateway = new MockDlmmGateway({
      getPosition: {
        type: "success",
        value: {
          ...buildConfirmedPosition("pos_out_of_range"),
          activeBin: 30,
          outOfRangeSince: null,
        },
      },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_out_of_range",
          txIds: ["tx_out_of_range"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
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
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 30,
        },
      },
    });

    const action = await requestDeploy({
      actionQueue,
      wallet: "wallet_001",
      payload: deployPayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processDeployAction({
        action: queuedAction,
        dlmmGateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T01:01:00.000Z",
      }),
    );

    const confirmation = await confirmDeployAction({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway,
      journalRepository,
      now: () => "2026-04-20T01:05:00.000Z",
    });

    expect(confirmation.outcome).toBe("CONFIRMED");
    expect(confirmation.position?.status).toBe("OPEN");
    expect(confirmation.position?.outOfRangeSince).toBe(
      "2026-04-20T01:05:00.000Z",
    );
  });

  it("does not infer outOfRangeSince when activeBin is unknown during deploy confirmation", async () => {
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
    const dlmmGateway = new MockDlmmGateway({
      getPosition: {
        type: "success",
        value: {
          ...buildConfirmedPosition("pos_unknown_bin"),
          activeBin: null,
          outOfRangeSince: null,
        },
      },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_unknown_bin",
          txIds: ["tx_unknown_bin"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
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
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
        },
      },
    });

    const action = await requestDeploy({
      actionQueue,
      wallet: "wallet_001",
      payload: {
        ...deployPayload,
        initialActiveBin: null,
      },
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processDeployAction({
        action: queuedAction,
        dlmmGateway,
        stateRepository,
        now: () => "2026-04-20T01:01:00.000Z",
      }),
    );

    const confirmation = await confirmDeployAction({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway,
      now: () => "2026-04-20T01:05:00.000Z",
    });

    expect(confirmation.outcome).toBe("CONFIRMED");
    expect(confirmation.position?.status).toBe("OPEN");
    expect(confirmation.position?.activeBin).toBeNull();
    expect(confirmation.position?.outOfRangeSince).toBeNull();
  });

  it("treats a non-OPEN gateway position as reconciliation-required instead of confirmed", async () => {
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
    const dlmmGateway = new MockDlmmGateway({
      getPosition: {
        type: "success",
        value: buildGatewayPosition("pos_indexing", "DEPLOYING"),
      },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_indexing",
          txIds: ["tx_indexing"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
        },
      },
      listPositionsForWallet: {
        type: "success",
        value: {
          wallet: "wallet_001",
          positions: [buildGatewayPosition("pos_indexing", "DEPLOYING")],
        },
      },
      getPoolInfo: {
        type: "success",
        value: {
          poolAddress: "pool_001",
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
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
        dlmmGateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T01:01:00.000Z",
      }),
    );

    const confirmation = await confirmDeployAction({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway,
      journalRepository,
      now: () => "2026-04-20T01:05:00.000Z",
    });

    expect(confirmation.outcome).toBe("TIMED_OUT");
    expect(confirmation.action.status).toBe("TIMED_OUT");
    expect(confirmation.position?.status).toBe("RECONCILIATION_REQUIRED");
    expect(confirmation.position?.needsReconciliation).toBe(true);
  });

  it("marks deploy as TIMED_OUT and position as RECONCILIATION_REQUIRED when confirmation never appears", async () => {
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
    const dlmmGateway = new MockDlmmGateway({
      getPosition: { type: "success", value: null },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_timeout",
          txIds: ["tx_timeout"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "pos_timeout",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "pos_timeout",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
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
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
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
        dlmmGateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T01:01:00.000Z",
      }),
    );

    const timedOut = await confirmDeployAction({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway,
      journalRepository,
      now: () => "2026-04-20T01:10:00.000Z",
    });

    expect(timedOut.outcome).toBe("TIMED_OUT");
    expect(timedOut.action.status).toBe("TIMED_OUT");
    expect(timedOut.position?.status).toBe("RECONCILIATION_REQUIRED");
    expect(timedOut.position?.needsReconciliation).toBe(true);
  });

  it("returns UNCHANGED when deploy confirmation is called again after completion", async () => {
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
    const dlmmGateway = new MockDlmmGateway({
      getPosition: {
        type: "success",
        value: buildConfirmedPosition("pos_repeat"),
      },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_repeat",
          txIds: ["tx_repeat"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
        },
      },
      listPositionsForWallet: {
        type: "success",
        value: {
          wallet: "wallet_001",
          positions: [buildConfirmedPosition("pos_repeat")],
        },
      },
      getPoolInfo: {
        type: "success",
        value: {
          poolAddress: "pool_001",
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
        },
      },
    });

    const action = await requestDeploy({
      actionQueue,
      wallet: "wallet_001",
      payload: deployPayload,
      requestedBy: "system",
    });

    await actionQueue.processNext((queuedAction) =>
      processDeployAction({
        action: queuedAction,
        dlmmGateway,
        stateRepository,
        journalRepository,
      }),
    );

    const firstConfirmation = await confirmDeployAction({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway,
      journalRepository,
    });
    const secondConfirmation = await confirmDeployAction({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway,
      journalRepository,
    });

    expect(firstConfirmation.outcome).toBe("CONFIRMED");
    expect(secondConfirmation.outcome).toBe("UNCHANGED");
    expect(secondConfirmation.action.status).toBe("DONE");
    expect(secondConfirmation.position?.status).toBe("OPEN");
  });

  it("resumes deploy confirmation when the local OPEN position was committed before the action finished", async () => {
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
    const confirmedPosition = buildConfirmedPosition("pos_resume");
    const dlmmGateway = new MockDlmmGateway({
      getPosition: {
        type: "success",
        value: confirmedPosition,
      },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_resume",
          txIds: ["tx_resume"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
        },
      },
      listPositionsForWallet: {
        type: "success",
        value: {
          wallet: "wallet_001",
          positions: [confirmedPosition],
        },
      },
      getPoolInfo: {
        type: "success",
        value: {
          poolAddress: "pool_001",
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
        },
      },
    });

    const action = await requestDeploy({
      actionQueue,
      journalRepository,
      wallet: "wallet_001",
      payload: deployPayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T01:00:00.000Z",
    });

    await actionQueue.processNext((queuedAction) =>
      processDeployAction({
        action: queuedAction,
        dlmmGateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T01:01:00.000Z",
      }),
    );

    // Simulate a crash after the position commit but before the action finished.
    await stateRepository.upsert({
      ...confirmedPosition,
      lastWriteActionId: action.actionId,
    });

    const resumed = await confirmDeployAction({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway,
      journalRepository,
      now: () => "2026-04-20T01:05:00.000Z",
    });

    expect(resumed.outcome).toBe("CONFIRMED");
    expect(resumed.action.status).toBe("DONE");
    expect(resumed.position?.status).toBe("OPEN");
    expect(resumed.position?.needsReconciliation).toBe(false);
    expect((await actionRepository.get(action.actionId))?.status).toBe("DONE");
    expect((await stateRepository.get("pos_resume"))?.status).toBe("OPEN");
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("DEPLOY_CONFIRMED");
  });

  it("keeps action in WAITING_CONFIRMATION if confirmed position payload cannot be normalized into OPEN state", async () => {
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
    const invalidGatewayPosition = {
      ...buildConfirmedPosition("pos_invalid_confirm"),
      rangeLowerBin: 20,
      rangeUpperBin: 10,
    } as unknown as Position;
    const dlmmGateway = new MockDlmmGateway({
      getPosition: {
        type: "success",
        value: invalidGatewayPosition,
      },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_invalid_confirm",
          txIds: ["tx_invalid_confirm"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
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
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
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
        dlmmGateway,
        stateRepository,
        journalRepository,
      }),
    );

    await expect(
      confirmDeployAction({
        actionId: action.actionId,
        actionRepository,
        stateRepository,
        dlmmGateway,
        journalRepository,
      }),
    ).rejects.toThrow();

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get("pos_invalid_confirm");

    expect(persistedAction?.status).toBe("WAITING_CONFIRMATION");
    expect(persistedPosition?.status).toBe("DEPLOYING");
  });

  it("marks deploy as FAILED when submit fails and does not create a position", async () => {
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
    const dlmmGateway = new MockDlmmGateway({
      getPosition: { type: "success", value: null },
      deployLiquidity: { type: "fail", error: "rpc submit failed" },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
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
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
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

    const processed = await actionQueue.processNext((queuedAction) =>
      processDeployAction({
        action: queuedAction,
        dlmmGateway,
        stateRepository,
        journalRepository,
      }),
    );

    const persistedAction = await actionRepository.get(action.actionId);
    const positions = await stateRepository.list();
    const events = await journalRepository.list();

    expect(processed?.status).toBe("FAILED");
    expect(persistedAction?.status).toBe("FAILED");
    expect(positions).toHaveLength(0);
    expect(events.map((event) => event.eventType)).toContain(
      "DEPLOY_SUBMISSION_FAILED",
    );
  });

  it("routes ambiguous deploy submission to WAITING_CONFIRMATION + reconciliation instead of FAILED", async () => {
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
    const ambiguousError = new AmbiguousSubmissionError(
      "rpc submit timed out after broadcast",
      {
        operation: "DEPLOY",
        positionId: "pos_ambiguous_001",
        txIds: ["tx_maybe_sent_001"],
      },
    );
    const dlmmGateway = new MockDlmmGateway({
      getPosition: { type: "success", value: null },
      deployLiquidity: { type: "fail", error: ambiguousError },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
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
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
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

    const processed = await actionQueue.processNext((queuedAction) =>
      processDeployAction({
        action: queuedAction,
        dlmmGateway,
        stateRepository,
        journalRepository,
      }),
    );

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get("pos_ambiguous_001");
    const events = await journalRepository.list();

    expect(processed?.status).toBe("WAITING_CONFIRMATION");
    expect(persistedAction?.status).toBe("WAITING_CONFIRMATION");
    expect(
      (
        persistedAction?.resultPayload as {
          submissionAmbiguous?: boolean;
          submissionStatus?: string;
        }
      )?.submissionAmbiguous,
    ).toBe(true);
    expect(
      (
        persistedAction?.resultPayload as {
          submissionAmbiguous?: boolean;
          submissionStatus?: string;
        }
      )?.submissionStatus,
    ).toBe("maybe_submitted");
    expect(persistedAction?.txIds).toEqual(["tx_maybe_sent_001"]);
    expect(persistedPosition?.status).toBe("RECONCILIATION_REQUIRED");
    expect(persistedPosition?.needsReconciliation).toBe(true);
    expect(events.map((event) => event.eventType)).toContain(
      "DEPLOY_SUBMISSION_AMBIGUOUS",
    );
    expect(events.map((event) => event.eventType)).not.toContain(
      "DEPLOY_SUBMISSION_FAILED",
    );
  });

  it("deploy ambiguous local RECONCILIATION_REQUIRED + confirmed OPEN -> DONE", async () => {
    const directory = await makeTempDir();
    const actionsPath = path.join(directory, "actions.json");
    const positionsPath = path.join(directory, "positions.json");
    const journalPath = path.join(directory, "journal.jsonl");

    let failPositionWrite = true;
    const flakyFs: FileSystemAdapter = {
      access: (filePath) => fs.access(filePath),
      appendFile: (filePath, data, encoding) =>
        fs.appendFile(filePath, data, encoding),
      mkdir: (dirPath, options) => fs.mkdir(dirPath, options),
      readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
      rename: (fromPath, toPath) => fs.rename(fromPath, toPath),
      rm: (targetPath, options) => fs.rm(targetPath, options),
      writeFile: async (filePath, data, encoding) => {
        if (failPositionWrite && filePath.includes("positions.json")) {
          failPositionWrite = false;
          throw new Error("simulated position write failure");
        }

        await fs.writeFile(filePath, data, encoding);
      },
    };

    const actionRepository = new ActionRepository({
      filePath: actionsPath,
    });
    const stateRepository = new StateRepository({
      filePath: positionsPath,
      fs: flakyFs,
    });
    const journalRepository = new JournalRepository({
      filePath: journalPath,
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });
    const dlmmGateway = new MockDlmmGateway({
      getPosition: {
        type: "success",
        value: buildConfirmedPosition("pos_recover"),
      },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_recover",
          txIds: ["tx_recover"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
        },
      },
      listPositionsForWallet: {
        type: "success",
        value: {
          wallet: "wallet_001",
          positions: [buildConfirmedPosition("pos_recover")],
        },
      },
      getPoolInfo: {
        type: "success",
        value: {
          poolAddress: "pool_001",
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
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

    const processed = await actionQueue.processNext((queuedAction) =>
      processDeployAction({
        action: queuedAction,
        dlmmGateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T01:01:00.000Z",
      }),
    );

    const persistedAction = await actionRepository.get(action.actionId);
    const afterSubmitPosition = await stateRepository.get("pos_recover");

    expect(processed?.status).toBe("WAITING_CONFIRMATION");
    expect(processed?.error).toMatch(/requires reconciliation/i);
    expect(persistedAction?.status).toBe("WAITING_CONFIRMATION");
    expect(afterSubmitPosition?.status).toBe("RECONCILIATION_REQUIRED");

    const confirmation = await confirmDeployAction({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway,
      journalRepository,
      now: () => "2026-04-20T01:05:00.000Z",
    });

    expect(confirmation.outcome).toBe("CONFIRMED");
    expect(confirmation.action.status).toBe("DONE");
    expect(confirmation.position?.status).toBe("OPEN");
    expect(confirmation.position?.positionId).toBe("pos_recover");
  });

  it("reconstructs an OPEN position when confirmation succeeds but local pending state is missing", async () => {
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
    const dlmmGateway = new MockDlmmGateway({
      getPosition: {
        type: "success",
        value: buildConfirmedPosition("pos_recover_missing"),
      },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_recover_missing",
          txIds: ["tx_recover_missing"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
        },
      },
      listPositionsForWallet: {
        type: "success",
        value: {
          wallet: "wallet_001",
          positions: [buildConfirmedPosition("pos_recover_missing")],
        },
      },
      getPoolInfo: {
        type: "success",
        value: {
          poolAddress: "pool_001",
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
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
        dlmmGateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T01:01:00.000Z",
      }),
    );

    await stateRepository.replaceAll([]);

    const confirmation = await confirmDeployAction({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway,
      journalRepository,
      now: () => "2026-04-20T01:05:00.000Z",
    });

    expect(confirmation.outcome).toBe("CONFIRMED");
    expect(confirmation.action.status).toBe("DONE");
    expect(confirmation.position?.status).toBe("OPEN");
    expect(confirmation.position?.positionId).toBe("pos_recover_missing");
  });

  it("does not mark action TIMED_OUT if reconciliation position write fails during timeout handling", async () => {
    const directory = await makeTempDir();
    const actionsPath = path.join(directory, "actions.json");
    const positionsPath = path.join(directory, "positions.json");
    const journalPath = path.join(directory, "journal.jsonl");

    let positionWriteCount = 0;
    const flakyFs: FileSystemAdapter = {
      access: (filePath) => fs.access(filePath),
      appendFile: (filePath, data, encoding) =>
        fs.appendFile(filePath, data, encoding),
      mkdir: (dirPath, options) => fs.mkdir(dirPath, options),
      readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
      rename: (fromPath, toPath) => fs.rename(fromPath, toPath),
      rm: (targetPath, options) => fs.rm(targetPath, options),
      writeFile: async (filePath, data, encoding) => {
        if (filePath.includes("positions.json")) {
          positionWriteCount += 1;
          if (positionWriteCount >= 2) {
            throw new Error("simulated timeout reconciliation write failure");
          }
        }

        await fs.writeFile(filePath, data, encoding);
      },
    };

    const actionRepository = new ActionRepository({
      filePath: actionsPath,
    });
    const stateRepository = new StateRepository({
      filePath: positionsPath,
      fs: flakyFs,
    });
    const journalRepository = new JournalRepository({
      filePath: journalPath,
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });
    const dlmmGateway = new MockDlmmGateway({
      getPosition: { type: "success", value: null },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_timeout_write_fail",
          txIds: ["tx_timeout_write_fail"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "unused",
          txIds: ["tx_unused"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_unused"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "unused",
          remainingPercentage: 50,
          txIds: ["tx_unused"],
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
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 15,
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
        dlmmGateway,
        stateRepository,
        journalRepository,
      }),
    );

    await expect(
      confirmDeployAction({
        actionId: action.actionId,
        actionRepository,
        stateRepository,
        dlmmGateway,
        journalRepository,
      }),
    ).rejects.toThrow(/simulated timeout reconciliation write failure/i);

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get(
      "pos_timeout_write_fail",
    );

    expect(persistedAction?.status).toBe("WAITING_CONFIRMATION");
    expect(persistedPosition?.status).toBe("DEPLOYING");
  });

  it("reuses the same queued action for duplicate deploy requests with the same idempotency key", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    const first = await requestDeploy({
      actionQueue,
      wallet: "wallet_001",
      payload: deployPayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T01:00:00.000Z",
    });

    const second = await requestDeploy({
      actionQueue,
      wallet: "wallet_001",
      payload: deployPayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T01:00:05.000Z",
    });

    const actions = await actionRepository.list();

    expect(first.actionId).toBe(second.actionId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe("QUEUED");
  });
});
