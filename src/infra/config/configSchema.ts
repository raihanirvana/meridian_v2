import { z } from "zod";

import { ManagementPolicySchema } from "../../domain/rules/managementRules.js";

const PositiveNumber = z.number().positive();
const PercentNumber = z.number().min(0).max(100);
const TimeOfDaySchema = z.string().regex(/^\d{2}:\d{2}$/, "must be HH:MM");

export const AiModeSchema = z.enum([
  "disabled",
  "advisory",
  "constrained_action",
]);

export const EnvSecretsSchema = z.object({
  WALLET_PRIVATE_KEY: z.string().min(1),
  RPC_URL: z.url(),
  SCREENING_API_KEY: z.string().min(1).optional(),
  ANALYTICS_API_KEY: z.string().min(1).optional(),
  JUPITER_API_KEY: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_BASE_URL: z.url().optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
});

export const UserConfigSchema = z
  .object({
    risk: z
        .object({
          maxConcurrentPositions: z.number().int().positive(),
          maxCapitalUsagePct: PercentNumber,
          minReserveUsd: PositiveNumber,
          maxTokenExposurePct: PercentNumber,
          maxPoolExposurePct: PercentNumber,
        maxRebalancesPerPosition: z.number().int().min(0),
        dailyLossLimitPct: PositiveNumber,
        maxDailyLossSol: PositiveNumber.optional(),
        dailyProfitTargetSol: PositiveNumber.optional(),
        circuitBreakerCooldownMin: z.number().int().positive(),
        maxNewDeploysPerHour: z.number().int().positive(),
      })
      .strict(),
    screening: z
      .object({
        timeframe: z.enum(["5m", "1h", "24h"]),
        minMarketCapUsd: PositiveNumber,
        maxMarketCapUsd: PositiveNumber,
        minTvlUsd: PositiveNumber,
        minVolumeUsd: PositiveNumber,
        minVolumeTrendPct: z.number().optional(),
        minFeeActiveTvlRatio: PositiveNumber,
        minFeePerTvl24h: PositiveNumber,
        minOrganic: PercentNumber,
        minTokenAgeHours: z.number().nonnegative().optional(),
        maxTokenAgeHours: z.number().nonnegative().optional(),
        athFilterPct: z.number().min(-100).max(0).optional(),
        minHolderCount: z.number().int().positive(),
        allowedBinSteps: z.array(z.number().int().positive()).min(1),
        blockedLaunchpads: z.array(z.string().min(1)),
        intervalTimezone: z.string().min(1).default("UTC"),
        peakHours: z.array(
          z.object({
            start: TimeOfDaySchema,
            end: TimeOfDaySchema,
            intervalSec: z.number().int().positive(),
          }).strict(),
        ).default([]),
      })
      .strict(),
    schedule: z
      .object({
        screeningIntervalSec: z.number().int().positive(),
        managementIntervalSec: z.number().int().positive(),
        reconciliationIntervalSec: z.number().int().positive(),
        reportingIntervalSec: z.number().int().positive(),
      })
      .strict(),
    management: ManagementPolicySchema.omit({
      maxRebalancesPerPosition: true,
    }),
    ai: z
      .object({
        mode: AiModeSchema,
        generalModel: z.string().min(1).optional(),
        managementModel: z.string().min(1).optional(),
        screeningModel: z.string().min(1).optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    deploy: z
      .object({
        defaultAmountSol: PositiveNumber,
        minAmountSol: PositiveNumber,
      })
      .strict(),
    notifications: z
      .object({
        telegramEnabled: z.boolean(),
        alertChatId: z.string().min(1).optional(),
      })
      .strict(),
    reporting: z
      .object({
        solMode: z.boolean(),
        briefingEmoji: z.boolean().default(false),
      })
      .strict(),
    claim: z
      .object({
        autoSwapAfterClaim: z.boolean().default(false),
        swapOutputMint: z.string().min(1).default(
          "So11111111111111111111111111111111111111112",
        ),
        autoCompoundFees: z.boolean().default(false),
        compoundToSide: z.enum(["base", "quote"]).default("quote"),
      })
      .default({
        autoSwapAfterClaim: false,
        swapOutputMint: "So11111111111111111111111111111111111111112",
        autoCompoundFees: false,
        compoundToSide: "quote",
      }),
    poolMemory: z
      .object({
        snapshotsEnabled: z.boolean(),
      })
      .strict(),
    darwin: z
      .object({
        enabled: z.boolean(),
      })
      .strict(),
    runtime: z
      .object({
        dryRun: z.boolean(),
        logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.screening.maxMarketCapUsd < config.screening.minMarketCapUsd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screening", "maxMarketCapUsd"],
        message: "must be greater than or equal to minMarketCapUsd",
      });
    }

    if (config.deploy.defaultAmountSol < config.deploy.minAmountSol) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deploy", "defaultAmountSol"],
        message: "must be greater than or equal to minAmountSol",
      });
    }

    if (
      config.screening.minTokenAgeHours !== undefined &&
      config.screening.maxTokenAgeHours !== undefined &&
      config.screening.maxTokenAgeHours < config.screening.minTokenAgeHours
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screening", "maxTokenAgeHours"],
        message: "must be greater than or equal to minTokenAgeHours",
      });
    }

    for (const [index, window] of config.screening.peakHours.entries()) {
      const [startHourRaw, startMinuteRaw] = window.start.split(":");
      const [endHourRaw, endMinuteRaw] = window.end.split(":");
      const startHour = Number(startHourRaw ?? "");
      const startMinute = Number(startMinuteRaw ?? "");
      const endHour = Number(endHourRaw ?? "");
      const endMinute = Number(endMinuteRaw ?? "");
      const startValid = Number.isInteger(startHour) &&
        Number.isInteger(startMinute) &&
        startHour >= 0 &&
        startHour <= 23 &&
        startMinute >= 0 &&
        startMinute <= 59;
      const endValid = Number.isInteger(endHour) &&
        Number.isInteger(endMinute) &&
        endHour >= 0 &&
        endHour <= 23 &&
        endMinute >= 0 &&
        endMinute <= 59;
      if (!startValid || !endValid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["screening", "peakHours", index],
          message: "peak hour windows must use valid 24h HH:MM values",
        });
      }
    }

    if (config.claim.autoSwapAfterClaim && config.claim.autoCompoundFees) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claim", "autoCompoundFees"],
        message: "cannot be enabled together with autoSwapAfterClaim",
      });
    }
  });

export const ResolvedConfigSchema = z
  .object({
    secrets: EnvSecretsSchema,
    user: UserConfigSchema,
  })
  .strict();

export type EnvSecrets = z.infer<typeof EnvSecretsSchema>;
export type UserConfig = z.infer<typeof UserConfigSchema>;
export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;
