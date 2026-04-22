import { z } from "zod";

import { TimestampSchema } from "../types/schemas.js";

export const SignalWeightKeySchema = z.enum([
  "feeToTvl",
  "volumeConsistency",
  "liquidityDepth",
  "organicScore",
  "holderQuality",
  "tokenAuditHealth",
  "smartMoney",
  "poolMaturity",
  "launchpadPenalty",
  "overlapPenalty",
]);

export const SIGNAL_WEIGHT_KEYS = SignalWeightKeySchema.options;

export const SignalWeightEntrySchema = z
  .object({
    weight: z.number().min(0.1).max(3.0),
    sampleSize: z.number().int().min(0),
    lastAdjustedAt: TimestampSchema.nullable(),
  })
  .strict();

export const SignalWeightsSchema = z
  .object({
    feeToTvl: SignalWeightEntrySchema,
    volumeConsistency: SignalWeightEntrySchema,
    liquidityDepth: SignalWeightEntrySchema,
    organicScore: SignalWeightEntrySchema,
    holderQuality: SignalWeightEntrySchema,
    tokenAuditHealth: SignalWeightEntrySchema,
    smartMoney: SignalWeightEntrySchema,
    poolMaturity: SignalWeightEntrySchema,
    launchpadPenalty: SignalWeightEntrySchema,
    overlapPenalty: SignalWeightEntrySchema,
  })
  .strict();

export type SignalWeightKey = z.infer<typeof SignalWeightKeySchema>;
export type SignalWeightEntry = z.infer<typeof SignalWeightEntrySchema>;
export type SignalWeights = z.infer<typeof SignalWeightsSchema>;

export function createDefaultSignalWeights(): SignalWeights {
  const entry = {
    weight: 1,
    sampleSize: 0,
    lastAdjustedAt: null,
  } satisfies SignalWeightEntry;

  return SignalWeightsSchema.parse({
    feeToTvl: entry,
    volumeConsistency: entry,
    liquidityDepth: entry,
    organicScore: entry,
    holderQuality: entry,
    tokenAuditHealth: entry,
    smartMoney: entry,
    poolMaturity: entry,
    launchpadPenalty: entry,
    overlapPenalty: entry,
  });
}
