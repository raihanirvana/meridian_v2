import { describe, expect, it } from "vitest";

import { HttpTokenIntelGateway } from "../../src/adapters/analytics/HttpTokenIntelGateway.js";
import { HttpDlmmGateway } from "../../src/adapters/dlmm/HttpDlmmGateway.js";
import { AdapterHttpStatusError, AdapterResponseValidationError, AdapterTransportError } from "../../src/adapters/http/HttpJsonClient.js";
import { JupiterApiSwapGateway } from "../../src/adapters/jupiter/JupiterApiSwapGateway.js";
import { HttpScreeningGateway } from "../../src/adapters/screening/HttpScreeningGateway.js";

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
        amount: 100000000,
      }),
    ).resolves.toEqual({
      expectedOutputAmount: 17057460,
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
      screening.listCandidates({ limit: 1 }),
    ).resolves.toHaveLength(1);

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

    await expect(
      intel.getTokenRiskSnapshot("mint_001"),
    ).resolves.toEqual({
      tokenMint: "mint_001",
      riskScore: 10,
      topHolderPct: 12,
      botHolderPct: 1,
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
      screening.listCandidates({ limit: 5 }),
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

    await expect(
      intel.getTokenRiskSnapshot("mint_001"),
    ).rejects.toBeInstanceOf(AdapterResponseValidationError);
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
      screening.listCandidates({ limit: 5 }),
    ).rejects.toBeInstanceOf(AdapterTransportError);
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

  it("maps Jupiter execute response into existing SwapGateway contract", async () => {
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
        amount: 100000000,
      }),
    ).resolves.toEqual({
      txId: "sig_001",
      inputAmount: 100000000,
      outputAmount: 17057460,
    });
  });

  it("requires an explicit execution bridge for Jupiter executeSwap", async () => {
    const jupiter = new JupiterApiSwapGateway();

    await expect(
      jupiter.executeSwap({
        wallet: "wallet_001",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 100000000,
      }),
    ).rejects.toThrow(/executeBaseUrl is required/i);
  });
});
