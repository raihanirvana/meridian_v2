import { describe, expect, it } from "vitest";

import { HttpTokenIntelGateway } from "../../src/adapters/analytics/HttpTokenIntelGateway.js";
import { HttpDlmmGateway } from "../../src/adapters/dlmm/HttpDlmmGateway.js";
import { HttpAiStrategyReviewer } from "../../src/adapters/llm/HttpAiStrategyReviewer.js";
import { HttpLlmGateway } from "../../src/adapters/llm/HttpLlmGateway.js";
import {
  AdapterHttpStatusError,
  AdapterResponseValidationError,
  AdapterTransportError,
  JsonHttpClient,
} from "../../src/adapters/http/HttpJsonClient.js";
import { JupiterApiSwapGateway } from "../../src/adapters/jupiter/JupiterApiSwapGateway.js";
import { JupiterSolPriceGateway } from "../../src/adapters/pricing/JupiterSolPriceGateway.js";
import { HttpScreeningGateway } from "../../src/adapters/screening/HttpScreeningGateway.js";
import {
  MeteoraPoolDiscoveryScreeningGateway,
  type MeteoraRateLimitedError,
} from "../../src/adapters/screening/MeteoraPoolDiscoveryScreeningGateway.js";
import { HttpTelegramOperatorGateway } from "../../src/adapters/telegram/HttpTelegramOperatorGateway.js";
import { CandidateSchema } from "../../src/domain/entities/Candidate.js";
import { SolanaRpcWalletGateway } from "../../src/adapters/wallet/SolanaRpcWalletGateway.js";

function createFetchFromResponse(response: Response) {
  return async () => response;
}

