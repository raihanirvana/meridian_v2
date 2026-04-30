import { LessonSchema, type Lesson } from "../entities/Lesson.js";
import {
  PerformanceRecordSchema,
  type PerformanceRecord,
} from "../entities/PerformanceRecord.js";

type DerivedOutcome = "good" | "neutral" | "poor" | "bad";

export function classifyOutcome(pnlPct: number): DerivedOutcome {
  if (pnlPct >= 5) {
    return "good";
  }

  if (pnlPct >= 0) {
    return "neutral";
  }

  if (pnlPct >= -5) {
    return "poor";
  }

  return "bad";
}

export function isSuspiciousUnitMix(perf: PerformanceRecord): boolean {
  return (
    Number.isFinite(perf.initialValueUsd) &&
    Number.isFinite(perf.finalValueUsd) &&
    Number.isFinite(perf.amountSol) &&
    perf.initialValueUsd >= 20 &&
    perf.amountSol >= 0.25 &&
    perf.finalValueUsd > 0 &&
    perf.finalValueUsd <= perf.amountSol * 2
  );
}

export function buildContextString(perf: PerformanceRecord): string {
  return [
    perf.poolName,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.binStep}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.feeTvlRatio}`,
    `organic=${perf.organicScore}`,
    `bin_range=${perf.binRangeLower}-${perf.binRangeUpper}`,
  ].join(", ");
}

function formatCloseReason(perf: PerformanceRecord): string {
  const detail = perf.closeReasonDetail?.trim();
  if (detail === undefined || detail.length === 0) {
    return perf.closeReason;
  }

  if (detail.toLowerCase() === perf.closeReason.replaceAll("_", " ")) {
    return perf.closeReason;
  }

  return `${perf.closeReason} (${detail})`;
}

export function inferRoleTags(perf: PerformanceRecord): string[] {
  const tags = new Set<string>();

  if (perf.rangeEfficiencyPct < 30) {
    tags.add("oor");
  }

  if (perf.rangeEfficiencyPct > 80) {
    tags.add("efficient");
  }

  if (perf.closeReason === "volume_collapse") {
    tags.add("volume_collapse");
  }

  if (perf.pnlPct > 0) {
    tags.add("worked");
  }

  if (perf.pnlPct < 0) {
    tags.add("failed");
  }

  tags.add(perf.strategy);
  tags.add(`volatility_${Math.round(perf.volatility)}`);

  return [...tags];
}

export function collectTags(perf: PerformanceRecord): string[] {
  return inferRoleTags(perf);
}

export function pickRuleTemplate(perf: PerformanceRecord): string | null {
  const outcome = classifyOutcome(perf.pnlPct);
  const context = buildContextString(perf);

  if (outcome === "neutral") {
    return null;
  }

  if (perf.rangeEfficiencyPct < 30 && outcome === "bad") {
    return `AVOID: ${perf.poolName}-type pools (volatility=${perf.volatility}, bin_step=${perf.binStep}) with strategy="${perf.strategy}" — went OOR ${Math.round(100 - perf.rangeEfficiencyPct)}% of the time. Consider wider bin range or bid_ask strategy.`;
  }

  if (perf.rangeEfficiencyPct > 80 && outcome === "good") {
    return `PREFER: ${perf.poolName}-type pools (volatility=${perf.volatility}, bin_step=${perf.binStep}) with strategy="${perf.strategy}" — ${perf.rangeEfficiencyPct}% in-range efficiency, PnL +${perf.pnlPct}%.`;
  }

  if (outcome === "bad" && perf.closeReason === "volume_collapse") {
    return `AVOID: Pools with fee_tvl_ratio=${perf.feeTvlRatio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
  }

  if (outcome === "good") {
    return `WORKED: ${context} -> PnL +${perf.pnlPct}%, range efficiency ${perf.rangeEfficiencyPct}%.`;
  }

  return `FAILED: ${context} -> PnL ${perf.pnlPct}%, range efficiency ${perf.rangeEfficiencyPct}%. Reason: ${formatCloseReason(perf)}.`;
}

export function deriveLesson(
  rawPerf: PerformanceRecord,
  now: string,
  idGen: () => string,
): Lesson | null {
  const perf = PerformanceRecordSchema.parse(rawPerf);
  const outcome = classifyOutcome(perf.pnlPct);

  if (outcome === "neutral") {
    return null;
  }

  const rule = pickRuleTemplate(perf);
  if (rule === null) {
    return null;
  }

  return LessonSchema.parse({
    id: idGen(),
    rule,
    tags: collectTags(perf),
    outcome: outcome === "good" ? "good" : outcome === "poor" ? "poor" : "bad",
    role: null,
    pinned: false,
    pnlPct: perf.pnlPct,
    rangeEfficiencyPct: perf.rangeEfficiencyPct,
    pool: perf.pool,
    context: buildContextString(perf),
    createdAt: now,
  });
}
