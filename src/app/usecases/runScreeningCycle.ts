import { z } from "zod";

import type { ScreeningGateway } from "../../adapters/screening/ScreeningGateway.js";
import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { PriceGateway } from "../../adapters/pricing/PriceGateway.js";
import type { WalletGateway } from "../../adapters/wallet/WalletGateway.js";
import type { TokenIntelGateway } from "../../adapters/analytics/TokenIntelGateway.js";
import type { LlmGateway } from "../../adapters/llm/LlmGateway.js";
import {
  CandidateSchema,
  type Candidate,
} from "../../domain/entities/Candidate.js";
import {
  screenAndScoreCandidates,
  type ScreeningPolicy,
} from "../../domain/rules/screeningRules.js";
import { buildEnrichmentPlan } from "../../domain/rules/enrichmentBudgetRules.js";
import { buildDataFreshnessSnapshot } from "../../domain/rules/poolFeatureRules.js";
import type { PortfolioRiskPolicy } from "../../domain/rules/riskRules.js";
import {
  ScreeningCandidateInputSchema,
  type ScreeningCandidateInput,
} from "../../domain/scoring/candidateScore.js";
import { deriveDefaultCandidateScorePolicy } from "../../domain/scoring/defaultCandidateScorePolicy.js";
import { logger } from "../../infra/logging/logger.js";
import type { UserConfig } from "../../infra/config/configSchema.js";
import { rankShortlistWithAi } from "../services/AiAdvisoryService.js";
import { buildPortfolioState } from "../services/PortfolioStateBuilder.js";
import type { PolicyProvider } from "../services/PolicyProvider.js";
import type { SignalWeightsProvider } from "../services/SignalWeightsProvider.js";
import type { LessonPromptService } from "../services/LessonPromptService.js";
import type { MeteoraDetailRateLimiter } from "../services/MeteoraDetailRateLimiter.js";

function nowTimestamp(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function toJournalRecord(value: unknown): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(JSON.stringify(value)));
}

async function appendJournalBestEffort(
  journalRepository: JournalRepository,
  event: {
    timestamp: string;
    eventType: string;
    actor: "system" | "operator" | "ai";
    wallet: string;
    positionId: string | null;
    actionId: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    txIds: string[];
    resultStatus: string;
    error: string | null;
  },
  warningMessage: string,
): Promise<void> {
  try {
    await journalRepository.append(event);
  } catch (error) {
    logger.warn({ err: error, eventType: event.eventType }, warningMessage);
  }
}

function asNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`candidate field ${fieldName} must be a finite number`);
  }

  return value;
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`candidate field ${fieldName} must be a non-empty string`);
  }

  return value;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function addMs(timestamp: string, ms: number): string {
  return new Date(Date.parse(timestamp) + ms).toISOString();
}

function sleep(ms: number): Promise<void> {
  return ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitedDetailError(error: unknown): {
  poolAddress?: string;
  retryAfterMs?: number;
  responseKind: "cloudflare_html" | "json" | "unknown";
} | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const record = error as Record<string, unknown>;
  if (record.status !== 429 || record.endpoint !== "candidate_detail") {
    return null;
  }
  const responseKind =
    record.responseKind === "cloudflare_html" ||
    record.responseKind === "json" ||
    record.responseKind === "unknown"
      ? record.responseKind
      : "unknown";
  return {
    ...(typeof record.poolAddress === "string"
      ? { poolAddress: record.poolAddress }
      : {}),
    ...(typeof record.retryAfterMs === "number"
      ? { retryAfterMs: record.retryAfterMs }
      : {}),
    responseKind,
  };
}

