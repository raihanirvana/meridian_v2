import { z } from "zod";

import {
  CandidateSchema,
  type Candidate,
} from "../../domain/entities/Candidate.js";
import { JsonHttpClient, type FetchLike } from "../http/HttpJsonClient.js";

import {
  CandidateDetailsSchema,
  ListCandidatesRequestSchema,
  type CandidateDetails,
  type ListCandidatesRequest,
  type ScreeningGateway,
} from "./ScreeningGateway.js";

const DEFAULT_POOL_DISCOVERY_BASE_URL =
  "https://pool-discovery-api.datapi.meteora.ag";

const UnknownRecordSchema = z.record(z.string(), z.unknown());

const PoolDiscoveryResponseSchema = z.union([
  z.array(UnknownRecordSchema),
  z
    .object({
      data: z.array(UnknownRecordSchema).optional(),
      pools: z.array(UnknownRecordSchema).optional(),
      result: z.array(UnknownRecordSchema).optional(),
    })
    .passthrough(),
]);

export interface MeteoraPoolDiscoveryScreeningGatewayOptions {
  baseUrl?: string;
  category?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  now?: () => string;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return UnknownRecordSchema.safeParse(value).success
    ? (value as Record<string, unknown>)
    : {};
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ageHoursFromTimestamp(
  value: unknown,
  nowMs: number,
): number | undefined {
  const timestamp = firstString(value);
  if (timestamp === undefined) {
    return undefined;
  }

  const parsedMs = Date.parse(timestamp);
  if (!Number.isFinite(parsedMs)) {
    return undefined;
  }

  return Math.max(0, (nowMs - parsedMs) / 3_600_000);
}

function normalizeRatio(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }

  return value > 0 && value < 1 ? value * 100 : value;
}

function pickTokenRecords(pool: Record<string, unknown>): {
  tokenX: Record<string, unknown>;
  tokenY: Record<string, unknown>;
} {
  const tokenX = optionalRecord(
    pool.token_x ?? pool.tokenX ?? pool.base_token ?? pool.baseToken,
  );
  const tokenY = optionalRecord(
    pool.token_y ?? pool.tokenY ?? pool.quote_token ?? pool.quoteToken,
  );

  return { tokenX, tokenY };
}

function mapPairType(symbolX: string, symbolY: string): string {
  const stableSymbols = new Set(["USDC", "USDT", "USDH", "PYUSD"]);
  return stableSymbols.has(symbolX.toUpperCase()) &&
    stableSymbols.has(symbolY.toUpperCase())
    ? "stable"
    : "volatile";
}

function extractPoolAddress(pool: Record<string, unknown>): string | undefined {
  return firstString(
    pool.pool_address,
    pool.poolAddress,
    pool.address,
    pool.publicKey,
  );
}

function extractBinStep(pool: Record<string, unknown>): number | undefined {
  const dlmmParams = optionalRecord(pool.dlmm_params ?? pool.dlmmParams);
  return firstNumber(
    dlmmParams.bin_step,
    dlmmParams.binStep,
    pool.bin_step,
    pool.binStep,
  );
}

function extractFeePerTvl(input: {
  pool: Record<string, unknown>;
  feeToTvlRatio: number;
  feeUsd: number;
  tvlUsd: number;
}): number {
  return (
    normalizeRatio(
      firstNumber(
        input.pool.fee_per_tvl_24h,
        input.pool.feePerTvl24h,
        input.pool.fee_tvl_24h,
        input.pool.feeTvl24h,
      ),
    ) ||
    (input.tvlUsd > 0
      ? (input.feeUsd / input.tvlUsd) * 100
      : input.feeToTvlRatio)
  );
}

function extractPools(
  response: z.infer<typeof PoolDiscoveryResponseSchema>,
): Record<string, unknown>[] {
  if (Array.isArray(response)) {
    return response;
  }

  return response.data ?? response.pools ?? response.result ?? [];
}

export class MeteoraPoolDiscoveryScreeningGateway implements ScreeningGateway {
  private readonly client: JsonHttpClient;
  private readonly category: string;
  private readonly now: () => string;

