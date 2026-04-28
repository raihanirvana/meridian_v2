import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AmbiguousSubmissionError,
  MockDlmmGateway,
} from "../../src/adapters/dlmm/DlmmGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { FileRuntimeControlStore } from "../../src/adapters/storage/RuntimeControlStore.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { createPostClaimSwapHook } from "../../src/app/usecases/executePostClaimSwap.js";
import { finalizeClaimFees } from "../../src/app/usecases/finalizeClaimFees.js";
import { processClaimFeesAction } from "../../src/app/usecases/processClaimFeesAction.js";
import { requestClaimFees } from "../../src/app/usecases/requestClaimFees.js";
import { type Position } from "../../src/domain/entities/Position.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-claim-"),
  );
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function buildOpenPosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: "pos_001",
    poolAddress: "pool_001",
    tokenXMint: "mint_x",
    tokenYMint: "mint_y",
    baseMint: "mint_x",
    quoteMint: "mint_y",
    wallet: "wallet_001",
    status: "OPEN",
    openedAt: "2026-04-21T00:00:00.000Z",
    lastSyncedAt: "2026-04-21T00:00:00.000Z",
    closedAt: null,
    deployAmountBase: 10,
    deployAmountQuote: 5,
    currentValueBase: 10,
    currentValueUsd: 100,
    feesClaimedBase: 0,
    feesClaimedUsd: 0,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: 2,
    unrealizedPnlUsd: 20,
    rebalanceCount: 0,
    partialCloseCount: 0,
    strategy: "spot",
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

function buildCompoundDeployRiskGuard() {
  return {
    portfolio: {
      walletBalance: 1_000,
      reservedBalance: 50,
      availableBalance: 950,
      openPositions: 1,
      pendingActions: 1,
      dailyRealizedPnl: 0,
      solPriceUsd: 100,
      drawdownState: "NORMAL" as const,
      circuitBreakerState: "OFF" as const,
      exposureByToken: {},
      exposureByPool: {},
    },
    policy: {
      maxConcurrentPositions: 5,
      maxCapitalUsagePct: 90,
      minReserveUsd: 1,
      maxTokenExposurePct: 90,
      maxPoolExposurePct: 90,
      maxRebalancesPerPosition: 2,
      dailyLossLimitPct: 10,
      circuitBreakerCooldownMin: 180,
      maxNewDeploysPerHour: 5,
    },
    recentNewDeploys: 0,
    solPriceUsd: 100,
  };
}