function toScreeningInput(
  candidate: Candidate,
  details: {
    feePerTvl24h?: number;
    tokenAgeHours?: number;
    athDistancePct?: number;
    volumeTrendPct?: number;
    marketFeatureSnapshot?: Candidate["marketFeatureSnapshot"];
    dlmmMicrostructureSnapshot?: Candidate["dlmmMicrostructureSnapshot"];
    dataFreshnessSnapshot?: Candidate["dataFreshnessSnapshot"];
    narrativeSummary?: string | null;
    holderDistributionSummary?: string | null;
  },
): ScreeningCandidateInput {
  return ScreeningCandidateInputSchema.parse({
    candidateId: candidate.candidateId,
    poolAddress: candidate.poolAddress,
    symbolPair: candidate.symbolPair,
    tokenXMint: asString(candidate.tokenRiskSnapshot.tokenXMint, "tokenXMint"),
    tokenYMint: asString(candidate.tokenRiskSnapshot.tokenYMint, "tokenYMint"),
    marketCapUsd: asNumber(
      candidate.screeningSnapshot.marketCapUsd,
      "marketCapUsd",
    ),
    tvlUsd: asNumber(candidate.screeningSnapshot.tvlUsd, "tvlUsd"),
    volumeUsd: asNumber(candidate.screeningSnapshot.volumeUsd, "volumeUsd"),
    volumeTrendPct:
      details.volumeTrendPct ??
      asOptionalNumber(candidate.screeningSnapshot.volumeTrendPct),
    volumeConsistencyScore: asNumber(
      candidate.screeningSnapshot.volumeConsistencyScore,
      "volumeConsistencyScore",
    ),
    feeToTvlRatio: asNumber(
      candidate.screeningSnapshot.feeToTvlRatio,
      "feeToTvlRatio",
    ),
    feePerTvl24h:
      details.feePerTvl24h ??
      asOptionalNumber(candidate.screeningSnapshot.feePerTvl24h),
    organicScore: asNumber(
      candidate.screeningSnapshot.organicScore,
      "organicScore",
    ),
    holderCount: asNumber(
      candidate.screeningSnapshot.holderCount,
      "holderCount",
    ),
    binStep: asNumber(candidate.screeningSnapshot.binStep, "binStep"),
    launchpad: asNullableString(candidate.screeningSnapshot.launchpad) ?? null,
    deployerAddress: asString(
      candidate.tokenRiskSnapshot.deployerAddress,
      "deployerAddress",
    ),
    pairType: asString(candidate.screeningSnapshot.pairType, "pairType"),
    topHolderPct: asNumber(
      candidate.tokenRiskSnapshot.topHolderPct,
      "topHolderPct",
    ),
    botHolderPct: asNumber(
      candidate.tokenRiskSnapshot.botHolderPct,
      "botHolderPct",
    ),
    bundleRiskPct: asNumber(
      candidate.tokenRiskSnapshot.bundleRiskPct,
      "bundleRiskPct",
    ),
    washTradingRiskPct: asNumber(
      candidate.tokenRiskSnapshot.washTradingRiskPct,
      "washTradingRiskPct",
    ),
    auditScore: asNumber(candidate.tokenRiskSnapshot.auditScore, "auditScore"),
    smartWalletCount: asNumber(
      candidate.smartMoneySnapshot.smartWalletCount,
      "smartWalletCount",
    ),
    smartMoneyConfidenceScore: asNumber(
      candidate.smartMoneySnapshot.confidenceScore,
      "confidenceScore",
    ),
    poolAgeHours: asNumber(
      candidate.smartMoneySnapshot.poolAgeHours,
      "poolAgeHours",
    ),
    tokenAgeHours:
      details.tokenAgeHours ??
      asOptionalNumber(candidate.smartMoneySnapshot.tokenAgeHours),
    athDistancePct:
      details.athDistancePct ??
      asOptionalNumber(candidate.screeningSnapshot.athDistancePct),
    narrativeSummary:
      details.narrativeSummary ??
      asNullableString(candidate.smartMoneySnapshot.narrativeSummary) ??
      null,
    holderDistributionSummary:
      details.holderDistributionSummary ??
      asNullableString(
        candidate.smartMoneySnapshot.holderDistributionSummary,
      ) ??
      null,
    narrativePenaltyScore: asNumber(
      candidate.smartMoneySnapshot.narrativePenaltyScore,
      "narrativePenaltyScore",
    ),
    marketFeatureSnapshot:
      details.marketFeatureSnapshot ?? candidate.marketFeatureSnapshot,
    dlmmMicrostructureSnapshot:
      details.dlmmMicrostructureSnapshot ??
      candidate.dlmmMicrostructureSnapshot,
    dataFreshnessSnapshot:
      details.dataFreshnessSnapshot ?? candidate.dataFreshnessSnapshot,
  });
}

