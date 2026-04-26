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
    currentValueQuote: z.number().nonnegative().optional(),
    currentValueUsd: z.number().nonnegative(),
    releasedAmountBase: z.number().nonnegative().nullable(),
    releasedAmountQuote: z.number().nonnegative().nullable(),
    estimatedReleasedValueUsd: z.number().nonnegative().nullable(),
    releasedAmountSource: z
      .enum(["post_tx", "position_snapshot", "unavailable"])
      .default("unavailable"),
    preCloseFeesClaimed: z.boolean().nullable(),
    preCloseFeesClaimError: z.string().min(1).nullable(),
    sourceConfidence: z.enum(["post_tx", "snapshot", "unavailable"]),
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
  closeProceeds?: {
    releasedAmountBase?: number;
    releasedAmountQuote?: number;
    estimatedReleasedValueUsd?: number;
    releasedAmountSource?: "post_tx" | "position_snapshot" | "unavailable";
    preCloseFeesClaimed?: boolean;
    preCloseFeesClaimError?: string | null;
  },
): CloseAccountingSummary {
  const releasedAmountSource =
    closeProceeds?.releasedAmountSource ?? "unavailable";

  return CloseAccountingSummarySchema.parse({
    positionId: position.positionId,
    closedAt: position.closedAt,
    realizedPnlBase: position.realizedPnlBase,
    realizedPnlUsd: position.realizedPnlUsd,
    feesClaimedBase: position.feesClaimedBase,
    feesClaimedUsd: position.feesClaimedUsd,
    currentValueBase: position.currentValueBase,
    ...(position.currentValueQuote === undefined
      ? {}
      : { currentValueQuote: position.currentValueQuote }),
    currentValueUsd: position.currentValueUsd,
    releasedAmountBase: closeProceeds?.releasedAmountBase ?? null,
    releasedAmountQuote: closeProceeds?.releasedAmountQuote ?? null,
    estimatedReleasedValueUsd: closeProceeds?.estimatedReleasedValueUsd ?? null,
    releasedAmountSource,
    preCloseFeesClaimed: closeProceeds?.preCloseFeesClaimed ?? null,
    preCloseFeesClaimError: closeProceeds?.preCloseFeesClaimError ?? null,
    sourceConfidence:
      releasedAmountSource === "post_tx"
        ? "post_tx"
        : releasedAmountSource === "position_snapshot"
          ? "snapshot"
          : "unavailable",
    postCloseSwap,
  });
}
