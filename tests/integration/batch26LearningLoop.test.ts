import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MockDlmmGateway,
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
import type { LlmGateway } from "../../src/adapters/llm/LlmGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { FileLessonRepository } from "../../src/adapters/storage/LessonRepository.js";
import { FilePerformanceRepository } from "../../src/adapters/storage/PerformanceRepository.js";
import { FilePoolMemoryRepository } from "../../src/adapters/storage/PoolMemoryRepository.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { rankShortlistWithAi } from "../../src/app/services/AiAdvisoryService.js";
import { DefaultLessonPromptService } from "../../src/app/services/LessonPromptService.js";
import { createRecordPositionPerformanceLessonHook } from "../../src/app/services/PerformanceLessonHook.js";
import { finalizeClose } from "../../src/app/usecases/finalizeClose.js";
import { finalizeRebalance } from "../../src/app/usecases/finalizeRebalance.js";
import { processCloseAction } from "../../src/app/usecases/processCloseAction.js";
import { processRebalanceAction } from "../../src/app/usecases/processRebalanceAction.js";
import { requestClose } from "../../src/app/usecases/requestClose.js";
import {
  requestRebalance,
  type RebalanceActionRequestPayload,
} from "../../src/app/usecases/requestRebalance.js";
import {
  CandidateSchema,
  type Candidate,
} from "../../src/domain/entities/Candidate.js";
import type { Position } from "../../src/domain/entities/Position.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-batch26-"),
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
    baseMint: "mint_base",
    quoteMint: "mint_quote",
    wallet: "wallet_001",
    status: "OPEN",
    openedAt: "2026-04-20T00:00:00.000Z",
    lastSyncedAt: "2026-04-20T00:00:00.000Z",
    closedAt: null,
    deployAmountBase: 1,
    deployAmountQuote: 0.5,
    currentValueBase: 1,
    currentValueUsd: 100,
    feesClaimedBase: 0.05,
    feesClaimedUsd: 5,
    realizedPnlBase: 0.2,
    realizedPnlUsd: 20,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
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
    ...overrides,
  };
}

function buildCloseConfirmedPosition(
  overrides: Partial<Position> = {},
): Position {
  return {
    ...buildOpenPosition(),
    status: "CLOSE_CONFIRMED",
    closedAt: "2026-04-20T00:05:00.000Z",
    lastSyncedAt: "2026-04-20T00:05:00.000Z",
    currentValueUsd: 100,
    feesClaimedUsd: 5,
    realizedPnlUsd: 20,
    unrealizedPnlUsd: 0,
    ...overrides,
  };
}

function buildCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return CandidateSchema.parse({
    candidateId: "cand_001",
    poolAddress: "pool_001",
    symbolPair: "SOL-USDC",
    screeningSnapshot: {},
    tokenRiskSnapshot: {},
    smartMoneySnapshot: {},
    hardFilterPassed: true,
    score: 90,
    scoreBreakdown: {
      quality: 90,
    },
    decision: "SHORTLISTED",
    decisionReason: "Passed deterministic shortlist",
    createdAt: "2026-04-21T12:00:00.000Z",
    ...overrides,
  });
}

