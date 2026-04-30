import { z } from "zod";

import {
  CandidateSchema,
  type Candidate,
} from "../../domain/entities/Candidate.js";
import {
  AdapterResponseValidationError,
  JsonHttpClient,
  type FetchLike,
} from "../http/HttpJsonClient.js";

import {
  CandidateDetailsSchema,
  GetCandidateDetailsOptionsSchema,
  ListCandidatesRequestSchema,
  type CandidateDetails,
  type GetCandidateDetailsOptions,
  type ListCandidatesRequest,
  type ScreeningGateway,
} from "./ScreeningGateway.js";

export interface HttpScreeningGatewayOptions {
  baseUrl: string;
  apiKey?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export class HttpScreeningGateway implements ScreeningGateway {
  private readonly client: JsonHttpClient;

  public constructor(options: HttpScreeningGatewayOptions) {
    this.client = new JsonHttpClient({
      adapterName: "HttpScreeningGateway",
      baseUrl: options.baseUrl,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      defaultHeaders:
        options.apiKey === undefined ? {} : { "x-api-key": options.apiKey },
    });
  }

  public async listCandidates(
    request: ListCandidatesRequest,
  ): Promise<Candidate[]> {
    const parsedRequest = ListCandidatesRequestSchema.parse(request);
    return this.client.request({
      method: "GET",
      path: "/candidates",
      query: {
        limit: parsedRequest.limit,
        timeframe: parsedRequest.timeframe,
      },
      responseSchema: CandidateSchema.array(),
    });
  }

  public async getCandidateDetails(
    poolAddress: string,
    options: GetCandidateDetailsOptions = {},
  ): Promise<CandidateDetails> {
    const parsedPoolAddress = z.string().min(1).parse(poolAddress);
    const parsedOptions = GetCandidateDetailsOptionsSchema.parse(options);
    const details = await this.client.request({
      method: "GET",
      path: `/candidates/${encodeURIComponent(parsedPoolAddress)}`,
      query: {
        ...(parsedOptions.timeframe === undefined
          ? {}
          : { timeframe: parsedOptions.timeframe }),
      },
      responseSchema: CandidateDetailsSchema,
    });

    if (details.poolAddress !== parsedPoolAddress) {
      throw new AdapterResponseValidationError("HttpScreeningGateway", [
        `poolAddress: response pool ${details.poolAddress} does not match requested pool ${parsedPoolAddress}`,
      ]);
    }

    return details;
  }
}
