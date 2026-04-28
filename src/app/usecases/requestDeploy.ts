import { z } from "zod";

import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { RuntimeControlStore } from "../../adapters/storage/RuntimeControlStore.js";
import type { Action } from "../../domain/entities/Action.js";
import type { PortfolioState } from "../../domain/entities/PortfolioState.js";
import { PositionEntryMetadataSchema } from "../../domain/entities/Position.js";
import {
  evaluatePortfolioRisk,
  type PortfolioRiskPolicy,
} from "../../domain/rules/riskRules.js";
import { StrategySchema, type Actor } from "../../domain/types/enums.js";
import { logger } from "../../infra/logging/logger.js";
import type { ActionQueue } from "../services/ActionQueue.js";
import { createIdempotencyKey } from "../services/ActionService.js";

export const DeployActionRequestPayloadSchema = z
  .object({
    poolAddress: z.string().min(1),
    tokenXMint: z.string().min(1),
    tokenYMint: z.string().min(1),
    baseMint: z.string().min(1),
    quoteMint: z.string().min(1),
    amountBase: z.number().nonnegative(),
    amountQuote: z.number().nonnegative(),
    slippageBps: z.number().int().positive().max(10_000).optional(),
    strategy: StrategySchema,
    rangeLowerBin: z.number().int(),
    rangeUpperBin: z.number().int(),
    initialActiveBin: z.number().int().nullable(),
    estimatedValueUsd: z.number().nonnegative(),
    entryMetadata: PositionEntryMetadataSchema.optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.amountBase <= 0 && payload.amountQuote <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountBase"],
        message: "amountBase or amountQuote must be greater than zero",
      });
    }

    if (payload.rangeLowerBin >= payload.rangeUpperBin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rangeUpperBin"],
        message: "must be greater than rangeLowerBin",
      });
    }
  });

export type DeployActionRequestPayload = z.infer<
  typeof DeployActionRequestPayloadSchema
>;

export interface RequestDeployInput {
  actionQueue: ActionQueue;
  wallet: string;
  payload: DeployActionRequestPayload;
  requestedBy: Actor;
  requestedAt?: string;
  idempotencyKey?: string;
  journalRepository?: JournalRepository;
  runtimeControlStore?: RuntimeControlStore;
  riskGuard?: {
    portfolio: PortfolioState;
    policy: PortfolioRiskPolicy;
    recentNewDeploys: number;
    solPriceUsd?: number;
  };
}

function buildDeployJournalPayload(action: Action): Record<string, unknown> {
  return {
    actionId: action.actionId,
    type: action.type,
    status: action.status,
    requestPayload: action.requestPayload,
    idempotencyKey: action.idempotencyKey,
  };
}

export async function requestDeploy(
  input: RequestDeployInput,
): Promise<Action> {
  const payload = DeployActionRequestPayloadSchema.parse(input.payload);
  const journalTimestamp = input.requestedAt ?? new Date().toISOString();
  if (
    input.runtimeControlStore !== undefined &&
    (await input.runtimeControlStore.snapshot()).stopAllDeploys.active
  ) {
    throw new Error(
      "manual circuit breaker is active; deploy requests are blocked",
    );
  }
  if (input.riskGuard !== undefined) {
    const riskResult = evaluatePortfolioRisk({
      action: "DEPLOY",
      portfolio: input.riskGuard.portfolio,
      policy: input.riskGuard.policy,
      proposedAllocationUsd: payload.estimatedValueUsd,
      proposedPoolAddress: payload.poolAddress,
      proposedTokenMints: [
        ...new Set([payload.tokenXMint, payload.tokenYMint]),
      ],
      recentNewDeploys: input.riskGuard.recentNewDeploys,
      position: null,
      ...(input.riskGuard.solPriceUsd === undefined
        ? {}
        : { solPriceUsd: input.riskGuard.solPriceUsd }),
    });

    if (!riskResult.allowed) {
      try {
        await input.journalRepository?.append({
          timestamp: journalTimestamp,
          eventType: "DEPLOY_REQUEST_BLOCKED_BY_RISK",
          actor: input.requestedBy,
          wallet: input.wallet,
          positionId: null,
          actionId: null,
          before: null,
          after: {
            requestPayload: payload,
            riskDecision: riskResult.decision,
            blockingRules: riskResult.blockingRules,
            projectedExposureByPool: riskResult.projectedExposureByPool,
            projectedExposureByToken: riskResult.projectedExposureByToken,
          },
          txIds: [],
          resultStatus: "BLOCKED",
          error: riskResult.reason,
        });
      } catch (error) {
        logger.warn(
          { err: error },
          "deploy risk-block journal append failed",
        );
      }

      throw new Error(`deploy blocked by risk guard: ${riskResult.reason}`);
    }
  }
  const idempotencyKey =
    input.idempotencyKey ??
    createIdempotencyKey({
      wallet: input.wallet,
      type: "DEPLOY",
      positionId: null,
      requestPayload: payload,
    });

  const action = await input.actionQueue.enqueue({
    type: "DEPLOY",
    wallet: input.wallet,
    positionId: null,
    idempotencyKey,
    requestPayload: payload,
    requestedBy: input.requestedBy,
    ...(input.requestedAt === undefined
      ? {}
      : { requestedAt: input.requestedAt }),
  });

  if (input.journalRepository !== undefined) {
    try {
      await input.journalRepository.append({
        timestamp: journalTimestamp,
        eventType: "DEPLOY_REQUEST_ACCEPTED",
        actor: action.requestedBy,
        wallet: action.wallet,
        positionId: action.positionId,
        actionId: action.actionId,
        before: null,
        after: buildDeployJournalPayload(action),
        txIds: [],
        resultStatus: action.status,
        error: null,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          actionId: action.actionId,
          wallet: action.wallet,
        },
        "deploy request journal append failed after enqueue; preserving accepted action",
      );
    }
  }

  return action;
}
