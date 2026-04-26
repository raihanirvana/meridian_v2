import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileLessonRepository } from "../../src/adapters/storage/LessonRepository.js";
import { FilePoolMemoryRepository } from "../../src/adapters/storage/PoolMemoryRepository.js";
import { rankShortlistWithAi } from "../../src/app/services/AiAdvisoryService.js";
import { DefaultLessonPromptService } from "../../src/app/services/LessonPromptService.js";
import {
  CandidateSchema,
  type Candidate,
} from "../../src/domain/entities/Candidate.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-ai-pool-memory-"),
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

describe("AI shortlist pool memory", () => {
  it("injects POOL MEMORY block for shortlisted candidates", async () => {
    const directory = await makeTempDir();
    const lessonRepository = new FileLessonRepository({
      filePath: path.join(directory, "lessons.json"),
    });
    const poolMemoryRepository = new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    });
    await poolMemoryRepository.upsert("pool_001", () => ({
      poolAddress: "pool_001",
      name: "SOL-USDC",
      baseMint: "mint_sol",
      totalDeploys: 2,
      deploys: [
        {
          deployedAt: "2026-04-22T00:00:00.000Z",
          closedAt: "2026-04-22T02:00:00.000Z",
          pnlPct: 5,
          pnlUsd: 5,
          rangeEfficiencyPct: 80,
          minutesHeld: 120,
          closeReason: "take_profit",
          strategy: "bid_ask",
          volatilityAtDeploy: 12,
        },
      ],
      avgPnlPct: 5,
      winRatePct: 100,
      lastDeployedAt: "2026-04-22T02:00:00.000Z",
      lastOutcome: "profit",
      notes: [
        {
          note: "Momentum strongest after noon",
          addedAt: "2026-04-22T02:05:00.000Z",
        },
      ],
      snapshots: [],
    }));

    let capturedPrompt: string | null = null;
    const result = await rankShortlistWithAi({
      shortlist: [
        buildCandidate({
          candidateId: "cand_b",
          poolAddress: "pool_001",
        }),
        buildCandidate({
          candidateId: "cand_a",
          poolAddress: "pool_001",
        }),
      ],
      aiMode: "advisory",
      lessonPromptService: new DefaultLessonPromptService(
        lessonRepository,
        poolMemoryRepository,
      ),
      llmGateway: {
        rankCandidates: async (input) => {
          capturedPrompt = input.systemPrompt;
          return {
            rankedCandidateIds: ["cand_a", "cand_b"],
            reasoning: "pool memory says this pool is familiar",
          };
        },
        explainManagementDecision: async () => ({
          action: "HOLD",
          reasoning: "unused",
        }),
      },
    });

    expect(result.source).toBe("AI");
    expect(capturedPrompt).toContain("### POOL MEMORY");
    expect(capturedPrompt).toContain("pool_001");
    expect(capturedPrompt).toContain("Momentum strongest after noon");
  });
});
