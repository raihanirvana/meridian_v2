import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MockDlmmGateway,
  type MockDlmmGatewayBehaviors,
} from "../../../src/adapters/dlmm/DlmmGateway.js";
import { ActionRepository } from "../../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../../src/adapters/storage/JournalRepository.js";
import { FileLessonRepository } from "../../../src/adapters/storage/LessonRepository.js";
import { FilePerformanceRepository } from "../../../src/adapters/storage/PerformanceRepository.js";
import { StateRepository } from "../../../src/adapters/storage/StateRepository.js";
import { ActionQueue } from "../../../src/app/services/ActionQueue.js";
import { createRecordPositionPerformanceLessonHook } from "../../../src/app/services/PerformanceLessonHook.js";
import {
  finalizeClose,
  type LessonHook,
} from "../../../src/app/usecases/finalizeClose.js";
import { processCloseAction } from "../../../src/app/usecases/processCloseAction.js";
import { reconcilePortfolio } from "../../../src/app/usecases/reconcilePortfolio.js";
import { requestClose } from "../../../src/app/usecases/requestClose.js";
import { type Position } from "../../../src/domain/entities/Position.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-close-idempotency-"),
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
    activeBin: 15,
    outOfRangeSince: null,
    lastManagementDecision: null,
    lastManagementReason: null,
    lastWriteActionId: null,
    needsReconciliation: false,
    entryMetadata: {
      poolName: "SOL-USDC",
      binStep: 100,
      volatility: 12,
      feeTvlRatio: 0.14,
      organicScore: 78,
      amountSol: 1.5,
    },
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
      value: { wallet: "wallet_001", positions: [] },
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

async function bootstrap(directory: string) {
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
  return {
    actionRepository,
    stateRepository,
    journalRepository,
    lessonRepository,
    performanceRepository,
    actionQueue,
  };
}