  public constructor(
    options: MeteoraPoolDiscoveryScreeningGatewayOptions = {},
  ) {
    this.client = new JsonHttpClient({
      adapterName: "MeteoraPoolDiscoveryScreeningGateway",
      baseUrl: options.baseUrl ?? DEFAULT_POOL_DISCOVERY_BASE_URL,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
    this.category = options.category ?? "trending";
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async listCandidates(
    request: ListCandidatesRequest,
  ): Promise<Candidate[]> {
    const parsedRequest = ListCandidatesRequestSchema.parse(request);
    const pageSize = Math.max(parsedRequest.limit * 5, 50);
    const response = await this.client.request({
      method: "GET",
      path: "/pools",
      query: {
        page_size: pageSize,
        timeframe: parsedRequest.timeframe,
        category: this.category,
      },
      responseSchema: PoolDiscoveryResponseSchema,
    });

    return extractPools(response)
      .map((pool) => this.toCandidate(pool))
      .filter((candidate): candidate is Candidate => candidate !== null);
  }

  public async getCandidateDetails(
    poolAddress: string,
  ): Promise<CandidateDetails> {
    const parsedPoolAddress = z.string().min(1).parse(poolAddress);
    const response = await this.client.request({
      method: "GET",
      path: "/pools",
      query: {
        page_size: 1,
        category: this.category,
        filter_by: `pool_address=${parsedPoolAddress}`,
      },
      responseSchema: PoolDiscoveryResponseSchema,
    });
    const pool =
      extractPools(response).find(
        (item) => extractPoolAddress(item) === parsedPoolAddress,
      ) ?? extractPools(response)[0];

    if (pool === undefined) {
      return CandidateDetailsSchema.parse({
        poolAddress: parsedPoolAddress,
        pairLabel: parsedPoolAddress,
        feeToTvlRatio: 0,
        feePerTvl24h: 0,
        organicScore: 0,
        holderCount: 0,
      });
    }

    return CandidateDetailsSchema.parse(this.toCandidateDetails(pool));
  }

  private toCandidate(pool: Record<string, unknown>): Candidate | null {
    const poolAddress = extractPoolAddress(pool);
    const { tokenX, tokenY } = pickTokenRecords(pool);
    const tokenXMint = firstString(
      tokenX.address,
      tokenX.mint,
      pool.token_x_mint,
    );
    const tokenYMint = firstString(
      tokenY.address,
      tokenY.mint,
      pool.token_y_mint,
    );
    const binStep = extractBinStep(pool);

    if (
      poolAddress === undefined ||
      tokenXMint === undefined ||
      tokenYMint === undefined ||
      binStep === undefined
    ) {
      return null;
    }

    const now = this.now();
    const nowMs = Date.parse(now);
    const symbolX =
      firstString(tokenX.symbol, pool.token_x_symbol) ?? "TOKEN_X";
    const symbolY =
      firstString(tokenY.symbol, pool.token_y_symbol) ?? "TOKEN_Y";
    const symbolPair =
      firstString(pool.name, pool.symbol_pair, pool.symbolPair) ??
      `${symbolX}-${symbolY}`;
    const tvlUsd =
      firstNumber(pool.active_tvl, pool.activeTvl, pool.tvl, pool.liquidity) ??
      0;
    const volumeUsd =
      firstNumber(pool.volume, pool.volume_usd, pool.volumeUsd) ?? 0;
    const feeUsd = firstNumber(pool.fee, pool.fee_usd, pool.feeUsd) ?? 0;
    const feeToTvlRatio = normalizeRatio(
      firstNumber(
        pool.fee_active_tvl_ratio,
        pool.feeActiveTvlRatio,
        tvlUsd > 0 ? (feeUsd / tvlUsd) * 100 : undefined,
      ),
    );
    const tokenAgeHours = ageHoursFromTimestamp(
      tokenX.created_at ?? tokenX.createdAt ?? pool.base_token_created_at,
      Number.isFinite(nowMs) ? nowMs : Date.now(),
    );
    const poolAgeHours =
      ageHoursFromTimestamp(
        pool.created_at ?? pool.createdAt,
        Number.isFinite(nowMs) ? nowMs : Date.now(),
      ) ??
      tokenAgeHours ??
      0;
    const organicScore = clamp(
      firstNumber(
        tokenX.organic_score,
        tokenX.organicScore,
        pool.organic_score,
      ) ?? 0,
      0,
      100,
    );
    const holderCount = Math.floor(
      firstNumber(
        pool.base_token_holders,
        pool.baseTokenHolders,
        tokenX.holders,
        tokenX.holder_count,
      ) ?? 0,
    );
    const topHolderPct = clamp(
      firstNumber(
        tokenX.top10_holder_pct,
        tokenX.topHolderPct,
        pool.top_holder_pct,
      ) ?? 0,
      0,
      100,
    );
    const botHolderPct = clamp(
      firstNumber(
        tokenX.bot_holder_pct,
        tokenX.botHolderPct,
        pool.bot_holder_pct,
      ) ?? 0,
      0,
      100,
    );
    const bundleRiskPct = clamp(
      firstNumber(
        tokenX.bundle_risk_pct,
        tokenX.bundleRiskPct,
        pool.bundle_risk_pct,
      ) ?? 0,
      0,
      100,
    );
    const washTradingRiskPct = clamp(
      firstNumber(pool.wash_trading_risk_pct, pool.washTradingRiskPct) ?? 0,
      0,
      100,
    );
    const feePerTvl24h = extractFeePerTvl({
      pool,
      feeToTvlRatio,
      feeUsd,
      tvlUsd,
    });

    return CandidateSchema.parse({
      candidateId: poolAddress,
      poolAddress,
      symbolPair,
      screeningSnapshot: {
        marketCapUsd:
          firstNumber(tokenX.market_cap, tokenX.marketCap, pool.market_cap) ??
          0,
        tvlUsd,
        volumeUsd,
        volumeTrendPct: firstNumber(
          pool.volume_change_pct,
          pool.volumeChangePct,
          pool.volume_trend_pct,
        ),
        volumeConsistencyScore: clamp(
          firstNumber(
            pool.volume_consistency_score,
            pool.volumeConsistencyScore,
          ) ?? 50,
          0,
          100,
        ),
        feeToTvlRatio,
        feePerTvl24h,
        organicScore,
        holderCount,
        binStep,
        launchpad: firstString(tokenX.launchpad, pool.launchpad) ?? null,
        pairType: mapPairType(symbolX, symbolY),
        athDistancePct: firstNumber(
          pool.ath_distance_pct,
          pool.athDistancePct,
          tokenX.ath_distance_pct,
        ),
      },
      tokenRiskSnapshot: {
        tokenXMint,
        tokenYMint,
        deployerAddress:
          firstString(tokenX.dev, tokenX.deployer, tokenX.deployerAddress) ??
          `unknown:${tokenXMint}`,
        topHolderPct,
        botHolderPct,
        bundleRiskPct,
        washTradingRiskPct,
        auditScore: clamp(
          firstNumber(tokenX.audit_score, tokenX.auditScore) ??
            100 - Math.max(bundleRiskPct, washTradingRiskPct),
          0,
          100,
        ),
      },
      smartMoneySnapshot: {
        smartWalletCount: Math.floor(
          firstNumber(pool.smart_wallet_count, pool.smartWalletCount) ?? 0,
        ),
        confidenceScore: clamp(
          firstNumber(pool.smart_money_confidence, pool.smartMoneyConfidence) ??
            organicScore,
          0,
          100,
        ),
        poolAgeHours,
        tokenAgeHours,
        narrativeSummary: null,
        holderDistributionSummary: null,
        narrativePenaltyScore: 0,
      },
      hardFilterPassed: true,
      score: 0,
      scoreBreakdown: {},
      decision: "PASSED_HARD_FILTER",
      decisionReason: "Listed by Meteora Pool Discovery",
      createdAt: now,
    });
  }

  private toCandidateDetails(pool: Record<string, unknown>): CandidateDetails {
    const candidate = this.toCandidate(pool);
    if (candidate === null) {
      const poolAddress = extractPoolAddress(pool) ?? "unknown_pool";
      return CandidateDetailsSchema.parse({
        poolAddress,
        pairLabel: poolAddress,
        feeToTvlRatio: 0,
        feePerTvl24h: 0,
        organicScore: 0,
        holderCount: 0,
      });
    }

    return CandidateDetailsSchema.parse({
      poolAddress: candidate.poolAddress,
      pairLabel: candidate.symbolPair,
      feeToTvlRatio: candidate.screeningSnapshot.feeToTvlRatio,
      feePerTvl24h: candidate.screeningSnapshot.feePerTvl24h,
      volumeTrendPct: candidate.screeningSnapshot.volumeTrendPct,
      organicScore: candidate.screeningSnapshot.organicScore,
      holderCount: candidate.screeningSnapshot.holderCount,
      tokenAgeHours: candidate.smartMoneySnapshot.tokenAgeHours,
      athDistancePct: candidate.screeningSnapshot.athDistancePct,
      narrativeSummary: null,
      holderDistributionSummary: null,
    });
  }
}
