import { z } from "zod";

import { ManagementPolicySchema } from "../../domain/rules/managementRules.js";

const PositiveNumber = z.number().positive();
const PercentNumber = z.number().min(0).max(100);

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
        circuitBreakerCooldownMin: z.number().int().positive(),
        maxNewDeploysPerHour: z.number().int().positive(),
      })
      .strict(),
    screening: z
      .object({
        minMarketCapUsd: PositiveNumber,
        maxMarketCapUsd: PositiveNumber,
        minTvlUsd: PositiveNumber,
        minVolumeUsd: PositiveNumber,
        minFeeToTvlRatio: PositiveNumber,
        minOrganicScore: PercentNumber,
        minHolderCount: z.number().int().positive(),
        allowedBinSteps: z.array(z.number().int().positive()).min(1),
        blockedLaunchpads: z.array(z.string().min(1)),
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
