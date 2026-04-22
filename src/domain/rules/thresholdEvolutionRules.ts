import {
  type PerformanceRecord,
} from "../entities/PerformanceRecord.js";
import {
  ScreeningPolicySchema,
  type ScreeningPolicy,
} from "./screeningRules.js";

export const MIN_EVOLVE_POSITIONS = 5;
export const MAX_CHANGE_PER_STEP = 0.2;

export interface ThresholdEvolutionResult {
  changes: Partial<Pick<ScreeningPolicy, "minFeeActiveTvlRatio" | "minOrganic">>;
  rationale: Record<string, string>;
}

function isFiniteNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function nudge(current: number, target: number, maxChangePerStep: number): number {
  if (!isFiniteNum(current) || !isFiniteNum(target)) {
    return current;
  }

  const maxDelta = Math.abs(current) * maxChangePerStep;
  if (maxDelta === 0) {
    return target;
  }

  const delta = clamp(target - current, -maxDelta, maxDelta);
  return current + delta;
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function evolveThresholds(input: {
  performance: PerformanceRecord[];
  currentPolicy: ScreeningPolicy;
}): ThresholdEvolutionResult | null {
  const performance = input.performance;
  const currentPolicy = ScreeningPolicySchema.parse(input.currentPolicy);

  if (performance.length < MIN_EVOLVE_POSITIONS) {
    return null;
  }

  const winners = performance.filter((record) => record.pnlPct > 0);
  const losers = performance.filter((record) => record.pnlPct < -5);
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) {
    return null;
  }

  const changes: ThresholdEvolutionResult["changes"] = {};
  const rationale: Record<string, string> = {};

  {
    const winnerFees = winners.map((record) => record.feeTvlRatio).filter(isFiniteNum);
    const loserFees = losers.map((record) => record.feeTvlRatio).filter(isFiniteNum);
    const current = currentPolicy.minFeeActiveTvlRatio;

    if (winnerFees.length >= 2) {
      const minWinnerFee = Math.min(...winnerFees);
      if (minWinnerFee > current * 1.2) {
        const target = minWinnerFee * 0.85;
        const next = clamp(
          nudge(current, target, MAX_CHANGE_PER_STEP),
          0.05,
          10.0,
        );
        const rounded = Number(next.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio =
            `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} -> ${rounded}`;
        }
      }
    }

    if (loserFees.length >= 2 && winnerFees.length > 0 && changes.minFeeActiveTvlRatio === undefined) {
      const maxLoserFee = Math.max(...loserFees);
      const minWinnerFee = Math.min(...winnerFees);
      if (maxLoserFee < current * 1.5 && minWinnerFee > maxLoserFee) {
        const target = maxLoserFee * 1.2;
        const next = clamp(
          nudge(current, target, MAX_CHANGE_PER_STEP),
          0.05,
          10.0,
        );
        const rounded = Number(next.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio =
            `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} -> ${rounded}`;
        }
      }
    }
  }

  {
    const loserOrganics = losers.map((record) => record.organicScore).filter(isFiniteNum);
    const winnerOrganics = winners.map((record) => record.organicScore).filter(isFiniteNum);
    const current = currentPolicy.minOrganic;

    if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoserOrganic = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        const next = clamp(
          Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)),
          60,
          90,
        );
        if (next > current) {
          changes.minOrganic = next;
          rationale.minOrganic =
            `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} -> ${next}`;
        }
      }
    }
  }

  return {
    changes,
    rationale,
  };
}
