import { z } from "zod";

import {
  ClosePositionResultSchema,
  DeployLiquidityResultSchema,
  type DlmmGateway,
} from "../../adapters/dlmm/DlmmGateway.js";
import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { RuntimeControlStore } from "../../adapters/storage/RuntimeControlStore.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { Action } from "../../domain/entities/Action.js";
import type { JournalEvent } from "../../domain/entities/JournalEvent.js";
import {
  PositionSchema,
  type Position,
} from "../../domain/entities/Position.js";
import { transitionActionStatus } from "../../domain/stateMachines/actionLifecycle.js";
import { transitionPositionStatus } from "../../domain/stateMachines/positionLifecycle.js";
import { PositionLock } from "../../infra/locks/positionLock.js";
import { WalletLock } from "../../infra/locks/walletLock.js";
import {
  buildCloseAccountingSummary,
  resolveOutOfRangeSince,
} from "../services/AccountingService.js";

import { RebalanceCloseSubmittedPayloadSchema } from "./processRebalanceAction.js";
import {
  RebalanceActionRequestPayloadSchema,
  deriveRebalanceCapitalRequirement,
} from "./requestRebalance.js";
import {
  DeployActionRequestPayloadSchema,
  type DeployActionRequestPayload,
} from "./requestDeploy.js";

const CloseActionResultPayloadSchema = ClosePositionResultSchema;
const DeployActionResultPayloadSchema = DeployLiquidityResultSchema;

export const RebalanceRedeploySubmittedPayloadSchema = z
  .object({
    phase: z.literal("REDEPLOY_SUBMITTED"),
    closeResult: CloseActionResultPayloadSchema,
    closeAccounting: z.record(z.string(), z.unknown()),
    closedPositionId: z.string().min(1),
    availableCapitalUsd: z.number().nonnegative(),
    redeployResult: DeployActionResultPayloadSchema,
    redeployRequest: DeployActionRequestPayloadSchema.optional(),
  })
  .strict();

export const RebalanceCompletedPayloadSchema = z
  .object({
    phase: z.literal("REBALANCE_COMPLETED"),
    closeResult: CloseActionResultPayloadSchema,
    closeAccounting: z.record(z.string(), z.unknown()),
    closedPositionId: z.string().min(1),
    availableCapitalUsd: z.number().nonnegative(),
    redeployResult: DeployActionResultPayloadSchema,
    redeployRequest: DeployActionRequestPayloadSchema.optional(),
    confirmedPositionId: z.string().min(1),
  })
  .strict();

export const RebalanceAbortedPayloadSchema = z
  .object({
    phase: z.literal("REBALANCE_ABORTED"),
    closeResult: CloseActionResultPayloadSchema,
    closeAccounting: z.record(z.string(), z.unknown()),
    closedPositionId: z.string().min(1),
    availableCapitalUsd: z.number().nonnegative(),
    failureReason: z.string().min(1),
  })
  .strict();

export const RebalanceActionResultPayloadSchema = z.discriminatedUnion(
  "phase",
  [
    RebalanceCloseSubmittedPayloadSchema,
    RebalanceRedeploySubmittedPayloadSchema,
    RebalanceCompletedPayloadSchema,
    RebalanceAbortedPayloadSchema,
  ],
);

type RebalanceCloseSubmittedPayload = z.infer<
  typeof RebalanceCloseSubmittedPayloadSchema
>;
type RebalanceRedeploySubmittedPayload = z.infer<
  typeof RebalanceRedeploySubmittedPayloadSchema
>;
type RebalanceCompletedPayload = z.infer<
  typeof RebalanceCompletedPayloadSchema
>;
type RebalanceAbortedPayload = z.infer<typeof RebalanceAbortedPayloadSchema>;

export interface FinalizeRebalanceInput {
  actionId: string;
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  dlmmGateway: DlmmGateway;
  journalRepository?: JournalRepository;
  runtimeControlStore?: RuntimeControlStore;
  walletLock?: WalletLock;
  positionLock?: PositionLock;
  now?: () => string;
}

