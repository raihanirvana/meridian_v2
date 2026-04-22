import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MockDlmmGateway,
  type MockDlmmGatewayBehaviors,
} from "../../src/adapters/dlmm/DlmmGateway.js";
import { FileRuntimePolicyStore } from "../../src/adapters/config/RuntimePolicyStore.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { FileLessonRepository } from "../../src/adapters/storage/LessonRepository.js";
import { FilePerformanceRepository } from "../../src/adapters/storage/PerformanceRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { createRecordPositionPerformanceLessonHook } from "../../src/app/services/PerformanceLessonHook.js";
import { finalizeClose } from "../../src/app/usecases/finalizeClose.js";
import { processCloseAction } from "../../src/app/usecases/processCloseAction.js";
import { requestClose } from "../../src/app/usecases/requestClose.js";
import { type PerformanceRecord } from "../../src/domain/entities/PerformanceRecord.js";
import { type Position } from "../../src/domain/entities/Position.js";
import { type ScreeningPolicy } from "../../src/domain/rules/screeningRules.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v2-close-"));
  tempDirs.push(directory);
  return directory;
}

function buildOpenPosition(
  positionId: string,
  overrides: Partial<Position> = {},
): Position {
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
    feesClaimedBase: 0.05,
    feesClaimedUsd: 5,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: 0.2,
    unrealizedPnlUsd: 20,
    rebalanceCount: 0,
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
    ...overrides,
  };
}

function buildManagementReviewPosition(positionId: string): Position {
  return {
    ...buildOpenPosition(positionId),
    status: "MANAGEMENT_REVIEW",
    lastManagementDecision: "HOLD",
    lastManagementReason: "review in progress",
  };
}

