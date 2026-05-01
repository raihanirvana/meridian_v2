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

function formatPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
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

function buildPerformanceSummary(perf: PerformanceRecord): string {
  return [
    `close=${formatCloseReason(perf)}`,
    `held=${perf.minutesHeld}m`,
    `in_range=${perf.minutesInRange}/${perf.minutesHeld}m`,
    `value=${formatUsd(perf.initialValueUsd)}->${formatUsd(perf.finalValueUsd)}`,
    `pnl=${formatUsd(perf.pnlUsd)} (${formatPct(perf.pnlPct)})`,
    `fees=${formatUsd(perf.feesEarnedUsd)}`,
  ].join(", ");
}

function buildLearningHint(perf: PerformanceRecord): string {
  switch (perf.closeReason) {
    case "take_profit":
      return "Learn: profit was protected by take-profit/trailing exit; prefer similar setup only if entry conditions and in-range efficiency remain comparable.";
    case "rebalance":
      return "Learn: rebalance outcome depends on post-rebalance accounting and fresh range quality; do not treat same-pool redeploy as success unless realized PnL confirms it.";
    case "volume_collapse":
      return "Learn: volume/fee durability failed after entry; require stronger sustained fee and volume confirmation before redeploying.";
    case "out_of_range":
      return "Learn: range selection was too fragile for the move; prefer wider range or a different strategy under similar volatility.";
    case "stop_loss":
      return "Learn: downside protection fired; avoid similar entries unless risk flags improve materially.";
    case "timeout":
      return "Learn: capital was tied up too long relative to payoff; prefer faster fee generation or clearer momentum.";
    default:
      return "Learn: use this outcome as supporting evidence, but confirm with fresh market structure before repeating.";
  }
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
  const performanceSummary = buildPerformanceSummary(perf);
  const learningHint = buildLearningHint(perf);

  if (outcome === "neutral") {
    return null;
  }

  if (perf.rangeEfficiencyPct < 30 && outcome === "bad") {
    return `AVOID: ${perf.poolName}-type pools (volatility=${perf.volatility}, bin_step=${perf.binStep}) with strategy="${perf.strategy}" — went OOR ${Math.round(100 - perf.rangeEfficiencyPct)}% of the time. ${performanceSummary}. ${learningHint}`;
  }

  if (perf.rangeEfficiencyPct > 80 && outcome === "good") {
    return `PREFER: ${perf.poolName}-type pools (volatility=${perf.volatility}, bin_step=${perf.binStep}) with strategy="${perf.strategy}" — ${formatPct(perf.rangeEfficiencyPct)} in-range efficiency. ${performanceSummary}. ${learningHint}`;
  }

  if (outcome === "bad" && perf.closeReason === "volume_collapse") {
    return `AVOID: Pools with fee_tvl_ratio=${perf.feeTvlRatio} that showed volume collapse — fees evaporated quickly. ${performanceSummary}. ${learningHint}`;
  }

  if (outcome === "good") {
    return `WORKED: ${context}. ${performanceSummary}. range_efficiency=${formatPct(perf.rangeEfficiencyPct)}. ${learningHint}`;
  }

  return `FAILED: ${context}. ${performanceSummary}. range_efficiency=${formatPct(perf.rangeEfficiencyPct)}. ${learningHint}`;
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