function mergeCandidateContext(
  candidate: Candidate,
  enriched: ScreeningCandidateInput,
  createdAt: string,
): Candidate {
  return CandidateSchema.parse({
    ...candidate,
    createdAt,
    screeningSnapshot: {
      ...candidate.screeningSnapshot,
      feePerTvl24h: enriched.feePerTvl24h,
      tokenAgeHours: enriched.tokenAgeHours,
      athDistancePct: enriched.athDistancePct,
      volumeTrendPct: enriched.volumeTrendPct,
    },
    marketFeatureSnapshot: enriched.marketFeatureSnapshot,
    dlmmMicrostructureSnapshot: enriched.dlmmMicrostructureSnapshot,
    dataFreshnessSnapshot: enriched.dataFreshnessSnapshot,
    smartMoneySnapshot: {
      ...candidate.smartMoneySnapshot,
      tokenAgeHours: enriched.tokenAgeHours,
      narrativeSummary: enriched.narrativeSummary ?? null,
      holderDistributionSummary: enriched.holderDistributionSummary ?? null,
    },
  });
}

export interface RunScreeningCycleInput {
  wallet: string;
  screeningGateway: ScreeningGateway;
  stateRepository: StateRepository;
  actionRepository: ActionRepository;
  journalRepository: JournalRepository;
  walletGateway: WalletGateway;
  priceGateway: PriceGateway;
  riskPolicy: PortfolioRiskPolicy;
  policyProvider: PolicyProvider;
  signalWeightsProvider?: SignalWeightsProvider;
  tokenIntelGateway?: TokenIntelGateway;
  aiMode?: UserConfig["ai"]["mode"];
  lessonPromptService?: LessonPromptService;
  llmGateway?: LlmGateway;
  aiTimeoutMs?: number;
  poolMemoryRepository?: PoolMemoryRepository;
  candidateLimit?: number;
  detailEnrichmentTopN?: number;
  maxDetailRequestsPerCycle?: number;
  detailCooldownAfter429Ms?: number;
  detailRateLimiter?: MeteoraDetailRateLimiter;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
}

export interface RunScreeningCycleResult {
  wallet: string;
  evaluatedAt: string;
  timeframe: ScreeningPolicy["timeframe"];
  candidates: Candidate[];
  shortlist: Candidate[];
  aiSource: "DISABLED" | "DETERMINISTIC" | "AI" | "FALLBACK";
  aiReasoning: string | null;
  enrichmentSummary: {
    candidateCount: number;
    hardFilterPassed: number;
    selectedForDetail: number;
    skippedDetail: number;
    rateLimitCooldownUntil: string | null;
    snapshotOnlyWatchCount: number;
    deployBlockedMissingDetailCount: number;
  };
}

