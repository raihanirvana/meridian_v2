import { z } from "zod";

import type { Position } from "../../domain/entities/Position.js";

export interface ResolveOutOfRangeSinceInput {
  activeBin: number | null;
  rangeLowerBin: number;
  rangeUpperBin: number;
  preferredValue?: string | null;
  fallbackValue?: string | null;
}

export const CloseAccountingSummarySchema = z
  .object({
    positionId: z.string().min(1),
    closedAt: z.string().datetime(),
    realizedPnlBase: z.number(),
    realizedPnlUsd: z.number(),
    feesClaimedBase: z.number().nonnegative(),
    feesClaimedUsd: z.number().nonnegative(),
    currentValueBase: z.number().nonnegative(),
    currentValueUsd: z.number().nonnegative(),
    postCloseSwap: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

export type CloseAccountingSummary = z.infer<
  typeof CloseAccountingSummarySchema
>;

export function resolveOutOfRangeSince(
  input: ResolveOutOfRangeSinceInput,
): string | null {
  if (input.activeBin === null) {
    return input.preferredValue ?? null;
  }

  const isInRange =
    input.activeBin >= input.rangeLowerBin &&
    input.activeBin <= input.rangeUpperBin;

  if (isInRange) {
    return null;
  }

  return input.preferredValue ?? input.fallbackValue ?? null;
}

export function buildCloseAccountingSummary(
  position: Position,
  postCloseSwap: Record<string, unknown> | null,
): CloseAccountingSummary {
  return CloseAccountingSummarySchema.parse({
    positionId: position.positionId,
    closedAt: position.closedAt,
    realizedPnlBase: position.realizedPnlBase,
    realizedPnlUsd: position.realizedPnlUsd,
    feesClaimedBase: position.feesClaimedBase,
    feesClaimedUsd: position.feesClaimedUsd,
    currentValueBase: position.currentValueBase,
    currentValueUsd: position.currentValueUsd,
    postCloseSwap,
  });
}
