import { z } from "zod";

import {
  AdapterResponseValidationError,
  JsonHttpClient,
  type FetchLike,
} from "../http/HttpJsonClient.js";

import {
  ExecuteSwapRequestSchema,
  ExecuteSwapResultSchema,
  SwapQuoteRequestSchema,
  SwapQuoteResultSchema,
  type ExecuteSwapRequest,
  type ExecuteSwapResult,
  type SwapGateway,
  type SwapQuoteRequest,
  type SwapQuoteResult,
} from "./SwapGateway.js";

const JupiterQuoteResponseSchema = z
  .object({
    outAmount: z.string().min(1),
    priceImpactPct: z.string().min(1),
  })
  .passthrough();

const JupiterExecuteResponseSchema = z
  .object({
    signature: z.string().min(1),
    inputAmountResult: z.string().min(1).optional(),
    totalInputAmount: z.string().min(1).optional(),
    outputAmountResult: z.string().min(1).optional(),
    totalOutputAmount: z.string().min(1).optional(),
  })
  .passthrough();

function parseNumericString(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AdapterResponseValidationError("JupiterApiSwapGateway", [
      `${fieldName}: invalid numeric string`,
    ]);
  }

  return parsed;
}

function parseRawAmountString(value: string, fieldName: string): string {
  if (!/^\d+$/.test(value)) {
    throw new AdapterResponseValidationError("JupiterApiSwapGateway", [
      `${fieldName}: invalid raw amount string`,
    ]);
  }

  return value;
}

function pickRawAmount(
  primary: string | undefined,
  fallback: string | undefined,
  fieldName: string,
): string {
  const value = primary ?? fallback;
  if (value === undefined) {
    throw new AdapterResponseValidationError("JupiterApiSwapGateway", [
      `${fieldName}: missing numeric string`,
    ]);
  }

  return parseRawAmountString(value, fieldName);
}

export interface JupiterApiSwapGatewayOptions {
  apiKey?: string;
  quoteBaseUrl?: string;
  executeBaseUrl?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export class JupiterApiSwapGateway implements SwapGateway {
  private readonly quoteClient: JsonHttpClient;
  private readonly executeClient: JsonHttpClient | null;

  public constructor(options: JupiterApiSwapGatewayOptions = {}) {
    const defaultHeaders =
      options.apiKey === undefined ? {} : { "x-api-key": options.apiKey };

    this.quoteClient = new JsonHttpClient({
      adapterName: "JupiterApiSwapGateway.quote",
      baseUrl: options.quoteBaseUrl ?? "https://api.jup.ag/swap/v1/",
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      defaultHeaders,
    });
    this.executeClient =
      options.executeBaseUrl === undefined
        ? null
        : new JsonHttpClient({
            adapterName: "JupiterApiSwapGateway.execute",
            baseUrl: options.executeBaseUrl,
            ...(options.fetchFn === undefined
              ? {}
              : { fetchFn: options.fetchFn }),
            ...(options.timeoutMs === undefined
              ? {}
              : { timeoutMs: options.timeoutMs }),
            defaultHeaders,
          });
  }

  public async quoteSwap(request: SwapQuoteRequest): Promise<SwapQuoteResult> {
    const parsedRequest = SwapQuoteRequestSchema.parse(request);
    const quoteResponse = await this.quoteClient.request({
      method: "GET",
      path: "quote",
      query: {
        inputMint: parsedRequest.inputMint,
        outputMint: parsedRequest.outputMint,
        amount: parsedRequest.amountRaw,
      },
      responseSchema: JupiterQuoteResponseSchema,
    });

    return SwapQuoteResultSchema.parse({
      expectedOutputAmountRaw: parseRawAmountString(
        quoteResponse.outAmount,
        "outAmount",
      ),
      // Jupiter returns a fractional ratio string such as "0.0001" (= 0.01%).
      priceImpactPct: parseNumericString(
        quoteResponse.priceImpactPct,
        "priceImpactPct",
      ),
    });
  }

  public async executeSwap(
    request: ExecuteSwapRequest,
  ): Promise<ExecuteSwapResult> {
    if (this.executeClient === null) {
      throw new Error(
        "executeBaseUrl is required for executeSwap; Batch 16 still expects an execution bridge for signed swap submission",
      );
    }

    const parsedRequest = ExecuteSwapRequestSchema.parse(request);
    const executeResponse = await this.executeClient.request({
      method: "POST",
      path: "execute",
      body: {
        wallet: parsedRequest.wallet,
        inputMint: parsedRequest.inputMint,
        outputMint: parsedRequest.outputMint,
        amount: parsedRequest.amountRaw,
      },
      responseSchema: JupiterExecuteResponseSchema,
    });
    const inputAmountRaw = pickRawAmount(
      executeResponse.inputAmountResult,
      executeResponse.totalInputAmount,
      "inputAmountResult",
    );
    const outputAmountRaw = pickRawAmount(
      executeResponse.outputAmountResult,
      executeResponse.totalOutputAmount,
      "outputAmountResult",
    );

    return ExecuteSwapResultSchema.parse({
      txId: executeResponse.signature,
      inputAmountRaw,
      outputAmountRaw,
    });
  }
}