describe("finalizeClose lesson hook idempotency", () => {
  it("does not duplicate performance records when finalizeClose is invoked twice", async () => {
    const directory = await makeTempDir();
    const stores = await bootstrap(directory);
    await stores.stateRepository.upsert(buildOpenPosition("pos_001"));

    const action = await requestClose({
      actionQueue: stores.actionQueue,
      stateRepository: stores.stateRepository,
      journalRepository: stores.journalRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: { reason: "take profit close" },
      requestedBy: "operator",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    await stores.actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close"],
            },
          },
        }),
        stateRepository: stores.stateRepository,
        journalRepository: stores.journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const lessonHook = createRecordPositionPerformanceLessonHook({
      lessonRepository: stores.lessonRepository,
      performanceRepository: stores.performanceRepository,
      journalRepository: stores.journalRepository,
    });

    const first = await finalizeClose({
      actionId: action.actionId,
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_001"),
        },
      }),
      journalRepository: stores.journalRepository,
      lessonHook,
      now: () => "2026-04-20T00:05:00.000Z",
    });
    expect(first.outcome).toBe("FINALIZED");
    expect(await stores.performanceRepository.list()).toHaveLength(1);

    const second = await finalizeClose({
      actionId: action.actionId,
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_001"),
        },
      }),
      journalRepository: stores.journalRepository,
      lessonHook,
      now: () => "2026-04-20T00:06:00.000Z",
    });
    expect(second.outcome).toBe("UNCHANGED");
    expect(await stores.performanceRepository.list()).toHaveLength(1);

    const journal = await stores.journalRepository.list();
    const recordedEvents = journal.filter(
      (event) => event.eventType === "PERFORMANCE_RECORDED",
    );
    expect(recordedEvents).toHaveLength(1);
  });

  it("records performance on the second finalizeClose when first finalize crashed before the lesson hook", async () => {
    const directory = await makeTempDir();
    const stores = await bootstrap(directory);
    await stores.stateRepository.upsert(buildOpenPosition("pos_001"));

    const action = await requestClose({
      actionQueue: stores.actionQueue,
      stateRepository: stores.stateRepository,
      journalRepository: stores.journalRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: { reason: "take profit close" },
      requestedBy: "operator",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    await stores.actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close"],
            },
          },
        }),
        stateRepository: stores.stateRepository,
        journalRepository: stores.journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const throwingLessonHook: LessonHook = async () => {
      throw new Error("simulated crash before lesson recording");
    };

    const first = await finalizeClose({
      actionId: action.actionId,
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_001"),
        },
      }),
      journalRepository: stores.journalRepository,
      lessonHook: throwingLessonHook,
      now: () => "2026-04-20T00:05:00.000Z",
    });
    expect(first.outcome).toBe("FINALIZED");
    expect(await stores.performanceRepository.list()).toHaveLength(0);

    const lessonHookFailed = (await stores.journalRepository.list()).find(
      (event) => event.eventType === "LESSON_HOOK_FAILED",
    );
    expect(lessonHookFailed).toBeDefined();
    expect(lessonHookFailed?.error).toContain("simulated crash");

    const recoveryLessonHook = createRecordPositionPerformanceLessonHook({
      lessonRepository: stores.lessonRepository,
      performanceRepository: stores.performanceRepository,
      journalRepository: stores.journalRepository,
    });

    const recovered = await finalizeClose({
      actionId: action.actionId,
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_001"),
        },
      }),
      journalRepository: stores.journalRepository,
      lessonHook: recoveryLessonHook,
      now: () => "2026-04-20T00:06:00.000Z",
    });
    expect(recovered.outcome).toBe("UNCHANGED");
    const recoveredPerformance = await stores.performanceRepository.list();
    expect(recoveredPerformance).toHaveLength(1);
    expect(recoveredPerformance[0]?.initialValueUsd).toBe(30);
    expect(recoveredPerformance[0]?.finalValueUsd).toBe(60);
    expect(recoveredPerformance[0]?.pnlPct).toBe(100);

    const performanceRecorded = (await stores.journalRepository.list()).filter(
      (event) => event.eventType === "PERFORMANCE_RECORDED",
    );
    expect(performanceRecorded).toHaveLength(1);
  });

  it("reconciliation retries missing performance after a DONE close lesson hook failure", async () => {
    const directory = await makeTempDir();
    const stores = await bootstrap(directory);
    await stores.stateRepository.upsert(buildOpenPosition("pos_001"));

    const action = await requestClose({
      actionQueue: stores.actionQueue,
      stateRepository: stores.stateRepository,
      journalRepository: stores.journalRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: { reason: "take profit close" },
      requestedBy: "operator",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    await stores.actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({}),
        stateRepository: stores.stateRepository,
        journalRepository: stores.journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const first = await finalizeClose({
      actionId: action.actionId,
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_001"),
        },
      }),
      journalRepository: stores.journalRepository,
      lessonHook: async () => {
        throw new Error("temporary learning store outage");
      },
      now: () => "2026-04-20T00:05:00.000Z",
    });
    expect(first.outcome).toBe("FINALIZED");
    expect(await stores.performanceRepository.list()).toHaveLength(0);

    const recoveryLessonHook = createRecordPositionPerformanceLessonHook({
      lessonRepository: stores.lessonRepository,
      performanceRepository: stores.performanceRepository,
      journalRepository: stores.journalRepository,
    });

    const recovery = await reconcilePortfolio({
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: buildGateway({}),
      journalRepository: stores.journalRepository,
      lessonHook: recoveryLessonHook,
      now: () => "2026-04-20T00:06:00.000Z",
    });

    expect(
      recovery.records.some((record) =>
        record.detail.includes("Terminal close action learning"),
      ),
    ).toBe(true);
    const recoveredPerformance = await stores.performanceRepository.list();
    expect(recoveredPerformance).toHaveLength(1);
    expect(recoveredPerformance[0]?.finalValueUsd).toBe(60);
  });

  it("reconciliation recovers a RECONCILING close from durable performance snapshot", async () => {
    const directory = await makeTempDir();
    const stores = await bootstrap(directory);
    await stores.stateRepository.upsert(buildOpenPosition("pos_001"));

    const action = await requestClose({
      actionQueue: stores.actionQueue,
      stateRepository: stores.stateRepository,
      journalRepository: stores.journalRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: { reason: "take profit close" },
      requestedBy: "operator",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    await stores.actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({}),
        stateRepository: stores.stateRepository,
        journalRepository: stores.journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const waitingAction = await stores.actionRepository.get(action.actionId);
    if (waitingAction === null) {
      throw new Error("expected waiting close action");
    }
    const performanceSnapshot = buildCloseConfirmedPosition("pos_001");
    await stores.actionRepository.upsert({
      ...waitingAction,
      status: "RECONCILING",
      resultPayload: {
        actionType: "CLOSE",
        closedPositionId: "pos_001",
        txIds: ["tx_close"],
        performanceSnapshot,
      },
    });
    await stores.stateRepository.upsert({
      ...performanceSnapshot,
      status: "CLOSED",
      currentValueBase: 0,
      currentValueQuote: 0,
      currentValueUsd: 0,
      unrealizedPnlBase: 0,
      unrealizedPnlUsd: 0,
    });

    const recoveryLessonHook = createRecordPositionPerformanceLessonHook({
      lessonRepository: stores.lessonRepository,
      performanceRepository: stores.performanceRepository,
      journalRepository: stores.journalRepository,
    });

    await reconcilePortfolio({
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: buildGateway({}),
      journalRepository: stores.journalRepository,
      lessonHook: recoveryLessonHook,
      now: () => "2026-04-20T00:06:00.000Z",
    });

    const recoveredPerformance = await stores.performanceRepository.list();
    expect(recoveredPerformance).toHaveLength(1);
    expect(recoveredPerformance[0]?.finalValueUsd).toBe(60);
    expect(recoveredPerformance[0]?.initialValueUsd).toBe(30);
  });
});
