import { z } from "zod";

import {
  AdapterResponseValidationError,
  JsonHttpClient,
  type FetchLike,
} from "../http/HttpJsonClient.js";

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
    const parsedTokenMint = z.string().min(1).parse(tokenMint);
    const snapshot = await this.client.request({
      method: "GET",
      path: `/tokens/${encodeURIComponent(parsedTokenMint)}/risk`,
      responseSchema: TokenRiskSnapshotSchema,
    });

    assertRequestedTokenMint({
      methodName: "getTokenRiskSnapshot",
      requestedTokenMint: parsedTokenMint,
      responseTokenMint: snapshot.tokenMint,
    });

    return snapshot;
  }

  public async getSmartMoneySnapshot(
    tokenMint: string,
  ): Promise<SmartMoneySnapshot> {
    const parsedTokenMint = z.string().min(1).parse(tokenMint);
    const snapshot = await this.client.request({
      method: "GET",
      path: `/tokens/${encodeURIComponent(parsedTokenMint)}/smart-money`,
      responseSchema: SmartMoneySnapshotSchema,
    });

    assertRequestedTokenMint({
      methodName: "getSmartMoneySnapshot",
      requestedTokenMint: parsedTokenMint,
      responseTokenMint: snapshot.tokenMint,
    });

    return snapshot;
  }

  public async getTokenNarrativeSnapshot(
    tokenMint: string,
  ): Promise<TokenNarrativeSnapshot> {
    const parsedTokenMint = z.string().min(1).parse(tokenMint);
    const snapshot = await this.client.request({
      method: "GET",
      path:
        `/tokens/${encodeURIComponent(parsedTokenMint)}` + "/narrative",
      responseSchema: TokenNarrativeSnapshotSchema,
    });

    assertRequestedTokenMint({
      methodName: "getTokenNarrativeSnapshot",
      requestedTokenMint: parsedTokenMint,
      responseTokenMint: snapshot.tokenMint,
    });

    return snapshot;
  }
}

function assertRequestedTokenMint(input: {
  methodName: string;
  requestedTokenMint: string;
  responseTokenMint: string;
}): void {
  if (input.responseTokenMint === input.requestedTokenMint) {
    return;
  }

  throw new AdapterResponseValidationError("HttpTokenIntelGateway", [
    `${input.methodName}.tokenMint: response token ${input.responseTokenMint} does not match requested token ${input.requestedTokenMint}`,
  ]);
}
