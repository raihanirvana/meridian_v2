import { afterEach, describe, expect, it } from "vitest";

import type { LlmGateway } from "../../src/adapters/llm/LlmGateway.js";
import { MockLlmGateway } from "../../src/adapters/llm/LlmGateway.js";
import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import { DefaultLessonPromptService } from "../../src/app/services/LessonPromptService.js";
import {
  adviseManagementDecision,
  rankShortlistWithAi,
} from "../../src/app/services/AiAdvisoryService.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { FileLessonRepository } from "../../src/adapters/storage/LessonRepository.js";
import { FilePoolMemoryRepository } from "../../src/adapters/storage/PoolMemoryRepository.js";
import { runManagementWorker } from "../../src/app/workers/managementWorker.js";
import {
  CandidateSchema,
  type Candidate,
} from "../../src/domain/entities/Candidate.js";
import { type Position } from "../../src/domain/entities/Position.js";
import { type ManagementEvaluationResult } from "../../src/domain/rules/managementRules.js";
import { type ManagementPolicy } from "../../src/domain/rules/managementRules.js";
import { type PortfolioRiskPolicy } from "../../src/domain/rules/riskRules.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v2-ai-"));
  tempDirs.push(directory);
  return directory;
}

function createEmptyLessonPromptService(directory: string) {
  return new DefaultLessonPromptService(
    new FileLessonRepository({
      filePath: path.join(directory, "lessons.json"),
    }),
    new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    }),
  );
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

function buildPosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: "pos_001",
    poolAddress: "pool_001",
    tokenXMint: "mint_x",
    tokenYMint: "mint_y",
    baseMint: "mint_base",
    quoteMint: "mint_quote",
    wallet: "wallet_001",
    status: "OPEN",
    openedAt: "2026-04-21T00:00:00.000Z",
    lastSyncedAt: "2026-04-21T00:00:00.000Z",
    closedAt: null,
    deployAmountBase: 1,
    deployAmountQuote: 0.5,
    currentValueBase: 1,
    currentValueUsd: 20,
    feesClaimedBase: 0,
    feesClaimedUsd: 0,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: -60,
    unrealizedPnlUsd: -60,
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
    ...overrides,
  };
}

function buildEvaluation(
  overrides: Partial<ManagementEvaluationResult> = {},
): ManagementEvaluationResult {
  return {
    action: "CLOSE",
    priority: "HARD_EXIT",
    priorityScore: 90,
    reason: "Hard exit rule triggered close",
    triggerReasons: ["stop loss reached"],
    ...overrides,
  };
}

function buildRiskPolicy(
  overrides: Partial<PortfolioRiskPolicy> = {},
): PortfolioRiskPolicy {
  return {
    maxConcurrentPositions: 3,
    maxCapitalUsagePct: 80,
    minReserveUsd: 10,
    maxTokenExposurePct: 45,
    maxPoolExposurePct: 45,
    maxRebalancesPerPosition: 2,
    dailyLossLimitPct: 8,
    circuitBreakerCooldownMin: 180,
    maxNewDeploysPerHour: 2,
    ...overrides,
  };
}

