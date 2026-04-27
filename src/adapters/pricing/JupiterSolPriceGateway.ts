import { z } from "zod";

import {
  AdapterResponseValidationError,
  JsonHttpClient,
  type FetchLike,
} from "../http/HttpJsonClient.js";

import {
  SolPriceQuoteSchema,
  type PriceGateway,
  type SolPriceQuote,
} from "./PriceGateway.js";

const JupiterQuoteResponseSchema = z
  .object({
    outAmount: z.string().min(1),
  })
  .passthrough();

const SolMint = "So11111111111111111111111111111111111111112";
const UsdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OneSolLamports = 1_000_000_000;
const UsdcDecimals = 1_000_000;

function parseAmount(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AdapterResponseValidationError("JupiterSolPriceGateway", [
      `${fieldName}: invalid numeric string`,
    ]);
  }

  return parsed;
}

export interface JupiterSolPriceGatewayOptions {
  quoteBaseUrl?: string;
  apiKey?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  now?: () => string;
}

export class JupiterSolPriceGateway implements PriceGateway {
  private readonly client: JsonHttpClient;
  private readonly now: () => string;

  public constructor(options: JupiterSolPriceGatewayOptions = {}) {
    this.client = new JsonHttpClient({
      adapterName: "JupiterSolPriceGateway",
      baseUrl: options.quoteBaseUrl ?? "https://api.jup.ag/swap/v1/",
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      defaultHeaders:
        options.apiKey === undefined ? {} : { "x-api-key": options.apiKey },
    });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async getSolPriceUsd(): Promise<SolPriceQuote> {
    const response = await this.client.request({
      method: "GET",
      path: "quote",
      query: {
        inputMint: SolMint,
        outputMint: UsdcMint,
        amount: OneSolLamports,
      },
      responseSchema: JupiterQuoteResponseSchema,
    });

    return SolPriceQuoteSchema.parse({
      symbol: "SOL",
      priceUsd: parseAmount(response.outAmount, "outAmount") / UsdcDecimals,
      asOf: this.now(),
    });
  }
}
