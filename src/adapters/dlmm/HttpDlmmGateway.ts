import { z } from "zod";

import {
  PositionSchema,
  type Position,
} from "../../domain/entities/Position.js";
import {
  AdapterHttpStatusError,
  JsonHttpClient,
  type FetchLike,
} from "../http/HttpJsonClient.js";

import {
  ClaimFeesRequestSchema,
  ClaimFeesResultSchema,
  ClosePositionRequestSchema,
  ClosePositionResultSchema,
  DeployLiquidityRequestSchema,
  DeployLiquidityResultSchema,
  PartialClosePositionRequestSchema,
  PartialClosePositionResultSchema,
  PoolInfoSchema,
  WalletPositionsSnapshotSchema,
  type ClaimFeesRequest,
  type ClaimFeesResult,
  type ClosePositionRequest,
  type ClosePositionResult,
  type DeployLiquidityRequest,
  type DeployLiquidityResult,
  type DlmmGateway,
  type PartialClosePositionRequest,
  type PartialClosePositionResult,
  type PoolInfo,
  type WalletPositionsSnapshot,
} from "./DlmmGateway.js";

const NullablePositionSchema = PositionSchema.nullable();

export interface HttpDlmmGatewayOptions {
  baseUrl: string;
  apiKey?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export class HttpDlmmGateway implements DlmmGateway {
  private readonly client: JsonHttpClient;

  public constructor(options: HttpDlmmGatewayOptions) {
    this.client = new JsonHttpClient({
      adapterName: "HttpDlmmGateway",
      baseUrl: options.baseUrl,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      defaultHeaders:
        options.apiKey === undefined
          ? {}
          : { authorization: `Bearer ${options.apiKey}` },
    });
  }

  public async getPosition(positionId: string): Promise<Position | null> {
    try {
      return await this.client.request({
        method: "GET",
        path: `/positions/${encodeURIComponent(z.string().min(1).parse(positionId))}`,
        responseSchema: NullablePositionSchema,
      });
    } catch (error) {
      if (error instanceof AdapterHttpStatusError && error.status === 404) {
        return null;
      }

      throw error;
    }
  }

  public async deployLiquidity(
    request: DeployLiquidityRequest,
  ): Promise<DeployLiquidityResult> {
    return this.client.request({
      method: "POST",
      path: "/positions/deploy",
      body: DeployLiquidityRequestSchema.parse(request),
      responseSchema: DeployLiquidityResultSchema,
    });
  }

  public async closePosition(
    request: ClosePositionRequest,
  ): Promise<ClosePositionResult> {
    return this.client.request({
      method: "POST",
      path: "/positions/close",
      body: ClosePositionRequestSchema.parse(request),
      responseSchema: ClosePositionResultSchema,
    });
  }

  public async claimFees(request: ClaimFeesRequest): Promise<ClaimFeesResult> {
    return this.client.request({
      method: "POST",
      path: "/positions/claim-fees",
      body: ClaimFeesRequestSchema.parse(request),
      responseSchema: ClaimFeesResultSchema,
    });
  }

  public async partialClosePosition(
    request: PartialClosePositionRequest,
  ): Promise<PartialClosePositionResult> {
    return this.client.request({
      method: "POST",
      path: "/positions/partial-close",
      body: PartialClosePositionRequestSchema.parse(request),
      responseSchema: PartialClosePositionResultSchema,
    });
  }

  public async listPositionsForWallet(
    wallet: string,
  ): Promise<WalletPositionsSnapshot> {
    return this.client.request({
      method: "GET",
      path: `/wallets/${encodeURIComponent(z.string().min(1).parse(wallet))}/positions`,
      responseSchema: WalletPositionsSnapshotSchema,
    });
  }

  public async getPoolInfo(poolAddress: string): Promise<PoolInfo> {
    return this.client.request({
      method: "GET",
      path: `/pools/${encodeURIComponent(z.string().min(1).parse(poolAddress))}`,
      responseSchema: PoolInfoSchema,
    });
  }
}
