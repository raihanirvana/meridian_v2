import { z } from "zod";

import { JsonHttpClient, type FetchLike } from "../http/HttpJsonClient.js";

import {
  SmartMoneySnapshotSchema,
  TokenNarrativeSnapshotSchema,
  TokenRiskSnapshotSchema,
  type TokenNarrativeSnapshot,
  type SmartMoneySnapshot,
  type TokenIntelGateway,
  type TokenRiskSnapshot,
} from "./TokenIntelGateway.js";

export interface HttpTokenIntelGatewayOptions {
  baseUrl: string;
  apiKey?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export class HttpTokenIntelGateway implements TokenIntelGateway {
  private readonly client: JsonHttpClient;

  public constructor(options: HttpTokenIntelGatewayOptions) {
    this.client = new JsonHttpClient({
      adapterName: "HttpTokenIntelGateway",
      baseUrl: options.baseUrl,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      defaultHeaders:
        options.apiKey === undefined ? {} : { "x-api-key": options.apiKey },
    });
  }

  public async getTokenRiskSnapshot(
    tokenMint: string,
  ): Promise<TokenRiskSnapshot> {
    return this.client.request({
      method: "GET",
      path: `/tokens/${encodeURIComponent(z.string().min(1).parse(tokenMint))}/risk`,
      responseSchema: TokenRiskSnapshotSchema,
    });
  }

  public async getSmartMoneySnapshot(
    tokenMint: string,
  ): Promise<SmartMoneySnapshot> {
    return this.client.request({
      method: "GET",
      path: `/tokens/${encodeURIComponent(z.string().min(1).parse(tokenMint))}/smart-money`,
      responseSchema: SmartMoneySnapshotSchema,
    });
  }

  public async getTokenNarrativeSnapshot(
    tokenMint: string,
  ): Promise<TokenNarrativeSnapshot> {
    return this.client.request({
      method: "GET",
      path:
        `/tokens/${encodeURIComponent(z.string().min(1).parse(tokenMint))}` +
        "/narrative",
      responseSchema: TokenNarrativeSnapshotSchema,
    });
  }
}
