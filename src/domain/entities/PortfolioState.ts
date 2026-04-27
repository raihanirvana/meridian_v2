import { z } from "zod";

import {
  CircuitBreakerStateSchema,
  DrawdownStateSchema,
} from "../types/enums.js";

export const PortfolioStateSchema = z
  .object({
    walletBalance: z.number().nonnegative(),
    reservedBalance: z.number().nonnegative(),
    availableBalance: z.number().nonnegative(),
    openPositions: z.number().int().nonnegative(),
    pendingActions: z.number().int().nonnegative(),
    dailyRealizedPnl: z.number(),
    solPriceUsd: z.number().positive().optional(),
    drawdownState: DrawdownStateSchema,
    circuitBreakerState: CircuitBreakerStateSchema,
    circuitBreakerActivatedAt: z.string().datetime().nullable().optional(),
    circuitBreakerCooldownStartedAt: z
      .string()
      .datetime()
      .nullable()
      .optional(),
    exposureByToken: z.record(z.string(), z.number().nonnegative()),
    exposureByPool: z.record(z.string(), z.number().nonnegative()),
  })
  .superRefine((state, ctx) => {
    if (
      state.reservedBalance + state.availableBalance >
      state.walletBalance + 1e-9
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availableBalance"],
        message:
          "reservedBalance + availableBalance must not exceed walletBalance",
      });
    }
  })
  .strict();

export type PortfolioState = z.infer<typeof PortfolioStateSchema>;