export interface FinalizeRebalanceResult {
  action: Action;
  oldPosition: Position | null;
  newPosition: Position | null;
  outcome:
    | "REDEPLOY_SUBMITTED"
    | "FINALIZED"
    | "TIMED_OUT"
    | "REBALANCE_ABORTED"
    | "UNCHANGED";
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

function assertRebalanceAction(action: Action): asserts action is Action & {
  type: "REBALANCE";
  positionId: string;
} {
  if (action.type !== "REBALANCE" || action.positionId === null) {
    throw new Error(
      `Expected REBALANCE action with positionId, received ${action.type}/${action.positionId}`,
    );
  }
}

function getNewPositionIdFromPayload(
  payload: Action["resultPayload"],
): string | null {
  const parsed = RebalanceActionResultPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  if (parsed.data.phase === "REDEPLOY_SUBMITTED") {
    return parsed.data.redeployResult.positionId;
  }

  if (parsed.data.phase === "REBALANCE_COMPLETED") {
    return parsed.data.confirmedPositionId;
  }

  return null;
}

function buildCloseConfirmedPosition(input: {
  confirmedPosition: Position;
  closingPosition: Position;
  actionId: string;
  now: string;
}): Position {
  const rangeLowerBin =
    input.confirmedPosition.rangeLowerBin ??
    input.closingPosition.rangeLowerBin;
  const rangeUpperBin =
    input.confirmedPosition.rangeUpperBin ??
    input.closingPosition.rangeUpperBin;
  const activeBin =
    input.confirmedPosition.activeBin ?? input.closingPosition.activeBin;
  const closeConfirmedStatus = transitionPositionStatus(
    input.closingPosition.status,
    "CLOSE_CONFIRMED",
  );

  return PositionSchema.parse({
    ...input.closingPosition,
    ...input.confirmedPosition,
    status: closeConfirmedStatus,
    closedAt: input.confirmedPosition.closedAt ?? input.now,
    lastSyncedAt: input.now,
    rangeLowerBin,
    rangeUpperBin,
    activeBin,
    outOfRangeSince: resolveOutOfRangeSince({
      activeBin,
      rangeLowerBin,
      rangeUpperBin,
      preferredValue:
        input.confirmedPosition.outOfRangeSince ??
        input.closingPosition.outOfRangeSince,
      fallbackValue: input.closingPosition.outOfRangeSince ?? input.now,
    }),
    lastWriteActionId: input.actionId,
    needsReconciliation: false,
  });
}

function inferCloseConfirmedPosition(
  closingPosition: Position | null,
  confirmedPosition: Position | null,
  useOpenOnlyReadModel: boolean,
  actionId: string,
  now: string,
): Position | null {
  if (
    confirmedPosition !== null &&
    confirmedPosition.status === "CLOSE_CONFIRMED"
  ) {
    return confirmedPosition;
  }

  if (
    useOpenOnlyReadModel &&
    confirmedPosition === null &&
    closingPosition !== null &&
    (closingPosition.status === "CLOSING_FOR_REBALANCE" ||
      closingPosition.status === "CLOSE_CONFIRMED" ||
      closingPosition.status === "RECONCILING" ||
      closingPosition.status === "CLOSED")
  ) {
    return buildCloseConfirmedPosition({
      confirmedPosition: closingPosition,
      closingPosition,
      actionId,
      now,
    });
  }

  return null;
}

function buildClosedOldPosition(input: {
  closeConfirmedPosition: Position;
  actionId: string;
  now: string;
}): Position {
  const reconcilingPosition = PositionSchema.parse({
    ...input.closeConfirmedPosition,
    status: transitionPositionStatus(
      input.closeConfirmedPosition.status,
      "RECONCILING",
    ),
    lastSyncedAt: input.now,
    lastWriteActionId: input.actionId,
    needsReconciliation: false,
  });

  return PositionSchema.parse({
    ...reconcilingPosition,
    status: transitionPositionStatus(reconcilingPosition.status, "CLOSED"),
    closedAt: reconcilingPosition.closedAt ?? input.now,
    currentValueBase: 0,
    currentValueQuote: 0,
    currentValueUsd: 0,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    lastSyncedAt: input.now,
    lastWriteActionId: input.actionId,
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

function buildPendingRedeployPosition(input: {
  action: Action & { positionId: string; type: "REBALANCE" };
  closedPosition: Position;
  redeployPayload: DeployActionRequestPayload;
  redeployResult: z.infer<typeof DeployActionResultPayloadSchema>;
  now: string;
}): Position {
  const payload = RebalanceActionRequestPayloadSchema.parse(
    input.action.requestPayload,
  );
  const redeployPayload = DeployActionRequestPayloadSchema.parse(
    input.redeployPayload,
  );
  const redeployingStatus = transitionPositionStatus(
    "REDEPLOY_REQUESTED",
    "REDEPLOYING",
  );

  return PositionSchema.parse({
    positionId: input.redeployResult.positionId,
    poolAddress: redeployPayload.poolAddress,
    tokenXMint: redeployPayload.tokenXMint,
    tokenYMint: redeployPayload.tokenYMint,
    baseMint: redeployPayload.baseMint,
    quoteMint: redeployPayload.quoteMint,
    wallet: input.action.wallet,
    status: redeployingStatus,
    openedAt: null,
    lastSyncedAt: input.now,
    closedAt: null,
    deployAmountBase: redeployPayload.amountBase,
    deployAmountQuote: redeployPayload.amountQuote,
    currentValueBase: redeployPayload.amountBase,
    ...(redeployPayload.amountQuote <= 0
      ? {}
      : { currentValueQuote: redeployPayload.amountQuote }),
    currentValueUsd: redeployPayload.estimatedValueUsd,
    feesClaimedBase: 0,
    feesClaimedUsd: 0,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    lastRebalanceAt: input.now,
    rebalanceCount: input.closedPosition.rebalanceCount + 1,
    partialCloseCount: 0,
    strategy: redeployPayload.strategy,
    rangeLowerBin: redeployPayload.rangeLowerBin,
    rangeUpperBin: redeployPayload.rangeUpperBin,
    activeBin: redeployPayload.initialActiveBin,
    outOfRangeSince: null,
    lastManagementDecision: "REBALANCE",
    lastManagementReason: payload.reason,
    lastWriteActionId: input.action.actionId,
    needsReconciliation: false,
    ...(redeployPayload.entryMetadata === undefined
      ? {}
      : { entryMetadata: redeployPayload.entryMetadata }),
  });
}

function buildOpenRedeployedPosition(input: {
  pendingPosition: Position;
  confirmedPosition: Position;
  actionId: string;
  now: string;
}): Position {
  const rangeLowerBin =
    input.confirmedPosition.rangeLowerBin ??
    input.pendingPosition.rangeLowerBin;
  const rangeUpperBin =
    input.confirmedPosition.rangeUpperBin ??
    input.pendingPosition.rangeUpperBin;
  const activeBin =
    input.confirmedPosition.activeBin ?? input.pendingPosition.activeBin;

  return PositionSchema.parse({
    ...input.pendingPosition,
    ...input.confirmedPosition,
    status:
      input.pendingPosition.status === "OPEN"
        ? "OPEN"
        : transitionPositionStatus(input.pendingPosition.status, "OPEN"),
    openedAt:
      input.confirmedPosition.openedAt ??
      input.pendingPosition.openedAt ??
      input.now,
    lastSyncedAt: input.now,
    closedAt: null,
    rangeLowerBin,
    rangeUpperBin,
    activeBin,
    outOfRangeSince: resolveOutOfRangeSince({
      activeBin,
      rangeLowerBin,
      rangeUpperBin,
      preferredValue:
        input.confirmedPosition.outOfRangeSince ??
        input.pendingPosition.outOfRangeSince,
      fallbackValue: input.now,
    }),
    lastWriteActionId: input.actionId,
    needsReconciliation: false,
  });
}

function buildRedeploySubmittedPayload(input: {
  closeSubmitted: RebalanceCloseSubmittedPayload;
  closeAccounting: Record<string, unknown>;
  closedPositionId: string;
  availableCapitalUsd: number;
  redeployRequest: DeployActionRequestPayload;
  redeployResult: z.infer<typeof DeployActionResultPayloadSchema>;
}): RebalanceRedeploySubmittedPayload {
  return RebalanceRedeploySubmittedPayloadSchema.parse({
    phase: "REDEPLOY_SUBMITTED",
    closeResult: input.closeSubmitted.closeResult,
    closeAccounting: input.closeAccounting,
    closedPositionId: input.closedPositionId,
    availableCapitalUsd: input.availableCapitalUsd,
    redeployRequest: input.redeployRequest,
    redeployResult: input.redeployResult,
  });
}

function buildCompletedPayload(input: {
  redeploySubmitted: RebalanceRedeploySubmittedPayload;
  confirmedPositionId: string;
}): RebalanceCompletedPayload {
  return RebalanceCompletedPayloadSchema.parse({
    phase: "REBALANCE_COMPLETED",
    closeResult: input.redeploySubmitted.closeResult,
    closeAccounting: input.redeploySubmitted.closeAccounting,
    closedPositionId: input.redeploySubmitted.closedPositionId,
    availableCapitalUsd: input.redeploySubmitted.availableCapitalUsd,
    redeployResult: input.redeploySubmitted.redeployResult,
    ...(input.redeploySubmitted.redeployRequest === undefined
      ? {}
      : { redeployRequest: input.redeploySubmitted.redeployRequest }),
    confirmedPositionId: input.confirmedPositionId,
  });
}

function buildAbortedPayload(input: {
  closeSubmitted: RebalanceCloseSubmittedPayload;
  closeAccounting: Record<string, unknown>;
  closedPositionId: string;
  availableCapitalUsd: number;
  failureReason: string;
}): RebalanceAbortedPayload {
  return RebalanceAbortedPayloadSchema.parse({
    phase: "REBALANCE_ABORTED",
    closeResult: input.closeSubmitted.closeResult,
    closeAccounting: input.closeAccounting,
    closedPositionId: input.closedPositionId,
    availableCapitalUsd: input.availableCapitalUsd,
    failureReason: input.failureReason,
  });
}

function validateRedeployTarget(input: {
  availableCapitalUsd: number;
  requestedCapitalUsd: number;
  amountBase: number;
  amountQuote: number;
}): string | null {
  if (input.availableCapitalUsd <= 0) {
    return "Rebalance redeploy validation failed because closed position released no usable capital";
  }

  if (input.amountBase <= 0 && input.amountQuote <= 0) {
    return "Rebalance redeploy validation failed because closed position released no usable token amounts";
  }

  if (input.availableCapitalUsd < input.requestedCapitalUsd) {
    return `Rebalance redeploy validation failed because available capital ${input.availableCapitalUsd} is below requested ${input.requestedCapitalUsd}`;
  }

  return null;
}

function validatePostCloseRedeploySettlement(
  closeResult: z.infer<typeof CloseActionResultPayloadSchema>,
): string | null {
  if (closeResult.releasedAmountSource !== "post_tx") {
    return "Rebalance redeploy validation failed because post-close token settlement amounts are unavailable";
  }

  if (
    closeResult.releasedAmountBase === undefined &&
    closeResult.releasedAmountQuote === undefined
  ) {
    return "Rebalance redeploy validation failed because post-close token settlement amounts are missing";
  }

  return null;
}

async function finalizeCloseLeg(input: {
  latestAction: Action & { type: "REBALANCE"; positionId: string };
  closeSubmitted: RebalanceCloseSubmittedPayload;
  stateRepository: StateRepository;
  dlmmGateway: DlmmGateway;
  now: string;
}): Promise<{
  closingPosition: Position;
  closeConfirmedPosition: Position;
  closedPosition: Position;
  closeAccounting: Record<string, unknown>;
  availableCapitalUsd: number;
}> {
  const closingPosition = await input.stateRepository.get(
    input.latestAction.positionId,
  );
  const confirmedPosition = await input.dlmmGateway.getPosition(
    input.latestAction.positionId,
  );
  const closeConfirmedPositionLike = inferCloseConfirmedPosition(
    closingPosition,
    confirmedPosition,
    input.dlmmGateway.reconciliationReadModel === "open_only",
    input.latestAction.actionId,
    input.now,
  );

  if (
    closingPosition === null ||
    closingPosition.status !== "CLOSING_FOR_REBALANCE" ||
    closeConfirmedPositionLike === null
  ) {
    const sourcePosition = closingPosition ?? confirmedPosition;

    if (sourcePosition === null) {
      throw new Error(
        `Rebalance finalization cannot build reconciliation state for ${input.latestAction.positionId}`,
      );
    }

    const detail =
      closingPosition === null
        ? `Rebalance close finalization requires reconciliation because local closing position is missing for ${input.latestAction.positionId}`
        : closingPosition.status !== "CLOSING_FOR_REBALANCE"
          ? `Rebalance close finalization requires reconciliation because local position status is ${closingPosition.status} for ${input.latestAction.positionId}`
          : closeConfirmedPositionLike === null
            ? `Rebalance close confirmation not found for position ${input.latestAction.positionId}`
            : `Rebalance close confirmation returned unsupported status ${confirmedPosition?.status ?? "unknown"} for ${input.latestAction.positionId}`;

    throw Object.assign(new Error(detail), {
      reconciliationSourcePosition: sourcePosition,
    });
  }

  const closeConfirmedPosition = closeConfirmedPositionLike;
  const availableCapitalUsd =
    input.closeSubmitted.closeResult.estimatedReleasedValueUsd ??
    closeConfirmedPosition.currentValueUsd;
  const closedPosition = buildClosedOldPosition({
    closeConfirmedPosition,
    actionId: input.latestAction.actionId,
    now: input.now,
  });
  const closeAccounting = buildCloseAccountingSummary(closedPosition, null);

  return {
    closingPosition,
    closeConfirmedPosition,
    closedPosition,
    closeAccounting: toJournalRecord(closeAccounting),
    availableCapitalUsd,
  };
}

function buildPostCloseRedeployPayload(input: {
  requestedRedeploy: DeployActionRequestPayload;
  closeSubmitted: RebalanceCloseSubmittedPayload;
  closeConfirmedPosition: Position;
}): DeployActionRequestPayload {
  const closeResult = input.closeSubmitted.closeResult;
  const amountBase = closeResult.releasedAmountBase ?? 0;
  const amountQuote = closeResult.releasedAmountQuote ?? 0;
  const estimatedValueUsd =
    closeResult.estimatedReleasedValueUsd ??
    input.closeConfirmedPosition.currentValueUsd;

  return DeployActionRequestPayloadSchema.parse({
    ...input.requestedRedeploy,
    amountBase,
    amountQuote,
    estimatedValueUsd,
  });
}

export async function finalizeRebalance(
  input: FinalizeRebalanceInput,
): Promise<FinalizeRebalanceResult> {
  const action = await input.actionRepository.get(input.actionId);
  if (action === null) {
    throw new Error(`Rebalance action not found: ${input.actionId}`);
  }

  assertRebalanceAction(action);
  const now = nowTimestamp(input.now);
  const walletLock = input.walletLock ?? new WalletLock();

  if (
    action.status === "DONE" ||
    action.status === "TIMED_OUT" ||
    action.status === "FAILED" ||
    action.status === "ABORTED"
  ) {
    const newPositionId = getNewPositionIdFromPayload(action.resultPayload);
    return {
      action,
      oldPosition: await input.stateRepository.get(action.positionId),
      newPosition:
        newPositionId === null
          ? null
          : await input.stateRepository.get(newPositionId),
      outcome: "UNCHANGED",
    };
  }

  if (action.status !== "WAITING_CONFIRMATION") {
    throw new Error(
      `Rebalance finalization expected WAITING_CONFIRMATION, received ${action.status}`,
    );
  }

  const positionLock = input.positionLock ?? new PositionLock();

  return walletLock.withLock(action.wallet, async () => {
    const oldPositionId = action.positionId;
    return positionLock.withLock(oldPositionId, async () => {
      const latestAction = await input.actionRepository.get(action.actionId);
      if (latestAction === null) {
        throw new Error(
          `Rebalance action disappeared during finalization: ${action.actionId}`,
        );
      }

      assertRebalanceAction(latestAction);

      if (
        latestAction.status === "DONE" ||
        latestAction.status === "TIMED_OUT" ||
        latestAction.status === "FAILED" ||
        latestAction.status === "ABORTED"
      ) {
        const newPositionId = getNewPositionIdFromPayload(
          latestAction.resultPayload,
        );
        return {
          action: latestAction,
          oldPosition: await input.stateRepository.get(latestAction.positionId),
          newPosition:
            newPositionId === null
              ? null
              : await input.stateRepository.get(newPositionId),
          outcome: "UNCHANGED" as const,
        };
      }

      if (latestAction.status !== "WAITING_CONFIRMATION") {
        throw new Error(
          `Rebalance finalization expected WAITING_CONFIRMATION, received ${latestAction.status}`,
        );
      }

      const requestPayload = RebalanceActionRequestPayloadSchema.parse(
        latestAction.requestPayload,
      );
      const latestPayload = RebalanceActionResultPayloadSchema.parse(
        latestAction.resultPayload,
      );

      if (latestPayload.phase === "CLOSE_SUBMITTED") {
        let closeLeg;

        try {
          closeLeg = await finalizeCloseLeg({
            latestAction,
            closeSubmitted: latestPayload,
            stateRepository: input.stateRepository,
            dlmmGateway: input.dlmmGateway,
            now,
          });
        } catch (error) {
          const sourcePosition =
            error instanceof Error &&
            "reconciliationSourcePosition" in error &&
            error.reconciliationSourcePosition !== undefined
              ? (error.reconciliationSourcePosition as Position)
              : await input.stateRepository.get(latestAction.positionId);

          if (sourcePosition === null) {
            throw error;
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
            error: errorMessage(
              error,
              "Rebalance close finalization requires reconciliation",
            ),
            completedAt: now,
          } satisfies Action;
          await input.actionRepository.upsert(timedOutAction);

          await appendJournalEvent(input.journalRepository, {
            timestamp: now,
            eventType: "REBALANCE_CLOSE_TIMED_OUT",
            actor: latestAction.requestedBy,
            wallet: latestAction.wallet,
            positionId: latestAction.positionId,
            actionId: latestAction.actionId,
            before: toJournalRecord({
              action: latestAction,
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
            oldPosition: reconciliationPosition,
            newPosition: null,
            outcome: "TIMED_OUT" as const,
          };
        }

        await input.stateRepository.upsert(closeLeg.closedPosition);
        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "REBALANCE_CLOSE_FINALIZED",
          actor: latestAction.requestedBy,
          wallet: latestAction.wallet,
          positionId: latestAction.positionId,
          actionId: latestAction.actionId,
          before: toJournalRecord({
            action: latestAction,
            position: closeLeg.closingPosition,
          }),
          after: toJournalRecord({
            position: closeLeg.closedPosition,
            accounting: closeLeg.closeAccounting,
          }),
          txIds: latestPayload.closeResult.txIds,
          resultStatus: closeLeg.closedPosition.status,
          error: null,
        });

        const settlementValidationError = validatePostCloseRedeploySettlement(
          latestPayload.closeResult,
        );
        let postCloseRedeployPayload: DeployActionRequestPayload | null = null;
        let validationError = settlementValidationError;
        if (validationError === null) {
          postCloseRedeployPayload = buildPostCloseRedeployPayload({
            requestedRedeploy: requestPayload.redeploy,
            closeSubmitted: latestPayload,
            closeConfirmedPosition: closeLeg.closeConfirmedPosition,
          });
          validationError = validateRedeployTarget({
            availableCapitalUsd: closeLeg.availableCapitalUsd,
            requestedCapitalUsd: deriveRebalanceCapitalRequirement(
              postCloseRedeployPayload,
            ),
            amountBase: postCloseRedeployPayload.amountBase,
            amountQuote: postCloseRedeployPayload.amountQuote,
          });
        }

        if (validationError !== null) {
          const abortedPayload = buildAbortedPayload({
            closeSubmitted: latestPayload,
            closeAccounting: closeLeg.closeAccounting,
            closedPositionId: closeLeg.closedPosition.positionId,
            availableCapitalUsd: closeLeg.availableCapitalUsd,
            failureReason: validationError,
          });
          const failedAction = {
            ...latestAction,
            status: transitionActionStatus(latestAction.status, "FAILED"),
            resultPayload: toJournalRecord(abortedPayload),
            txIds: latestAction.txIds,
            error: validationError,
            completedAt: now,
          } satisfies Action;
          await input.actionRepository.upsert(failedAction);

          await appendJournalEvent(input.journalRepository, {
            timestamp: now,
            eventType: "REBALANCE_ABORTED",
            actor: latestAction.requestedBy,
            wallet: latestAction.wallet,
            positionId: latestAction.positionId,
            actionId: latestAction.actionId,
            before: toJournalRecord({
              action: latestAction,
            }),
            after: toJournalRecord({
              action: failedAction,
              oldPosition: closeLeg.closedPosition,
            }),
            txIds: latestAction.txIds,
            resultStatus: failedAction.status,
            error: validationError,
          });

          return {
            action: failedAction,
            oldPosition: closeLeg.closedPosition,
            newPosition: null,
            outcome: "REBALANCE_ABORTED" as const,
          };
        }

        if (postCloseRedeployPayload === null) {
          throw new Error("post-close redeploy payload unexpectedly missing");
        }

        if (
          input.runtimeControlStore !== undefined &&
          (await input.runtimeControlStore.snapshot()).stopAllDeploys.active
        ) {
          const failureReason =
            "manual circuit breaker is active; rebalance redeploy is blocked";
          const abortedPayload = buildAbortedPayload({
            closeSubmitted: latestPayload,
            closeAccounting: closeLeg.closeAccounting,
            closedPositionId: closeLeg.closedPosition.positionId,
            availableCapitalUsd: closeLeg.availableCapitalUsd,
            failureReason,
          });
          const failedAction = {
            ...latestAction,
            status: transitionActionStatus(latestAction.status, "FAILED"),
            resultPayload: toJournalRecord(abortedPayload),
            txIds: latestAction.txIds,
            error: failureReason,
            completedAt: now,
          } satisfies Action;
          await input.actionRepository.upsert(failedAction);

          await appendJournalEvent(input.journalRepository, {
            timestamp: now,
            eventType: "REBALANCE_ABORTED",
            actor: latestAction.requestedBy,
            wallet: latestAction.wallet,
            positionId: latestAction.positionId,
            actionId: latestAction.actionId,
            before: toJournalRecord({
              action: latestAction,
            }),
            after: toJournalRecord({
              action: failedAction,
              oldPosition: closeLeg.closedPosition,
            }),
            txIds: latestAction.txIds,
            resultStatus: failedAction.status,
            error: failureReason,
          });

          return {
            action: failedAction,
            oldPosition: closeLeg.closedPosition,
            newPosition: null,
            outcome: "REBALANCE_ABORTED" as const,
          };
        }

        let redeployResult: z.infer<typeof DeployActionResultPayloadSchema>;

        try {
          redeployResult = DeployActionResultPayloadSchema.parse(
            await input.dlmmGateway.deployLiquidity({
              wallet: latestAction.wallet,
              poolAddress: postCloseRedeployPayload.poolAddress,
              tokenXMint: postCloseRedeployPayload.tokenXMint,
              tokenYMint: postCloseRedeployPayload.tokenYMint,
              baseMint: postCloseRedeployPayload.baseMint,
              quoteMint: postCloseRedeployPayload.quoteMint,
              amountBase: postCloseRedeployPayload.amountBase,
              amountQuote: postCloseRedeployPayload.amountQuote,
              ...(postCloseRedeployPayload.slippageBps === undefined
                ? {}
                : { slippageBps: postCloseRedeployPayload.slippageBps }),
              strategy: postCloseRedeployPayload.strategy,
              rangeLowerBin: postCloseRedeployPayload.rangeLowerBin,
              rangeUpperBin: postCloseRedeployPayload.rangeUpperBin,
              initialActiveBin: postCloseRedeployPayload.initialActiveBin,
            }),
          );
        } catch (error) {
          const failureReason = `Rebalance redeploy failed after old leg closed: ${errorMessage(
            error,
            "unknown redeploy submission error",
          )}`;
          const abortedPayload = buildAbortedPayload({
            closeSubmitted: latestPayload,
            closeAccounting: closeLeg.closeAccounting,
            closedPositionId: closeLeg.closedPosition.positionId,
            availableCapitalUsd: closeLeg.availableCapitalUsd,
            failureReason,
          });
          const failedAction = {
            ...latestAction,
            status: transitionActionStatus(latestAction.status, "FAILED"),
            resultPayload: toJournalRecord(abortedPayload),
            txIds: latestAction.txIds,
            error: failureReason,
            completedAt: now,
          } satisfies Action;
          await input.actionRepository.upsert(failedAction);

          await appendJournalEvent(input.journalRepository, {
            timestamp: now,
            eventType: "REBALANCE_ABORTED",
            actor: latestAction.requestedBy,
            wallet: latestAction.wallet,
            positionId: latestAction.positionId,
            actionId: latestAction.actionId,
            before: toJournalRecord({
              action: latestAction,
            }),
            after: toJournalRecord({
              action: failedAction,
              oldPosition: closeLeg.closedPosition,
            }),
            txIds: latestAction.txIds,
            resultStatus: failedAction.status,
            error: failureReason,
          });

          return {
            action: failedAction,
            oldPosition: closeLeg.closedPosition,
            newPosition: null,
            outcome: "REBALANCE_ABORTED" as const,
          };
        }

        const pendingRedeployPosition = buildPendingRedeployPosition({
          action: latestAction,
          closedPosition: closeLeg.closedPosition,
          redeployPayload: postCloseRedeployPayload,
          redeployResult,
          now,
        });

        try {
          await input.stateRepository.upsert(pendingRedeployPosition);
        } catch (error) {
          const reconciliationPosition = buildReconciliationRequiredPosition(
            pendingRedeployPosition,
            latestAction.actionId,
            now,
          );

          try {
            await input.stateRepository.upsert(reconciliationPosition);
          } catch {
            // Best effort only; the action payload retains the new positionId.
          }

          const timedOutAction = {
            ...latestAction,
            status: transitionActionStatus(latestAction.status, "TIMED_OUT"),
            txIds: [...latestAction.txIds, ...redeployResult.txIds],
            error: `Rebalance redeploy submitted but local persistence requires reconciliation: ${errorMessage(
              error,
              "unknown local persistence error",
            )}`,
            completedAt: now,
          } satisfies Action;
          await input.actionRepository.upsert(timedOutAction);

          await appendJournalEvent(input.journalRepository, {
            timestamp: now,
            eventType: "REBALANCE_REDEPLOY_REQUIRES_RECONCILIATION",
            actor: latestAction.requestedBy,
            wallet: latestAction.wallet,
            positionId: pendingRedeployPosition.positionId,
            actionId: latestAction.actionId,
            before: toJournalRecord({
              action: latestAction,
              oldPosition: closeLeg.closedPosition,
            }),
            after: toJournalRecord({
              action: timedOutAction,
              oldPosition: closeLeg.closedPosition,
              newPosition: reconciliationPosition,
            }),
            txIds: timedOutAction.txIds,
            resultStatus: timedOutAction.status,
            error: timedOutAction.error,
          });

          return {
            action: timedOutAction,
            oldPosition: closeLeg.closedPosition,
            newPosition: reconciliationPosition,
            outcome: "TIMED_OUT" as const,
          };
        }

        const redeploySubmittedPayload = buildRedeploySubmittedPayload({
          closeSubmitted: latestPayload,
          closeAccounting: closeLeg.closeAccounting,
          closedPositionId: closeLeg.closedPosition.positionId,
          availableCapitalUsd: closeLeg.availableCapitalUsd,
          redeployRequest: postCloseRedeployPayload,
          redeployResult,
        });
        const waitingAction = {
          ...latestAction,
          resultPayload: toJournalRecord(redeploySubmittedPayload),
          txIds: [...latestAction.txIds, ...redeployResult.txIds],
          error: null,
        } satisfies Action;
        await input.actionRepository.upsert(waitingAction);

        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "REBALANCE_REDEPLOY_SUBMITTED",
          actor: latestAction.requestedBy,
          wallet: latestAction.wallet,
          positionId: pendingRedeployPosition.positionId,
          actionId: latestAction.actionId,
          before: toJournalRecord({
            action: latestAction,
            oldPosition: closeLeg.closedPosition,
          }),
          after: toJournalRecord({
            action: waitingAction,
            oldPosition: closeLeg.closedPosition,
            newPosition: pendingRedeployPosition,
          }),
          txIds: waitingAction.txIds,
          resultStatus: waitingAction.status,
          error: null,
        });

        return {
          action: waitingAction,
          oldPosition: closeLeg.closedPosition,
          newPosition: pendingRedeployPosition,
          outcome: "REDEPLOY_SUBMITTED" as const,
        };
      }

      if (latestPayload.phase === "REDEPLOY_SUBMITTED") {
        const newPositionId = latestPayload.redeployResult.positionId;

        return positionLock.withLock(newPositionId, async () => {
          const latestActionAfterRedeployLock =
            await input.actionRepository.get(latestAction.actionId);
          if (latestActionAfterRedeployLock === null) {
            throw new Error(
              `Rebalance action disappeared during redeploy confirmation: ${latestAction.actionId}`,
            );
          }

          assertRebalanceAction(latestActionAfterRedeployLock);

          if (
            latestActionAfterRedeployLock.status === "DONE" ||
            latestActionAfterRedeployLock.status === "TIMED_OUT" ||
            latestActionAfterRedeployLock.status === "FAILED" ||
            latestActionAfterRedeployLock.status === "ABORTED"
          ) {
            return {
              action: latestActionAfterRedeployLock,
              oldPosition: await input.stateRepository.get(
                latestActionAfterRedeployLock.positionId,
              ),
              newPosition: await input.stateRepository.get(newPositionId),
              outcome: "UNCHANGED" as const,
            };
          }

          const pendingPosition =
            await input.stateRepository.get(newPositionId);
          const confirmedPosition =
            await input.dlmmGateway.getPosition(newPositionId);
          const oldPosition = await input.stateRepository.get(
            latestActionAfterRedeployLock.positionId,
          );

          if (
            pendingPosition !== null &&
            pendingPosition.status === "OPEN" &&
            confirmedPosition !== null &&
            confirmedPosition.status === "OPEN"
          ) {
            const openPosition = buildOpenRedeployedPosition({
              pendingPosition,
              confirmedPosition,
              actionId: latestActionAfterRedeployLock.actionId,
              now,
            });
            await input.stateRepository.upsert(openPosition);

            const reconcilingAction = {
              ...latestActionAfterRedeployLock,
              status: transitionActionStatus(
                latestActionAfterRedeployLock.status,
                "RECONCILING",
              ),
            } satisfies Action;
            await input.actionRepository.upsert(reconcilingAction);

            const completedPayload = buildCompletedPayload({
              redeploySubmitted: latestPayload,
              confirmedPositionId: openPosition.positionId,
            });
            const doneAction = {
              ...reconcilingAction,
              status: transitionActionStatus(reconcilingAction.status, "DONE"),
              resultPayload: toJournalRecord(completedPayload),
              completedAt: now,
              error: null,
            } satisfies Action;
            await input.actionRepository.upsert(doneAction);

            await appendJournalEvent(input.journalRepository, {
              timestamp: now,
              eventType: "REBALANCE_FINALIZED",
              actor: latestActionAfterRedeployLock.requestedBy,
              wallet: latestActionAfterRedeployLock.wallet,
              positionId: openPosition.positionId,
              actionId: latestActionAfterRedeployLock.actionId,
              before: toJournalRecord({
                action: latestActionAfterRedeployLock,
                oldPosition,
                newPosition: pendingPosition,
              }),
              after: toJournalRecord({
                action: doneAction,
                oldPosition,
                newPosition: openPosition,
              }),
              txIds: doneAction.txIds,
              resultStatus: doneAction.status,
              error: null,
            });

            return {
              action: doneAction,
              oldPosition,
              newPosition: openPosition,
              outcome: "FINALIZED" as const,
            };
          }

          if (
            pendingPosition === null ||
            pendingPosition.status !== "REDEPLOYING" ||
            confirmedPosition === null ||
            confirmedPosition.status !== "OPEN"
          ) {
            const sourcePosition = pendingPosition ?? confirmedPosition;

            if (sourcePosition === null) {
              throw new Error(
                `Rebalance redeploy confirmation cannot build reconciliation state for ${newPositionId}`,
              );
            }

            const reconciliationPosition = buildReconciliationRequiredPosition(
              sourcePosition,
              latestActionAfterRedeployLock.actionId,
              now,
            );
            await input.stateRepository.upsert(reconciliationPosition);

            const timedOutAction = {
              ...latestActionAfterRedeployLock,
              status: transitionActionStatus(
                latestActionAfterRedeployLock.status,
                "TIMED_OUT",
              ),
              error:
                pendingPosition === null
                  ? `Rebalance redeploy confirmation requires reconciliation because local pending position is missing for ${newPositionId}`
                  : pendingPosition.status !== "REDEPLOYING"
                    ? `Rebalance redeploy confirmation requires reconciliation because local position status is ${pendingPosition.status} for ${newPositionId}`
                    : confirmedPosition === null
                      ? `Rebalance redeploy confirmation not found for position ${newPositionId}`
                      : `Rebalance redeploy confirmation returned non-open status ${confirmedPosition.status} for ${newPositionId}`,
              completedAt: now,
            } satisfies Action;
            await input.actionRepository.upsert(timedOutAction);

            await appendJournalEvent(input.journalRepository, {
              timestamp: now,
              eventType: "REBALANCE_REDEPLOY_TIMED_OUT",
              actor: latestActionAfterRedeployLock.requestedBy,
              wallet: latestActionAfterRedeployLock.wallet,
              positionId: newPositionId,
              actionId: latestActionAfterRedeployLock.actionId,
              before: toJournalRecord({
                action: latestActionAfterRedeployLock,
                oldPosition,
                newPosition: pendingPosition,
              }),
              after: toJournalRecord({
                action: timedOutAction,
                oldPosition,
                newPosition: reconciliationPosition,
              }),
              txIds: timedOutAction.txIds,
              resultStatus: timedOutAction.status,
              error: timedOutAction.error,
            });

            return {
              action: timedOutAction,
              oldPosition,
              newPosition: reconciliationPosition,
              outcome: "TIMED_OUT" as const,
            };
          }

          const openPosition = buildOpenRedeployedPosition({
            pendingPosition,
            confirmedPosition,
            actionId: latestActionAfterRedeployLock.actionId,
            now,
          });
          await input.stateRepository.upsert(openPosition);

          const reconcilingAction = {
            ...latestActionAfterRedeployLock,
            status: transitionActionStatus(
              latestActionAfterRedeployLock.status,
              "RECONCILING",
            ),
          } satisfies Action;
          await input.actionRepository.upsert(reconcilingAction);

          const completedPayload = buildCompletedPayload({
            redeploySubmitted: latestPayload,
            confirmedPositionId: openPosition.positionId,
          });
          const doneAction = {
            ...reconcilingAction,
            status: transitionActionStatus(reconcilingAction.status, "DONE"),
            resultPayload: toJournalRecord(completedPayload),
            completedAt: now,
            error: null,
          } satisfies Action;
          await input.actionRepository.upsert(doneAction);

          await appendJournalEvent(input.journalRepository, {
            timestamp: now,
            eventType: "REBALANCE_FINALIZED",
            actor: latestActionAfterRedeployLock.requestedBy,
            wallet: latestActionAfterRedeployLock.wallet,
            positionId: openPosition.positionId,
            actionId: latestActionAfterRedeployLock.actionId,
            before: toJournalRecord({
              action: latestActionAfterRedeployLock,
              oldPosition,
              newPosition: pendingPosition,
            }),
            after: toJournalRecord({
              action: doneAction,
              oldPosition,
              newPosition: openPosition,
            }),
            txIds: doneAction.txIds,
            resultStatus: doneAction.status,
            error: null,
          });

          return {
            action: doneAction,
            oldPosition,
            newPosition: openPosition,
            outcome: "FINALIZED" as const,
          };
        });
      }

      return {
        action: latestAction,
        oldPosition: await input.stateRepository.get(latestAction.positionId),
        newPosition:
          latestPayload.phase === "REBALANCE_COMPLETED"
            ? await input.stateRepository.get(latestPayload.confirmedPositionId)
            : null,
        outcome: "UNCHANGED" as const,
      };
    });
  });
}
