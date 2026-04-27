import {
  DataFreshnessSnapshotSchema,
  DlmmMicrostructureSnapshotSchema,
  MarketFeatureSnapshotSchema,
  type DataFreshnessSnapshot,
  type DlmmMicrostructureSnapshot,
  type MarketFeatureSnapshot,
} from "../entities/Candidate.js";

const DefaultFreshnessMaxAgeMs = 120_000;
const MissingSnapshotAgeMs = 86_400_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

function ageMs(timestamp: string | null, nowMs: number): number {
  if (timestamp === null) {
    return MissingSnapshotAgeMs;
  }

  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return MissingSnapshotAgeMs;
  }

  return Math.max(0, nowMs - parsed);
}

export function buildMarketFeatureSnapshot(input: {
  volume5mUsd?: number;
  volume15mUsd?: number;
  volume1hUsd?: number;
  volume24hUsd?: number;
  fees5mUsd?: number;
  fees15mUsd?: number;
  fees1hUsd?: number;
  fees24hUsd?: number;
  tvlUsd: number;
  priceChange5mPct?: number;
  priceChange15mPct?: number;
  priceChange1hPct?: number;
  priceChange24hPct?: number;
  volatility5mPct?: number;
  volatility15mPct?: number;
  volatility1hPct?: number;
  trendStrength15m?: number;
  trendStrength1h?: number;
  meanReversionScore?: number;
  washTradingRiskScore?: number;
  organicVolumeScore?: number;
}): MarketFeatureSnapshot {
  const volume24hUsd = input.volume24hUsd ?? 0;
  const volume1hUsd =
    input.volume1hUsd ??
    (input.volume24hUsd === undefined ? 0 : volume24hUsd / 24);
  const volume15mUsd =
    input.volume15mUsd ??
    (input.volume1hUsd !== undefined || input.volume24hUsd !== undefined
      ? volume1hUsd / 4
      : 0);
  const volume5mUsd =
    input.volume5mUsd ??
    (input.volume15mUsd !== undefined ||
    input.volume1hUsd !== undefined ||
    input.volume24hUsd !== undefined
      ? volume15mUsd / 3
      : 0);
  const fees24hUsd = input.fees24hUsd ?? 0;
  const fees1hUsd =
    input.fees1hUsd ?? (input.fees24hUsd === undefined ? 0 : fees24hUsd / 24);
  const fees15mUsd =
    input.fees15mUsd ??
    (input.fees1hUsd !== undefined || input.fees24hUsd !== undefined
      ? fees1hUsd / 4
      : 0);
  const fees5mUsd =
    input.fees5mUsd ??
    (input.fees15mUsd !== undefined ||
    input.fees1hUsd !== undefined ||
    input.fees24hUsd !== undefined
      ? fees15mUsd / 3
      : 0);
  const priceChange15mPct =
    input.priceChange15mPct ?? input.priceChange5mPct ?? 0;
  const priceChange1hPct = input.priceChange1hPct ?? priceChange15mPct;

  return MarketFeatureSnapshotSchema.parse({
    volume5mUsd,
    volume15mUsd,
    volume1hUsd,
    volume24hUsd,
    fees5mUsd,
    fees15mUsd,
    fees1hUsd,
    fees24hUsd,
    tvlUsd: input.tvlUsd,
    feeTvlRatio1h: ratio(fees1hUsd, input.tvlUsd),
    feeTvlRatio24h: ratio(fees24hUsd, input.tvlUsd),
    volumeTvlRatio1h: ratio(volume1hUsd, input.tvlUsd),
    volumeTvlRatio24h: ratio(volume24hUsd, input.tvlUsd),
    priceChange5mPct: input.priceChange5mPct ?? 0,
    priceChange15mPct,
    priceChange1hPct,
    priceChange24hPct: input.priceChange24hPct ?? priceChange1hPct,
    volatility5mPct:
      input.volatility5mPct ?? Math.abs(input.priceChange5mPct ?? 0),
    volatility15mPct: input.volatility15mPct ?? Math.abs(priceChange15mPct),
    volatility1hPct: input.volatility1hPct ?? Math.abs(priceChange1hPct),
    trendStrength15m: clamp(
      input.trendStrength15m ?? Math.abs(priceChange15mPct) * 10,
      0,
      100,
    ),
    trendStrength1h: clamp(
      input.trendStrength1h ?? Math.abs(priceChange1hPct) * 8,
      0,
      100,
    ),
    meanReversionScore: clamp(input.meanReversionScore ?? 50, 0, 100),
    washTradingRiskScore: clamp(input.washTradingRiskScore ?? 0, 0, 100),
    organicVolumeScore: clamp(input.organicVolumeScore ?? 50, 0, 100),
  });
}

