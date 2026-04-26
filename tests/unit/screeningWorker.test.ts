import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MockLlmGateway,
  type CandidateRankingInput,
  type LlmGateway,
} from "../../src/adapters/llm/LlmGateway.js";
import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { MockScreeningGateway } from "../../src/adapters/screening/ScreeningGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { MockTokenIntelGateway } from "../../src/adapters/analytics/TokenIntelGateway.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import {
  CandidateSchema,
  type Candidate,
} from "../../src/domain/entities/Candidate.js";
import {
  buildDataFreshnessSnapshot,
  buildDlmmMicrostructureSnapshot,
  buildMarketFeatureSnapshot,
} from "../../src/domain/rules/poolFeatureRules.js";
import { type ScreeningPolicy } from "../../src/domain/rules/screeningRules.js";
import { type PortfolioRiskPolicy } from "../../src/domain/rules/riskRules.js";
import { runScreeningCycle } from "../../src/app/usecases/runScreeningCycle.js";

const tempDirs: string[] = [];
const now = "2026-04-22T10:00:00.000Z";

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-screen-"),
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

function buildPolicy(
  overrides: Partial<ScreeningPolicy> = {},
): ScreeningPolicy {
  return {
    timeframe: "5m",
    minMarketCapUsd: 150_000,
    maxMarketCapUsd: 10_000_000,
    minTvlUsd: 10_000,
    minVolumeUsd: 5_000,
    minVolumeTrendPct: 0,
    minFeeActiveTvlRatio: 0.05,
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

function buildGatewayCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return CandidateSchema.parse({
    candidateId: "cand_001",
    poolAddress: "pool_001",
    symbolPair: "ABC-SOL",
    tokenXMint: "mint_abc",
    tokenYMint: "mint_sol",
    baseMint: "mint_abc",
    quoteMint: "mint_sol",
    screeningSnapshot: {
      marketCapUsd: 500_000,
      tvlUsd: 50_000,
      volumeUsd: 25_000,
      volumeConsistencyScore: 75,
      feeToTvlRatio: 0.12,
      feePerTvl24h: 0.03,
      organicScore: 80,
      holderCount: 1_200,
      binStep: 100,
      pairType: "volatile",
      launchpad: null,
    },
    marketFeatureSnapshot: buildMarketFeatureSnapshot({
      volume24hUsd: 25_000,
      fees24hUsd: 15,
      tvlUsd: 50_000,
      organicVolumeScore: 80,
      washTradingRiskScore: 5,
    }),
    dlmmMicrostructureSnapshot: buildDlmmMicrostructureSnapshot({
      binStep: 100,
      activeBin: 1000,
      activeBinObservedAt: now,
      depthNearActiveUsd: 20_000,
      depthWithin10BinsUsd: 40_000,
      depthWithin25BinsUsd: 50_000,
      estimatedSlippageBpsForDefaultSize: 100,
      now,
    }),
    tokenRiskSnapshot: {
      deployerAddress: "deployer_ok",
      topHolderPct: 18,
      botHolderPct: 4,
      bundleRiskPct: 6,
      washTradingRiskPct: 5,
      auditScore: 88,
      tokenXMint: "mint_abc",
      tokenYMint: "mint_sol",
    },
    smartMoneySnapshot: {
      smartWalletCount: 6,
      confidenceScore: 83,
      poolAgeHours: 96,
      tokenAgeHours: 24,
      narrativePenaltyScore: 10,
    },
    dataFreshnessSnapshot: buildDataFreshnessSnapshot({
      now,
      screeningSnapshotAt: now,
      poolDetailFetchedAt: now,
      tokenIntelFetchedAt: now,
      chainSnapshotFetchedAt: now,
      hasActiveBin: true,
    }),
    hardFilterPassed: true,
    score: 80,
    scoreBreakdown: {},
    decision: "SHORTLISTED",
    decisionReason: "selected upstream",
    createdAt: now,
    ...overrides,
  });
}

function buildRiskPolicy(
  overrides: Partial<PortfolioRiskPolicy> = {},
): PortfolioRiskPolicy {
  return {
    maxConcurrentPositions: 3,
    maxCapitalUsagePct: 80,
    minReserveUsd: 50,
    maxTokenExposurePct: 45,
    maxPoolExposurePct: 35,
    maxRebalancesPerPosition: 2,
    dailyLossLimitPct: 10,
    circuitBreakerCooldownMin: 60,
    maxNewDeploysPerHour: 3,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("screening worker", () => {
  it("blocks candidates that are in a downtrend below minVolumeTrendPct", async () => {
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

    const result = await runScreeningCycle({
      wallet: "wallet_001",
      screeningGateway: new MockScreeningGateway({
        listCandidates: {
          type: "success",
          value: [buildGatewayCandidate()],
        },
        getCandidateDetails: {
          type: "success",
          value: {
            poolAddress: "pool_001",
            pairLabel: "ABC-SOL",
            feeToTvlRatio: 0.12,
            feePerTvl24h: 0.03,
            volumeTrendPct: -20,
            organicScore: 80,
            holderCount: 1_200,
          },
        },
      }),
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-22T10:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 150,
            asOf: "2026-04-22T10:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      policyProvider: {
        async resolveScreeningPolicy() {
          return buildPolicy({
            minVolumeTrendPct: 0,
          });
        },
      },
      aiMode: "disabled",
      now: () => "2026-04-22T10:00:00.000Z",
    });

    expect(result.shortlist).toHaveLength(0);
    expect(result.candidates[0]?.decision).toBe("REJECTED_HARD_FILTER");
    expect(result.candidates[0]?.decisionReason).toBe(
      "volume trend below minimum",
    );
  });

  it("injects narrative enrichment into AI shortlist ranking context", async () => {
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

    let seenRankingInput: CandidateRankingInput | null = null;
    const result = await runScreeningCycle({
      wallet: "wallet_001",
      screeningGateway: new MockScreeningGateway({
        listCandidates: {
          type: "success",
          value: [
            buildGatewayCandidate(),
            buildGatewayCandidate({
              candidateId: "cand_002",
              poolAddress: "pool_002",
              symbolPair: "XYZ-SOL",
              tokenRiskSnapshot: {
                deployerAddress: "deployer_ok",
                topHolderPct: 15,
                botHolderPct: 3,
                bundleRiskPct: 4,
                washTradingRiskPct: 3,
                auditScore: 90,
                tokenXMint: "mint_xyz",
                tokenYMint: "mint_sol",
              },
            }),
          ],
        },
        getCandidateDetails: {
          type: "success",
          value: {
            poolAddress: "pool_001",
            pairLabel: "ABC-SOL",
            feeToTvlRatio: 0.12,
            feePerTvl24h: 0.03,
            volumeTrendPct: 10,
            organicScore: 80,
            holderCount: 1_200,
          },
        },
      }),
      tokenIntelGateway: new MockTokenIntelGateway({
        getTokenRiskSnapshot: {
          type: "success",
          value: {
            tokenMint: "mint_abc",
            riskScore: 20,
            topHolderPct: 18,
            botHolderPct: 4,
          },
        },
        getSmartMoneySnapshot: {
          type: "success",
          value: {
            tokenMint: "mint_abc",
            smartWalletCount: 6,
            confidenceScore: 80,
          },
        },
        getTokenNarrativeSnapshot: {
          type: "success",
          value: {
            tokenMint: "mint_abc",
            narrativeSummary: "Meme with fresh organic interest",
            holderDistributionSummary: "Top holders are broadly distributed",
          },
        },
      }),
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-22T10:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 150,
            asOf: "2026-04-22T10:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      policyProvider: {
        async resolveScreeningPolicy() {
          return buildPolicy({
            minVolumeTrendPct: -50,
          });
        },
      },
      aiMode: "advisory",
      lessonPromptService: {
        async buildLessonsPrompt() {
          return "Prefer distributed holders";
        },
      },
      llmGateway: new MockLlmGateway({
        rankCandidates: {
          type: "success",
          value: {
            rankedCandidateIds: ["cand_002", "cand_001"],
            reasoning: "Narrative favors XYZ over ABC",
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
      now: () => "2026-04-22T10:00:00.000Z",
    });

    const llm = result;
    expect(llm.aiSource).toBe("AI");
    expect(result.shortlist.map((candidate) => candidate.candidateId)).toEqual([
      "cand_002",
      "cand_001",
    ]);

    const observingGateway: LlmGateway = {
      async rankCandidates(input) {
        seenRankingInput = input;
        return {
          rankedCandidateIds: ["cand_001", "cand_002"],
          reasoning: "captured",
        };
      },
      async explainManagementDecision() {
        return {
          action: "HOLD",
          reasoning: "unused",
        };
      },
    };
    await runScreeningCycle({
      wallet: "wallet_001",
      screeningGateway: new MockScreeningGateway({
        listCandidates: {
          type: "success",
          value: [
            buildGatewayCandidate(),
            buildGatewayCandidate({
              candidateId: "cand_002",
              poolAddress: "pool_002",
              symbolPair: "XYZ-SOL",
            }),
          ],
        },
        getCandidateDetails: {
          type: "success",
          value: {
            poolAddress: "pool_001",
            pairLabel: "ABC-SOL",
            feeToTvlRatio: 0.12,
            feePerTvl24h: 0.03,
            volumeTrendPct: 10,
            organicScore: 80,
            holderCount: 1_200,
          },
        },
      }),
      tokenIntelGateway: new MockTokenIntelGateway({
        getTokenRiskSnapshot: {
          type: "success",
          value: {
            tokenMint: "mint_abc",
            riskScore: 20,
            topHolderPct: 18,
            botHolderPct: 4,
          },
        },
        getSmartMoneySnapshot: {
          type: "success",
          value: {
            tokenMint: "mint_abc",
            smartWalletCount: 6,
            confidenceScore: 80,
          },
        },
        getTokenNarrativeSnapshot: {
          type: "success",
          value: {
            tokenMint: "mint_abc",
            narrativeSummary: "Narrative attached",
            holderDistributionSummary: "Holder spread attached",
          },
        },
      }),
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-22T10:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 150,
            asOf: "2026-04-22T10:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      policyProvider: {
        async resolveScreeningPolicy() {
          return buildPolicy({
            minVolumeTrendPct: -50,
          });
        },
      },
      aiMode: "advisory",
      lessonPromptService: {
        async buildLessonsPrompt() {
          return "Prefer distributed holders";
        },
      },
      llmGateway: observingGateway,
      now: () => "2026-04-22T10:00:00.000Z",
    });

    expect(seenRankingInput).not.toBeNull();
    const rankingInput = seenRankingInput as unknown as CandidateRankingInput;

    expect(rankingInput.systemPrompt).toContain("### LESSONS LEARNED");
    expect(
      rankingInput.candidates[0]?.smartMoneySnapshot.narrativeSummary,
    ).toBe("Narrative attached");
    expect(
      rankingInput.candidates[0]?.smartMoneySnapshot.holderDistributionSummary,
    ).toBe("Holder spread attached");
  });

  it("enriches candidate details in parallel instead of serially per candidate", async () => {
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

    const firstDetails = createDeferred<{
      poolAddress: string;
      pairLabel: string;
      feeToTvlRatio: number;
      feePerTvl24h: number;
      volumeTrendPct: number;
      organicScore: number;
      holderCount: number;
    }>();
    const secondDetails = createDeferred<{
      poolAddress: string;
      pairLabel: string;
      feeToTvlRatio: number;
      feePerTvl24h: number;
      volumeTrendPct: number;
      organicScore: number;
      holderCount: number;
    }>();
    const bothStarted = createDeferred<void>();
    const startedPools: string[] = [];

    const runPromise = runScreeningCycle({
      wallet: "wallet_001",
      screeningGateway: {
        async listCandidates() {
          return [
            buildGatewayCandidate({
              candidateId: "cand_001",
              poolAddress: "pool_001",
            }),
            buildGatewayCandidate({
              candidateId: "cand_002",
              poolAddress: "pool_002",
              symbolPair: "XYZ-SOL",
              tokenRiskSnapshot: {
                deployerAddress: "deployer_ok",
                topHolderPct: 15,
                botHolderPct: 3,
                bundleRiskPct: 4,
                washTradingRiskPct: 3,
                auditScore: 90,
                tokenXMint: "mint_xyz",
                tokenYMint: "mint_sol",
              },
            }),
          ];
        },
        async getCandidateDetails(poolAddress) {
          startedPools.push(poolAddress);
          if (startedPools.length === 2) {
            bothStarted.resolve();
          }
          if (poolAddress === "pool_001") {
            return firstDetails.promise;
          }

          return secondDetails.promise;
        },
      },
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-22T10:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 150,
            asOf: "2026-04-22T10:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      policyProvider: {
        async resolveScreeningPolicy() {
          return buildPolicy();
        },
      },
      aiMode: "disabled",
      now: () => "2026-04-22T10:00:00.000Z",
    });

    await bothStarted.promise;
    expect(startedPools).toEqual(["pool_001", "pool_002"]);

    firstDetails.resolve({
      poolAddress: "pool_001",
      pairLabel: "ABC-SOL",
      feeToTvlRatio: 0.12,
      feePerTvl24h: 0.03,
      volumeTrendPct: 10,
      organicScore: 80,
      holderCount: 1_200,
    });
    secondDetails.resolve({
      poolAddress: "pool_002",
      pairLabel: "XYZ-SOL",
      feeToTvlRatio: 0.12,
      feePerTvl24h: 0.03,
      volumeTrendPct: 10,
      organicScore: 80,
      holderCount: 1_200,
    });

    const result = await runPromise;
    expect(result.candidates).toHaveLength(2);
  });

  it("continues screening when one candidate detail request fails", async () => {
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

    const result = await runScreeningCycle({
      wallet: "wallet_001",
      screeningGateway: {
        async listCandidates() {
          return [
            buildGatewayCandidate({
              candidateId: "cand_001",
              poolAddress: "pool_001",
            }),
            buildGatewayCandidate({
              candidateId: "cand_002",
              poolAddress: "pool_002",
              symbolPair: "XYZ-SOL",
            }),
          ];
        },
        async getCandidateDetails(poolAddress) {
          if (poolAddress === "pool_001") {
            throw new Error("details API unavailable");
          }

          return {
            poolAddress,
            pairLabel: poolAddress,
            feeToTvlRatio: 0.12,
            feePerTvl24h: 0.03,
            volumeTrendPct: 10,
            organicScore: 80,
            holderCount: 1_200,
          };
        },
      },
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: now,
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 150,
            asOf: now,
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      policyProvider: {
        async resolveScreeningPolicy() {
          return buildPolicy({ shortlistLimit: 2 });
        },
      },
      aiMode: "disabled",
      now: () => now,
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.poolAddress)).toEqual(
      ["pool_001", "pool_002"],
    );
  });

  it("caps candidate enrichment concurrency to protect upstream rate limits", async () => {
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
    let activeDetails = 0;
    let maxActiveDetails = 0;

    const result = await runScreeningCycle({
      wallet: "wallet_001",
      screeningGateway: {
        async listCandidates() {
          return [
            buildGatewayCandidate({
              candidateId: "cand_001",
              poolAddress: "pool_001",
            }),
            buildGatewayCandidate({
              candidateId: "cand_002",
              poolAddress: "pool_002",
              symbolPair: "XYZ-SOL",
            }),
            buildGatewayCandidate({
              candidateId: "cand_003",
              poolAddress: "pool_003",
              symbolPair: "DEF-SOL",
            }),
          ];
        },
        async getCandidateDetails(poolAddress) {
          activeDetails += 1;
          maxActiveDetails = Math.max(maxActiveDetails, activeDetails);
          await Promise.resolve();
          activeDetails -= 1;
          return {
            poolAddress,
            pairLabel: poolAddress,
            feeToTvlRatio: 0.12,
            feePerTvl24h: 0.03,
            volumeTrendPct: 10,
            organicScore: 80,
            holderCount: 1_200,
          };
        },
      },
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: now,
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 150,
            asOf: now,
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      policyProvider: {
        async resolveScreeningPolicy() {
          return buildPolicy({ shortlistLimit: 3 });
        },
      },
      aiMode: "disabled",
      enrichmentConcurrency: 1,
      now: () => now,
    });

    expect(result.candidates).toHaveLength(3);
    expect(maxActiveDetails).toBe(1);
  });
});
