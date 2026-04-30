import { z } from "zod";

import {
  CandidateSchema,
  type Candidate,
} from "../../domain/entities/Candidate.js";
import {
  buildDataFreshnessSnapshot,
  buildDlmmMicrostructureSnapshot,
  buildMarketFeatureSnapshot,
} from "../../domain/rules/poolFeatureRules.js";
import { scoreStrategySuitability } from "../../domain/scoring/strategySuitabilityScore.js";
import { JsonHttpClient, type FetchLike } from "../http/HttpJsonClient.js";
import { AdapterHttpStatusError } from "../http/HttpJsonClient.js";

import {
  CandidateDetailsSchema,
  GetCandidateDetailsOptionsSchema,
  ListCandidatesRequestSchema,
  type CandidateDetails,
  type GetCandidateDetailsOptions,
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

export class MeteoraRateLimitedError extends Error {
  public readonly status = 429;
  public readonly endpoint = "candidate_detail";
  public readonly poolAddress?: string;
  public readonly retryAfterMs?: number;
  public readonly responseKind: "cloudflare_html" | "json" | "unknown";

  public constructor(input: {
    poolAddress?: string;
    retryAfterMs?: number;
    responseKind: "cloudflare_html" | "json" | "unknown";
    cause?: unknown;
  }) {
    super(
      `Meteora candidate detail rate limited${
        input.poolAddress === undefined ? "" : ` for ${input.poolAddress}`
      }`,
    );
    this.name = "MeteoraRateLimitedError";
    if (input.poolAddress !== undefined) {
      this.poolAddress = input.poolAddress;
    }
    if (input.retryAfterMs !== undefined) {
      this.retryAfterMs = input.retryAfterMs;
    }
    this.responseKind = input.responseKind;
    this.cause = input.cause;
  }
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

const PREFERRED_QUOTE_MINTS = [
  "So11111111111111111111111111111111111111112", // SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
];

function deriveBaseMintAndQuoteMint(
  tokenXMint: string,
  tokenYMint: string,
): { baseMint: string; quoteMint: string } {
  if (PREFERRED_QUOTE_MINTS.includes(tokenYMint)) {
    return { baseMint: tokenXMint, quoteMint: tokenYMint };
  }
  if (PREFERRED_QUOTE_MINTS.includes(tokenXMint)) {
    return { baseMint: tokenYMint, quoteMint: tokenXMint };
  }
  return { baseMint: tokenXMint, quoteMint: tokenYMint };
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

function extractActiveBin(pool: Record<string, unknown>): number | undefined {
  const dlmmParams = optionalRecord(pool.dlmm_params ?? pool.dlmmParams);
  return firstNumber(
    pool.active_bin,
    pool.activeBin,
    pool.active_id,
    pool.activeId,
    dlmmParams.active_bin,
    dlmmParams.activeBin,
    dlmmParams.active_id,
    dlmmParams.activeId,
  );
}

function windowedValueForTimeframe(
  value: number,
  timeframe: "5m" | "1h" | "24h" | undefined,
): {
  value5m?: number;
  value1h?: number;
  value24h?: number;
} {
  switch (timeframe) {
    case "5m":
      return { value5m: value };
    case "1h":
      return { value1h: value };
    case "24h":
      return { value24h: value };
    default:
      return {};
  }
}

function extractFeePerTvl(input: {
  pool: Record<string, unknown>;
  allowUnwindowedRatio?: boolean;
}): number | undefined {
  const explicitFeePerTvl24h = firstNumber(
    input.pool.fee_per_tvl_24h,
    input.pool.feePerTvl24h,
    input.pool.fee_tvl_24h,
    input.pool.feeTvl24h,
  );
  const feePerTvl =
    explicitFeePerTvl24h ??
    (input.allowUnwindowedRatio === true
      ? firstNumber(input.pool.fee_tvl_ratio, input.pool.feeTvlRatio)
      : undefined);
  return feePerTvl === undefined ? undefined : normalizeRatio(feePerTvl);
}

function extractPools(
  response: z.infer<typeof PoolDiscoveryResponseSchema>,
): Record<string, unknown>[] {
  if (Array.isArray(response)) {
    return response;
  }

  return response.data ?? response.pools ?? response.result ?? [];
}

function classifyRateLimitResponseKind(
  responseText: string,
): "cloudflare_html" | "json" | "unknown" {
  const trimmed = responseText.trim();
  if (
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    trimmed.toLowerCase().includes("cloudflare")
  ) {
    return "cloudflare_html";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }
  return "unknown";
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
      .map((pool) => this.toCandidate(pool, false, parsedRequest.timeframe))
      .filter((candidate): candidate is Candidate => candidate !== null);
  }

  public async getCandidateDetails(
    poolAddress: string,
    options: GetCandidateDetailsOptions = {},
  ): Promise<CandidateDetails> {
    const parsedPoolAddress = z.string().min(1).parse(poolAddress);
    const parsedOptions = GetCandidateDetailsOptionsSchema.parse(options);
    let response: z.infer<typeof PoolDiscoveryResponseSchema>;
    try {
      response = await this.client.request({
        method: "GET",
        path: "/pools",
        query: {
          page_size: 1,
          category: this.category,
          ...(parsedOptions.timeframe === undefined
            ? {}
            : { timeframe: parsedOptions.timeframe }),
          filter_by: `pool_address=${parsedPoolAddress}`,
        },
        responseSchema: PoolDiscoveryResponseSchema,
      });
    } catch (error) {
      if (error instanceof AdapterHttpStatusError && error.status === 429) {
        throw new MeteoraRateLimitedError({
          poolAddress: parsedPoolAddress,
          responseKind: classifyRateLimitResponseKind(error.responseText),
          cause: error,
        });
      }
      throw error;
    }
    const pool = extractPools(response).find(
      (item) => extractPoolAddress(item) === parsedPoolAddress,
    );

    if (pool === undefined) {
      return CandidateDetailsSchema.parse({
        poolAddress: parsedPoolAddress,
        pairLabel: parsedPoolAddress,
        feeToTvlRatio: 0,
        organicScore: 0,
        holderCount: 0,
      });
    }

    return CandidateDetailsSchema.parse(
      this.toCandidateDetails(pool, true, parsedOptions.timeframe),
    );
  }

  private toCandidate(
    pool: Record<string, unknown>,
    detailFetched: boolean = false,
    timeframe?: "5m" | "1h" | "24h",
  ): Candidate | null {
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
    const activeBin = extractActiveBin(pool);

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
      allowUnwindowedRatio: detailFetched || timeframe === "24h",
    });
    const timeframeVolume = windowedValueForTimeframe(volumeUsd, timeframe);
    const timeframeFee = windowedValueForTimeframe(feeUsd, timeframe);
    const volume5mUsd = firstNumber(pool.volume_5m, pool.volume5mUsd);
    const volume15mUsd = firstNumber(pool.volume_15m, pool.volume15mUsd);
    const volume1hUsd = firstNumber(pool.volume_1h, pool.volume1hUsd);
    const volume24hUsd = firstNumber(
      pool.volume_24h,
      pool.volume24hUsd,
      timeframeVolume.value24h,
    );
    const fees24hUsd = firstNumber(
      pool.fee_24h,
      pool.fees24hUsd,
      timeframeFee.value24h,
    );
    const fees1hUsd = firstNumber(
      pool.fee_1h,
      pool.fees1hUsd,
      timeframeFee.value1h,
    );
    const priceChange5mPct = firstNumber(
      pool.price_change_5m,
      pool.priceChange5mPct,
    );
    const priceChange15mPct = firstNumber(
      pool.price_change_15m,
      pool.priceChange15mPct,
    );
    const priceChange1hPct = firstNumber(
      pool.price_change_1h,
      pool.priceChange1hPct,
    );
    const priceChange24hPct = firstNumber(
      pool.price_change_24h,
      pool.priceChange24hPct,
    );
    const depthNearActiveUsd =
      firstNumber(
        pool.depth_near_active_usd,
        pool.depthNearActiveUsd,
        pool.liquidity_near_active_usd,
      ) ?? tvlUsd * 0.2;
    const depthWithin10BinsUsd =
      firstNumber(pool.depth_within_10_bins_usd, pool.depthWithin10BinsUsd) ??
      tvlUsd * 0.5;
    const depthWithin25BinsUsd =
      firstNumber(pool.depth_within_25_bins_usd, pool.depthWithin25BinsUsd) ??
      tvlUsd;
    const estimatedSlippageBpsForDefaultSize =
      firstNumber(
        pool.estimated_slippage_bps,
        pool.estimatedSlippageBpsForDefaultSize,
        pool.slippage_bps,
      ) ?? 0;
    const volatility5mPct = firstNumber(
      pool.volatility_5m,
      pool.volatility5mPct,
    );
    const volatility15mPct = firstNumber(
      pool.volatility_15m,
      pool.volatility15mPct,
    );
    const volatility1hPct = firstNumber(
      pool.volatility_1h,
      pool.volatility1hPct,
    );
    const trendStrength15m = firstNumber(
      pool.trend_strength_15m,
      pool.trendStrength15m,
    );
    const trendStrength1h = firstNumber(
      pool.trend_strength_1h,
      pool.trendStrength1h,
    );
    const meanReversionScore = firstNumber(
      pool.mean_reversion_score,
      pool.meanReversionScore,
    );
    const effectiveVolume5mUsd = volume5mUsd ?? timeframeVolume.value5m;
    const effectiveVolume1hUsd = volume1hUsd ?? timeframeVolume.value1h;
    const marketFeatureSnapshot = buildMarketFeatureSnapshot({
      ...(effectiveVolume5mUsd === undefined
        ? {}
        : { volume5mUsd: effectiveVolume5mUsd }),
      ...(volume15mUsd === undefined ? {} : { volume15mUsd }),
      ...(effectiveVolume1hUsd === undefined
        ? {}
        : { volume1hUsd: effectiveVolume1hUsd }),
      ...(volume24hUsd === undefined ? {} : { volume24hUsd }),
      ...(timeframeFee.value5m === undefined
        ? {}
        : { fees5mUsd: timeframeFee.value5m }),
      ...(fees1hUsd === undefined ? {} : { fees1hUsd }),
      ...(fees24hUsd === undefined ? {} : { fees24hUsd }),
      tvlUsd,
      ...(priceChange5mPct === undefined ? {} : { priceChange5mPct }),
      ...(priceChange15mPct === undefined ? {} : { priceChange15mPct }),
      ...(priceChange1hPct === undefined ? {} : { priceChange1hPct }),
      ...(priceChange24hPct === undefined ? {} : { priceChange24hPct }),
      ...(volatility5mPct === undefined ? {} : { volatility5mPct }),
      ...(volatility15mPct === undefined ? {} : { volatility15mPct }),
      ...(volatility1hPct === undefined ? {} : { volatility1hPct }),
      ...(trendStrength15m === undefined ? {} : { trendStrength15m }),
      ...(trendStrength1h === undefined ? {} : { trendStrength1h }),
      ...(meanReversionScore === undefined ? {} : { meanReversionScore }),
      washTradingRiskScore: washTradingRiskPct,
      organicVolumeScore: organicScore,
    });
    const liquidityImbalancePct = firstNumber(
      pool.liquidity_imbalance_pct,
      pool.liquidityImbalancePct,
    );
    const spreadBps = firstNumber(pool.spread_bps, pool.spreadBps);
    const outOfRangeRiskScore = firstNumber(
      pool.out_of_range_risk_score,
      pool.outOfRangeRiskScore,
    );
    const rangeStabilityScore = firstNumber(
      pool.range_stability_score,
      pool.rangeStabilityScore,
    );
    const dlmmMicrostructureSnapshot = buildDlmmMicrostructureSnapshot({
      binStep,
      activeBin: activeBin ?? null,
      activeBinSource: activeBin === undefined ? "unavailable" : "screening",
      activeBinObservedAt: activeBin === undefined ? null : now,
      depthNearActiveUsd,
      depthWithin10BinsUsd,
      depthWithin25BinsUsd,
      ...(liquidityImbalancePct === undefined ? {} : { liquidityImbalancePct }),
      ...(spreadBps === undefined ? {} : { spreadBps }),
      estimatedSlippageBpsForDefaultSize,
      ...(outOfRangeRiskScore === undefined ? {} : { outOfRangeRiskScore }),
      ...(rangeStabilityScore === undefined ? {} : { rangeStabilityScore }),
      now,
    });
    const dataFreshnessSnapshot = buildDataFreshnessSnapshot({
      now,
      screeningSnapshotAt: now,
      poolDetailFetchedAt: detailFetched ? now : null,
      tokenIntelFetchedAt: null,
      chainSnapshotFetchedAt: now,
      hasActiveBin: activeBin !== undefined,
    });
    const strategySuitability = scoreStrategySuitability({
      marketFeatureSnapshot,
      dlmmMicrostructureSnapshot,
      dataFreshnessSnapshot,
    });

    const { baseMint, quoteMint } = deriveBaseMintAndQuoteMint(
      tokenXMint,
      tokenYMint,
    );
    return CandidateSchema.parse({
      candidateId: poolAddress,
      poolAddress,
      symbolPair,
      tokenXMint,
      tokenYMint,
      baseMint,
      quoteMint,
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
        ...(feePerTvl24h === undefined ? {} : { feePerTvl24h }),
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
      marketFeatureSnapshot,
      dlmmMicrostructureSnapshot,
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
      dataFreshnessSnapshot,
      strategySuitability,
      hardFilterPassed: true,
      score: 0,
      scoreBreakdown: {},
      decision: "PASSED_HARD_FILTER",
      decisionReason: "Listed by Meteora Pool Discovery",
      createdAt: now,
    });
  }

  private toCandidateDetails(
    pool: Record<string, unknown>,
    detailFetched: boolean,
    timeframe?: "5m" | "1h" | "24h",
  ): CandidateDetails {
    const candidate = this.toCandidate(pool, detailFetched, timeframe);
    if (candidate === null) {
      const poolAddress = extractPoolAddress(pool) ?? "unknown_pool";
      return CandidateDetailsSchema.parse({
        poolAddress,
        pairLabel: poolAddress,
        feeToTvlRatio: 0,
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
      marketFeatureSnapshot: candidate.marketFeatureSnapshot,
      dlmmMicrostructureSnapshot: candidate.dlmmMicrostructureSnapshot,
      dataFreshnessSnapshot: candidate.dataFreshnessSnapshot,
      narrativeSummary: null,
      holderDistributionSummary: null,
    });
  }
}
