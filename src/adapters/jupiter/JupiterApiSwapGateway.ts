import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
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

const JupiterSwapTransactionResponseSchema = z
  .object({
    swapTransaction: z.string().min(1),
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

function parseOptionalNonnegativeNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AdapterResponseValidationError("JupiterApiSwapGateway", [
      `${fieldName}: invalid non-negative number`,
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

function decodeWalletPrivateKey(raw: string): Uint8Array {
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error("WALLET_PRIVATE_KEY must not be empty");
  }

  if (value.startsWith("[")) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("WALLET_PRIVATE_KEY JSON array is empty or invalid");
    }
    const decoded = Uint8Array.from(parsed);
    if (decoded.length !== 64) {
      throw new Error("WALLET_PRIVATE_KEY must decode to 64 bytes");
    }
    return decoded;
  }

  const decoded = bs58.decode(value);
  if (decoded.length !== 64) {
    throw new Error("WALLET_PRIVATE_KEY must decode to 64 bytes");
  }
  return decoded;
}

export interface JupiterApiSwapGatewayOptions {
  apiKey?: string;
  quoteBaseUrl?: string;
  executeBaseUrl?: string;
  rpcUrl?: string;
  walletPrivateKey?: string;
  wallet?: string;
  slippageBps?: number;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export class JupiterApiSwapGateway implements SwapGateway {
  private readonly quoteClient: JsonHttpClient;
  private readonly executeClient: JsonHttpClient | null;
  private readonly directConnection: Connection | null;
  private readonly directWallet: Keypair | null;
  private readonly slippageBps: number | null;

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
    this.directWallet =
      options.walletPrivateKey === undefined
        ? null
        : Keypair.fromSecretKey(decodeWalletPrivateKey(options.walletPrivateKey));
    if (
      options.wallet !== undefined &&
      this.directWallet !== null &&
      this.directWallet.publicKey.toBase58() !== options.wallet
    ) {
      throw new Error("PUBLIC_WALLET_ADDRESS must match WALLET_PRIVATE_KEY");
    }
    this.directConnection =
      options.rpcUrl === undefined || this.directWallet === null
        ? null
        : new Connection(options.rpcUrl, "confirmed");
    this.slippageBps = options.slippageBps ?? null;
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
    const parsedRequest = ExecuteSwapRequestSchema.parse(request);
    if (this.executeClient === null) {
      return this.executeDirectSwap(parsedRequest);
    }

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
    const inputAmountUi = parseOptionalNonnegativeNumber(
      executeResponse.inputAmountUi,
      "inputAmountUi",
    );
    const outputAmountUi = parseOptionalNonnegativeNumber(
      executeResponse.outputAmountUi,
      "outputAmountUi",
    );
    const outputAmountUsd = parseOptionalNonnegativeNumber(
      executeResponse.outputAmountUsd,
      "outputAmountUsd",
    );

    return ExecuteSwapResultSchema.parse({
      txId: executeResponse.signature,
      inputAmountRaw,
      ...(inputAmountUi === undefined ? {} : { inputAmountUi }),
      outputAmountRaw,
      ...(outputAmountUi === undefined ? {} : { outputAmountUi }),
      ...(outputAmountUsd === undefined ? {} : { outputAmountUsd }),
    });
  }

  private async executeDirectSwap(
    parsedRequest: ExecuteSwapRequest,
  ): Promise<ExecuteSwapResult> {
    const connection = this.directConnection;
    const wallet = this.directWallet;
    if (connection === null || wallet === null) {
      throw new Error(
        "executeBaseUrl or direct signing options are required for executeSwap",
      );
    }
    const signerWallet = wallet.publicKey.toBase58();
    if (parsedRequest.wallet !== signerWallet) {
      throw new Error("swap request wallet must match WALLET_PRIVATE_KEY");
    }

    const quoteResponse = await this.quoteClient.request({
      method: "GET",
      path: "quote",
      query: {
        inputMint: parsedRequest.inputMint,
        outputMint: parsedRequest.outputMint,
        amount: parsedRequest.amountRaw,
        ...(this.slippageBps === null
          ? {}
          : { slippageBps: this.slippageBps }),
      },
      responseSchema: JupiterQuoteResponseSchema,
    });
    const swapResponse = await this.quoteClient.request({
      method: "POST",
      path: "swap",
      body: {
        quoteResponse,
        userPublicKey: signerWallet,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      },
      responseSchema: JupiterSwapTransactionResponseSchema,
    });
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(swapResponse.swapTransaction, "base64"),
    );
    transaction.sign([wallet]);

    const txId = await connection.sendRawTransaction(transaction.serialize(), {
      maxRetries: 3,
      skipPreflight: false,
    });
    const confirmation = await connection.confirmTransaction(txId, "confirmed");
    if (confirmation.value.err !== null) {
      throw new Error(
        `Jupiter swap transaction failed confirmation: ${JSON.stringify(
          confirmation.value.err,
        )}`,
      );
    }

    return ExecuteSwapResultSchema.parse({
      txId,
      inputAmountRaw: parsedRequest.amountRaw,
      outputAmountRaw: parseRawAmountString(quoteResponse.outAmount, "outAmount"),
    });
  }
}