export async function runScreeningCycle(
  input: RunScreeningCycleInput,
): Promise<RunScreeningCycleResult> {
  const now = nowTimestamp(input.now);
  const screeningPolicy = await input.policyProvider.resolveScreeningPolicy();
  const portfolio = await buildPortfolioState({
    wallet: input.wallet,
    minReserveUsd: input.riskPolicy.minReserveUsd,
    dailyLossLimitPct: input.riskPolicy.dailyLossLimitPct,
    circuitBreakerCooldownMin: input.riskPolicy.circuitBreakerCooldownMin,
    stateRepository: input.stateRepository,
    actionRepository: input.actionRepository,
    journalRepository: input.journalRepository,
    walletGateway: input.walletGateway,
    priceGateway: input.priceGateway,
    now,
  });
  const listedCandidates = await input.screeningGateway.listCandidates({
    limit:
      input.candidateLimit ?? Math.max(screeningPolicy.shortlistLimit * 5, 10),
    timeframe: screeningPolicy.timeframe,
  });

  const coarseInputs = listedCandidates.map((candidate) =>
    toScreeningInput(candidate, {}),
  );
  const signalWeights =
    input.signalWeightsProvider === undefined
      ? undefined
      : await input.signalWeightsProvider.resolveSignalWeights();
  const poolMemoryMap =
    input.poolMemoryRepository === undefined
      ? undefined
      : Object.fromEntries(
          (await input.poolMemoryRepository.listAll()).map((entry) => [
            entry.poolAddress,
            { cooldownUntil: entry.cooldownUntil },
          ]),
        );
  const {
    minVolumeTrendPct: _coarseMinVolumeTrendPct,
    minTokenAgeHours: _coarseMinTokenAgeHours,
    maxTokenAgeHours: _coarseMaxTokenAgeHours,
    athFilterPct: _coarseAthFilterPct,
    ...coarsePolicyBase
  } = screeningPolicy;
  const coarsePolicy: ScreeningPolicy = {
    ...coarsePolicyBase,
    minFeePerTvl24h: 0,
    requireFreshSnapshot: false,
  };
  const coarse = screenAndScoreCandidates({
    candidates: coarseInputs,
    portfolio,
    screeningPolicy: coarsePolicy,
    scoringPolicy: deriveDefaultCandidateScorePolicy(coarsePolicy),
    ...(signalWeights === undefined ? {} : { signalWeights }),
    ...(poolMemoryMap === undefined ? {} : { poolMemoryMap }),
    createdAt: now,
    now,
  });
  const detailTopN =
    input.detailEnrichmentTopN ??
    screeningPolicy.detailEnrichmentTopN ??
    Math.min(5, screeningPolicy.shortlistLimit);
  const maxDetailRequestsPerCycle =
    input.maxDetailRequestsPerCycle ??
    screeningPolicy.maxDetailRequestsPerCycle ??
    detailTopN;
  const endpointCooldownUntil =
    (await input.detailRateLimiter?.getCooldownUntil()) ?? null;
  const enrichmentPlan = buildEnrichmentPlan({
    candidates: coarse.candidates.filter(
      (candidate) => candidate.hardFilterPassed,
    ),
    topN: detailTopN,
    maxDetailRequestsPerCycle,
    now,
    endpointCooldownUntil,
  });

  await input.journalRepository.append({
    timestamp: now,
    eventType: "ENRICHMENT_PLAN_BUILT",
    actor: "system",
    wallet: input.wallet,
    positionId: null,
    actionId: null,
    before: null,
    after: toJournalRecord({
      candidateCount: listedCandidates.length,
      hardFilterPassed: coarse.candidates.filter(
        (candidate) => candidate.hardFilterPassed,
      ).length,
      selectedCount: enrichmentPlan.selectedForDetail.length,
      skippedCount: enrichmentPlan.skipped.length,
      topN: detailTopN,
      maxDetailRequestsPerCycle,
      endpointCooldownUntil,
    }),
    txIds: [],
    resultStatus: "PLANNED",
    error: null,
  });
  for (const skipped of enrichmentPlan.skipped) {
    await appendJournalBestEffort(
      input.journalRepository,
      {
        timestamp: now,
        eventType: "METEORA_DETAIL_REQUEST_SKIPPED",
        actor: "system",
        wallet: input.wallet,
        positionId: null,
        actionId: null,
        before: null,
        after: toJournalRecord(skipped),
        txIds: [],
        resultStatus: "SKIPPED",
        error: null,
      },
      "detail request skipped journal append failed",
    );
  }

  const selectedIds = new Set(
    enrichmentPlan.selectedForDetail.map((candidate) => candidate.candidateId),
  );
  const detailByCandidateId = new Map<
    string,
    {
      feePerTvl24h?: number;
      tokenAgeHours?: number;
      athDistancePct?: number;
      volumeTrendPct?: number;
      marketFeatureSnapshot?: Candidate["marketFeatureSnapshot"];
      dlmmMicrostructureSnapshot?: Candidate["dlmmMicrostructureSnapshot"];
      dataFreshnessSnapshot?: Candidate["dataFreshnessSnapshot"];
      narrativeSummary?: string | null;
      holderDistributionSummary?: string | null;
    }
  >();
  let rateLimitCooldownUntil: string | null = endpointCooldownUntil;
  let stoppedByRateLimit = false;
  const wait = input.sleep ?? sleep;
  let detailRequestNow = now;

  for (const [index, candidate] of enrichmentPlan.selectedForDetail.entries()) {
    if (stoppedByRateLimit) {
      break;
    }

    const limiterDecision =
      await input.detailRateLimiter?.reserveRequest(detailRequestNow);
    if (limiterDecision !== undefined && !limiterDecision.allowed) {
      rateLimitCooldownUntil =
        limiterDecision.reason === "window_budget_exhausted"
          ? addMs(detailRequestNow, limiterDecision.retryAfterMs)
          : ((await input.detailRateLimiter?.getCooldownUntil()) ?? null);
      const remainingDetailsSkipped =
        enrichmentPlan.selectedForDetail.length - index;
      await appendJournalBestEffort(
        input.journalRepository,
        {
          timestamp: now,
          eventType: "METEORA_DETAIL_REQUEST_SKIPPED",
          actor: "system",
          wallet: input.wallet,
          positionId: null,
          actionId: null,
          before: null,
          after: toJournalRecord({
            candidateId: candidate.candidateId,
            poolAddress: candidate.poolAddress,
            reason: limiterDecision.reason,
            retryAfterMs: limiterDecision.retryAfterMs,
            remainingDetailsSkipped,
          }),
          txIds: [],
          resultStatus: "SKIPPED",
          error: limiterDecision.reason,
        },
        "detail request skipped journal append failed",
      );
      break;
    }
    if (limiterDecision !== undefined && limiterDecision.waitMs > 0) {
      await wait(limiterDecision.waitMs);
      detailRequestNow = addMs(detailRequestNow, limiterDecision.waitMs);
    }

    try {
      const tokenMint = asString(
        candidate.tokenRiskSnapshot.tokenXMint,
        "tokenXMint",
      );
      const narrativePromise =
        input.tokenIntelGateway === undefined
          ? Promise.resolve(null)
          : input.tokenIntelGateway
              .getTokenNarrativeSnapshot(tokenMint)
              .catch((error) => {
                logger.warn(
                  { err: error, tokenMint, poolAddress: candidate.poolAddress },
                  "token narrative enrichment failed; continuing with gateway details",
                );
                return null;
              });
      const [details, narrative] = await Promise.all([
        input.screeningGateway.getCandidateDetails(candidate.poolAddress),
        narrativePromise,
      ]);
      await input.detailRateLimiter?.recordSuccess(detailRequestNow);

      let narrativeSummary = details?.narrativeSummary ?? null;
      let holderDistributionSummary =
        details?.holderDistributionSummary ?? null;
      if (narrative !== null) {
        narrativeSummary = narrative.narrativeSummary ?? narrativeSummary;
        holderDistributionSummary =
          narrative.holderDistributionSummary ?? holderDistributionSummary;
      }

      const updatedDataFreshnessSnapshot = (() => {
        if (details?.dataFreshnessSnapshot === undefined) return undefined;
        if (narrative === null) return details.dataFreshnessSnapshot;
        return buildDataFreshnessSnapshot({
          now: detailRequestNow,
          screeningSnapshotAt: details.dataFreshnessSnapshot.screeningSnapshotAt,
          poolDetailFetchedAt: details.dataFreshnessSnapshot.poolDetailFetchedAt,
          tokenIntelFetchedAt: detailRequestNow,
          chainSnapshotFetchedAt: details.dataFreshnessSnapshot.chainSnapshotFetchedAt,
          hasActiveBin:
            details.dlmmMicrostructureSnapshot?.activeBinSource !== "unavailable",
        });
      })();
      detailByCandidateId.set(candidate.candidateId, {
        ...(details?.feePerTvl24h === undefined
          ? {}
          : { feePerTvl24h: details.feePerTvl24h }),
        ...(details?.tokenAgeHours === undefined
          ? {}
          : { tokenAgeHours: details.tokenAgeHours }),
        ...(details?.athDistancePct === undefined
          ? {}
          : { athDistancePct: details.athDistancePct }),
        ...(details?.volumeTrendPct === undefined
          ? {}
          : { volumeTrendPct: details.volumeTrendPct }),
        ...(details?.marketFeatureSnapshot === undefined
          ? {}
          : { marketFeatureSnapshot: details.marketFeatureSnapshot }),
        ...(details?.dlmmMicrostructureSnapshot === undefined
          ? {}
          : { dlmmMicrostructureSnapshot: details.dlmmMicrostructureSnapshot }),
        ...(updatedDataFreshnessSnapshot === undefined
          ? {}
          : { dataFreshnessSnapshot: updatedDataFreshnessSnapshot }),
        ...(narrativeSummary === null ? {} : { narrativeSummary }),
        ...(holderDistributionSummary === null
          ? {}
          : { holderDistributionSummary }),
      });
      await appendJournalBestEffort(
        input.journalRepository,
        {
          timestamp: now,
          eventType: "METEORA_DETAIL_FETCHED",
          actor: "system",
          wallet: input.wallet,
          positionId: null,
          actionId: null,
          before: null,
          after: toJournalRecord({
            candidateId: candidate.candidateId,
            poolAddress: candidate.poolAddress,
            detailFetchedAt: detailRequestNow,
            hasMarketFeatureSnapshot:
              details?.marketFeatureSnapshot !== undefined,
            hasDlmmMicrostructureSnapshot:
              details?.dlmmMicrostructureSnapshot !== undefined,
            hasDataFreshnessSnapshot:
              details?.dataFreshnessSnapshot !== undefined,
            hasNarrative:
              narrativeSummary !== null || holderDistributionSummary !== null,
          }),
          txIds: [],
          resultStatus: "OK",
          error: null,
        },
        "detail fetched journal append failed",
      );
    } catch (error) {
      const rateLimit = isRateLimitedDetailError(error);
      if (rateLimit !== null) {
        await input.detailRateLimiter?.recordRateLimited({
          now: detailRequestNow,
          ...(rateLimit.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: rateLimit.retryAfterMs }),
        });
        rateLimitCooldownUntil =
          (await input.detailRateLimiter?.getCooldownUntil()) ??
          addMs(
            detailRequestNow,
            input.detailCooldownAfter429Ms ??
              screeningPolicy.detailCooldownAfter429Ms ??
              900_000,
          );
        const remainingDetailsSkipped =
          enrichmentPlan.selectedForDetail.length - index - 1;
        await appendJournalBestEffort(
          input.journalRepository,
          {
            timestamp: now,
            eventType: "METEORA_DETAIL_RATE_LIMITED",
            actor: "system",
            wallet: input.wallet,
            positionId: null,
            actionId: null,
            before: null,
            after: toJournalRecord({
              poolAddress: rateLimit.poolAddress ?? candidate.poolAddress,
              endpoint: "candidate_detail",
              responseKind: rateLimit.responseKind,
              cooldownUntil: rateLimitCooldownUntil,
              remainingDetailsSkipped,
            }),
            txIds: [],
            resultStatus: "RATE_LIMITED",
            error: error instanceof Error ? error.message : "rate limited",
          },
          "detail rate-limited journal append failed",
        );
        await appendJournalBestEffort(
          input.journalRepository,
          {
            timestamp: now,
            eventType: "METEORA_DETAIL_COOLDOWN_STARTED",
            actor: "system",
            wallet: input.wallet,
            positionId: null,
            actionId: null,
            before: null,
            after: toJournalRecord({
              endpoint: "candidate_detail",
              cooldownUntil: rateLimitCooldownUntil,
            }),
            txIds: [],
            resultStatus: "COOLDOWN",
            error: null,
          },
          "detail cooldown journal append failed",
        );
        stoppedByRateLimit = true;
        break;
      }

      logger.warn(
        { err: error, poolAddress: candidate.poolAddress },
        "candidate detail enrichment failed; continuing with gateway candidate snapshot",
      );
      await input.detailRateLimiter?.recordFailure(detailRequestNow);
    }
  }

  const enrichedResults = listedCandidates.map((candidate) => {
    const details = detailByCandidateId.get(candidate.candidateId) ?? {};
    const screeningInput = toScreeningInput(candidate, details);
    return {
      screeningInput,
      enrichedCandidate: mergeCandidateContext(candidate, screeningInput, now),
      detailFetched: detailByCandidateId.has(candidate.candidateId),
      selectedForDetail: selectedIds.has(candidate.candidateId),
    };
  });
  const enrichedInputs = enrichedResults.map((item) => item.screeningInput);
  const enrichedCandidates = enrichedResults.map(
    (item) => item.enrichedCandidate,
  );

  const deterministic = screenAndScoreCandidates({
    candidates: enrichedInputs,
    portfolio,
    screeningPolicy,
    scoringPolicy: deriveDefaultCandidateScorePolicy(screeningPolicy),
    ...(signalWeights === undefined ? {} : { signalWeights }),
    ...(poolMemoryMap === undefined ? {} : { poolMemoryMap }),
    createdAt: now,
    now,
  });

  const aiMode = input.aiMode ?? "disabled";
  const lessonPromptService: LessonPromptService =
    aiMode === "disabled"
      ? {
          async buildLessonsPrompt() {
            return null;
          },
        }
      : (input.lessonPromptService ?? {
          async buildLessonsPrompt(): Promise<string | null> {
            throw new Error(
              "LessonPromptService is required when AI mode is enabled",
            );
          },
        });
  const aiShortlist = await rankShortlistWithAi({
    shortlist: deterministic.shortlist.map(
      (candidate) =>
        enrichedCandidates.find(
          (item) => item.candidateId === candidate.candidateId,
        ) ?? candidate,
    ),
    aiMode,
    lessonPromptService,
    wallet: input.wallet,
    journalRepository: input.journalRepository,
    ...(input.llmGateway === undefined ? {} : { llmGateway: input.llmGateway }),
    ...(input.aiTimeoutMs === undefined
      ? {}
      : { timeoutMs: input.aiTimeoutMs }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  const finalCandidates = deterministic.candidates.map((candidate) => {
    const enriched = enrichedCandidates.find(
      (item) => item.candidateId === candidate.candidateId,
    );
    if (enriched === undefined) {
      return candidate;
    }
    return CandidateSchema.parse({
      ...candidate,
      screeningSnapshot: {
        ...candidate.screeningSnapshot,
        ...enriched.screeningSnapshot,
      },
      marketFeatureSnapshot: enriched.marketFeatureSnapshot,
      dlmmMicrostructureSnapshot: enriched.dlmmMicrostructureSnapshot,
      dataFreshnessSnapshot: enriched.dataFreshnessSnapshot,
      strategySuitability: candidate.strategySuitability,
      smartMoneySnapshot: {
        ...candidate.smartMoneySnapshot,
        ...enriched.smartMoneySnapshot,
      },
    });
  });
  const finalCandidateById = new Map(
    finalCandidates.map(
      (candidate) => [candidate.candidateId, candidate] as const,
    ),
  );
  const finalShortlist = aiShortlist.shortlist.map(
    (candidate) => finalCandidateById.get(candidate.candidateId) ?? candidate,
  );
  const finalShortlistIds = new Set(
    finalShortlist.map((candidate) => candidate.candidateId),
  );
  const snapshotOnlyWatchCount = enrichedResults.filter(
    (item) =>
      item.selectedForDetail &&
      !item.detailFetched &&
      item.enrichedCandidate.dataFreshnessSnapshot.poolDetailFetchedAt === null,
  ).length;
  const deployBlockedMissingDetailCount = finalCandidates.filter(
    (candidate) =>
      finalShortlistIds.has(candidate.candidateId) &&
      !candidate.dataFreshnessSnapshot.isFreshEnoughForDeploy,
  ).length;
  const enrichmentSummary = {
    candidateCount: finalCandidates.length,
    hardFilterPassed: coarse.candidates.filter(
      (candidate) => candidate.hardFilterPassed,
    ).length,
    selectedForDetail: enrichmentPlan.selectedForDetail.length,
    skippedDetail: enrichmentPlan.skipped.length,
    rateLimitCooldownUntil,
    snapshotOnlyWatchCount,
    deployBlockedMissingDetailCount,
  };

  if (input.journalRepository !== undefined) {
    await appendJournalBestEffort(
      input.journalRepository,
      {
        timestamp: now,
        eventType: "SCREENING_COMPLETED",
        actor: "system",
        wallet: input.wallet,
        positionId: null,
        actionId: null,
        before: null,
        after: toJournalRecord({
          timeframe: screeningPolicy.timeframe,
          candidateCount: finalCandidates.length,
          shortlistCount: finalShortlist.length,
          aiSource: aiShortlist.source,
          enrichment: enrichmentSummary,
        }),
        txIds: [],
        resultStatus: "SCREENED",
        error: null,
      },
      "screening completed journal append failed",
    );
  }

  return {
    wallet: input.wallet,
    evaluatedAt: now,
    timeframe: screeningPolicy.timeframe,
    candidates: finalCandidates,
    shortlist: finalShortlist,
    aiSource: aiShortlist.source,
    aiReasoning: aiShortlist.aiReasoning,
    enrichmentSummary,
  };
}