describe("claim flow", () => {
  it("finalizes claim fees and persists optional auto-swap result without breaking lifecycle", async () => {
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

    await stateRepository.upsert(buildOpenPosition());

    const action = await requestClaimFees({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "fees above threshold",
        autoSwapOutputMint: "So11111111111111111111111111111111111111112",
      },
      requestedBy: "system",
      requestedAt: "2026-04-22T10:00:00.000Z",
      journalRepository,
    });

    const processed = await processClaimFeesAction({
      action,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition({
            status: "CLAIM_CONFIRMED",
            feesClaimedBase: 1,
            feesClaimedUsd: 12,
          }),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      stateRepository,
      journalRepository,
      now: () => "2026-04-22T10:01:00.000Z",
    });

    await actionRepository.upsert({
      ...action,
      status: "WAITING_CONFIRMATION",
      startedAt: "2026-04-22T10:00:30.000Z",
      resultPayload: processed.resultPayload ?? null,
      txIds: processed.txIds ?? [],
      error: processed.error ?? null,
      completedAt: null,
    });

    const finalized = await finalizeClaimFees({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition({
            status: "CLAIM_CONFIRMED",
            feesClaimedBase: 1,
            feesClaimedUsd: 12,
            currentValueUsd: 101,
          }),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      journalRepository,
      postClaimSwapHook: async () => ({
        txId: "tx_swap",
        inputAmountRaw: "1000000000",
        outputAmountRaw: "900000000",
      }),
      now: () => "2026-04-22T10:02:00.000Z",
    });

    expect(finalized.outcome).toBe("FINALIZED");
    expect(finalized.action.status).toBe("DONE");
    expect(finalized.position?.status).toBe("OPEN");
    expect(finalized.action.resultPayload).toMatchObject({
      actionType: "CLAIM_FEES",
      swap: {
        txId: "tx_swap",
        inputAmountRaw: "1000000000",
        outputAmountRaw: "900000000",
      },
    });
  });

  it("finalizes claim fees when Meteora reports the position as OPEN again after claim", async () => {
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

    await stateRepository.upsert(buildOpenPosition());

    const action = await requestClaimFees({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "fees above threshold",
      },
      requestedBy: "system",
      requestedAt: "2026-04-22T10:00:00.000Z",
      journalRepository,
    });

    const processed = await processClaimFeesAction({
      action,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition({
            status: "CLAIM_CONFIRMED",
            feesClaimedBase: 1,
            feesClaimedUsd: 12,
          }),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      stateRepository,
      journalRepository,
      now: () => "2026-04-22T10:01:00.000Z",
    });

    await actionRepository.upsert({
      ...action,
      status: "WAITING_CONFIRMATION",
      startedAt: "2026-04-22T10:00:30.000Z",
      resultPayload: processed.resultPayload ?? null,
      txIds: processed.txIds ?? [],
      error: processed.error ?? null,
      completedAt: null,
    });

    const finalized = await finalizeClaimFees({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: Object.assign(
        new MockDlmmGateway({
          getPosition: {
            type: "success",
            value: buildOpenPosition({
              status: "OPEN",
              feesClaimedBase: 1,
              feesClaimedUsd: 12,
              currentValueUsd: 101,
            }),
          },
          deployLiquidity: {
            type: "success",
            value: {
              actionType: "DEPLOY",
              positionId: "unused",
              txIds: [],
            },
          },
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "unused",
              txIds: [],
            },
          },
          claimFees: {
            type: "success",
            value: {
              actionType: "CLAIM_FEES",
              claimedBaseAmount: 1,
              txIds: ["tx_claim"],
            },
          },
          partialClosePosition: {
            type: "success",
            value: {
              actionType: "PARTIAL_CLOSE",
              closedPositionId: "unused",
              remainingPercentage: 50,
              txIds: [],
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
              pairLabel: "X-Y",
              binStep: 100,
              activeBin: 15,
            },
          },
        }),
        {
          reconciliationReadModel: "open_only" as const,
        },
      ),
      journalRepository,
      now: () => "2026-04-22T10:02:00.000Z",
    });

    expect(finalized.outcome).toBe("FINALIZED");
    expect(finalized.action.status).toBe("DONE");
    expect(finalized.position?.status).toBe("OPEN");
  });

  it("queues a child DEPLOY action when auto-compound succeeds", async () => {
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

    await stateRepository.upsert(buildOpenPosition());

    const action = await requestClaimFees({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "compound claimed fees",
        autoCompound: {
          outputMint: "mint_y",
        },
      },
      requestedBy: "system",
      requestedAt: "2026-04-22T10:00:00.000Z",
      journalRepository,
    });

    const processed = await processClaimFeesAction({
      action,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition({
            status: "CLAIM_CONFIRMED",
            feesClaimedBase: 1,
            feesClaimedUsd: 12,
          }),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      stateRepository,
      journalRepository,
      now: () => "2026-04-22T10:01:00.000Z",
    });

    await actionRepository.upsert({
      ...action,
      status: "WAITING_CONFIRMATION",
      startedAt: "2026-04-22T10:00:30.000Z",
      resultPayload: processed.resultPayload ?? null,
      txIds: processed.txIds ?? [],
      error: processed.error ?? null,
      completedAt: null,
    });

    const finalized = await finalizeClaimFees({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition({
            status: "CLAIM_CONFIRMED",
            feesClaimedBase: 1,
            feesClaimedUsd: 12,
            currentValueUsd: 101,
          }),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      actionQueue,
      journalRepository,
      compoundDeployRiskGuard: buildCompoundDeployRiskGuard(),
      postClaimSwapHook: async () => ({
        txId: "tx_swap_compound",
        inputAmountRaw: "1000000000",
        outputAmountRaw: "750000000",
        outputAmountUi: 0.75,
        outputAmountUsd: 75,
      }),
      now: () => "2026-04-22T10:02:00.000Z",
    });

    expect(finalized.action.status).toBe("DONE");
    expect(finalized.action.resultPayload).toMatchObject({
      autoCompound: {
        phase: "DEPLOY_QUEUED",
      },
    });

    const actions = await actionRepository.list();
    const deployAction = actions.find((item) => item.type === "DEPLOY");
    expect(deployAction).toBeDefined();
    expect(deployAction?.status).toBe("QUEUED");
    expect(deployAction?.requestPayload).toMatchObject({
      poolAddress: "pool_001",
      amountBase: 0,
      amountQuote: 0.75,
      estimatedValueUsd: 75,
    });
  });

  it("keeps auto-compound as DEPLOY_QUEUED when child deploy is enqueued but deploy request journal append fails", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const baseJournalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository: baseJournalRepository,
    });

    await stateRepository.upsert(buildOpenPosition());

    const action = await requestClaimFees({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "compound claimed fees",
        autoCompound: {
          outputMint: "mint_y",
        },
      },
      requestedBy: "system",
      requestedAt: "2026-04-22T10:00:00.000Z",
      journalRepository: baseJournalRepository,
    });

    const processed = await processClaimFeesAction({
      action,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition({
            status: "CLAIM_CONFIRMED",
            feesClaimedBase: 1,
            feesClaimedUsd: 12,
          }),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      stateRepository,
      journalRepository: baseJournalRepository,
      now: () => "2026-04-22T10:01:00.000Z",
    });

    await actionRepository.upsert({
      ...action,
      status: "WAITING_CONFIRMATION",
      startedAt: "2026-04-22T10:00:30.000Z",
      resultPayload: processed.resultPayload ?? null,
      txIds: processed.txIds ?? [],
      error: processed.error ?? null,
      completedAt: null,
    });

    const selectiveFailJournal = {
      async append(event: { eventType: string }) {
        if (event.eventType === "DEPLOY_REQUEST_ACCEPTED") {
          throw new Error("journal unavailable");
        }
        await baseJournalRepository.append(event as never);
      },
    } as JournalRepository;

    const finalized = await finalizeClaimFees({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition({
            status: "CLAIM_CONFIRMED",
            feesClaimedBase: 1,
            feesClaimedUsd: 12,
            currentValueUsd: 101,
          }),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      actionQueue,
      journalRepository: selectiveFailJournal,
      compoundDeployRiskGuard: buildCompoundDeployRiskGuard(),
      postClaimSwapHook: async () => ({
        txId: "tx_swap_compound",
        inputAmountRaw: "1000000000",
        outputAmountRaw: "750000000",
        outputAmountUi: 0.75,
        outputAmountUsd: 75,
      }),
      now: () => "2026-04-22T10:02:00.000Z",
    });

    expect(finalized.action.status).toBe("DONE");
    expect(finalized.action.resultPayload).toMatchObject({
      autoCompound: {
        phase: "DEPLOY_QUEUED",
      },
    });
    const actions = await actionRepository.list();
    expect(actions.filter((item) => item.type === "DEPLOY")).toHaveLength(1);
  });

  it("marks compound as failed when redeploy is blocked, without failing the claim itself", async () => {
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
    const runtimeControlStore = new FileRuntimeControlStore({
      filePath: path.join(directory, "runtime-control.json"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await runtimeControlStore.tripStopAllDeploys({
      reason: "panic",
      updatedAt: "2026-04-22T09:59:00.000Z",
    });
    await stateRepository.upsert(buildOpenPosition());

    const action = await requestClaimFees({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "compound claimed fees",
        autoCompound: {
          outputMint: "mint_y",
        },
      },
      requestedBy: "system",
      requestedAt: "2026-04-22T10:00:00.000Z",
      journalRepository,
    });

    const processed = await processClaimFeesAction({
      action,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition({
            status: "CLAIM_CONFIRMED",
            feesClaimedBase: 1,
            feesClaimedUsd: 12,
          }),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      stateRepository,
      journalRepository,
      now: () => "2026-04-22T10:01:00.000Z",
    });

    await actionRepository.upsert({
      ...action,
      status: "WAITING_CONFIRMATION",
      startedAt: "2026-04-22T10:00:30.000Z",
      resultPayload: processed.resultPayload ?? null,
      txIds: processed.txIds ?? [],
      error: processed.error ?? null,
      completedAt: null,
    });

    const finalized = await finalizeClaimFees({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition({
            status: "CLAIM_CONFIRMED",
            feesClaimedBase: 1,
            feesClaimedUsd: 12,
            currentValueUsd: 101,
          }),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      actionQueue,
      runtimeControlStore,
      journalRepository,
      postClaimSwapHook: async () => ({
        txId: "tx_swap_compound",
        inputAmountRaw: "1000000000",
        outputAmountRaw: "750000000",
        outputAmountUi: 0.75,
      }),
      now: () => "2026-04-22T10:02:00.000Z",
    });

    expect(finalized.action.status).toBe("DONE");
    expect(finalized.position?.status).toBe("OPEN");
    expect(finalized.action.resultPayload).toMatchObject({
      autoCompound: {
        phase: "FAILED",
      },
    });

    const actions = await actionRepository.list();
    expect(actions.filter((item) => item.type === "DEPLOY")).toHaveLength(0);
  });

  it("marks compound as failed when claimed amount source is unavailable", async () => {
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

    await stateRepository.upsert(buildOpenPosition());

    const action = await requestClaimFees({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "compound claimed fees",
        autoCompound: {
          outputMint: "mint_y",
        },
      },
      requestedBy: "system",
      requestedAt: "2026-04-22T10:00:00.000Z",
      journalRepository,
    });

    const processed = await processClaimFeesAction({
      action,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition({
            status: "CLAIM_CONFIRMED",
            feesClaimedBase: 1,
            feesClaimedUsd: 12,
          }),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 0,
            claimedBaseAmountSource: "unavailable",
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      stateRepository,
      journalRepository,
      now: () => "2026-04-22T10:01:00.000Z",
    });

    await actionRepository.upsert({
      ...action,
      status: "WAITING_CONFIRMATION",
      startedAt: "2026-04-22T10:00:30.000Z",
      resultPayload: processed.resultPayload ?? null,
      txIds: processed.txIds ?? [],
      error: processed.error ?? null,
      completedAt: null,
    });

    const finalized = await finalizeClaimFees({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition({
            status: "CLAIM_CONFIRMED",
            feesClaimedBase: 1,
            feesClaimedUsd: 12,
            currentValueUsd: 101,
          }),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 0,
            claimedBaseAmountSource: "unavailable",
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      actionQueue,
      journalRepository,
      postClaimSwapHook: async () => ({
        txId: "tx_swap_compound",
        inputAmountRaw: "1000000000",
        outputAmountRaw: "750000000",
        outputAmountUi: 0.75,
      }),
      now: () => "2026-04-22T10:02:00.000Z",
    });

    expect(finalized.action.status).toBe("DONE");
    expect(finalized.position?.status).toBe("OPEN");
    expect(finalized.action.resultPayload).toMatchObject({
      claimedBaseAmountSource: "unavailable",
      autoCompound: {
        phase: "FAILED",
        error:
          "claimed base amount unavailable after claim; auto-compound skipped",
      },
    });

    const actions = await actionRepository.list();
    expect(actions.filter((item) => item.type === "DEPLOY")).toHaveLength(0);
  });

  it("resumes compound redeploy from RECONCILING state after restart", async () => {
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
      buildOpenPosition({
        status: "RECONCILING",
        needsReconciliation: true,
        lastWriteActionId: "act_claim_resume",
      }),
    );
    await actionRepository.upsert({
      actionId: "act_claim_resume",
      type: "CLAIM_FEES",
      status: "RECONCILING",
      wallet: "wallet_001",
      positionId: "pos_001",
      idempotencyKey: "claim:resume",
      requestPayload: {
        reason: "compound claimed fees",
        autoCompound: {
          outputMint: "mint_y",
        },
      },
      resultPayload: {
        actionType: "CLAIM_FEES",
        claimedBaseAmount: 1,
        txIds: ["tx_claim"],
        reason: "compound claimed fees",
        autoCompound: {
          outputMint: "mint_y",
          phase: "SWAP_DONE",
          deployTemplate: {
            poolAddress: "pool_001",
            tokenXMint: "mint_x",
            tokenYMint: "mint_y",
            baseMint: "mint_x",
            quoteMint: "mint_y",
            strategy: "spot",
            rangeLowerBin: 10,
            rangeUpperBin: 20,
            initialActiveBin: 15,
          },
          swap: {
            txId: "tx_swap_compound",
            inputAmountRaw: "1000000000",
            outputAmountRaw: "750000000",
            outputAmountUi: 0.75,
            outputAmountUsd: 75,
          },
        },
      },
      txIds: ["tx_claim"],
      error: null,
      requestedAt: "2026-04-22T10:00:00.000Z",
      startedAt: "2026-04-22T10:00:30.000Z",
      completedAt: null,
      requestedBy: "system",
    });

    const finalized = await finalizeClaimFees({
      actionId: "act_claim_resume",
      actionRepository,
      stateRepository,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition(),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      actionQueue,
      journalRepository,
      compoundDeployRiskGuard: buildCompoundDeployRiskGuard(),
      now: () => "2026-04-22T10:05:00.000Z",
    });

    expect(finalized.outcome).toBe("FINALIZED");
    expect(finalized.action.status).toBe("DONE");
    expect(finalized.action.resultPayload).toMatchObject({
      autoCompound: {
        phase: "DEPLOY_QUEUED",
      },
    });

    const actions = await actionRepository.list();
    expect(actions.filter((item) => item.type === "DEPLOY")).toHaveLength(1);
  });

  it("keeps claim action recoverable when claim submission is ambiguous", async () => {
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

    await stateRepository.upsert(buildOpenPosition());
    const action = await requestClaimFees({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "claim before close",
      },
      requestedBy: "system",
      requestedAt: "2026-04-22T10:00:00.000Z",
      journalRepository,
    });

    const result = await processClaimFeesAction({
      action,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition(),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "fail",
          error: new AmbiguousSubmissionError("claim response lost", {
            operation: "CLAIM_FEES",
            positionId: "pos_001",
            txIds: ["tx_claim_maybe"],
          }),
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      stateRepository,
      journalRepository,
      now: () => "2026-04-22T10:01:00.000Z",
    });

    const position = await stateRepository.get("pos_001");
    expect(result.nextStatus).toBe("WAITING_CONFIRMATION");
    expect(result.resultPayload).toMatchObject({
      actionType: "CLAIM_FEES",
      claimedBaseAmountSource: "unavailable",
      submissionStatus: "maybe_submitted",
      submissionAmbiguous: true,
    });
    expect(position?.status).toBe("RECONCILIATION_REQUIRED");
    expect(position?.needsReconciliation).toBe(true);
  });

  it("finalizes ambiguous claim when local state is RECONCILIATION_REQUIRED and live position is OPEN", async () => {
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

    await stateRepository.upsert(buildOpenPosition());
    const action = await requestClaimFees({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "claim before close",
      },
      requestedBy: "system",
      requestedAt: "2026-04-22T10:00:00.000Z",
      journalRepository,
    });

    const processed = await processClaimFeesAction({
      action,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition(),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "fail",
          error: new AmbiguousSubmissionError("claim response lost", {
            operation: "CLAIM_FEES",
            positionId: "pos_001",
            txIds: ["tx_claim_maybe"],
          }),
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      stateRepository,
      journalRepository,
      now: () => "2026-04-22T10:01:00.000Z",
    });

    await actionRepository.upsert({
      ...action,
      status: "WAITING_CONFIRMATION",
      startedAt: "2026-04-22T10:00:30.000Z",
      resultPayload: processed.resultPayload ?? null,
      txIds: processed.txIds ?? [],
      error: processed.error ?? null,
      completedAt: null,
    });

    const finalized = await finalizeClaimFees({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: Object.assign(
        new MockDlmmGateway({
          getPosition: {
            type: "success",
            value: buildOpenPosition({
              status: "OPEN",
              feesClaimedBase: 1,
              feesClaimedUsd: 12,
              currentValueUsd: 101,
            }),
          },
          deployLiquidity: {
            type: "success",
            value: {
              actionType: "DEPLOY",
              positionId: "unused",
              txIds: [],
            },
          },
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "unused",
              txIds: [],
            },
          },
          claimFees: {
            type: "success",
            value: {
              actionType: "CLAIM_FEES",
              claimedBaseAmount: 1,
              txIds: ["tx_claim"],
            },
          },
          partialClosePosition: {
            type: "success",
            value: {
              actionType: "PARTIAL_CLOSE",
              closedPositionId: "unused",
              remainingPercentage: 50,
              txIds: [],
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
              pairLabel: "X-Y",
              binStep: 100,
              activeBin: 15,
            },
          },
        }),
        {
          reconciliationReadModel: "open_only" as const,
        },
      ),
      journalRepository,
      now: () => "2026-04-22T10:02:00.000Z",
    });

    expect(finalized.outcome).toBe("FINALIZED");
    expect(finalized.action.status).toBe("DONE");
    expect(finalized.position?.status).toBe("OPEN");
  });

  it("does not re-run simple auto-swap when restart finds swap in progress", async () => {
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
    const postClaimSwapHook = vi.fn(async () => ({
      txId: "tx_swap_should_not_run",
    }));

    await stateRepository.upsert(
      buildOpenPosition({
        status: "RECONCILING",
        needsReconciliation: true,
        lastWriteActionId: "act_claim_swap_resume",
      }),
    );
    await actionRepository.upsert({
      actionId: "act_claim_swap_resume",
      type: "CLAIM_FEES",
      status: "RECONCILING",
      wallet: "wallet_001",
      positionId: "pos_001",
      idempotencyKey: "claim:swap-resume",
      requestPayload: {
        reason: "auto swap claimed fees",
        autoSwapOutputMint: "mint_y",
      },
      resultPayload: {
        actionType: "CLAIM_FEES",
        claimedBaseAmount: 1,
        txIds: ["tx_claim"],
        reason: "auto swap claimed fees",
        autoSwapOutputMint: "mint_y",
        autoSwap: {
          outputMint: "mint_y",
          phase: "SWAP_IN_PROGRESS",
          swap: null,
          error: null,
        },
        autoCompound: null,
      },
      txIds: ["tx_claim"],
      error: null,
      requestedAt: "2026-04-22T10:00:00.000Z",
      startedAt: "2026-04-22T10:00:30.000Z",
      completedAt: null,
      requestedBy: "system",
    });

    const finalized = await finalizeClaimFees({
      actionId: "act_claim_swap_resume",
      actionRepository,
      stateRepository,
      dlmmGateway: new MockDlmmGateway({
        getPosition: {
          type: "success",
          value: buildOpenPosition(),
        },
        deployLiquidity: {
          type: "success",
          value: {
            actionType: "DEPLOY",
            positionId: "unused",
            txIds: [],
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "unused",
            txIds: [],
          },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
            remainingPercentage: 50,
            txIds: [],
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      journalRepository,
      postClaimSwapHook,
      now: () => "2026-04-22T10:05:00.000Z",
    });

    expect(postClaimSwapHook).not.toHaveBeenCalled();
    expect(finalized.action.status).toBe("DONE");
    expect(finalized.action.resultPayload).toMatchObject({
      autoSwap: {
        phase: "MANUAL_REVIEW_REQUIRED",
      },
      swap: {
        status: "MANUAL_REVIEW_REQUIRED",
      },
    });
  });

  it("uses claimedBaseAmountRaw for post-claim swap execution when available", async () => {
    let capturedAmountRaw: string | null = null;

    const hook = createPostClaimSwapHook({
      async quoteSwap() {
        throw new Error("unused");
      },
      async executeSwap(request) {
        capturedAmountRaw = request.amountRaw;
        return {
          txId: "tx_swap",
          inputAmountRaw: "250000000",
          outputAmountRaw: "100000000",
        };
      },
    });

    const result = await hook({
      actionId: "act_001",
      wallet: "wallet_001",
      position: buildOpenPosition({
        baseMint: "So11111111111111111111111111111111111111112",
      }),
      claimedBaseAmount: 0.25,
      claimedBaseAmountRaw: "250000000",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });

    expect(capturedAmountRaw).toBe("250000000");
    expect(result).toMatchObject({
      txId: "tx_swap",
    });
  });

  it("keeps ambiguous claim in WAITING_CONFIRMATION when ambiguity journal append fails", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    await stateRepository.upsert(buildOpenPosition());
    const action = await requestClaimFees({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: { reason: "claim before close" },
      requestedBy: "system",
      requestedAt: "2026-04-22T10:00:00.000Z",
    });

    const failingJournal = {
      async append() {
        throw new Error("journal unavailable");
      },
    } as unknown as JournalRepository;

    const result = await processClaimFeesAction({
      action,
      dlmmGateway: new MockDlmmGateway({
        getPosition: { type: "success", value: buildOpenPosition() },
        deployLiquidity: {
          type: "success",
          value: { actionType: "DEPLOY", positionId: "unused", txIds: [] },
        },
        closePosition: {
          type: "success",
          value: { actionType: "CLOSE", closedPositionId: "unused", txIds: [] },
        },
        claimFees: {
          type: "fail",
          error: new AmbiguousSubmissionError("claim response lost", {
            operation: "CLAIM_FEES",
            positionId: "pos_001",
            txIds: ["tx_claim_maybe"],
          }),
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      stateRepository,
      journalRepository: failingJournal,
      now: () => "2026-04-22T10:01:00.000Z",
    });

    expect(result.nextStatus).toBe("WAITING_CONFIRMATION");
    expect((await stateRepository.get("pos_001"))?.status).toBe(
      "RECONCILIATION_REQUIRED",
    );
  });

  it("returns WAITING_CONFIRMATION and preserves CLAIMING when claim submitted journal fails after a successful submit", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    await stateRepository.upsert(buildOpenPosition());
    const action = await requestClaimFees({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: { reason: "claim before close" },
      requestedBy: "system",
      requestedAt: "2026-04-22T10:00:00.000Z",
    });

    const failingJournal = {
      async append() {
        throw new Error("journal unavailable");
      },
    } as unknown as JournalRepository;

    const result = await processClaimFeesAction({
      action,
      dlmmGateway: new MockDlmmGateway({
        getPosition: { type: "success", value: buildOpenPosition() },
        deployLiquidity: {
          type: "success",
          value: { actionType: "DEPLOY", positionId: "unused", txIds: [] },
        },
        closePosition: {
          type: "success",
          value: { actionType: "CLOSE", closedPositionId: "unused", txIds: [] },
        },
        claimFees: {
          type: "success",
          value: {
            actionType: "CLAIM_FEES",
            claimedBaseAmount: 1,
            txIds: ["tx_claim"],
          },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      stateRepository,
      journalRepository: failingJournal,
      now: () => "2026-04-22T10:01:00.000Z",
    });

    expect(result.nextStatus).toBe("WAITING_CONFIRMATION");
    expect((await stateRepository.get("pos_001"))?.status).toBe("CLAIMING");
  });

  it("returns FINALIZED when CLAIM_FINALIZED journal append fails after OPEN/DONE persistence", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });

    await stateRepository.upsert(
      buildOpenPosition({
        status: "RECONCILING",
        needsReconciliation: true,
        lastWriteActionId: "act_claim_final_journal_fail",
      }),
    );
    await actionRepository.upsert({
      actionId: "act_claim_final_journal_fail",
      type: "CLAIM_FEES",
      status: "RECONCILING",
      wallet: "wallet_001",
      positionId: "pos_001",
      idempotencyKey: "claim:final-journal-fail",
      requestPayload: { reason: "operator claim" },
      resultPayload: {
        actionType: "CLAIM_FEES",
        claimedBaseAmount: 1,
        txIds: ["tx_claim"],
        reason: "operator claim",
        autoSwapOutputMint: null,
        autoSwap: null,
        autoCompound: null,
      },
      txIds: ["tx_claim"],
      error: null,
      requestedAt: "2026-04-22T10:00:00.000Z",
      startedAt: "2026-04-22T10:00:30.000Z",
      completedAt: null,
      requestedBy: "system",
    });

    const failingJournal = {
      async append(event: { eventType?: string }) {
        if (event.eventType === "CLAIM_FINALIZED") {
          throw new Error("journal unavailable");
        }
      },
    } as unknown as JournalRepository;

    const finalized = await finalizeClaimFees({
      actionId: "act_claim_final_journal_fail",
      actionRepository,
      stateRepository,
      dlmmGateway: new MockDlmmGateway({
        getPosition: { type: "success", value: buildOpenPosition() },
        deployLiquidity: {
          type: "success",
          value: { actionType: "DEPLOY", positionId: "unused", txIds: [] },
        },
        closePosition: {
          type: "success",
          value: { actionType: "CLOSE", closedPositionId: "unused", txIds: [] },
        },
        claimFees: {
          type: "success",
          value: { actionType: "CLAIM_FEES", claimedBaseAmount: 1, txIds: [] },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      journalRepository: failingJournal,
      now: () => "2026-04-22T10:05:00.000Z",
    });

    expect(finalized.outcome).toBe("FINALIZED");
    expect(finalized.action.status).toBe("DONE");
    expect(finalized.position?.status).toBe("OPEN");
  });

  it("keeps auto-compound as DEPLOY_QUEUED when child deploy already exists but requestDeploy throws", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });

    await stateRepository.upsert(
      buildOpenPosition({
        status: "RECONCILING",
        needsReconciliation: true,
        lastWriteActionId: "act_claim_child_exists",
      }),
    );
    await actionRepository.upsert({
      actionId: "act_claim_child_exists",
      type: "CLAIM_FEES",
      status: "RECONCILING",
      wallet: "wallet_001",
      positionId: "pos_001",
      idempotencyKey: "claim:child-exists",
      requestPayload: { reason: "auto compound claimed fees" },
      resultPayload: {
        actionType: "CLAIM_FEES",
        claimedBaseAmount: 1,
        txIds: ["tx_claim"],
        reason: "auto compound claimed fees",
        autoSwapOutputMint: null,
        autoSwap: null,
        autoCompound: {
          outputMint: "mint_y",
          phase: "SWAP_DONE",
          deployTemplate: {
            poolAddress: "pool_001",
            tokenXMint: "mint_x",
            tokenYMint: "mint_y",
            baseMint: "mint_x",
            quoteMint: "mint_y",
            strategy: "spot",
            rangeLowerBin: 10,
            rangeUpperBin: 20,
            initialActiveBin: 15,
          },
          swap: { outputAmount: 3, outputAmountUi: 3, outputAmountUsd: 30 },
          error: null,
        },
      },
      txIds: ["tx_claim"],
      error: null,
      requestedAt: "2026-04-22T10:00:00.000Z",
      startedAt: "2026-04-22T10:00:30.000Z",
      completedAt: null,
      requestedBy: "system",
    });
    await actionRepository.upsert({
      actionId: "act_child_deploy_existing",
      type: "DEPLOY",
      status: "QUEUED",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: "act_claim_child_exists:AUTO_COMPOUND_DEPLOY",
      requestPayload: { strategy: "spot", amountSol: 0.1 },
      resultPayload: null,
      txIds: [],
      error: null,
      requestedAt: "2026-04-22T10:01:00.000Z",
      startedAt: null,
      completedAt: null,
      requestedBy: "system",
    });

    const failingActionQueue = {
      async enqueue() {
        throw new Error("post-enqueue edge case");
      },
    } as unknown as ActionQueue;

    const finalized = await finalizeClaimFees({
      actionId: "act_claim_child_exists",
      actionRepository,
      stateRepository,
      actionQueue: failingActionQueue,
      compoundDeployRiskGuard: buildCompoundDeployRiskGuard(),
      dlmmGateway: new MockDlmmGateway({
        getPosition: { type: "success", value: buildOpenPosition() },
        deployLiquidity: {
          type: "success",
          value: { actionType: "DEPLOY", positionId: "unused", txIds: [] },
        },
        closePosition: {
          type: "success",
          value: { actionType: "CLOSE", closedPositionId: "unused", txIds: [] },
        },
        claimFees: {
          type: "success",
          value: { actionType: "CLAIM_FEES", claimedBaseAmount: 1, txIds: [] },
        },
        partialClosePosition: {
          type: "success",
          value: {
            actionType: "PARTIAL_CLOSE",
            closedPositionId: "unused",
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
            pairLabel: "X-Y",
            binStep: 100,
            activeBin: 15,
          },
        },
      }),
      now: () => "2026-04-22T10:05:00.000Z",
    });

    expect(finalized.action.status).toBe("DONE");
    expect(finalized.action.resultPayload).toMatchObject({
      autoCompound: {
        phase: "DEPLOY_QUEUED",
        deployActionId: "act_child_deploy_existing",
      },
    });
  });

  it("returns accepted action when CLAIM_REQUEST_ACCEPTED journal fails", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    await stateRepository.upsert(buildOpenPosition({
      positionId: "pos_claim_request_journal_fail",
    }));

    const failingJournal = {
      async append() {
        throw new Error("journal unavailable");
      },
    } as unknown as JournalRepository;

    const action = await requestClaimFees({
      actionQueue,
      stateRepository,
      journalRepository: failingJournal,
      wallet: "wallet_001",
      positionId: "pos_claim_request_journal_fail",
      payload: { reason: "operator claim" },
      requestedBy: "operator",
    });

    expect(action.type).toBe("CLAIM_FEES");
    expect(action.status).toBe("QUEUED");

    const persistedAction = await actionRepository.get(action.actionId);
    expect(persistedAction?.status).toBe("QUEUED");
  });
});
