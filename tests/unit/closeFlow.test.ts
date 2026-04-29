import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AmbiguousSubmissionError,
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
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-close-"),
  );
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

function buildPolicy(
  overrides: Partial<ScreeningPolicy> = {},
): ScreeningPolicy {
  return {
    timeframe: "5m",
    minMarketCapUsd: 150_000,
    maxMarketCapUsd: 10_000_000,
    minTvlUsd: 10_000,
    minVolumeUsd: 5_000,
    minFeeActiveTvlRatio: 0.1,
    minFeePerTvl24h: 0.01,
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

function buildPerformance(
  overrides: Partial<PerformanceRecord> = {},
): PerformanceRecord {
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
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
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
    expect(finalized.position?.outOfRangeSince).toBe(
      "2026-04-19T23:00:00.000Z",
    );

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get("pos_001");
    const journalEvents = await journalRepository.list();

    expect(persistedAction?.status).toBe("DONE");
    expect(
      (
        persistedAction?.resultPayload?.accounting as {
          postCloseSwap?: { txId?: string };
          sourceConfidence?: string;
        }
      )?.postCloseSwap?.txId,
    ).toBe("swap_close_001");
    expect(
      (
        persistedAction?.resultPayload?.accounting as {
          sourceConfidence?: string;
        }
      )?.sourceConfidence,
    ).toBe("unavailable");
    expect(persistedPosition?.status).toBe("CLOSED");
    expect(journalEvents.map((event) => event.eventType)).toContain(
      "CLOSE_FINALIZED",
    );
  });

  it("includes close proceeds and stable swap intent in final close accounting", async () => {
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
    let capturedSwapIntentId: string | null = null;

    await stateRepository.upsert(buildOpenPosition("pos_proceeds"));
    const action = await requestClose({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_proceeds",
      payload: { reason: "capture proceeds" },
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
              closedPositionId: "pos_proceeds",
              txIds: ["tx_close_proceeds"],
              preCloseFeesClaimed: true,
              releasedAmountBase: 1.25,
              releasedAmountQuote: 0.75,
              estimatedReleasedValueUsd: 128,
              releasedAmountSource: "post_tx",
            },
          },
        }),
        stateRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_proceeds"),
        },
      }),
      postCloseSwapHook: async (input) => {
        capturedSwapIntentId = input.swapIntentId;
        return {
          swapIntentId: input.swapIntentId,
          status: "SKIPPED",
        };
      },
      now: () => "2026-04-20T00:05:00.000Z",
    });

    const persistedAction = await actionRepository.get(action.actionId);
    const accounting = persistedAction?.resultPayload?.accounting as {
      releasedAmountBase?: number;
      releasedAmountQuote?: number;
      estimatedReleasedValueUsd?: number;
      releasedAmountSource?: string;
      preCloseFeesClaimed?: boolean;
      sourceConfidence?: string;
      postCloseSwap?: { swapIntentId?: string };
    };

    expect(capturedSwapIntentId).toBe(`${action.actionId}:POST_CLOSE_SWAP`);
    expect(accounting.releasedAmountBase).toBe(1.25);
    expect(accounting.releasedAmountQuote).toBe(0.75);
    expect(accounting.estimatedReleasedValueUsd).toBe(128);
    expect(accounting.releasedAmountSource).toBe("post_tx");
    expect(accounting.sourceConfidence).toBe("post_tx");
    expect(accounting.preCloseFeesClaimed).toBe(true);
    expect(accounting.postCloseSwap?.swapIntentId).toBe(
      `${action.actionId}:POST_CLOSE_SWAP`,
    );
  });

  it("routes ambiguous close submission to WAITING_CONFIRMATION + reconciliation instead of FAILED", async () => {
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

    await stateRepository.upsert(buildOpenPosition("pos_001"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: { reason: "operator close" },
      requestedBy: "operator",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    const ambiguousError = new AmbiguousSubmissionError(
      "rpc submit timed out after broadcast",
      {
        operation: "CLOSE",
        positionId: "pos_001",
        txIds: ["tx_close_maybe_sent"],
      },
    );

    const queuedResult = await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: { type: "fail", error: ambiguousError },
        }),
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get("pos_001");
    const events = await journalRepository.list();

    expect(queuedResult?.status).toBe("WAITING_CONFIRMATION");
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
    expect(persistedAction?.txIds).toEqual(["tx_close_maybe_sent"]);
    expect(persistedPosition?.status).toBe("RECONCILIATION_REQUIRED");
    expect(persistedPosition?.needsReconciliation).toBe(true);
    expect(events.map((event) => event.eventType)).toContain(
      "CLOSE_SUBMISSION_AMBIGUOUS",
    );
    expect(events.map((event) => event.eventType)).not.toContain(
      "CLOSE_SUBMISSION_FAILED",
    );
  });

  it("finalizes a close when Meteora no longer reports the position as open", async () => {
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

    await stateRepository.upsert(buildOpenPosition("pos_001"));

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

    await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_001",
              txIds: ["tx_close_001"],
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
      dlmmGateway: Object.assign(
        buildGateway({
          getPosition: {
            type: "success",
            value: null,
          },
        }),
        {
          reconciliationReadModel: "open_only" as const,
        },
      ),
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("FINALIZED");
    expect(finalized.action.status).toBe("DONE");
    expect(finalized.position?.status).toBe("CLOSED");
  });

  it("finalizes an ambiguous close from RECONCILIATION_REQUIRED when open_only returns null", async () => {
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

    await stateRepository.upsert(buildOpenPosition("pos_ambiguous_close"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_ambiguous_close",
      payload: {
        reason: "operator close",
      },
      requestedBy: "operator",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });

    const ambiguousError = new AmbiguousSubmissionError(
      "rpc submit timed out after broadcast",
      {
        operation: "CLOSE",
        positionId: "pos_ambiguous_close",
        txIds: ["tx_close_maybe_sent"],
      },
    );

    await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: { type: "fail", error: ambiguousError },
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
      dlmmGateway: Object.assign(buildGateway({}), {
        reconciliationReadModel: "open_only" as const,
      }),
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("FINALIZED");
    expect(finalized.action.status).toBe("DONE");
    expect(finalized.position?.status).toBe("CLOSED");
  });

  it("finalizes safely when local position is already CLOSED and open_only returns null", async () => {
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

    await stateRepository.upsert(buildOpenPosition("pos_closed_local"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_closed_local",
      payload: {
        reason: "operator close",
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
              closedPositionId: "pos_closed_local",
              txIds: ["tx_close_done"],
            },
          },
        }),
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    await stateRepository.upsert({
      ...buildOpenPosition("pos_closed_local"),
      status: "CLOSED",
      closedAt: "2026-04-20T00:05:00.000Z",
      currentValueBase: 0,
      currentValueUsd: 0,
      unrealizedPnlBase: 0,
      unrealizedPnlUsd: 0,
      needsReconciliation: false,
    });

    const finalized = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: Object.assign(buildGateway({}), {
        reconciliationReadModel: "open_only" as const,
      }),
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("FINALIZED");
    expect(finalized.action.status).toBe("DONE");
    expect(finalized.position?.status).toBe("CLOSED");
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
    expect(performance[0]?.initialValueUsd).toBe(30);
    expect(performance[0]?.finalValueUsd).toBe(60);
    expect(performance[0]?.pnlPct).toBe(100);
    expect(await lessonRepository.list()).toHaveLength(1);
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("LESSON_RECORDED");
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
      buildPerformance({
        positionId: "w1",
        pnlPct: 10,
        feeTvlRatio: 0.3,
        organicScore: 88,
      }),
      buildPerformance({
        positionId: "w2",
        pnlPct: 9,
        feeTvlRatio: 0.28,
        organicScore: 86,
      }),
      buildPerformance({
        positionId: "w3",
        pnlPct: 8,
        feeTvlRatio: 0.32,
        organicScore: 84,
      }),
      buildPerformance({
        positionId: "l1",
        pnlPct: -8,
        pnlUsd: -8,
        feeTvlRatio: 0.07,
        organicScore: 61,
      }),
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
    expect(await performanceRepository.list()).toHaveLength(5);
    expect(
      (await lessonRepository.list()).some(
        (lesson) => lesson.outcome === "evolution",
      ),
    ).toBe(true);
    expect(
      Object.keys((await runtimePolicyStore.snapshot()).overrides).length,
    ).toBeGreaterThan(0);
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("POLICY_EVOLVED");
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

  it("rejects mismatched close confirmation position identity", async () => {
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
    await stateRepository.upsert(buildOpenPosition("pos_001"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: {
        reason: "identity guard test",
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
              closedPositionId: "pos_001",
              txIds: ["tx_close_identity"],
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
          value: buildCloseConfirmedPosition("pos_wrong"),
        },
      }),
      journalRepository,
      now: () => "2026-04-20T00:10:00.000Z",
    });

    expect(finalized.outcome).toBe("TIMED_OUT");
    expect(finalized.action.status).toBe("TIMED_OUT");
    expect(finalized.action.error).toMatch(/mismatched positionId/i);
    expect((await stateRepository.get("pos_001"))?.status).toBe(
      "RECONCILIATION_REQUIRED",
    );
    expect(await stateRepository.get("pos_wrong")).toBeNull();
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

  it("resumes close finalization when the local CLOSED position was committed before the action finished", async () => {
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
    await stateRepository.upsert(buildOpenPosition("pos_resume_close"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_resume_close",
      payload: {
        reason: "resume close test",
      },
      requestedBy: "system",
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
              closedPositionId: "pos_resume_close",
              txIds: ["tx_resume_close"],
            },
          },
        }),
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    await stateRepository.upsert({
      ...buildCloseConfirmedPosition("pos_resume_close"),
      status: "CLOSED",
      currentValueBase: 0,
      currentValueUsd: 0,
      lastWriteActionId: action.actionId,
    });

    const resumed = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_resume_close"),
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "pos_resume_close",
            txIds: ["tx_resume_close"],
          },
        },
      }),
      journalRepository,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(resumed.outcome).toBe("FINALIZED");
    expect(resumed.action.status).toBe("DONE");
    expect(resumed.position?.status).toBe("CLOSED");
    expect(resumed.position?.needsReconciliation).toBe(false);
    expect((await actionRepository.get(action.actionId))?.status).toBe("DONE");
    expect((await stateRepository.get("pos_resume_close"))?.status).toBe(
      "CLOSED",
    );
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("CLOSE_FINALIZED");
  });

  it("does not invoke post-close swap hook again after a restart in POST_CLOSE_SWAP_IN_PROGRESS", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });

    await stateRepository.upsert({
      ...buildCloseConfirmedPosition("pos_swap_resume"),
      status: "RECONCILING",
      needsReconciliation: true,
      lastWriteActionId: "act_swap_resume",
    });

    await actionRepository.upsert({
      actionId: "act_swap_resume",
      type: "CLOSE",
      status: "RECONCILING",
      wallet: "wallet_001",
      positionId: "pos_swap_resume",
      idempotencyKey: "wallet_001:CLOSE:pos_swap_resume",
      requestPayload: {
        reason: "operator close",
      },
      resultPayload: {
        actionType: "CLOSE",
        closedPositionId: "pos_swap_resume",
        txIds: ["tx_swap_resume"],
        phase: "POST_CLOSE_SWAP_IN_PROGRESS",
        swapIntentId: "act_swap_resume:POST_CLOSE_SWAP",
      },
      txIds: ["tx_swap_resume"],
      error: null,
      requestedAt: "2026-04-20T00:01:00.000Z",
      startedAt: "2026-04-20T00:02:00.000Z",
      completedAt: null,
      requestedBy: "operator",
    });

    let hookCalls = 0;
    const finalized = await finalizeClose({
      actionId: "act_swap_resume",
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({}),
      postCloseSwapHook: async () => {
        hookCalls += 1;
        return { txId: "tx_swap_duplicate" };
      },
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(hookCalls).toBe(0);
    expect(finalized.outcome).toBe("RECONCILIATION_REQUIRED");
    expect(finalized.action.status).toBe("FAILED");
    expect(finalized.position?.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("does not execute post-close swap hook twice after hook success followed by persistence failure", async () => {
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
    await stateRepository.upsert(buildOpenPosition("pos_swap_persist_fail"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      journalRepository,
      wallet: "wallet_001",
      positionId: "pos_swap_persist_fail",
      payload: {
        reason: "operator close",
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
              closedPositionId: "pos_swap_persist_fail",
              txIds: ["tx_swap_persist_fail"],
            },
          },
        }),
        stateRepository,
        journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    let hookCalls = 0;
    let failClosedWrite = true;
    const flakyStateRepository = {
      get: (positionId: string) => stateRepository.get(positionId),
      list: () => stateRepository.list(),
      replaceAll: (positions: Position[]) => stateRepository.replaceAll(positions),
      upsert: async (position: Position) => {
        if (
          failClosedWrite &&
          position.positionId === "pos_swap_persist_fail" &&
          position.status === "CLOSED"
        ) {
          failClosedWrite = false;
          throw new Error("simulated closed position write failure");
        }

        return stateRepository.upsert(position);
      },
    } as StateRepository;

    const first = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository: flakyStateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_swap_persist_fail"),
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "pos_swap_persist_fail",
            txIds: ["tx_swap_persist_fail"],
          },
        },
      }),
      journalRepository,
      postCloseSwapHook: async () => {
        hookCalls += 1;
        return { txId: "tx_swap_once" };
      },
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(first.outcome).toBe("RECONCILIATION_REQUIRED");
    expect(hookCalls).toBe(1);

    const second = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_swap_persist_fail"),
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "pos_swap_persist_fail",
            txIds: ["tx_swap_persist_fail"],
          },
        },
      }),
      journalRepository,
      postCloseSwapHook: async () => {
        hookCalls += 1;
        return { txId: "tx_swap_twice_should_not_happen" };
      },
      now: () => "2026-04-20T00:06:00.000Z",
    });

    expect(second.outcome).toBe("UNCHANGED");
    expect(second.action.status).toBe("FAILED");
    expect(hookCalls).toBe(1);
  });

  it("calls closePosition even when CLOSE_SUBMITTING journal fails", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    await stateRepository.upsert(buildOpenPosition("pos_submitting_journal_fail"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_submitting_journal_fail",
      payload: { reason: "operator close" },
      requestedBy: "operator",
    });

    const failingJournal = {
      async append() {
        throw new Error("journal unavailable");
      },
    } as unknown as JournalRepository;

    const result = await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_submitting_journal_fail",
              txIds: ["tx_close_submitting"],
            },
          },
        }),
        stateRepository,
        journalRepository: failingJournal,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    expect(result?.status).toBe("WAITING_CONFIRMATION");

    const persistedAction = await actionRepository.get(action.actionId);
    expect(persistedAction?.status).toBe("WAITING_CONFIRMATION");

    const position = await stateRepository.get("pos_submitting_journal_fail");
    expect(position?.status).not.toBe("CLOSING");
  });

  it("returns WAITING_CONFIRMATION when both CLOSE_SUBMITTED journals fail after closePosition succeeds", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    await stateRepository.upsert(buildOpenPosition("pos_submitted_journal_fail"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_submitted_journal_fail",
      payload: { reason: "operator close" },
      requestedBy: "operator",
    });

    const failingJournal = {
      async append() {
        throw new Error("journal disk full");
      },
    } as unknown as JournalRepository;

    const result = await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_submitted_journal_fail",
              txIds: ["tx_close_submitted"],
            },
          },
        }),
        stateRepository,
        journalRepository: failingJournal,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    expect(result?.status).toBe("WAITING_CONFIRMATION");

    const persistedAction = await actionRepository.get(action.actionId);
    expect(persistedAction?.status).toBe("WAITING_CONFIRMATION");
  });

  it("keeps action DONE and position CLOSED when CLOSE_FINALIZED journal fails", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const realJournalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository: realJournalRepository,
    });

    await stateRepository.upsert(buildOpenPosition("pos_finalized_journal_fail"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      journalRepository: realJournalRepository,
      wallet: "wallet_001",
      positionId: "pos_finalized_journal_fail",
      payload: { reason: "operator close" },
      requestedBy: "operator",
    });

    await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_finalized_journal_fail",
              txIds: ["tx_close_finalized_fail"],
            },
          },
        }),
        stateRepository,
        journalRepository: realJournalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const selectiveFailJournal = {
      async append(event: { eventType: string }) {
        if (event.eventType === "CLOSE_FINALIZED") {
          throw new Error("journal disk full on finalize");
        }
        await realJournalRepository.append(event as never);
      },
    } as unknown as JournalRepository;

    const finalized = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: {
          type: "success",
          value: buildCloseConfirmedPosition("pos_finalized_journal_fail"),
        },
        closePosition: {
          type: "success",
          value: {
            actionType: "CLOSE",
            closedPositionId: "pos_finalized_journal_fail",
            txIds: ["tx_close_finalized_fail"],
          },
        },
      }),
      journalRepository: selectiveFailJournal,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("FINALIZED");
    expect(finalized.action.status).toBe("DONE");
    expect(finalized.position?.status).toBe("CLOSED");

    const persistedAction = await actionRepository.get(action.actionId);
    const persistedPosition = await stateRepository.get(
      "pos_finalized_journal_fail",
    );
    expect(persistedAction?.status).toBe("DONE");
    expect(persistedPosition?.status).toBe("CLOSED");
  });

  it("returns accepted action when CLOSE_REQUEST_ACCEPTED journal fails", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    await stateRepository.upsert(buildOpenPosition("pos_request_journal_fail"));

    const failingJournal = {
      async append() {
        throw new Error("journal unavailable");
      },
    } as unknown as JournalRepository;

    const action = await requestClose({
      actionQueue,
      stateRepository,
      journalRepository: failingJournal,
      wallet: "wallet_001",
      positionId: "pos_request_journal_fail",
      payload: { reason: "operator close" },
      requestedBy: "operator",
    });

    expect(action.type).toBe("CLOSE");
    expect(action.status).toBe("QUEUED");

    const persistedAction = await actionRepository.get(action.actionId);
    expect(persistedAction?.status).toBe("QUEUED");
  });

  it("rethrows the original close error when failure journaling also fails", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionQueue = new ActionQueue({
      actionRepository: new ActionRepository({
        filePath: path.join(directory, "actions.json"),
      }),
    });

    await stateRepository.upsert(buildOpenPosition("pos_close_error_mask"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      wallet: "wallet_001",
      positionId: "pos_close_error_mask",
      payload: { reason: "operator close" },
      requestedBy: "operator",
    });

    const failingJournal = {
      async append() {
        throw new Error("journal disk full");
      },
    } as unknown as JournalRepository;

    await expect(
      processCloseAction({
        action,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "fail",
            error: new Error("close rejected by rpc"),
          },
        }),
        stateRepository,
        journalRepository: failingJournal,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    ).rejects.toThrow(/close rejected by rpc/i);
  });

  it("returns TIMED_OUT when CLOSE_TIMED_OUT journal append fails after timeout persistence", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const realJournalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository: realJournalRepository,
    });

    await stateRepository.upsert(buildOpenPosition("pos_timeout_journal_fail"));

    const action = await requestClose({
      actionQueue,
      stateRepository,
      journalRepository: realJournalRepository,
      wallet: "wallet_001",
      positionId: "pos_timeout_journal_fail",
      payload: { reason: "operator close" },
      requestedBy: "operator",
    });

    await actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway({
          closePosition: {
            type: "success",
            value: {
              actionType: "CLOSE",
              closedPositionId: "pos_timeout_journal_fail",
              txIds: ["tx_close_timeout_journal_fail"],
            },
          },
        }),
        stateRepository,
        journalRepository: realJournalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const selectiveFailJournal = {
      async append(event: { eventType: string }) {
        if (event.eventType === "CLOSE_TIMED_OUT") {
          throw new Error("journal disk full on timeout");
        }
        await realJournalRepository.append(event as never);
      },
    } as unknown as JournalRepository;

    const finalized = await finalizeClose({
      actionId: action.actionId,
      actionRepository,
      stateRepository,
      dlmmGateway: buildGateway({
        getPosition: { type: "success", value: null },
      }),
      journalRepository: selectiveFailJournal,
      now: () => "2026-04-20T00:05:00.000Z",
    });

    expect(finalized.outcome).toBe("TIMED_OUT");
    expect(finalized.action.status).toBe("TIMED_OUT");
    expect(finalized.position?.status).toBe("RECONCILIATION_REQUIRED");
  });
});