function buildManagementPolicy(
  overrides: Partial<ManagementPolicy> = {},
): ManagementPolicy {
  return {
    stopLossUsd: 50,
    maxHoldMinutes: 1440,
    maxOutOfRangeMinutes: 240,
    claimFeesThresholdUsd: 20,
    partialCloseEnabled: false,
    partialCloseProfitTargetUsd: 100,
    rebalanceEnabled: true,
    maxRebalancesPerPosition: 2,
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

describe("AI advisory service", () => {
  it("reorders deterministic shortlist when AI ranking is valid", async () => {
    const directory = await makeTempDir();
    const shortlist = [
      buildCandidate({
        candidateId: "cand_b",
        symbolPair: "BONK-USDC",
      }),
      buildCandidate({
        candidateId: "cand_a",
        symbolPair: "SOL-USDC",
      }),
    ];

    const result = await rankShortlistWithAi({
      shortlist,
      aiMode: "advisory",
      lessonPromptService: createEmptyLessonPromptService(directory),
      llmGateway: new MockLlmGateway({
        rankCandidates: {
          type: "success",
          value: {
            rankedCandidateIds: ["cand_a", "cand_b"],
            reasoning: "AI prefers cand_a first",
          },
        },
        explainManagementDecision: {
          type: "success",
          value: {
            action: "HOLD",
            reasoning: "unused",
          },
        },
      }),
    });

    expect(result.source).toBe("AI");
    expect(result.shortlist.map((candidate) => candidate.candidateId)).toEqual([
      "cand_a",
      "cand_b",
    ]);
  });

  it("injects lessons prompt into screener ranking requests", async () => {
    const directory = await makeTempDir();
    const lessonRepository = new FileLessonRepository({
      filePath: path.join(directory, "lessons.json"),
    });
    const poolMemoryRepository = new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    });
    await lessonRepository.append({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      rule: "PREFER pools with sustained fee density",
      tags: ["worked"],
      outcome: "good",
      role: "SCREENER",
      pinned: true,
      createdAt: "2026-04-21T12:00:00.000Z",
    });

    const shortlist = [
      buildCandidate({ candidateId: "cand_b" }),
      buildCandidate({ candidateId: "cand_a" }),
    ];

    let capturedSystemPrompt: string | null = null;
    const result = await rankShortlistWithAi({
      shortlist,
      aiMode: "advisory",
      lessonPromptService: new DefaultLessonPromptService(
        lessonRepository,
        poolMemoryRepository,
      ),
      llmGateway: {
        rankCandidates: async (input) => {
          capturedSystemPrompt = input.systemPrompt;
          return {
            rankedCandidateIds: ["cand_a", "cand_b"],
            reasoning: "lesson-informed reorder",
          };
        },
        explainManagementDecision: async () => ({
          action: "HOLD",
          reasoning: "unused",
        }),
      },
    });

    expect(result.source).toBe("AI");
    expect(capturedSystemPrompt).toContain("### LESSONS LEARNED");
    expect(capturedSystemPrompt).toContain("── PINNED (1) ──");
    expect(capturedSystemPrompt).toContain(
      "PREFER pools with sustained fee density",
    );
  });

  it("falls back to deterministic shortlist when AI ranking is invalid", async () => {
    const directory = await makeTempDir();
    const shortlist = [
      buildCandidate({
        candidateId: "cand_b",
      }),
      buildCandidate({
        candidateId: "cand_a",
      }),
    ];

    const invalidGateway: LlmGateway = {
      rankCandidates: async () =>
        ({
          rankedCandidateIds: ["cand_unknown", "cand_b"],
          reasoning: "bad ids",
        }) as never,
      explainManagementDecision: async () =>
        ({
          action: "HOLD",
          reasoning: "unused",
        }) as never,
    };

    const result = await rankShortlistWithAi({
      shortlist,
      aiMode: "advisory",
      lessonPromptService: createEmptyLessonPromptService(directory),
      llmGateway: invalidGateway,
    });

    expect(result.source).toBe("FALLBACK");
    expect(result.shortlist.map((candidate) => candidate.candidateId)).toEqual([
      "cand_b",
      "cand_a",
    ]);
  });

  it("journals lesson injection failure for shortlist ranking", async () => {
    const directory = await makeTempDir();
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const result = await rankShortlistWithAi({
      shortlist: [
        buildCandidate({ candidateId: "cand_a" }),
        buildCandidate({ candidateId: "cand_b" }),
      ],
      aiMode: "advisory",
      lessonPromptService: {
        async buildLessonsPrompt() {
          throw new Error("lesson store unavailable");
        },
      },
      llmGateway: new MockLlmGateway({
        rankCandidates: {
          type: "success",
          value: {
            rankedCandidateIds: ["cand_b", "cand_a"],
            reasoning: "should not run",
          },
        },
        explainManagementDecision: {
          type: "success",
          value: {
            action: "HOLD",
            reasoning: "unused",
          },
        },
      }),
      journalRepository,
      wallet: "wallet_001",
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.source).toBe("FALLBACK");
    const journal = await journalRepository.list();
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "AI_LESSON_INJECTION_FAILED",
          wallet: "wallet_001",
          resultStatus: "FAILED",
          after: {
            stage: "shortlist_ranking",
          },
        }),
      ]),
    );
  });

  it("falls back to deterministic management explanation when AI proposes invalid action", async () => {
    const directory = await makeTempDir();
    const result = await adviseManagementDecision({
      aiMode: "constrained_action",
      evaluation: buildEvaluation(),
      position: buildPosition(),
      triggerReasons: ["stop loss reached"],
      lessonPromptService: createEmptyLessonPromptService(directory),
      llmGateway: {
        rankCandidates: async () =>
          ({
            rankedCandidateIds: [],
            reasoning: "unused",
          }) as never,
        explainManagementDecision: async () =>
          ({
            action: "SELL_ALL",
            reasoning: "invalid enum",
          }) as never,
      },
    });

    expect(result.source).toBe("FALLBACK");
    expect(result.aiSuggestedAction).toBeNull();
    expect(result.aiReasoning).toBeNull();
  });

  it("journals lesson injection failure for management advisory", async () => {
    const directory = await makeTempDir();
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });

    const result = await adviseManagementDecision({
      aiMode: "advisory",
      evaluation: buildEvaluation(),
      position: buildPosition(),
      triggerReasons: ["stop loss reached"],
      lessonPromptService: {
        async buildLessonsPrompt() {
          throw new Error("lesson store unavailable");
        },
      },
      llmGateway: new MockLlmGateway({
        rankCandidates: {
          type: "success",
          value: {
            rankedCandidateIds: [],
            reasoning: "unused",
          },
        },
        explainManagementDecision: {
          type: "success",
          value: {
            action: "CLOSE",
            reasoning: "should not run",
          },
        },
      }),
      journalRepository,
      wallet: "wallet_001",
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.source).toBe("FALLBACK");
    const journal = await journalRepository.list();
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "AI_LESSON_INJECTION_FAILED",
          wallet: "wallet_001",
          positionId: "pos_001",
          resultStatus: "FAILED",
          after: {
            stage: "management_advisory",
          },
        }),
      ]),
    );
  });

  it("injects role-specific lessons into management explanation requests", async () => {
    const directory = await makeTempDir();
    const lessonRepository = new FileLessonRepository({
      filePath: path.join(directory, "lessons.json"),
    });
    const poolMemoryRepository = new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    });
    await lessonRepository.append({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      rule: "FAILED: close OOR positions sooner when efficiency collapses",
      tags: ["oor", "failed"],
      outcome: "bad",
      role: "MANAGER",
      pinned: false,
      createdAt: "2026-04-21T12:00:00.000Z",
    });

    let capturedSystemPrompt: string | null = null;
    const result = await adviseManagementDecision({
      aiMode: "advisory",
      evaluation: buildEvaluation(),
      position: buildPosition(),
      triggerReasons: ["stop loss reached"],
      lessonPromptService: new DefaultLessonPromptService(
        lessonRepository,
        poolMemoryRepository,
      ),
      llmGateway: {
        rankCandidates: async () => ({
          rankedCandidateIds: [],
          reasoning: "unused",
        }),
        explainManagementDecision: async (input) => {
          capturedSystemPrompt = input.systemPrompt;
          return {
            action: "CLOSE",
            reasoning: "manager lesson says close",
          };
        },
      },
    });

    expect(result.source).toBe("AI");
    expect(result.aiSuggestedAction).toBe("CLOSE");
    expect(capturedSystemPrompt).toContain("### LESSONS LEARNED");
    expect(capturedSystemPrompt).toContain("MANAGER");
    expect(capturedSystemPrompt).toContain("close OOR positions sooner");
  });

  it("AI timeout does not block management worker", async () => {
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
    const lessonPromptService = createEmptyLessonPromptService(directory);

    await stateRepository.upsert(buildPosition());

    const result = await runManagementWorker({
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      managementPolicy: buildManagementPolicy(),
      signalProvider: () => ({
        forcedManualClose: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        severeNegativeYield: false,
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        dataIncomplete: false,
      }),
      llmGateway: new MockLlmGateway({
        rankCandidates: {
          type: "success",
          value: {
            rankedCandidateIds: [],
            reasoning: "unused",
          },
        },
        explainManagementDecision: {
          type: "timeout",
          timeoutMs: 10,
        },
      }),
      aiMode: "advisory",
      lessonPromptService,
      aiTimeoutMs: 1,
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.positionResults).toHaveLength(1);
    expect(result.positionResults[0]?.managementAction).toBe("CLOSE");
    expect(result.positionResults[0]?.status).toBe("DISPATCHED");
    expect(result.positionResults[0]?.aiSource).toBe("FALLBACK");

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("CLOSE");
    expect(actions[0]?.status).toBe("QUEUED");
  });

  it("does not call AI advisory for HOLD results", async () => {
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
    const lessonPromptService = createEmptyLessonPromptService(directory);

    await stateRepository.upsert(
      buildPosition({
        unrealizedPnlUsd: 0,
      }),
    );

    const result = await runManagementWorker({
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      managementPolicy: buildManagementPolicy({
        stopLossUsd: 50,
        claimFeesThresholdUsd: 999,
      }),
      signalProvider: () => ({
        forcedManualClose: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        severeNegativeYield: false,
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        dataIncomplete: false,
      }),
      llmGateway: new MockLlmGateway({
        rankCandidates: {
          type: "success",
          value: {
            rankedCandidateIds: [],
            reasoning: "unused",
          },
        },
        explainManagementDecision: {
          type: "timeout",
          timeoutMs: 10,
        },
      }),
      aiMode: "advisory",
      lessonPromptService,
      aiTimeoutMs: 1,
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.positionResults).toHaveLength(1);
    expect(result.positionResults[0]?.managementAction).toBe("HOLD");
    expect(result.positionResults[0]?.status).toBe("NO_ACTION");
    expect(result.positionResults[0]?.aiSource).toBe("DETERMINISTIC");

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(0);
  });

  it("falls back without calling LLM when management worker has no lesson prompt service", async () => {
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

    await stateRepository.upsert(buildPosition());

    const result = await runManagementWorker({
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      managementPolicy: buildManagementPolicy(),
      signalProvider: () => ({
        forcedManualClose: false,
        severeTokenRisk: false,
        liquidityCollapse: false,
        severeNegativeYield: false,
        claimableFeesUsd: 0,
        expectedRebalanceImprovement: false,
        dataIncomplete: false,
      }),
      llmGateway: {
        rankCandidates: async () => {
          throw new Error("rankCandidates should not be called");
        },
        explainManagementDecision: async () => {
          throw new Error("explainManagementDecision should not be called");
        },
      },
      aiMode: "advisory",
      aiTimeoutMs: 1,
      now: () => "2026-04-21T12:00:00.000Z",
    });

    expect(result.positionResults).toHaveLength(1);
    expect(result.positionResults[0]?.managementAction).toBe("CLOSE");
    expect(result.positionResults[0]?.status).toBe("DISPATCHED");
    expect(result.positionResults[0]?.aiSource).toBe("FALLBACK");

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("CLOSE");
  });
});
