import type { PerformanceRecord } from "../entities/PerformanceRecord.js";
import {
  SIGNAL_WEIGHT_KEYS,
  SignalWeightsSchema,
  type SignalWeightKey,
  type SignalWeights,
} from "../entities/SignalWeights.js";

export const MIN_SIGNAL_WEIGHT_SAMPLES = 10;
export const MAX_SIGNAL_WEIGHT_CHANGE_PER_STEP = 0.2;
export const SIGNAL_WEIGHT_FLOOR = 0.1;
export const SIGNAL_WEIGHT_CEILING = 3.0;
export const MIN_MEANINGFUL_CORRELATION = 0.25;

type NumericExtractor = (record: PerformanceRecord) => number | null;

const SIGNAL_EXTRACTORS: Record<SignalWeightKey, NumericExtractor> = {
  feeToTvl: (record) => record.feeTvlRatio,
  volumeConsistency: () => null,
  liquidityDepth: () => null,
  organicScore: (record) => record.organicScore,
  holderQuality: () => null,
  tokenAuditHealth: () => null,
  smartMoney: () => null,
  poolMaturity: () => null,
  launchpadPenalty: () => null,
  overlapPenalty: () => null,
};

export interface SignalWeightRecalculationResult {
  changes: Partial<Record<SignalWeightKey, SignalWeights[SignalWeightKey]>>;
  rationale: Partial<Record<SignalWeightKey, string>>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isFiniteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function normalizeValues(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) {
    return values.map(() => 0.5);
  }

  return values.map((value) => (value - min) / range);
}

function pearsonCorrelation(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }

  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;

  let numerator = 0;
  let leftDenominator = 0;
  let rightDenominator = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index]! - leftMean;
    const rightDelta = right[index]! - rightMean;
    numerator += leftDelta * rightDelta;
    leftDenominator += leftDelta * leftDelta;
    rightDenominator += rightDelta * rightDelta;
  }

  if (leftDenominator === 0 || rightDenominator === 0) {
    return 0;
  }

  return numerator / Math.sqrt(leftDenominator * rightDenominator);
}

function collectSamples(
  performance: PerformanceRecord[],
  key: SignalWeightKey,
): Array<{ signalValue: number; pnlPct: number }> {
  const extractor = SIGNAL_EXTRACTORS[key];
  return performance
    .map((record) => ({
      signalValue: extractor(record),
      pnlPct: record.pnlPct,
    }))
    .filter(
      (
        sample,
      ): sample is {
        signalValue: number;
        pnlPct: number;
      } => isFiniteNumber(sample.signalValue) && Number.isFinite(sample.pnlPct),
    );
}

function buildUpdatedEntry(input: {
  currentWeights: SignalWeights;
  key: SignalWeightKey;
  samples: Array<{ signalValue: number; pnlPct: number }>;
}): SignalWeightRecalculationResult {
  const sampleSize = input.samples.length;
  if (sampleSize < MIN_SIGNAL_WEIGHT_SAMPLES) {
    return {
      changes: {},
      rationale: {},
    };
  }

  const currentEntry = input.currentWeights[input.key];
  const normalizedSignal = normalizeValues(
    input.samples.map((sample) => sample.signalValue),
  );
  const pnlValues = input.samples.map((sample) => sample.pnlPct);
  const correlation = pearsonCorrelation(normalizedSignal, pnlValues);

  if (Math.abs(correlation) < MIN_MEANINGFUL_CORRELATION) {
    return {
      changes: {},
      rationale: {},
    };
  }

  const deltaFactor = Math.min(
    Math.abs(correlation),
    1,
  ) * MAX_SIGNAL_WEIGHT_CHANGE_PER_STEP;
  const nextWeight = correlation > 0
    ? currentEntry.weight * (1 + deltaFactor)
    : currentEntry.weight * (1 - deltaFactor);
  const roundedWeight = roundWeight(
    clamp(nextWeight, SIGNAL_WEIGHT_FLOOR, SIGNAL_WEIGHT_CEILING),
  );

  if (roundedWeight === currentEntry.weight) {
    return {
      changes: {},
      rationale: {},
    };
  }

  return {
    changes: SignalWeightsSchema.partial().parse({
      [input.key]: {
        ...currentEntry,
        weight: roundedWeight,
        sampleSize,
      },
    }) as Partial<Record<SignalWeightKey, SignalWeights[SignalWeightKey]>>,
    rationale: {
      [input.key]:
        correlation > 0
          ? `Positive correlation ${correlation.toFixed(3)} across ${sampleSize} samples — raised weight ${currentEntry.weight} -> ${roundedWeight}`
          : `Negative correlation ${correlation.toFixed(3)} across ${sampleSize} samples — lowered weight ${currentEntry.weight} -> ${roundedWeight}`,
    },
  };
}

export function recalculateWeights(input: {
  performance: PerformanceRecord[];
  currentWeights: SignalWeights;
}): SignalWeightRecalculationResult {
  const currentWeights = SignalWeightsSchema.parse(input.currentWeights);
  const changes: Partial<Record<SignalWeightKey, SignalWeights[SignalWeightKey]>> = {};
  const rationale: Partial<Record<SignalWeightKey, string>> = {};

  for (const key of SIGNAL_WEIGHT_KEYS) {
    const result = buildUpdatedEntry({
      currentWeights,
      key,
      samples: collectSamples(input.performance, key),
    });

    if (Object.keys(result.changes).length > 0) {
      Object.assign(changes, result.changes);
    }
    if (Object.keys(result.rationale).length > 0) {
      Object.assign(rationale, result.rationale);
    }
  }

  return {
    changes: SignalWeightsSchema.partial().parse(changes) as Partial<
      Record<SignalWeightKey, SignalWeights[SignalWeightKey]>
    >,
    rationale,
  };
}
