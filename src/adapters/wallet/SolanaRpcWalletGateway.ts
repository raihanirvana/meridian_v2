import { z } from "zod";

import { JsonHttpClient, type FetchLike } from "../http/HttpJsonClient.js";

import {
  WalletBalanceSnapshotSchema,
  type WalletBalanceSnapshot,
  type WalletGateway,
} from "./WalletGateway.js";

const LamportsPerSol = 1_000_000_000;

const GetBalanceResponseSchema = z
  .object({
    result: z
      .object({
        value: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();

export interface SolanaRpcWalletGatewayOptions {
  rpcUrl: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  now?: () => string;
}

export class SolanaRpcWalletGateway implements WalletGateway {
  private readonly client: JsonHttpClient;
  private readonly now: () => string;

  public constructor(options: SolanaRpcWalletGatewayOptions) {
    this.client = new JsonHttpClient({
      adapterName: "SolanaRpcWalletGateway",
      baseUrl: options.rpcUrl,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async getWalletBalance(
    wallet: string,
  ): Promise<WalletBalanceSnapshot> {
    const parsedWallet = z.string().min(1).parse(wallet);
    const response = await this.client.request({
      method: "POST",
      path: "",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [parsedWallet],
      },
      responseSchema: GetBalanceResponseSchema,
    });

    return WalletBalanceSnapshotSchema.parse({
      wallet: parsedWallet,
      balanceSol: response.result.value / LamportsPerSol,
      asOf: this.now(),
    });
  }
}