describe("real adapters", () => {
  it("maps successful DLMM, Jupiter, screening, and intel responses through runtime schemas", async () => {
    const dlmm = new HttpDlmmGateway({
      baseUrl: "https://dlmm.example.com/v1/",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            actionType: "DEPLOY",
            positionId: "pos_001",
            txIds: ["tx_001"],
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      dlmm.deployLiquidity({
        wallet: "wallet_001",
        poolAddress: "pool_001",
        amountBase: 1,
        amountQuote: 2,
        strategy: "bid_ask",
      }),
    ).resolves.toEqual({
      actionType: "DEPLOY",
      positionId: "pos_001",
      submissionStatus: "submitted",
      txIds: ["tx_001"],
    });

    const jupiterQuote = new JupiterApiSwapGateway({
      apiKey: "jup_key",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            outAmount: "17057460",
            priceImpactPct: "0.0001",
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      jupiterQuote.quoteSwap({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountRaw: "100000000",
      }),
    ).resolves.toEqual({
      expectedOutputAmountRaw: "17057460",
      priceImpactPct: 0.0001,
    });

    const screening = new HttpScreeningGateway({
      baseUrl: "https://screening.example.com/v1/",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify([
            {
              candidateId: "cand_001",
              poolAddress: "pool_001",
              symbolPair: "SOL-USDC",
              screeningSnapshot: {},
              tokenRiskSnapshot: {},
              smartMoneySnapshot: {},
              hardFilterPassed: true,
              score: 90,
              scoreBreakdown: { quality: 90 },
              decision: "SHORTLISTED",
              decisionReason: "Passed deterministic shortlist",
              createdAt: "2026-04-21T12:00:00.000Z",
            },
          ]),
          { status: 200 },
        ),
      ),
    });

    await expect(
      screening.listCandidates({ limit: 1, timeframe: "5m" }),
    ).resolves.toHaveLength(1);

    const priceGateway = new JupiterSolPriceGateway({
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            outAmount: "150000000",
          }),
          { status: 200 },
        ),
      ),
      now: () => "2026-04-23T00:00:00.000Z",
    });

    await expect(priceGateway.getSolPriceUsd()).resolves.toEqual({
      symbol: "SOL",
      priceUsd: 150,
      asOf: "2026-04-23T00:00:00.000Z",
    });

    const walletGateway = new SolanaRpcWalletGateway({
      rpcUrl: "https://rpc.example.com",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            result: {
              value: 2500000000,
            },
          }),
          { status: 200 },
        ),
      ),
      now: () => "2026-04-23T00:00:00.000Z",
    });

    await expect(walletGateway.getWalletBalance("wallet_001")).resolves.toEqual(
      {
        wallet: "wallet_001",
        balanceSol: 2.5,
        asOf: "2026-04-23T00:00:00.000Z",
      },
    );

    const intel = new HttpTokenIntelGateway({
      baseUrl: "https://intel.example.com/v1/",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            tokenMint: "mint_001",
            riskScore: 10,
            topHolderPct: 12,
            botHolderPct: 1,
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(intel.getTokenRiskSnapshot("mint_001")).resolves.toEqual({
      tokenMint: "mint_001",
      riskScore: 10,
      topHolderPct: 12,
      botHolderPct: 1,
    });

    const llm = new HttpLlmGateway({
      baseUrl: "https://llm.example.com/v1/",
      generalModel: "gpt-test",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "CLOSE",
                    reasoning: "Stop loss triggered",
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      llm.explainManagementDecision({
        positionId: "pos_001",
        proposedAction: "CLOSE",
        positionSnapshot: {
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
          deployAmountQuote: 1,
          currentValueBase: 1,
          currentValueUsd: 100,
          feesClaimedBase: 0,
          feesClaimedUsd: 0,
          realizedPnlBase: 0,
          realizedPnlUsd: 0,
          unrealizedPnlBase: -1,
          unrealizedPnlUsd: -10,
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
        },
        triggerReasons: ["stop loss reached"],
        systemPrompt: "be concise",
      }),
    ).resolves.toEqual({
      action: "CLOSE",
      reasoning: "Stop loss triggered",
    });

    const strategyReviewer = new HttpAiStrategyReviewer({
      baseUrl: "https://llm.example.com/v1/",
      model: "gpt-test",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    poolAddress: "pool_001",
                    decision: "deploy",
                    recommendedStrategy: "bid_ask",
                    confidence: 0.82,
                    riskLevel: "medium",
                    binsBelow: 69,
                    binsAbove: 0,
                    slippageBps: 250,
                    maxPositionAgeMinutes: 720,
                    stopLossPct: 5,
                    takeProfitPct: 12,
                    trailingStopPct: 2,
                    reasons: ["mean reverting"],
                    rejectIf: ["active bin drifts"],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      strategyReviewer.reviewCandidateStrategy({
        candidate: CandidateSchema.parse({
          candidateId: "cand_001",
          poolAddress: "pool_001",
          symbolPair: "SOL-USDC",
          screeningSnapshot: {},
          tokenRiskSnapshot: {},
          smartMoneySnapshot: {},
          hardFilterPassed: true,
          score: 90,
          scoreBreakdown: { quality: 90 },
          decision: "SHORTLISTED",
          decisionReason: "Passed deterministic shortlist",
          createdAt: "2026-04-21T12:00:00.000Z",
        }),
        systemPrompt: "review strategy",
      }),
    ).resolves.toMatchObject({
      poolAddress: "pool_001",
      recommendedStrategy: "bid_ask",
    });
  });

  it("maps non-2xx HTTP responses into AdapterHttpStatusError", async () => {
    const screening = new HttpScreeningGateway({
      baseUrl: "https://screening.example.com/v1/",
      fetchFn: createFetchFromResponse(
        new Response("upstream unavailable", { status: 503 }),
      ),
    });

    await expect(
      screening.listCandidates({ limit: 5, timeframe: "5m" }),
    ).rejects.toBeInstanceOf(AdapterHttpStatusError);
  });

  it("maps invalid JSON/schema responses into AdapterResponseValidationError", async () => {
    const intel = new HttpTokenIntelGateway({
      baseUrl: "https://intel.example.com/v1/",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            tokenMint: "mint_001",
            riskScore: "bad",
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(intel.getTokenRiskSnapshot("mint_001")).rejects.toBeInstanceOf(
      AdapterResponseValidationError,
    );

    const llm = new HttpLlmGateway({
      baseUrl: "https://llm.example.com/v1/",
      generalModel: "gpt-test",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "not-json",
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      llm.rankCandidates({
        candidates: [],
        systemPrompt: "rank",
      }),
    ).rejects.toBeInstanceOf(AdapterResponseValidationError);

    const strategyReviewer = new HttpAiStrategyReviewer({
      baseUrl: "https://llm.example.com/v1/",
      model: "gpt-test",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "not-json",
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      strategyReviewer.reviewCandidateStrategy({
        candidate: CandidateSchema.parse({
          candidateId: "cand_001",
          poolAddress: "pool_001",
          symbolPair: "SOL-USDC",
          screeningSnapshot: {},
          tokenRiskSnapshot: {},
          smartMoneySnapshot: {},
          hardFilterPassed: true,
          score: 90,
          scoreBreakdown: { quality: 90 },
          decision: "SHORTLISTED",
          decisionReason: "Passed deterministic shortlist",
          createdAt: "2026-04-21T12:00:00.000Z",
        }),
        systemPrompt: "review strategy",
      }),
    ).rejects.toBeInstanceOf(AdapterResponseValidationError);

    const telegram = new HttpTelegramOperatorGateway({
      botToken: "telegram-token",
      baseUrl: "https://api.telegram.test",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  text: "/status",
                  chat: {
                    id: "chat_001",
                  },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(telegram.getUpdates()).resolves.toEqual([
      {
        updateId: 1,
        chatId: "chat_001",
        text: "/status",
      },
    ]);
  });

  it("maps transport failures into AdapterTransportError", async () => {
    const dlmm = new HttpDlmmGateway({
      baseUrl: "https://dlmm.example.com/v1/",
      fetchFn: async () => {
        throw new Error("network down");
      },
    });

    await expect(dlmm.getPoolInfo("pool_001")).rejects.toBeInstanceOf(
      AdapterTransportError,
    );
  });

  it("maps timeout-abort into AdapterTransportError", async () => {
    const screening = new HttpScreeningGateway({
      baseUrl: "https://screening.example.com/v1/",
      timeoutMs: 1,
      fetchFn: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("request aborted"));
          });
        }),
    });

    await expect(
      screening.listCandidates({ limit: 5, timeframe: "5m" }),
    ).rejects.toBeInstanceOf(AdapterTransportError);
  });

  it("honors a parent AbortSignal that is already aborted before the request starts", async () => {
    let receivedAbortedSignal = false;
    const controller = new AbortController();
    controller.abort();
    const client = new JsonHttpClient({
      adapterName: "PreAbortedClient",
      baseUrl: "https://example.test/",
      fetchFn: async (_url, init) => {
        receivedAbortedSignal = init?.signal?.aborted === true;
        throw new Error("request aborted");
      },
    });

    await expect(
      client.request({
        method: "GET",
        path: "health",
        responseSchema: CandidateSchema.array(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AdapterTransportError);

    expect(receivedAbortedSignal).toBe(true);
  });

  it("aborts HttpLlmGateway requests via AbortSignal when timeout elapses", async () => {
    let aborted = false;
    const llm = new HttpLlmGateway({
      baseUrl: "https://llm.example.com/v1/",
      generalModel: "gpt-test",
      timeoutMs: 1,
      fetchFn: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("request aborted"));
          });
        }),
    });

    await expect(
      llm.explainManagementDecision({
        positionId: "pos_001",
        proposedAction: "CLOSE",
        positionSnapshot: {
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
          deployAmountQuote: 1,
          currentValueBase: 1,
          currentValueUsd: 100,
          feesClaimedBase: 0,
          feesClaimedUsd: 0,
          realizedPnlBase: 0,
          realizedPnlUsd: 0,
          unrealizedPnlBase: -1,
          unrealizedPnlUsd: -10,
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
        },
        triggerReasons: ["stop loss reached"],
        systemPrompt: "be concise",
      }),
    ).rejects.toBeInstanceOf(AdapterTransportError);

    expect(aborted).toBe(true);
  });

  it("maps response body read failures into AdapterTransportError", async () => {
    const screening = new HttpScreeningGateway({
      baseUrl: "https://screening.example.com/v1/",
      fetchFn: async () =>
        ({
          ok: true,
          status: 200,
          text: async () => {
            throw new Error("body stream failed");
          },
        }) as unknown as Response,
    });

    await expect(
      screening.listCandidates({ limit: 5, timeframe: "5m" }),
    ).rejects.toBeInstanceOf(AdapterTransportError);
  });

  it("preserves Jupiter raw outAmount exactly even above Number.MAX_SAFE_INTEGER", async () => {
    const jupiterQuote = new JupiterApiSwapGateway({
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            outAmount: "9007199254740993",
            priceImpactPct: "0.0001",
          }),
          { status: 200 },
        ),
      ),
    });

    const result = await jupiterQuote.quoteSwap({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountRaw: "100000000",
    });

    expect(result.expectedOutputAmountRaw).toBe("9007199254740993");
  });

  it("aborts if response body read stalls after headers", async () => {
    const screening = new HttpScreeningGateway({
      baseUrl: "https://screening.example.com/v1/",
      timeoutMs: 5,
      fetchFn: async (_url, init) => {
        const signal = init?.signal;
        return {
          ok: true,
          status: 200,
          text: async () =>
            new Promise<string>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  reject(new Error("body read aborted"));
                },
                { once: true },
              );
            }),
        } as Response;
      },
    });

    await expect(
      screening.listCandidates({ limit: 5, timeframe: "5m" }),
    ).rejects.toBeInstanceOf(AdapterTransportError);
  });

  it("forwards screening timeframe to the HTTP query boundary", async () => {
    let requestedUrl = "";
    const screening = new HttpScreeningGateway({
      baseUrl: "https://screening.example.com/v1/",
      fetchFn: async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });

    await screening.listCandidates({ limit: 5, timeframe: "1h" });

    expect(new URL(requestedUrl).pathname).toBe("/v1/candidates");
    expect(requestedUrl).toContain("timeframe=1h");
    expect(requestedUrl).toContain("limit=5");
  });

  it("rejects screening detail responses for a different requested pool", async () => {
    const screening = new HttpScreeningGateway({
      baseUrl: "https://screening.example.com/v1/",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            poolAddress: "pool_other",
            pairLabel: "OTHER-SOL",
            feeToTvlRatio: 1.2,
            organicScore: 80,
            holderCount: 1_000,
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      screening.getCandidateDetails("pool_001"),
    ).rejects.toBeInstanceOf(AdapterResponseValidationError);
  });

  it("rejects token intel snapshots for a different requested token", async () => {
    const intel = new HttpTokenIntelGateway({
      baseUrl: "https://intel.example.com/v1/",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            tokenMint: "mint_other",
            narrativeSummary: "Wrong token narrative",
            holderDistributionSummary: "Wrong token holders",
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      intel.getTokenNarrativeSnapshot("mint_001"),
    ).rejects.toBeInstanceOf(AdapterResponseValidationError);
  });

  it("maps Meteora Pool Discovery pools into screening candidates", async () => {
    let requestedUrl = "";
    const screening = new MeteoraPoolDiscoveryScreeningGateway({
      baseUrl: "https://pool-discovery-api.datapi.meteora.ag",
      now: () => "2026-04-24T00:00:00.000Z",
      fetchFn: async (url) => {
        requestedUrl = String(url);
        return new Response(
          JSON.stringify({
            data: [
              {
                pool_address: "pool_001",
                name: "MEME-SOL",
                active_tvl: 25_000,
                volume: 80_000,
                fee: 250,
                fee_active_tvl_ratio: 1,
                volume_change_pct: 12,
                base_token_holders: 1_200,
                dlmm_params: { bin_step: 100 },
                token_x: {
                  address: "mint_meme",
                  symbol: "MEME",
                  organic_score: 72,
                  market_cap: 500_000,
                  created_at: "2026-04-23T00:00:00.000Z",
                  dev: "deployer_001",
                },
                token_y: {
                  address: "So11111111111111111111111111111111111111112",
                  symbol: "SOL",
                  organic_score: 90,
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    const candidates = await screening.listCandidates({
      limit: 3,
      timeframe: "5m",
    });

    expect(new URL(requestedUrl).searchParams.get("timeframe")).toBe("5m");
    expect(new URL(requestedUrl).searchParams.get("category")).toBe("trending");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.poolAddress).toBe("pool_001");
    expect(candidates[0]?.tokenRiskSnapshot.tokenXMint).toBe("mint_meme");
    expect(candidates[0]?.screeningSnapshot.binStep).toBe(100);
    expect(candidates[0]?.screeningSnapshot.feePerTvl24h).toBeUndefined();
    expect(candidates[0]?.dataFreshnessSnapshot.tokenIntelFetchedAt).toBeNull();
    expect(candidates[0]?.smartMoneySnapshot.tokenAgeHours).toBe(24);
    expect(candidates[0]?.baseMint).toBe("mint_meme");
    expect(candidates[0]?.quoteMint).toBe(
      "So11111111111111111111111111111111111111112",
    );
  });

  it("swaps baseMint/quoteMint when tokenX is a preferred quote token", async () => {
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const screening = new MeteoraPoolDiscoveryScreeningGateway({
      baseUrl: "https://pool-discovery-api.datapi.meteora.ag",
      now: () => "2026-04-24T00:00:00.000Z",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                pool_address: "pool_001",
                name: "USDC-MEME",
                active_tvl: 10_000,
                volume: 40_000,
                fee: 100,
                fee_active_tvl_ratio: 1,
                volume_change_pct: 5,
                base_token_holders: 800,
                dlmm_params: { bin_step: 80 },
                token_x: {
                  address: USDC_MINT,
                  symbol: "USDC",
                  organic_score: 95,
                  market_cap: 1_000_000_000,
                  dev: "deployer_usdc",
                },
                token_y: {
                  address: "mint_meme",
                  symbol: "MEME",
                  organic_score: 60,
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    const candidates = await screening.listCandidates({
      limit: 3,
      timeframe: "5m",
    });

    expect(candidates[0]?.tokenXMint).toBe(USDC_MINT);
    expect(candidates[0]?.tokenYMint).toBe("mint_meme");
    expect(candidates[0]?.baseMint).toBe("mint_meme");
    expect(candidates[0]?.quoteMint).toBe(USDC_MINT);
  });

  it("does not infer 24h fee-per-TVL from a timeframe-window fee", async () => {
    const screening = new MeteoraPoolDiscoveryScreeningGateway({
      baseUrl: "https://pool-discovery-api.datapi.meteora.ag",
      now: () => "2026-04-24T00:00:00.000Z",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                pool_address: "pool_001",
                name: "MEME-SOL",
                active_tvl: 25_000,
                volume: 80_000,
                fee: 250,
                fee_active_tvl_ratio: 1,
                fee_tvl_ratio: 1,
                base_token_holders: 1_200,
                dlmm_params: { bin_step: 100 },
                token_x: {
                  address: "mint_meme",
                  symbol: "MEME",
                  organic_score: 72,
                  market_cap: 500_000,
                },
                token_y: {
                  address: "So11111111111111111111111111111111111111112",
                  symbol: "SOL",
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    const candidates = await screening.listCandidates({
      limit: 3,
      timeframe: "5m",
    });

    expect(candidates[0]?.screeningSnapshot.feeToTvlRatio).toBe(1);
    expect(candidates[0]?.screeningSnapshot.feePerTvl24h).toBeUndefined();
    expect(candidates[0]?.marketFeatureSnapshot.volume5mUsd).toBe(80_000);
    expect(candidates[0]?.marketFeatureSnapshot.fees5mUsd).toBe(250);
    expect(candidates[0]?.marketFeatureSnapshot.volume24hUsd).toBe(0);
    expect(candidates[0]?.marketFeatureSnapshot.fees24hUsd).toBe(0);
  });

  it("uses unwindowed fee-tvl ratio as 24h fee-per-TVL for Meteora details", async () => {
    const screening = new MeteoraPoolDiscoveryScreeningGateway({
      baseUrl: "https://pool-discovery-api.datapi.meteora.ag",
      now: () => "2026-04-24T00:00:00.000Z",
      fetchFn: async () =>
        new Response(
          JSON.stringify([
            {
              pool_address: "pool_001",
              name: "MEME-SOL",
              active_tvl: 25_000,
              volume: 80_000,
              fee_active_tvl_ratio: 1.2,
              fee_tvl_ratio: 1.4,
              base_token_holders: 1_500,
              dlmm_params: { bin_step: 100 },
              token_x: {
                address: "mint_meme",
                symbol: "MEME",
                organic_score: 74,
                market_cap: 600_000,
              },
              token_y: {
                address: "So11111111111111111111111111111111111111112",
                symbol: "SOL",
              },
            },
          ]),
          { status: 200 },
        ),
    });

    await expect(
      screening.getCandidateDetails("pool_001"),
    ).resolves.toMatchObject({
      poolAddress: "pool_001",
      feeToTvlRatio: 1.2,
      feePerTvl24h: 1.4,
    });
  });

  it("maps Meteora Pool Discovery details for enrichment", async () => {
    let filterBy: string | null = null;
    const screening = new MeteoraPoolDiscoveryScreeningGateway({
      baseUrl: "https://pool-discovery-api.datapi.meteora.ag",
      now: () => "2026-04-24T00:00:00.000Z",
      fetchFn: async (url) => {
        const parsedUrl = new URL(String(url));
        filterBy = parsedUrl.searchParams.get("filter_by");
        return new Response(
          JSON.stringify([
            {
              pool_address: "pool_001",
              name: "MEME-SOL",
              active_tvl: 25_000,
              volume: 80_000,
              fee_active_tvl_ratio: 1.2,
              fee_per_tvl_24h: 1.4,
              volume_change_pct: 18,
              base_token_holders: 1_500,
              dlmm_params: { bin_step: 100 },
              token_x: {
                address: "mint_meme",
                symbol: "MEME",
                organic_score: 74,
                market_cap: 600_000,
                created_at: "2026-04-22T00:00:00.000Z",
              },
              token_y: {
                address: "So11111111111111111111111111111111111111112",
                symbol: "SOL",
              },
            },
          ]),
          { status: 200 },
        );
      },
    });

    await expect(
      screening.getCandidateDetails("pool_001"),
    ).resolves.toMatchObject({
      poolAddress: "pool_001",
      pairLabel: "MEME-SOL",
      feeToTvlRatio: 1.2,
      feePerTvl24h: 1.4,
      volumeTrendPct: 18,
      organicScore: 74,
      holderCount: 1_500,
      tokenAgeHours: 48,
    });
    expect(filterBy).toBe("pool_address=pool_001");
  });

  it("does not enrich Meteora details from the first pool when the filtered pool is absent", async () => {
    const screening = new MeteoraPoolDiscoveryScreeningGateway({
      baseUrl: "https://pool-discovery-api.datapi.meteora.ag",
      now: () => "2026-04-24T00:00:00.000Z",
      fetchFn: async () =>
        new Response(
          JSON.stringify([
            {
              pool_address: "pool_other",
              name: "OTHER-SOL",
              active_tvl: 25_000,
              volume: 80_000,
              fee_active_tvl_ratio: 1.2,
              fee_per_tvl_24h: 1.4,
              base_token_holders: 1_500,
              dlmm_params: { bin_step: 100 },
              token_x: {
                address: "mint_other",
                symbol: "OTHER",
                organic_score: 74,
                market_cap: 600_000,
              },
              token_y: {
                address: "So11111111111111111111111111111111111111112",
                symbol: "SOL",
              },
            },
          ]),
          { status: 200 },
        ),
    });

    await expect(
      screening.getCandidateDetails("pool_001"),
    ).resolves.toMatchObject({
      poolAddress: "pool_001",
      pairLabel: "pool_001",
      feeToTvlRatio: 0,
      organicScore: 0,
      holderCount: 0,
    });
  });

  it("maps Meteora Pool Discovery 429 details to typed rate-limit errors", async () => {
    const screening = new MeteoraPoolDiscoveryScreeningGateway({
      baseUrl: "https://pool-discovery-api.datapi.meteora.ag",
      fetchFn: createFetchFromResponse(
        new Response("<!doctype html><html>cloudflare</html>", {
          status: 429,
        }),
      ),
    });

    await expect(
      screening.getCandidateDetails("pool_001"),
    ).rejects.toMatchObject({
      name: "MeteoraRateLimitedError",
      status: 429,
      endpoint: "candidate_detail",
      poolAddress: "pool_001",
      responseKind: "cloudflare_html",
    } satisfies Partial<MeteoraRateLimitedError>);
  });

  it("treats DLMM 404 getPosition as null to preserve reconciliation semantics", async () => {
    const dlmm = new HttpDlmmGateway({
      baseUrl: "https://dlmm.example.com/v1/",
      fetchFn: createFetchFromResponse(
        new Response("not found", { status: 404 }),
      ),
    });

    await expect(dlmm.getPosition("pos_missing")).resolves.toBeNull();
  });

  it("rejects DLMM wallet position snapshots for a different requested wallet", async () => {
    const dlmm = new HttpDlmmGateway({
      baseUrl: "https://dlmm.example.com/v1/",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            wallet: "wallet_other",
            positions: [],
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      dlmm.listPositionsForWallet("wallet_001"),
    ).rejects.toBeInstanceOf(AdapterResponseValidationError);
  });

  it("maps Jupiter execute response into existing SwapGateway contract", async () => {
    const jupiter = new JupiterApiSwapGateway({
      executeBaseUrl: "https://api.jup.ag/ultra/v1/",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            signature: "sig_001",
            inputAmountResult: "100000000",
            inputAmountUi: "0.1",
            outputAmountResult: "17057460",
            outputAmountUi: 17.05746,
            outputAmountUsd: "17.05",
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      jupiter.executeSwap({
        wallet: "wallet_001",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountRaw: "100000000",
      }),
    ).resolves.toEqual({
      txId: "sig_001",
      inputAmountRaw: "100000000",
      inputAmountUi: 0.1,
      outputAmountRaw: "17057460",
      outputAmountUi: 17.05746,
      outputAmountUsd: 17.05,
    });
  });

  it("maps Jupiter malformed numeric strings into AdapterResponseValidationError", async () => {
    const jupiter = new JupiterApiSwapGateway({
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            outAmount: "abc",
            priceImpactPct: "0.0001",
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      jupiter.quoteSwap({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountRaw: "100000000",
      }),
    ).rejects.toBeInstanceOf(AdapterResponseValidationError);
  });

  it("maps Jupiter SOL price malformed numeric strings into AdapterResponseValidationError", async () => {
    const priceGateway = new JupiterSolPriceGateway({
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            outAmount: "NaN",
          }),
          { status: 200 },
        ),
      ),
      now: () => "2026-04-23T00:00:00.000Z",
    });

    await expect(priceGateway.getSolPriceUsd()).rejects.toBeInstanceOf(
      AdapterResponseValidationError,
    );
  });

  it("rejects executeSwap when amountRaw is missing", async () => {
    const jupiter = new JupiterApiSwapGateway({
      executeBaseUrl: "https://api.jup.ag/ultra/v1/",
      fetchFn: createFetchFromResponse(
        new Response(
          JSON.stringify({
            signature: "sig_001",
            inputAmountResult: "100000000",
            outputAmountResult: "17057460",
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(
      jupiter.executeSwap({
        wallet: "wallet_001",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountRaw: "not_a_number",
      }),
    ).rejects.toThrow();
  });

  it("requires an explicit execution bridge for Jupiter executeSwap", async () => {
    const jupiter = new JupiterApiSwapGateway();

    await expect(
      jupiter.executeSwap({
        wallet: "wallet_001",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountRaw: "100000000",
      }),
    ).rejects.toThrow(/executeBaseUrl is required/i);
  });
});