function buildCloseConfirmedPosition(positionId: string): Position {
  return {
    ...buildOpenPosition(positionId),
    status: "CLOSE_CONFIRMED",
    closedAt: "2026-04-20T00:05:00.000Z",
    currentValueBase: 0.1,
    currentValueUsd: 10,
    feesClaimedBase: 0.2,
    feesClaimedUsd: 20,
    realizedPnlBase: 0.3,
    realizedPnlUsd: 30,
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
        closedPositionId: "pos_001",
        txIds: ["tx_close"],
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

function buildPolicy(overrides: Partial<ScreeningPolicy> = {}): ScreeningPolicy {
  return {
    minMarketCapUsd: 150_000,
    maxMarketCapUsd: 10_000_000,
    minTvlUsd: 10_000,
    minVolumeUsd: 5_000,
    minFeeActiveTvlRatio: 0.1,
    minOrganic: 60,
    minHolderCount: 500,
    allowedBinSteps: [80, 100, 125],
    blockedLaunchpads: [],
    blockedTokenMints: [],
    blockedDeployers: [],
    allowedPairTypes: ["volatile", "stable"],
    maxTopHolderPct: 35,
    maxBotHolderPct: 20,
    maxBundleRiskPct: 20,
    maxWashTradingRiskPct: 20,
    rejectDuplicatePoolExposure: true,
    rejectDuplicateTokenExposure: true,
    shortlistLimit: 2,
    ...overrides,
  };
}

function buildPerformance(overrides: Partial<PerformanceRecord> = {}): PerformanceRecord {
  return {
    positionId: "seed_pos",
    wallet: "wallet_001",
    pool: "pool_001",
    poolName: "SOL-USDC",
    baseMint: "mint_base",
    strategy: "bid_ask",
    binStep: 100,
    binRangeLower: 10,
    binRangeUpper: 20,
    volatility: 12,
    feeTvlRatio: 0.12,
    organicScore: 75,
    amountSol: 1,
    initialValueUsd: 100,
    finalValueUsd: 105,
    feesEarnedUsd: 2,
    pnlUsd: 5,
    pnlPct: 5,
    rangeEfficiencyPct: 80,
    minutesHeld: 120,
    minutesInRange: 96,
    closeReason: "take_profit",
    deployedAt: "2026-04-19T00:00:00.000Z",
    closedAt: "2026-04-19T02:00:00.000Z",
    recordedAt: "2026-04-19T02:00:00.000Z",
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

describe("close flow", () => {
  it("processes a close from request through accounting finalization", async () => {
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
    await stateRepository.upsert(
      buildOpenPosition("pos_001", {
        entryMetadata: {
          poolName: "SOL-USDC",
          binStep: 100,
          volatility: 12,
          feeTvlRatio: 0.14,
          organicScore: 78,
          amountSol: 1.5,
        },
      }),
    );

    const action = await requestClose({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "operator close",
      },
      requestedBy: "operator",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    const processGateway = buildGateway({
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "pos_001",
          txIds: ["tx_close_001"],
        },
      },
    });

    const queuedResult = await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: processGateway,
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    expect(queuedResult?.status).toBe("WAITING_CONFIRMATION");

    const closingPosition = await stateRepository.get("pos_001");
    expect(closingPosition?.status).toBe("CLOSING");
    expect(closingPosition?.lastManagementDecision).toBe("CLOSE");

    const finalizeGateway = buildGateway({
      getPosition: {
        type: "success",
        value: buildCloseConfirmedPosition("pos_001"),
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "pos_001",
          txIds: ["tx_close_001"],
        },
      },
    });

    const finalized = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: finalizeGateway,
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
      postCloseSwapHook: async () => ({
        txId: "swap_close_001",
        mode: "disabled",
      }),
    });

    expect(finalized.outcome).toBe("FINALIZED");
    expect(finalized.action.status).toBe("DONE");
    expect(finalized.position?.status).toBe("CLOSED");
    expect(finalized.position?.currentValueUsd).toBe(0);
    expect(finalized.position?.realizedPnlUsd).toBe(30);
    expect(finalized.position?.outOfRangeSince).toBe("2026-04-19T23:00:00.000Z");

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get("pos_001");
    const journalEvents = await journalRepository.list();

    expect(persistedAction?.status).toBe("DONE");
    expect(
      (persistedAction?.resultPayload?.accounting as { postCloseSwap?: { txId?: string } })
        ?.postCloseSwap?.txId,
    ).toBe("swap_close_001");
    expect(persistedPosition?.status).toBe("CLOSED");
    expect(journalEvents.map((event) => event.eventType)).toContain(
      "CLOSE_FINALIZED",
    );
  });

  it("records performance and lesson via lesson hook after close finalization", async () => {
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
    const lessonsFilePath = path.join(directory, "lessons.json");
    const lessonRepository = new FileLessonRepository({
      filePath: lessonsFilePath,
    });
    const performanceRepository = new FilePerformanceRepository({
      filePath: lessonsFilePath,
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });
    await stateRepository.upsert(
      buildOpenPosition("pos_001", {
        entryMetadata: {
          poolName: "SOL-USDC",
          binStep: 100,
          volatility: 12,
          feeTvlRatio: 0.14,
          organicScore: 78,
          amountSol: 1.5,
        },
      }),
    );

    const action = await requestClose({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "take profit close",
      },
      requestedBy: "operator",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close_profit"],
            },
          },
        }),
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const finalized = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_001"),
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "pos_001",
            txIds: ["tx_close_profit"],
          },
        },
      }),
      journalRepository,
      lessonHook: createRecordPositionPerformanceLessonHook({
        lessonRepository,
        performanceRepository,
        journalRepository,
      }),
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("FINALIZED");
    const performance = await performanceRepository.list();
    expect(performance).toHaveLength(1);
    expect(performance[0]).toMatchObject({
      poolName: "SOL-USDC",
      binStep: 100,
      volatility: 12,
      feeTvlRatio: 0.14,
      organicScore: 78,
      amountSol: 1.5,
    });
    expect((await lessonRepository.list())).toHaveLength(1);
    expect((await journalRepository.list()).map((event) => event.eventType)).toContain(
      "LESSON_RECORDED",
    );
  });

  it("auto-evolves runtime policy after the fifth recorded close performance", async () => {
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
    const lessonsFilePath = path.join(directory, "lessons.json");
    const lessonRepository = new FileLessonRepository({
      filePath: lessonsFilePath,
    });
    const performanceRepository = new FilePerformanceRepository({
      filePath: lessonsFilePath,
    });
    const runtimePolicyStore = new FileRuntimePolicyStore({
      filePath: path.join(directory, "policy-overrides.json"),
      basePolicy: buildPolicy({
        minFeeActiveTvlRatio: 0.06,
      }),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    for (const record of [
      buildPerformance({ positionId: "w1", pnlPct: 10, feeTvlRatio: 0.30, organicScore: 88 }),
      buildPerformance({ positionId: "w2", pnlPct: 9, feeTvlRatio: 0.28, organicScore: 86 }),
      buildPerformance({ positionId: "w3", pnlPct: 8, feeTvlRatio: 0.32, organicScore: 84 }),
      buildPerformance({ positionId: "l1", pnlPct: -8, pnlUsd: -8, feeTvlRatio: 0.07, organicScore: 61 }),
    ]) {
      await performanceRepository.append(record);
    }

    await stateRepository.upsert(buildOpenPosition("pos_001"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "take profit close",
      },
      requestedBy: "operator",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close_profit"],
            },
          },
        }),
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const finalized = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: {
            ...buildCloseConfirmedPosition("pos_001"),
            feesClaimedUsd: 0,
            realizedPnlUsd: -10,
            currentValueUsd: 90,
          },
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "pos_001",
            txIds: ["tx_close_profit"],
          },
        },
      }),
      journalRepository,
      lessonHook: createRecordPositionPerformanceLessonHook({
        lessonRepository,
        performanceRepository,
        runtimePolicyStore,
        journalRepository,
      }),
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("FINALIZED");
    expect((await performanceRepository.list())).toHaveLength(5);
    expect((await lessonRepository.list()).some((lesson) => lesson.outcome === "evolution")).toBe(
      true,
    );
    expect(Object.keys((await runtimePolicyStore.snapshot()).overrides).length).toBeGreaterThan(0);
    expect((await journalRepository.list()).map((event) => event.eventType)).toContain(
      "POLICY_EVOLVED",
    );
  });

  it("accepts close requests from MANAGEMENT_REVIEW and moves the position to CLOSING", async () => {
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
    await stateRepository.upsert(buildManagementReviewPosition("pos_review"));

    await requestClose({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_review",
      payload: {
        reason: "operator override",
      },
      requestedBy: "operator",
    });

    const queuedResult = await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_review",
              txIds: ["tx_review"],
            },
          },
        }),
        stateRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const persistedPosition = await stateRepository.get("pos_review");

    expect(queuedResult?.status).toBe("WAITING_CONFIRMATION");
    expect(persistedPosition?.status).toBe("CLOSING");
    expect(persistedPosition?.lastManagementReason).toBe("operator override");
  });

  it("marks close as TIMED_OUT and position as RECONCILIATION_REQUIRED when confirmation never appears", async () => {
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
    await stateRepository.upsert(buildOpenPosition("pos_timeout"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_timeout",
      payload: {
        reason: "timeout test",
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
              closedPositionId: "pos_timeout",
              txIds: ["tx_close_timeout"],
            },
          },
        }),
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const finalized = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: { type: "success", value: null },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "pos_timeout",
            txIds: ["tx_close_timeout"],
          },
        },
      }),
      journalRepository,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    expect(finalized.outcome).toBe("TIMED_OUT");
    expect(finalized.action.status).toBe("TIMED_OUT");
    expect(finalized.position?.status).toBe("RECONCILIATION_REQUIRED");
    expect(finalized.position?.needsReconciliation).toBe(true);
  });

  it("marks close as reconciliation-required when accounting finalization fails after confirmation", async () => {
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
    await stateRepository.upsert(buildOpenPosition("pos_fail"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_fail",
      payload: {
        reason: "accounting failure test",
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
              closedPositionId: "pos_fail",
              txIds: ["tx_close_fail"],
            },
          },
        }),
        stateRepository,
        journalRepository,
      }),
    );

    const finalized = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_fail"),
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "pos_fail",
            txIds: ["tx_close_fail"],
          },
        },
      }),
      journalRepository,
      postCloseSwapHook: async () => {
        throw new Error("post-close accounting hook failed");
      },
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("RECONCILIATION_REQUIRED");
    expect(finalized.action.status).toBe("FAILED");
    expect(finalized.position?.status).toBe("RECONCILIATION_REQUIRED");
    expect(finalized.position?.needsReconciliation).toBe(true);
  });

  it("returns UNCHANGED when finalizer is called again after the action is already DONE", async () => {
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
    await stateRepository.upsert(buildOpenPosition("pos_repeat"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_repeat",
      payload: {
        reason: "repeat finalizer test",
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
              closedPositionId: "pos_repeat",
              txIds: ["tx_repeat"],
            },
          },
        }),
        stateRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const finalizeGateway = buildGateway({
      getPosition: {
        type: "success",
        value: buildCloseConfirmedPosition("pos_repeat"),
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "pos_repeat",
          txIds: ["tx_repeat"],
        },
      },
    });

    const firstResult = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: finalizeGateway,
      now: () => "2026-04-20T00:05:00.000Z",
    });
    const secondResult = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: finalizeGateway,
      now: () => "2026-04-20T00:06:00.000Z",
    });

    expect(firstResult.outcome).toBe("FINALIZED");
    expect(secondResult.outcome).toBe("UNCHANGED");
    expect(secondResult.action.status).toBe("DONE");
    expect(secondResult.position?.status).toBe("CLOSED");
  });
});
