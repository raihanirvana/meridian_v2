import { z } from "zod";

import { CloseReasonSchema, StrategySchema } from "../types/enums.js";

const TimestampSchema = z.string().datetime();

export const PerformanceRecordSchema = z
  .object({
    positionId: z.string().min(1),
    wallet: z.string().min(1),
    pool: z.string().min(1),
    poolName: z.string().min(1),
    baseMint: z.string().min(1),
    strategy: StrategySchema,
    binStep: z.number().int().nonnegative(),
    binRangeLower: z.number().int(),
    binRangeUpper: z.number().int(),
    volatility: z.number().nonnegative(),
    feeTvlRatio: z.number().nonnegative(),
    organicScore: z.number().nonnegative(),
    amountSol: z.number().nonnegative(),
    initialValueUsd: z.number().nonnegative(),
    finalValueUsd: z.number().nonnegative(),
    feesEarnedUsd: z.number().nonnegative(),
    pnlUsd: z.number(),
    pnlPct: z.number(),
    rangeEfficiencyPct: z.number().min(0).max(100),
    minutesHeld: z.number().int().nonnegative(),
    minutesInRange: z.number().int().nonnegative(),
    closeReason: CloseReasonSchema,
    closeReasonDetail: z.string().min(1).max(300).optional(),
    deployedAt: TimestampSchema,
    closedAt: TimestampSchema,
    recordedAt: TimestampSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.binRangeLower >= record.binRangeUpper) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["binRangeUpper"],
        message: "must be greater than binRangeLower",
      });
    }

    if (record.minutesInRange > record.minutesHeld) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minutesInRange"],
        message: "must be less than or equal to minutesHeld",
      });
    }
  });

export type PerformanceRecord = z.infer<typeof PerformanceRecordSchema>;
