import { z } from "zod";

import type { DlmmGateway } from "../../adapters/dlmm/DlmmGateway.js";
import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { Action } from "../../domain/entities/Action.js";
import type { JournalEvent } from "../../domain/entities/JournalEvent.js";
import { PositionSchema, type Position } from "../../domain/entities/Position.js";
import { transitionActionStatus } from "../../domain/stateMachines/actionLifecycle.js";
import { transitionPositionStatus } from "../../domain/stateMachines/positionLifecycle.js";
import { PositionLock } from "../../infra/locks/positionLock.js";
import { WalletLock } from "../../infra/locks/walletLock.js";

const ClaimConfirmationPayloadSchema = z
  .object({
    actionType: z.literal("CLAIM_FEES"),
    claimedBaseAmount: z.number().nonnegative(),
    txIds: z.array(z.string().min(1)),
    reason: z.string().min(1),
    autoSwapOutputMint: z.string().min(1).nullable().optional(),
  })
  .strict();

export const PostClaimSwapInputSchema = z
  .object({
    actionId: z.string().min(1),
    wallet: z.string().min(1),
    position: PositionSchema,
    claimedBaseAmount: z.number().nonnegative(),
    outputMint: z.string().min(1),
  })
  .strict();

export type PostClaimSwapInput = z.infer<typeof PostClaimSwapInputSchema>;
export type PostClaimSwapHook = (
  input: PostClaimSwapInput,
) => Promise<Record<string, unknown> | null>;

export interface FinalizeClaimFeesInput {
  actionId: string;
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  dlmmGateway: DlmmGateway;
  journalRepository?: JournalRepository;
  walletLock?: WalletLock;
  positionLock?: PositionLock;
  now?: () => string;
  postClaimSwapHook?: PostClaimSwapHook;
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
  return z.record(z.string(), z.unknown()).parse(
    JSON.parse(JSON.stringify(value)),
  );
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
    status: transitionPositionStatus(claimConfirmedPosition.status, "RECONCILING"),
    lastSyncedAt: now,
    lastWriteActionId: actionId,
    needsReconciliation: false,
  });
}

function buildOpenPosition(
  reconcilingPosition: Position,
  actionId: string,
  now: string,
): Position {
  return PositionSchema.parse({
    ...reconcilingPosition,
    status: transitionPositionStatus(reconcilingPosition.status, "OPEN"),
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
    status: transitionPositionStatus(position.status, "RECONCILIATION_REQUIRED"),
    lastSyncedAt: now,
    lastWriteActionId: actionId,
    needsReconciliation: true,
  });
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

  if (action.status !== "WAITING_CONFIRMATION") {
    throw new Error(
      `Claim finalization expected WAITING_CONFIRMATION, received ${action.status}`,
    );
  }

  const claimResult = ClaimConfirmationPayloadSchema.parse(action.resultPayload);

  return walletLock.withLock(action.wallet, () =>
    positionLock.withLock(action.positionId, async () => {
      const latestAction = await input.actionRepository.get(action.actionId);
      if (latestAction === null) {
        throw new Error(`Claim action disappeared during finalization: ${action.actionId}`);
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

      if (latestAction.status !== "WAITING_CONFIRMATION") {
        throw new Error(
          `Claim finalization expected WAITING_CONFIRMATION, received ${latestAction.status}`,
        );
      }

      const claimingPosition = await input.stateRepository.get(latestAction.positionId);
      const confirmedPosition = await input.dlmmGateway.getPosition(latestAction.positionId);

      if (
        claimingPosition !== null &&
        claimingPosition.status === "OPEN" &&
        confirmedPosition !== null &&
        confirmedPosition.status === "OPEN"
      ) {
        const doneAction = {
          ...latestAction,
          status: transitionActionStatus(latestAction.status, "DONE"),
          completedAt: now,
          error: null,
        } satisfies Action;
        await input.actionRepository.upsert(doneAction);
        return {
          action: doneAction,
          position: claimingPosition,
          outcome: "FINALIZED",
        };
      }

      if (
        claimingPosition === null ||
        claimingPosition.status !== "CLAIMING" ||
        confirmedPosition === null ||
        confirmedPosition.status !== "CLAIM_CONFIRMED"
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
                : confirmedPosition === null
                  ? `Claim confirmation not found for position ${latestAction.positionId}`
                  : `Claim confirmation returned non-claim-confirmed status ${confirmedPosition.status} for ${latestAction.positionId}`,
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
        confirmedPosition,
        claimingPosition,
        actionId: latestAction.actionId,
        reason: claimResult.reason,
        now,
      });
      const reconcilingPosition = buildReconcilingPosition(
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

      let swapResult: Record<string, unknown> | null = null;
      if (
        input.postClaimSwapHook !== undefined &&
        claimResult.autoSwapOutputMint !== null &&
        claimResult.autoSwapOutputMint !== undefined &&
        claimResult.claimedBaseAmount > 0
      ) {
        try {
          swapResult =
            await input.postClaimSwapHook(
              PostClaimSwapInputSchema.parse({
                actionId: reconcilingAction.actionId,
                wallet: reconcilingAction.wallet,
                position: reconcilingPosition,
                claimedBaseAmount: claimResult.claimedBaseAmount,
                outputMint: claimResult.autoSwapOutputMint,
              }),
            );
        } catch (error) {
          await appendJournalEvent(input.journalRepository, {
            timestamp: now,
            eventType: "CLAIM_AUTO_SWAP_FAILED",
            actor: latestAction.requestedBy,
            wallet: latestAction.wallet,
            positionId: latestAction.positionId,
            actionId: latestAction.actionId,
            before: null,
            after: null,
            txIds: [],
            resultStatus: "FAILED",
            error: errorMessage(error, "claim auto swap failed"),
          });
          swapResult = {
            status: "FAILED",
            error: errorMessage(error, "claim auto swap failed"),
          };
        }
      }

      const openPosition = buildOpenPosition(
        reconcilingPosition,
        latestAction.actionId,
        now,
      );
      await input.stateRepository.upsert(openPosition);

      const doneAction = {
        ...reconcilingAction,
        status: transitionActionStatus(reconcilingAction.status, "DONE"),
        resultPayload: toJournalRecord({
          ...claimResult,
          swap: swapResult,
        }),
        completedAt: now,
        error: null,
      } satisfies Action;
      await input.actionRepository.upsert(doneAction);

      await appendJournalEvent(input.journalRepository, {
        timestamp: now,
        eventType: "CLAIM_FINALIZED",
        actor: latestAction.requestedBy,
        wallet: latestAction.wallet,
        positionId: latestAction.positionId,
        actionId: latestAction.actionId,
        before: toJournalRecord({
          action: latestAction,
          position: claimingPosition,
        }),
        after: toJournalRecord({
          action: doneAction,
          position: openPosition,
          swap: swapResult,
        }),
        txIds: doneAction.txIds,
        resultStatus: doneAction.status,
        error: null,
      });

      return {
        action: doneAction,
        position: openPosition,
        outcome: "FINALIZED",
      };
    }),
  );
}
