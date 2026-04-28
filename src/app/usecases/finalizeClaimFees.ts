import { z } from "zod";

import type { DlmmGateway } from "../../adapters/dlmm/DlmmGateway.js";
import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { RuntimeControlStore } from "../../adapters/storage/RuntimeControlStore.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { Action } from "../../domain/entities/Action.js";
import type { JournalEvent } from "../../domain/entities/JournalEvent.js";
import type { PortfolioState } from "../../domain/entities/PortfolioState.js";
import {
  PositionSchema,
  type Position,
} from "../../domain/entities/Position.js";
import type { PortfolioRiskPolicy } from "../../domain/rules/riskRules.js";
import { transitionActionStatus } from "../../domain/stateMachines/actionLifecycle.js";
import { transitionPositionStatus } from "../../domain/stateMachines/positionLifecycle.js";
import { logger } from "../../infra/logging/logger.js";
import { PositionLock } from "../../infra/locks/positionLock.js";
import { WalletLock } from "../../infra/locks/walletLock.js";
import type { ActionQueue } from "../services/ActionQueue.js";

import {
  DeployActionRequestPayloadSchema,
  requestDeploy,
} from "./requestDeploy.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

const CompoundDeployTemplateSchema = z
  .object({
    poolAddress: z.string().min(1),
    tokenXMint: z.string().min(1),
    tokenYMint: z.string().min(1),
    baseMint: z.string().min(1),
    quoteMint: z.string().min(1),
    strategy: z.string().min(1),
    rangeLowerBin: z.number().int(),
    rangeUpperBin: z.number().int(),
    initialActiveBin: z.number().int().nullable(),
    entryMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const ClaimAutoCompoundStateSchema = z
  .object({
    outputMint: z.string().min(1),
    phase: z.enum([
      "PENDING_SWAP",
      "SWAP_IN_PROGRESS",
      "SWAP_DONE",
      "DEPLOY_QUEUED",
      "FAILED",
      "MANUAL_REVIEW_REQUIRED",
    ]),
    deployTemplate: CompoundDeployTemplateSchema,
    swap: z.record(z.string(), z.unknown()).nullable().optional(),
    deployActionId: z.string().min(1).nullable().optional(),
    error: z.string().min(1).nullable().optional(),
  })
  .strict();

const ClaimAutoSwapStateSchema = z
  .object({
    outputMint: z.string().min(1),
    phase: z.enum([
      "PENDING_SWAP",
      "SWAP_IN_PROGRESS",
      "SWAP_DONE",
      "FAILED",
      "MANUAL_REVIEW_REQUIRED",
    ]),
    swap: z.record(z.string(), z.unknown()).nullable().optional(),
    error: z.string().min(1).nullable().optional(),
  })
  .strict();

const ClaimConfirmationPayloadSchema = z
  .object({
    actionType: z.literal("CLAIM_FEES"),
    claimedBaseAmount: z.number().nonnegative(),
    claimedBaseAmountRaw: z.string().regex(/^\d+$/).optional(),
    claimedBaseAmountUsd: z.number().nonnegative().optional(),
    claimedBaseAmountSource: z
      .enum(["post_tx", "cache", "pnl_estimate", "unavailable"])
      .optional(),
    txIds: z.array(z.string().min(1)),
    submissionStatus: z
      .enum(["not_submitted", "maybe_submitted", "submitted"])
      .default("submitted"),
    submissionAmbiguous: z.boolean().optional(),
    reason: z.string().min(1),
    autoSwapOutputMint: z.string().min(1).nullable().optional(),
    autoSwap: ClaimAutoSwapStateSchema.nullable().optional(),
    autoCompound: ClaimAutoCompoundStateSchema.nullable().optional(),
    swap: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export const PostClaimSwapInputSchema = z
  .object({
    actionId: z.string().min(1),
    wallet: z.string().min(1),
    position: PositionSchema,
    claimedBaseAmount: z.number().nonnegative(),
    claimedBaseAmountRaw: z.string().regex(/^\d+$/).optional(),
    outputMint: z.string().min(1),
  })
  .strict();

export type PostClaimSwapInput = z.infer<typeof PostClaimSwapInputSchema>;
export type PostClaimSwapHook = (
  input: PostClaimSwapInput,
) => Promise<Record<string, unknown> | null>;

export interface CompoundDeployRiskGuard {
  portfolio: PortfolioState;
  policy: PortfolioRiskPolicy;
  recentNewDeploys: number;
  solPriceUsd?: number;
}

export interface FinalizeClaimFeesInput {
  actionId: string;
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  dlmmGateway: DlmmGateway;
  journalRepository?: JournalRepository;
  walletLock?: WalletLock;
  positionLock?: PositionLock;
  actionQueue?: ActionQueue;
  runtimeControlStore?: RuntimeControlStore;
  now?: () => string;
  postClaimSwapHook?: PostClaimSwapHook;
  compoundDeployRiskGuard?: CompoundDeployRiskGuard;
}

export interface FinalizeClaimFeesResult {
  action: Action;
  position: Position | null;
  outcome: "FINALIZED" | "TIMED_OUT" | "UNCHANGED";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message.trim().length > 0 ? error.message : fallback;
  }

  const value = String(error).trim();
  return value.length > 0 ? value : fallback;
}

function nowTimestamp(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function toJournalRecord(value: unknown): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(JSON.stringify(value)));
}

async function appendJournalEvent(
  journalRepository: JournalRepository | undefined,
  event: JournalEvent,
): Promise<void> {
  if (journalRepository === undefined) {
    return;
  }

  await journalRepository.append(event);
}

function assertClaimAction(action: Action): asserts action is Action & {
  type: "CLAIM_FEES";
  positionId: string;
} {
  if (action.type !== "CLAIM_FEES" || action.positionId === null) {
    throw new Error(
      `Expected CLAIM_FEES action with positionId, received ${action.type}/${action.positionId}`,
    );
  }
}

function buildClaimConfirmedPosition(input: {
  confirmedPosition: Position;
  claimingPosition: Position;
  claimResult: z.infer<typeof ClaimConfirmationPayloadSchema>;
  actionId: string;
  reason: string;
  now: string;
}): Position {
  const claimConfirmedStatus = transitionPositionStatus(
    input.claimingPosition.status,
    "CLAIM_CONFIRMED",
  );
  return PositionSchema.parse({
    ...input.claimingPosition,
    ...input.confirmedPosition,
    feesClaimedBase: Math.max(
      input.confirmedPosition.feesClaimedBase,
      input.claimingPosition.feesClaimedBase +
        input.claimResult.claimedBaseAmount,
    ),
    feesClaimedUsd: Math.max(
      input.confirmedPosition.feesClaimedUsd,
      input.claimingPosition.feesClaimedUsd +
        (input.claimResult.claimedBaseAmountUsd ?? 0),
    ),
    status: claimConfirmedStatus,
    lastSyncedAt: input.now,
    lastManagementDecision: "CLAIM_FEES",
    lastManagementReason: input.reason,
    lastWriteActionId: input.actionId,
    needsReconciliation: false,
  });
}

function buildReconcilingPosition(
  claimConfirmedPosition: Position,
  actionId: string,
  now: string,
): Position {
  return PositionSchema.parse({
    ...claimConfirmedPosition,
    status:
      claimConfirmedPosition.status === "RECONCILING"
        ? "RECONCILING"
        : transitionPositionStatus(
            claimConfirmedPosition.status,
            "RECONCILING",
          ),
    lastSyncedAt: now,
    lastWriteActionId: actionId,
    needsReconciliation: true,
  });
}

function buildOpenPosition(
  reconcilingPosition: Position,
  actionId: string,
  now: string,
): Position {
  return PositionSchema.parse({
    ...reconcilingPosition,
    status:
      reconcilingPosition.status === "OPEN"
        ? "OPEN"
        : transitionPositionStatus(reconcilingPosition.status, "OPEN"),
    lastSyncedAt: now,
    lastWriteActionId: actionId,
    needsReconciliation: false,
  });
}

function buildReconciliationRequiredPosition(
  position: Position,
  actionId: string,
  now: string,
): Position {
  return PositionSchema.parse({
    ...position,
    status: transitionPositionStatus(
      position.status,
      "RECONCILIATION_REQUIRED",
    ),
    lastSyncedAt: now,
    lastWriteActionId: actionId,
    needsReconciliation: true,
  });
}

function buildCompoundDeployPayload(input: {
  template: z.infer<typeof CompoundDeployTemplateSchema>;
  outputMint: string;
  outputAmount: number;
  outputAmountUsd: number;
}): z.infer<typeof DeployActionRequestPayloadSchema> {
  const amountBase =
    input.outputMint === input.template.baseMint ? input.outputAmount : 0;
  const amountQuote =
    input.outputMint === input.template.quoteMint ? input.outputAmount : 0;
  if (amountBase <= 0 && amountQuote <= 0) {
    throw new Error(
      "compound output mint must match pool baseMint or quoteMint",
    );
  }

  return DeployActionRequestPayloadSchema.parse({
    poolAddress: input.template.poolAddress,
    tokenXMint: input.template.tokenXMint,
    tokenYMint: input.template.tokenYMint,
    baseMint: input.template.baseMint,
    quoteMint: input.template.quoteMint,
    amountBase,
    amountQuote,
    strategy: input.template.strategy,
    rangeLowerBin: input.template.rangeLowerBin,
    rangeUpperBin: input.template.rangeUpperBin,
    initialActiveBin: input.template.initialActiveBin,
    estimatedValueUsd: input.outputAmountUsd,
    ...(input.template.entryMetadata === undefined
      ? {}
      : { entryMetadata: input.template.entryMetadata }),
  });
}

function resolveCompoundOutputValueUsd(input: {
  outputMint: string;
  outputAmount: number;
  swapResult: Record<string, unknown>;
  solPriceUsd?: number;
}): number {
  const explicitValueUsd = z
    .number()
    .nonnegative()
    .safeParse(input.swapResult.outputAmountUsd);
  if (explicitValueUsd.success) {
    return explicitValueUsd.data;
  }

  if (
    input.outputMint === SOL_MINT &&
    input.solPriceUsd !== undefined &&
    input.solPriceUsd > 0
  ) {
    return input.outputAmount * input.solPriceUsd;
  }

  throw new Error(
    "compound output USD value unavailable; provide outputAmountUsd or SOL price",
  );
}

function buildCompoundRiskGuard(input: { riskGuard: CompoundDeployRiskGuard }) {
  return {
    ...input.riskGuard,
    portfolio: {
      ...input.riskGuard.portfolio,
      pendingActions: Math.max(0, input.riskGuard.portfolio.pendingActions - 1),
    },
  };
}

async function persistReconcilingAction(input: {
  actionRepository: ActionRepository;
  action: Action;
  resultPayload: z.infer<typeof ClaimConfirmationPayloadSchema>;
}): Promise<Action> {
  const nextAction = {
    ...input.action,
    resultPayload: toJournalRecord(input.resultPayload),
  } satisfies Action;
  await input.actionRepository.upsert(nextAction);
  return nextAction;
}

async function runClaimPostProcessing(input: {
  latestAction: Action;
  claimResult: z.infer<typeof ClaimConfirmationPayloadSchema>;
  reconcilingPosition: Position;
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  journalRepository: JournalRepository | undefined;
  actionQueue: ActionQueue | undefined;
  runtimeControlStore: RuntimeControlStore | undefined;
  postClaimSwapHook: PostClaimSwapHook | undefined;
  compoundDeployRiskGuard:
    | FinalizeClaimFeesInput["compoundDeployRiskGuard"]
    | undefined;
  now: string;
}): Promise<{
  action: Action;
  openPosition: Position;
}> {
  let workingAction = input.latestAction;
  let claimResult = input.claimResult;

  if (
    claimResult.autoCompound === null ||
    claimResult.autoCompound === undefined
  ) {
    let autoSwap =
      claimResult.autoSwap ??
      (claimResult.autoSwapOutputMint === null ||
      claimResult.autoSwapOutputMint === undefined
        ? null
        : ClaimAutoSwapStateSchema.parse({
            outputMint: claimResult.autoSwapOutputMint,
            phase:
              claimResult.swap === undefined ? "PENDING_SWAP" : "SWAP_DONE",
            swap: claimResult.swap ?? null,
            error: null,
          }));

    if (
      input.postClaimSwapHook !== undefined &&
      autoSwap !== null &&
      claimResult.claimedBaseAmount > 0 &&
      autoSwap.phase === "PENDING_SWAP"
    ) {
      autoSwap = ClaimAutoSwapStateSchema.parse({
        ...autoSwap,
        phase: "SWAP_IN_PROGRESS",
        error: null,
      });
      claimResult = ClaimConfirmationPayloadSchema.parse({
        ...claimResult,
        autoSwap,
      });
      workingAction = await persistReconcilingAction({
        actionRepository: input.actionRepository,
        action: workingAction,
        resultPayload: claimResult,
      });

      if (claimResult.claimedBaseAmountSource === "unavailable") {
        await appendJournalEvent(input.journalRepository, {
          timestamp: input.now,
          eventType: "CLAIM_AUTO_SWAP_FAILED",
          actor: workingAction.requestedBy,
          wallet: workingAction.wallet,
          positionId: workingAction.positionId,
          actionId: workingAction.actionId,
          before: null,
          after: null,
          txIds: [],
          resultStatus: "FAILED",
          error:
            "claimed base amount unavailable after claim; auto swap skipped",
        });
        autoSwap = ClaimAutoSwapStateSchema.parse({
          ...autoSwap,
          phase: "FAILED",
          swap: null,
          error:
            "claimed base amount unavailable after claim; auto swap skipped",
        });
      } else {
        try {
          const simpleSwapResult = await input.postClaimSwapHook(
            PostClaimSwapInputSchema.parse({
              actionId: workingAction.actionId,
              wallet: workingAction.wallet,
              position: input.reconcilingPosition,
              claimedBaseAmount: claimResult.claimedBaseAmount,
              ...(claimResult.claimedBaseAmountRaw === undefined
                ? {}
                : { claimedBaseAmountRaw: claimResult.claimedBaseAmountRaw }),
              outputMint: autoSwap.outputMint,
            }),
          );
          autoSwap = ClaimAutoSwapStateSchema.parse({
            ...autoSwap,
            phase: "SWAP_DONE",
            swap: simpleSwapResult,
            error: null,
          });
        } catch (error) {
          autoSwap = ClaimAutoSwapStateSchema.parse({
            ...autoSwap,
            phase: "FAILED",
            swap: null,
            error: errorMessage(error, "claim auto swap failed"),
          });
          claimResult = ClaimConfirmationPayloadSchema.parse({
            ...claimResult,
            autoSwap,
            swap: { status: "FAILED", error: autoSwap.error ?? "claim auto swap failed" },
          });
          workingAction = await persistReconcilingAction({
            actionRepository: input.actionRepository,
            action: workingAction,
            resultPayload: claimResult,
          });
          await appendJournalEvent(input.journalRepository, {
            timestamp: input.now,
            eventType: "CLAIM_AUTO_SWAP_FAILED",
            actor: workingAction.requestedBy,
            wallet: workingAction.wallet,
            positionId: workingAction.positionId,
            actionId: workingAction.actionId,
            before: null,
            after: null,
            txIds: [],
            resultStatus: "FAILED",
            error: errorMessage(error, "claim auto swap failed"),
          }).catch(() => undefined);
        }
      }

      claimResult = ClaimConfirmationPayloadSchema.parse({
        ...claimResult,
        autoSwap,
        swap: autoSwap.swap ?? {
          status: "FAILED",
          error: autoSwap.error ?? "claim auto swap failed",
        },
      });
      workingAction = await persistReconcilingAction({
        actionRepository: input.actionRepository,
        action: workingAction,
        resultPayload: claimResult,
      });
    } else if (autoSwap?.phase === "SWAP_IN_PROGRESS") {
      autoSwap = ClaimAutoSwapStateSchema.parse({
        ...autoSwap,
        phase: "MANUAL_REVIEW_REQUIRED",
        error:
          "simple claim swap status was left in progress after interruption",
      });
      claimResult = ClaimConfirmationPayloadSchema.parse({
        ...claimResult,
        autoSwap,
        swap: {
          status: "MANUAL_REVIEW_REQUIRED",
          error: autoSwap.error,
        },
      });
      workingAction = await persistReconcilingAction({
        actionRepository: input.actionRepository,
        action: workingAction,
        resultPayload: claimResult,
      });
    }
  } else {
    let compound = claimResult.autoCompound;

    if (compound.phase === "PENDING_SWAP") {
      compound = ClaimAutoCompoundStateSchema.parse({
        ...compound,
        phase: "SWAP_IN_PROGRESS",
        error: null,
      });
      claimResult = ClaimConfirmationPayloadSchema.parse({
        ...claimResult,
        autoCompound: compound,
      });
      workingAction = await persistReconcilingAction({
        actionRepository: input.actionRepository,
        action: workingAction,
        resultPayload: claimResult,
      });

      if (input.postClaimSwapHook === undefined) {
        compound = ClaimAutoCompoundStateSchema.parse({
          ...compound,
          phase: "FAILED",
          error: "post claim swap hook unavailable for auto-compound",
        });
      } else if (claimResult.claimedBaseAmountSource === "unavailable") {
        compound = ClaimAutoCompoundStateSchema.parse({
          ...compound,
          phase: "FAILED",
          error:
            "claimed base amount unavailable after claim; auto-compound skipped",
        });
      } else {
        try {
          const swapResult = await input.postClaimSwapHook(
            PostClaimSwapInputSchema.parse({
              actionId: workingAction.actionId,
              wallet: workingAction.wallet,
              position: input.reconcilingPosition,
              claimedBaseAmount: claimResult.claimedBaseAmount,
              ...(claimResult.claimedBaseAmountRaw === undefined
                ? {}
                : { claimedBaseAmountRaw: claimResult.claimedBaseAmountRaw }),
              outputMint: compound.outputMint,
            }),
          );
          compound = ClaimAutoCompoundStateSchema.parse({
            ...compound,
            phase: "SWAP_DONE",
            swap: swapResult,
            error: null,
          });
        } catch (error) {
          compound = ClaimAutoCompoundStateSchema.parse({
            ...compound,
            phase: "FAILED",
            error: errorMessage(error, "claim auto-compound swap failed"),
          });
          claimResult = ClaimConfirmationPayloadSchema.parse({
            ...claimResult,
            autoCompound: compound,
          });
          workingAction = await persistReconcilingAction({
            actionRepository: input.actionRepository,
            action: workingAction,
            resultPayload: claimResult,
          });
          await appendJournalEvent(input.journalRepository, {
            timestamp: input.now,
            eventType: "CLAIM_AUTO_COMPOUND_FAILED",
            actor: workingAction.requestedBy,
            wallet: workingAction.wallet,
            positionId: workingAction.positionId,
            actionId: workingAction.actionId,
            before: null,
            after: null,
            txIds: [],
            resultStatus: "FAILED",
            error: errorMessage(error, "claim auto-compound swap failed"),
          }).catch(() => undefined);
        }
      }

      claimResult = ClaimConfirmationPayloadSchema.parse({
        ...claimResult,
        autoCompound: compound,
      });
      workingAction = await persistReconcilingAction({
        actionRepository: input.actionRepository,
        action: workingAction,
        resultPayload: claimResult,
      });
    } else if (compound.phase === "SWAP_IN_PROGRESS") {
      compound = ClaimAutoCompoundStateSchema.parse({
        ...compound,
        phase: "MANUAL_REVIEW_REQUIRED",
        error: "compound swap status was left in progress after interruption",
      });
      claimResult = ClaimConfirmationPayloadSchema.parse({
        ...claimResult,
        autoCompound: compound,
      });
      workingAction = await persistReconcilingAction({
        actionRepository: input.actionRepository,
        action: workingAction,
        resultPayload: claimResult,
      });
    }

    if (compound.phase === "SWAP_DONE") {
      if (input.actionQueue === undefined) {
        compound = ClaimAutoCompoundStateSchema.parse({
          ...compound,
          phase: "FAILED",
          error: "action queue unavailable for auto-compound redeploy",
        });
      } else {
        try {
          const swapResult = z
            .record(z.string(), z.unknown())
            .parse(compound.swap ?? {});
          const outputAmount = z
            .number()
            .nonnegative()
            .parse(swapResult.outputAmount);
          const outputAmountUsd = resolveCompoundOutputValueUsd({
            outputMint: compound.outputMint,
            outputAmount,
            swapResult,
            ...(input.compoundDeployRiskGuard?.solPriceUsd === undefined
              ? {}
              : { solPriceUsd: input.compoundDeployRiskGuard.solPriceUsd }),
          });
          const deployPayload = buildCompoundDeployPayload({
            template: compound.deployTemplate,
            outputMint: compound.outputMint,
            outputAmount,
            outputAmountUsd,
          });
          if (input.compoundDeployRiskGuard === undefined) {
            throw new Error(
              "compound deploy risk guard unavailable; auto-compound redeploy blocked",
            );
          }
          const deployAction = await requestDeploy({
            actionQueue: input.actionQueue,
            wallet: workingAction.wallet,
            payload: deployPayload,
            requestedBy: workingAction.requestedBy,
            requestedAt: input.now,
            idempotencyKey: `${workingAction.actionId}:AUTO_COMPOUND_DEPLOY`,
            ...(input.journalRepository === undefined
              ? {}
              : { journalRepository: input.journalRepository }),
            ...(input.runtimeControlStore === undefined
              ? {}
              : { runtimeControlStore: input.runtimeControlStore }),
            riskGuard: buildCompoundRiskGuard({
              riskGuard: input.compoundDeployRiskGuard,
            }),
          });
          compound = ClaimAutoCompoundStateSchema.parse({
            ...compound,
            phase: "DEPLOY_QUEUED",
            deployActionId: deployAction.actionId,
            error: null,
          });
        } catch (error) {
          const existingDeployAction = await input.actionRepository
            .findByIdempotencyKey(
              `${workingAction.actionId}:AUTO_COMPOUND_DEPLOY`,
            )
            .catch(() => null);
          const compoundEnqueueFailed = existingDeployAction === null;
          compound = ClaimAutoCompoundStateSchema.parse({
            ...compound,
            ...(compoundEnqueueFailed
              ? {
                  phase: "FAILED" as const,
                  error: errorMessage(
                    error,
                    "claim auto-compound deploy enqueue failed",
                  ),
                }
              : {
                  phase: "DEPLOY_QUEUED" as const,
                  deployActionId: existingDeployAction.actionId,
                  error:
                    "deploy action exists but requestDeploy returned an error",
                }),
          });
          claimResult = ClaimConfirmationPayloadSchema.parse({
            ...claimResult,
            autoCompound: compound,
          });
          workingAction = await persistReconcilingAction({
            actionRepository: input.actionRepository,
            action: workingAction,
            resultPayload: claimResult,
          });
          if (compoundEnqueueFailed) {
            await appendJournalEvent(input.journalRepository, {
              timestamp: input.now,
              eventType: "CLAIM_AUTO_COMPOUND_FAILED",
              actor: workingAction.requestedBy,
              wallet: workingAction.wallet,
              positionId: workingAction.positionId,
              actionId: workingAction.actionId,
              before: null,
              after: null,
              txIds: [],
              resultStatus: "FAILED",
              error: errorMessage(
                error,
                "claim auto-compound deploy enqueue failed",
              ),
            }).catch(() => undefined);
          }
        }
      }

      claimResult = ClaimConfirmationPayloadSchema.parse({
        ...claimResult,
        autoCompound: compound,
      });
      workingAction = await persistReconcilingAction({
        actionRepository: input.actionRepository,
        action: workingAction,
        resultPayload: claimResult,
      });
    }
  }

  const openPosition = buildOpenPosition(
    input.reconcilingPosition,
    workingAction.actionId,
    input.now,
  );
  await input.stateRepository.upsert(openPosition);

  const doneAction = {
    ...workingAction,
    status: transitionActionStatus(workingAction.status, "DONE"),
    resultPayload: toJournalRecord(claimResult),
    completedAt: input.now,
    error: null,
  } satisfies Action;
  await input.actionRepository.upsert(doneAction);

  try {
    await appendJournalEvent(input.journalRepository, {
      timestamp: input.now,
      eventType: "CLAIM_FINALIZED",
      actor: workingAction.requestedBy,
      wallet: workingAction.wallet,
      positionId: workingAction.positionId,
      actionId: workingAction.actionId,
      before: toJournalRecord({
        action: workingAction,
        position: input.reconcilingPosition,
      }),
      after: toJournalRecord({
        action: doneAction,
        position: openPosition,
      }),
      txIds: doneAction.txIds,
      resultStatus: doneAction.status,
      error: null,
    });
  } catch (error) {
    logger.warn({ err: error }, "claim finalized journal append failed");
  }

  return {
    action: doneAction,
    openPosition,
  };
}

export async function finalizeClaimFees(
  input: FinalizeClaimFeesInput,
): Promise<FinalizeClaimFeesResult> {
  const action = await input.actionRepository.get(input.actionId);
  if (action === null) {
    throw new Error(`Claim action not found: ${input.actionId}`);
  }

  assertClaimAction(action);
  const now = nowTimestamp(input.now);
  const walletLock = input.walletLock ?? new WalletLock();
  const positionLock = input.positionLock ?? new PositionLock();

  if (
    action.status === "DONE" ||
    action.status === "TIMED_OUT" ||
    action.status === "FAILED" ||
    action.status === "ABORTED"
  ) {
    return {
      action,
      position: await input.stateRepository.get(action.positionId),
      outcome: "UNCHANGED",
    };
  }

  if (
    action.status !== "WAITING_CONFIRMATION" &&
    action.status !== "RECONCILING"
  ) {
    throw new Error(
      `Claim finalization expected WAITING_CONFIRMATION or RECONCILING, received ${action.status}`,
    );
  }

  return walletLock.withLock(action.wallet, () =>
    positionLock.withLock(action.positionId, async () => {
      const latestAction = await input.actionRepository.get(action.actionId);
      if (latestAction === null) {
        throw new Error(
          `Claim action disappeared during finalization: ${action.actionId}`,
        );
      }

      assertClaimAction(latestAction);

      if (
        latestAction.status === "DONE" ||
        latestAction.status === "TIMED_OUT" ||
        latestAction.status === "FAILED" ||
        latestAction.status === "ABORTED"
      ) {
        return {
          action: latestAction,
          position: await input.stateRepository.get(latestAction.positionId),
          outcome: "UNCHANGED" as const,
        };
      }

      if (
        latestAction.status !== "WAITING_CONFIRMATION" &&
        latestAction.status !== "RECONCILING"
      ) {
        throw new Error(
          `Claim finalization expected WAITING_CONFIRMATION or RECONCILING, received ${latestAction.status}`,
        );
      }

      const claimResult = ClaimConfirmationPayloadSchema.parse(
        latestAction.resultPayload,
      );
      let reconcilingPosition: Position;

      if (latestAction.status === "WAITING_CONFIRMATION") {
        const claimingPosition = await input.stateRepository.get(
          latestAction.positionId,
        );
        const confirmedPosition = await input.dlmmGateway.getPosition(
          latestAction.positionId,
        );

        if (
          claimingPosition !== null &&
          claimingPosition.status === "OPEN" &&
          confirmedPosition !== null &&
          confirmedPosition.status === "OPEN"
        ) {
          const reconcilingAction = {
            ...latestAction,
            status: transitionActionStatus(latestAction.status, "RECONCILING"),
          } satisfies Action;
          await input.actionRepository.upsert(reconcilingAction);
          const resumed = await runClaimPostProcessing({
            latestAction: reconcilingAction,
            claimResult,
            reconcilingPosition: claimingPosition,
            actionRepository: input.actionRepository,
            stateRepository: input.stateRepository,
            journalRepository: input.journalRepository,
            actionQueue: input.actionQueue,
            runtimeControlStore: input.runtimeControlStore,
            postClaimSwapHook: input.postClaimSwapHook,
            compoundDeployRiskGuard: input.compoundDeployRiskGuard,
            now,
          });
          return {
            action: resumed.action,
            position: resumed.openPosition,
            outcome: "FINALIZED" as const,
          };
        }

        if (
          claimingPosition !== null &&
          claimingPosition.status === "RECONCILIATION_REQUIRED" &&
          confirmedPosition !== null &&
          confirmedPosition.status === "OPEN"
        ) {
          const reconcilingPosition = buildReconcilingPosition(
            PositionSchema.parse({
              ...claimingPosition,
              ...confirmedPosition,
              status: transitionPositionStatus(
                "RECONCILIATION_REQUIRED",
                "RECONCILING",
              ),
              needsReconciliation: true,
              lastWriteActionId: latestAction.actionId,
              lastSyncedAt: now,
            }),
            latestAction.actionId,
            now,
          );
          const reconcilingAction = {
            ...latestAction,
            status: transitionActionStatus(latestAction.status, "RECONCILING"),
          } satisfies Action;
          await input.stateRepository.upsert(reconcilingPosition);
          await input.actionRepository.upsert(reconcilingAction);
          const resumed = await runClaimPostProcessing({
            latestAction: reconcilingAction,
            claimResult,
            reconcilingPosition,
            actionRepository: input.actionRepository,
            stateRepository: input.stateRepository,
            journalRepository: input.journalRepository,
            actionQueue: input.actionQueue,
            runtimeControlStore: input.runtimeControlStore,
            postClaimSwapHook: input.postClaimSwapHook,
            compoundDeployRiskGuard: input.compoundDeployRiskGuard,
            now,
          });
          return {
            action: resumed.action,
            position: resumed.openPosition,
            outcome: "FINALIZED" as const,
          };
        }

        const claimConfirmedLikePosition =
          confirmedPosition !== null &&
          (confirmedPosition.status === "CLAIM_CONFIRMED" ||
            (input.dlmmGateway.reconciliationReadModel === "open_only" &&
              confirmedPosition.status === "OPEN"))
            ? confirmedPosition
            : null;

        if (
          claimingPosition === null ||
          claimingPosition.status !== "CLAIMING" ||
          claimConfirmedLikePosition === null
        ) {
          const sourcePosition = claimingPosition ?? confirmedPosition;
          if (sourcePosition === null) {
            throw new Error(
              `Claim finalization cannot build reconciliation state for ${latestAction.positionId}`,
            );
          }

          const reconciliationPosition = buildReconciliationRequiredPosition(
            sourcePosition,
            latestAction.actionId,
            now,
          );
          await input.stateRepository.upsert(reconciliationPosition);

          const timedOutAction = {
            ...latestAction,
            status: transitionActionStatus(latestAction.status, "TIMED_OUT"),
            error:
              claimingPosition === null
                ? `Claim finalization requires reconciliation because local claiming position is missing for ${latestAction.positionId}`
                : claimingPosition.status !== "CLAIMING"
                  ? `Claim finalization requires reconciliation because local position status is ${claimingPosition.status} for ${latestAction.positionId}`
                  : claimConfirmedLikePosition === null
                    ? `Claim confirmation not found for position ${latestAction.positionId}`
                    : `Claim confirmation returned unsupported status ${confirmedPosition?.status ?? "unknown"} for ${latestAction.positionId}`,
            completedAt: now,
          } satisfies Action;
          await input.actionRepository.upsert(timedOutAction);

          await appendJournalEvent(input.journalRepository, {
            timestamp: now,
            eventType: "CLAIM_TIMED_OUT",
            actor: latestAction.requestedBy,
            wallet: latestAction.wallet,
            positionId: latestAction.positionId,
            actionId: latestAction.actionId,
            before: toJournalRecord({
              action: latestAction,
              position: claimingPosition,
            }),
            after: toJournalRecord({
              action: timedOutAction,
              position: reconciliationPosition,
            }),
            txIds: latestAction.txIds,
            resultStatus: timedOutAction.status,
            error: timedOutAction.error,
          });

          return {
            action: timedOutAction,
            position: reconciliationPosition,
            outcome: "TIMED_OUT",
          };
        }

        const claimConfirmedPosition = buildClaimConfirmedPosition({
          confirmedPosition: claimConfirmedLikePosition,
          claimingPosition,
          claimResult,
          actionId: latestAction.actionId,
          reason: claimResult.reason,
          now,
        });
        reconcilingPosition = buildReconcilingPosition(
          claimConfirmedPosition,
          latestAction.actionId,
          now,
        );
        const reconcilingAction = {
          ...latestAction,
          status: transitionActionStatus(latestAction.status, "RECONCILING"),
        } satisfies Action;
        await input.stateRepository.upsert(reconcilingPosition);
        await input.actionRepository.upsert(reconcilingAction);
        const finalized = await runClaimPostProcessing({
          latestAction: reconcilingAction,
          claimResult,
          reconcilingPosition,
          actionRepository: input.actionRepository,
          stateRepository: input.stateRepository,
          journalRepository: input.journalRepository,
          actionQueue: input.actionQueue,
          runtimeControlStore: input.runtimeControlStore,
          postClaimSwapHook: input.postClaimSwapHook,
          compoundDeployRiskGuard: input.compoundDeployRiskGuard,
          now,
        });
        return {
          action: finalized.action,
          position: finalized.openPosition,
          outcome: "FINALIZED",
        };
      }

      const currentPosition = await input.stateRepository.get(
        latestAction.positionId,
      );
      if (currentPosition === null) {
        throw new Error(
          `Claim reconciling position missing for ${latestAction.positionId}`,
        );
      }
      reconcilingPosition = currentPosition;
      if (
        reconcilingPosition.status !== "RECONCILING" &&
        reconcilingPosition.status !== "OPEN"
      ) {
        throw new Error(
          `Claim reconciliation resume expected RECONCILING/OPEN position, received ${reconcilingPosition.status}`,
        );
      }

      const resumed = await runClaimPostProcessing({
        latestAction,
        claimResult,
        reconcilingPosition,
        actionRepository: input.actionRepository,
        stateRepository: input.stateRepository,
        journalRepository: input.journalRepository,
        actionQueue: input.actionQueue,
        runtimeControlStore: input.runtimeControlStore,
        postClaimSwapHook: input.postClaimSwapHook,
        compoundDeployRiskGuard: input.compoundDeployRiskGuard,
        now,
      });
      return {
        action: resumed.action,
        position: resumed.openPosition,
        outcome: "FINALIZED",
      };
    }),
  );
}