export function buildDlmmMicrostructureSnapshot(input: {
  binStep: number;
  activeBin?: number | null;
  activeBinSource?: string;
  activeBinObservedAt?: string | null;
  activeBinDriftFromDiscovery?: number;
  depthNearActiveUsd?: number;
  depthWithin10BinsUsd?: number;
  depthWithin25BinsUsd?: number;
  liquidityImbalancePct?: number;
  spreadBps?: number;
  estimatedSlippageBpsForDefaultSize?: number;
  outOfRangeRiskScore?: number;
  rangeStabilityScore?: number;
  now: string;
}): DlmmMicrostructureSnapshot {
  const observedAt = input.activeBinObservedAt ?? input.now ?? null;
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) {
    throw new Error(
      "buildDlmmMicrostructureSnapshot requires a valid ISO timestamp in now",
    );
  }
  const activeBinAgeMs =
    observedAt === null ? MissingSnapshotAgeMs : ageMs(observedAt, nowMs);
  const depthWithin25BinsUsd =
    input.depthWithin25BinsUsd ??
    input.depthWithin10BinsUsd ??
    input.depthNearActiveUsd ??
    0;
  const depthWithin10BinsUsd =
    input.depthWithin10BinsUsd ??
    input.depthNearActiveUsd ??
    depthWithin25BinsUsd;

  return DlmmMicrostructureSnapshotSchema.parse({
    binStep: input.binStep,
    activeBin: input.activeBin ?? null,
    activeBinSource: input.activeBinSource ?? "screening",
    activeBinObservedAt: observedAt,
    activeBinAgeMs,
    activeBinDriftFromDiscovery: input.activeBinDriftFromDiscovery ?? 0,
    depthNearActiveUsd: input.depthNearActiveUsd ?? depthWithin10BinsUsd,
    depthWithin10BinsUsd,
    depthWithin25BinsUsd,
    liquidityImbalancePct: clamp(input.liquidityImbalancePct ?? 0, 0, 100),
    spreadBps: input.spreadBps ?? 0,
    estimatedSlippageBpsForDefaultSize:
      input.estimatedSlippageBpsForDefaultSize ?? 0,
    outOfRangeRiskScore: clamp(input.outOfRangeRiskScore ?? 0, 0, 100),
    rangeStabilityScore: clamp(input.rangeStabilityScore ?? 50, 0, 100),
  });
}

export function buildDataFreshnessSnapshot(input: {
  now: string;
  screeningSnapshotAt?: string | null;
  poolDetailFetchedAt?: string | null;
  tokenIntelFetchedAt?: string | null;
  chainSnapshotFetchedAt?: string | null;
  maxAgeMs?: number;
  hasActiveBin: boolean;
}): DataFreshnessSnapshot {
  const nowMs = Date.parse(input.now);
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const screeningSnapshotAt = input.screeningSnapshotAt ?? null;
  const poolDetailFetchedAt = input.poolDetailFetchedAt ?? null;
  const tokenIntelFetchedAt = input.tokenIntelFetchedAt ?? null;
  const chainSnapshotFetchedAt = input.chainSnapshotFetchedAt ?? null;
  const hasRequiredTimestamps =
    screeningSnapshotAt !== null &&
    poolDetailFetchedAt !== null &&
    tokenIntelFetchedAt !== null &&
    chainSnapshotFetchedAt !== null;
  const oldestRequiredSnapshotAgeMs = Math.max(
    ageMs(screeningSnapshotAt, safeNowMs),
    ageMs(poolDetailFetchedAt, safeNowMs),
    ageMs(tokenIntelFetchedAt, safeNowMs),
    ageMs(chainSnapshotFetchedAt, safeNowMs),
  );
  const maxAgeMs = input.maxAgeMs ?? DefaultFreshnessMaxAgeMs;

  return DataFreshnessSnapshotSchema.parse({
    screeningSnapshotAt,
    poolDetailFetchedAt,
    tokenIntelFetchedAt,
    chainSnapshotFetchedAt,
    oldestRequiredSnapshotAgeMs,
    isFreshEnoughForDeploy:
      input.hasActiveBin &&
      hasRequiredTimestamps &&
      oldestRequiredSnapshotAgeMs <= maxAgeMs,
  });
}