async function createStores(directory: string) {
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
  const poolMemoryRepository = new FilePoolMemoryRepository({
    filePath: path.join(directory, "pool-memory.json"),
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
    poolMemoryRepository,
    actionQueue,
  };
}

function buildGateway(closePosition: Position) {
  return new MockDlmmGateway({
    getPosition: {
      type: "success",
      value: closePosition,
    },
    deployLiquidity: {
      type: "success",
      value: {
        actionType: "DEPLOY",
        positionId: "unused",
        txIds: ["tx_deploy"],
      },
    },
    closePosition: {
      type: "success",
      value: {
        actionType: "CLOSE",
        closedPositionId: closePosition.positionId,
        txIds: ["tx_close"],
      },
    },
    claimFees: {
      type: "success",
      value: {
        actionType: "CLAIM_FEES",
        claimedBaseAmount: 0,
        txIds: ["tx_claim"],
      },
    },
    partialClosePosition: {
      type: "success",
      value: {
        actionType: "PARTIAL_CLOSE",
        closedPositionId: closePosition.positionId,
        remainingPercentage: 50,
        txIds: ["tx_partial"],
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

class RebalanceIntegrationGateway implements DlmmGateway {
  public readonly positions = new Map<string, Position>();
  public readonly deployRequests: DeployLiquidityRequest[] = [];

  public async getPosition(positionId: string): Promise<Position | null> {
    return this.positions.get(positionId) ?? null;
  }

  public async deployLiquidity(
    request: DeployLiquidityRequest,
  ): Promise<DeployLiquidityResult> {
    this.deployRequests.push(request);
    return {
      actionType: "DEPLOY",
      positionId: "pos_new",
      txIds: ["tx_deploy"],
    };
  }

  public async simulateDeployLiquidity() {
    return { ok: true, reason: null };
  }

  public async closePosition(
    _request: ClosePositionRequest,
  ): Promise<ClosePositionResult> {
    return {
      actionType: "CLOSE",
      closedPositionId: "pos_old",
      txIds: ["tx_close"],
      estimatedReleasedValueUsd: 120,
      releasedAmountBase: 1,
      releasedAmountQuote: 0.5,
      releasedAmountSource: "post_tx",
    };
  }

  public async simulateClosePosition() {
    return { ok: true, reason: null };
  }

  public async claimFees(): Promise<ClaimFeesResult> {
    return {
      actionType: "CLAIM_FEES",
      claimedBaseAmount: 0,
      txIds: ["tx_claim"],
    };
  }

  public async partialClosePosition(
    _request: PartialClosePositionRequest,
  ): Promise<PartialClosePositionResult> {
    return {
      actionType: "PARTIAL_CLOSE",
      closedPositionId: "unused",
      remainingPercentage: 50,
      txIds: ["tx_partial"],
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

describe("Batch 26 learning loop integration", () => {
  it("finalizeCloseAutoLearning records performance exactly once", async () => {
    const directory = await makeTempDir();
    const stores = await createStores(directory);
    await stores.stateRepository.upsert(buildOpenPosition());
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
        dlmmGateway: buildGateway(buildCloseConfirmedPosition()),
        stateRepository: stores.stateRepository,
        journalRepository: stores.journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    const lessonHook = createRecordPositionPerformanceLessonHook({
      lessonRepository: stores.lessonRepository,
      performanceRepository: stores.performanceRepository,
      poolMemoryRepository: stores.poolMemoryRepository,
      journalRepository: stores.journalRepository,
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FC1",
    });

    const first = await finalizeClose({
      actionId: action.actionId,
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: buildGateway(buildCloseConfirmedPosition()),
      journalRepository: stores.journalRepository,
      lessonHook,
      now: () => "2026-04-20T00:05:00.000Z",
    });
    const second = await finalizeClose({
      actionId: action.actionId,
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: buildGateway(buildCloseConfirmedPosition()),
      journalRepository: stores.journalRepository,
      lessonHook,
      now: () => "2026-04-20T00:06:00.000Z",
    });

    expect(first.outcome).toBe("FINALIZED");
    expect(second.outcome).toBe("UNCHANGED");
    expect(await stores.performanceRepository.list()).toHaveLength(1);
    expect(await stores.lessonRepository.list()).toHaveLength(1);
    expect(
      (await stores.journalRepository.list()).filter(
        (event) => event.eventType === "PERFORMANCE_RECORDED",
      ),
    ).toHaveLength(1);
  });

  it("records rebalance old-leg performance once across both finalization phases", async () => {
    const directory = await makeTempDir();
    const stores = await createStores(directory);
    const gateway = new RebalanceIntegrationGateway();
    await stores.stateRepository.upsert(
      buildOpenPosition({
        positionId: "pos_old",
        rebalanceCount: 1,
        activeBin: 21,
        outOfRangeSince: "2026-04-19T23:00:00.000Z",
      }),
    );
    const action = await requestRebalance({
      actionQueue: stores.actionQueue,
      stateRepository: stores.stateRepository,
      journalRepository: stores.journalRepository,
      wallet: "wallet_001",
      positionId: "pos_old",
      payload: rebalancePayload,
      requestedBy: "system",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });
    await stores.actionQueue.processNext((queuedAction) =>
      processRebalanceAction({
        action: queuedAction,
        dlmmGateway: gateway,
        stateRepository: stores.stateRepository,
        journalRepository: stores.journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    gateway.positions.set(
      "pos_old",
      buildCloseConfirmedPosition({
        positionId: "pos_old",
        rebalanceCount: 1,
        activeBin: 21,
        outOfRangeSince: "2026-04-19T23:00:00.000Z",
      }),
    );
    const lessonHook = createRecordPositionPerformanceLessonHook({
      lessonRepository: stores.lessonRepository,
      performanceRepository: stores.performanceRepository,
      poolMemoryRepository: stores.poolMemoryRepository,
      journalRepository: stores.journalRepository,
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FC2",
    });
    const first = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: gateway,
      journalRepository: stores.journalRepository,
      lessonHook,
      now: () => "2026-04-20T00:05:00.000Z",
    });
    gateway.positions.set(
      "pos_new",
      buildOpenPosition({
        positionId: "pos_new",
        poolAddress: "pool_002",
        status: "OPEN",
        rebalanceCount: 2,
        currentValueUsd: 80,
        lastWriteActionId: action.actionId,
      }),
    );
    const second = await finalizeRebalance({
      actionId: action.actionId,
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: gateway,
      journalRepository: stores.journalRepository,
      lessonHook,
      now: () => "2026-04-20T00:08:00.000Z",
    });

    expect(first.outcome).toBe("REDEPLOY_SUBMITTED");
    expect(second.outcome).toBe("FINALIZED");
    expect(await stores.performanceRepository.list()).toHaveLength(1);
  });

  it("bad pool close updates pool memory cooldown", async () => {
    const directory = await makeTempDir();
    const stores = await createStores(directory);
    await stores.stateRepository.upsert(buildOpenPosition());
    const action = await requestClose({
      actionQueue: stores.actionQueue,
      stateRepository: stores.stateRepository,
      journalRepository: stores.journalRepository,
      wallet: "wallet_001",
      positionId: "pos_001",
      payload: { reason: "volume collapse exit" },
      requestedBy: "system",
      requestedAt: "2026-04-20T00:01:00.000Z",
    });
    await stores.actionQueue.processNext((queuedAction) =>
      processCloseAction({
        action: queuedAction,
        dlmmGateway: buildGateway(
          buildCloseConfirmedPosition({
            realizedPnlUsd: -10,
          }),
        ),
        stateRepository: stores.stateRepository,
        journalRepository: stores.journalRepository,
        now: () => "2026-04-20T00:02:00.000Z",
      }),
    );

    await finalizeClose({
      actionId: action.actionId,
      actionRepository: stores.actionRepository,
      stateRepository: stores.stateRepository,
      dlmmGateway: buildGateway(
        buildCloseConfirmedPosition({
          realizedPnlUsd: -10,
        }),
      ),
      journalRepository: stores.journalRepository,
      lessonHook: createRecordPositionPerformanceLessonHook({
        lessonRepository: stores.lessonRepository,
        performanceRepository: stores.performanceRepository,
        poolMemoryRepository: stores.poolMemoryRepository,
        journalRepository: stores.journalRepository,
        idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FC3",
      }),
      now: () => "2026-04-20T00:05:00.000Z",
    });

    const poolMemory = await stores.poolMemoryRepository.get("pool_001");
    expect(poolMemory?.cooldownUntil).toBe("2026-04-20T04:05:00.000Z");
  });

  it("aiLessonEnforcement blocks LLM and journals when lesson store is corrupt", async () => {
    const directory = await makeTempDir();
    await fs.writeFile(path.join(directory, "lessons.json"), "{bad json");
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const rankCandidates = vi.fn<NonNullable<LlmGateway["rankCandidates"]>>();

    const result = await rankShortlistWithAi({
      shortlist: [
        buildCandidate({ candidateId: "cand_a" }),
        buildCandidate({ candidateId: "cand_b" }),
      ],
      aiMode: "advisory",
      lessonPromptService: new DefaultLessonPromptService(
        new FileLessonRepository({
          filePath: path.join(directory, "lessons.json"),
        }),
        new FilePoolMemoryRepository({
          filePath: path.join(directory, "pool-memory.json"),
        }),
      ),
      llmGateway: {
        rankCandidates,
        explainManagementDecision: async () => ({
          action: "HOLD",
          reasoning: "unused",
        }),
      },
      journalRepository,
      wallet: "wallet_001",
      now: () => "2026-04-20T00:00:00.000Z",
    });

    expect(result.source).toBe("FALLBACK");
    expect(rankCandidates).not.toHaveBeenCalled();
    expect(await journalRepository.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "AI_LESSON_INJECTION_FAILED",
          resultStatus: "FAILED",
        }),
      ]),
    );
  });

  it("backfill dry-run reports planned learning records without mutating stores", async () => {
    const directory = await makeTempDir();
    const closedPosition = {
      ...buildOpenPosition(),
      status: "CLOSED",
      closedAt: "2026-04-20T00:05:00.000Z",
      currentValueUsd: 100,
      realizedPnlUsd: 20,
      feesClaimedUsd: 5,
    };
    await fs.writeFile(
      path.join(directory, "positions.json"),
      JSON.stringify([closedPosition], null, 2),
    );
    await fs.writeFile(path.join(directory, "actions.json"), "[]");
    await fs.writeFile(
      path.join(directory, "lessons.json"),
      JSON.stringify({ lessons: [], performance: [] }, null, 2),
    );
    await fs.writeFile(
      path.join(directory, "pool-memory.json"),
      JSON.stringify({}, null, 2),
    );
    const beforeLessons = await fs.readFile(
      path.join(directory, "lessons.json"),
      "utf8",
    );
    const beforePoolMemory = await fs.readFile(
      path.join(directory, "pool-memory.json"),
      "utf8",
    );

    const { stdout } = await execFileAsync(process.execPath, [
      path.join(process.cwd(), "scripts/backfillPerformanceLessons.js"),
      "--dry-run",
      `--data-dir=${directory}`,
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      mode: "dry-run",
      recordsToCreate: 1,
      poolMemoryPoolsTouched: 1,
    });
    expect(
      await fs.readFile(path.join(directory, "lessons.json"), "utf8"),
    ).toBe(beforeLessons);
    expect(
      await fs.readFile(path.join(directory, "pool-memory.json"), "utf8"),
    ).toBe(beforePoolMemory);
  });
});
