import { z } from "zod";

import {
  DeployLiquidityResultSchema,
  type DlmmGateway,
} from "../../adapters/dlmm/DlmmGateway.js";
import type { RuntimeControlStore } from "../../adapters/storage/RuntimeControlStore.js";
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
import type { QueueExecutionResult } from "../services/ActionQueue.js";
import { resolveOutOfRangeSince } from "../services/AccountingService.js";

import {
  DeployActionRequestPayloadSchema,
  type DeployActionRequestPayload,
} from "./requestDeploy.js";

const DeployActionResultPayloadSchema = DeployLiquidityResultSchema;

export interface ProcessDeployActionInput {
  action: Action;
  dlmmGateway: DlmmGateway;
  stateRepository: StateRepository;
  journalRepository?: JournalRepository;
  runtimeControlStore?: RuntimeControlStore;
  now?: () => string;
}

export interface ConfirmDeployActionInput {
  actionId: string;
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  dlmmGateway: DlmmGateway;
  journalRepository?: JournalRepository;
  walletLock?: WalletLock;
  positionLock?: PositionLock;
  now?: () => string;
}

export interface ConfirmDeployActionResult {
  action: Action;
  position: Position | null;
  outcome: "CONFIRMED" | "TIMED_OUT" | "UNCHANGED";
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

function assertDeployAction(action: Action): void {
  if (action.type !== "DEPLOY") {
    throw new Error(`Expected DEPLOY action, received ${action.type}`);
  }
}

function buildPendingDeployPosition(input: {
  action: Action;
  payload: DeployActionRequestPayload;
  positionId: string;
  now: string;
}): Position {
  const deployingStatus = transitionPositionStatus("DEPLOY_REQUESTED", "DEPLOYING");

  return PositionSchema.parse({
    positionId: input.positionId,
    poolAddress: input.payload.poolAddress,
    tokenXMint: input.payload.tokenXMint,
    tokenYMint: input.payload.tokenYMint,
    baseMint: input.payload.baseMint,
    quoteMint: input.payload.quoteMint,
    wallet: input.action.wallet,
    status: deployingStatus,
    openedAt: null,
    lastSyncedAt: input.now,
    closedAt: null,
    deployAmountBase: input.payload.amountBase,
    deployAmountQuote: input.payload.amountQuote,
    currentValueBase: input.payload.amountBase,
    currentValueUsd: input.payload.estimatedValueUsd,
    feesClaimedBase: 0,
    feesClaimedUsd: 0,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    rebalanceCount: 0,
    partialCloseCount: 0,
    strategy: input.payload.strategy,
    rangeLowerBin: input.payload.rangeLowerBin,
    rangeUpperBin: input.payload.rangeUpperBin,
    activeBin: input.payload.initialActiveBin,
    outOfRangeSince: null,
    lastManagementDecision: null,
    lastManagementReason: null,
    lastWriteActionId: input.action.actionId,
    needsReconciliation: false,
    ...(input.payload.entryMetadata === undefined
      ? {}
      : { entryMetadata: input.payload.entryMetadata }),
  });
}

function buildOpenPosition(input: {
  confirmedPosition: Position;
  pendingPosition: Position;
  actionId: string;
  now: string;
}): Position {
  const rangeLowerBin =
    input.confirmedPosition.rangeLowerBin ?? input.pendingPosition.rangeLowerBin;
  const rangeUpperBin =
    input.confirmedPosition.rangeUpperBin ?? input.pendingPosition.rangeUpperBin;
  const activeBin = input.confirmedPosition.activeBin ?? input.pendingPosition.activeBin;

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

function buildReconciliationRequiredPositionFromExisting(
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

function buildReconciliationRequiredPositionFromDeployData(input: {
  action: Action;
  payload: DeployActionRequestPayload;
  positionId: string;
  now: string;
  sourcePosition?: Position | null;
}): Position {
  const basePosition =
    input.sourcePosition ??
    buildPendingDeployPosition({
      action: input.action,
      payload: input.payload,
      positionId: input.positionId,
      now: input.now,
    });

  return buildReconciliationRequiredPositionFromExisting(
    basePosition,
    input.action.actionId,
    input.now,
  );
}

export async function processDeployAction(
  input: ProcessDeployActionInput,
): Promise<QueueExecutionResult> {
  assertDeployAction(input.action);

  const payload = DeployActionRequestPayloadSchema.parse(input.action.requestPayload);
  const now = nowTimestamp(input.now);
  let deployResult: z.infer<typeof DeployActionResultPayloadSchema> | null = null;

  if (
    input.runtimeControlStore !== undefined &&
    (await input.runtimeControlStore.snapshot()).stopAllDeploys.active
  ) {
    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "DEPLOY_BLOCKED_MANUAL_CIRCUIT_BREAKER",
      actor: input.action.requestedBy,
      wallet: input.action.wallet,
      positionId: null,
      actionId: input.action.actionId,
      before: toJournalRecord({
        actionId: input.action.actionId,
        requestPayload: payload,
      }),
      after: null,
      txIds: [],
      resultStatus: "ABORTED",
      error: "manual circuit breaker is active",
    });
    return {
      nextStatus: "ABORTED",
      resultPayload: null,
      txIds: [],
      error: "manual circuit breaker is active",
    };
  }

  try {
    deployResult = DeployActionResultPayloadSchema.parse(
      await input.dlmmGateway.deployLiquidity({
        wallet: input.action.wallet,
        poolAddress: payload.poolAddress,
        amountBase: payload.amountBase,
        amountQuote: payload.amountQuote,
        strategy: payload.strategy,
      }),
    );
  } catch (error) {
    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "DEPLOY_SUBMISSION_FAILED",
      actor: input.action.requestedBy,
      wallet: input.action.wallet,
      positionId: null,
      actionId: input.action.actionId,
      before: toJournalRecord({
        actionId: input.action.actionId,
        requestPayload: payload,
      }),
      after: null,
      txIds: [],
      resultStatus: "FAILED",
      error: errorMessage(error, "deploy submission failed"),
    });
    throw error;
  }

  try {
    const pendingPosition = buildPendingDeployPosition({
      action: input.action,
      payload,
      positionId: deployResult.positionId,
      now,
    });

    await input.stateRepository.upsert(pendingPosition);
    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "DEPLOY_SUBMITTED",
      actor: input.action.requestedBy,
      wallet: input.action.wallet,
      positionId: pendingPosition.positionId,
      actionId: input.action.actionId,
      before: null,
      after: toJournalRecord({
        actionId: input.action.actionId,
        position: pendingPosition,
        deployResult,
      }),
      txIds: deployResult.txIds,
      resultStatus: "WAITING_CONFIRMATION",
      error: null,
    });

    return {
      nextStatus: "WAITING_CONFIRMATION",
      txIds: deployResult.txIds,
      resultPayload: toJournalRecord(deployResult),
      error: null,
    };
  } catch (error) {
    const reconciliationPosition = buildReconciliationRequiredPositionFromDeployData({
      action: input.action,
      payload,
      positionId: deployResult.positionId,
      now,
    });

    try {
      await input.stateRepository.upsert(reconciliationPosition);
    } catch {
      // Best effort only; the action result still carries the positionId so a
      // later reconciliation/confirmation pass can recover the on-chain deploy.
    }

    await appendJournalEvent(input.journalRepository, {
      timestamp: now,
      eventType: "DEPLOY_SUBMITTED_REQUIRES_RECONCILIATION",
      actor: input.action.requestedBy,
      wallet: input.action.wallet,
      positionId: deployResult.positionId,
      actionId: input.action.actionId,
      before: toJournalRecord({
        actionId: input.action.actionId,
        requestPayload: payload,
      }),
      after: toJournalRecord({
        position: reconciliationPosition,
        deployResult,
      }),
      txIds: deployResult.txIds,
      resultStatus: "WAITING_CONFIRMATION",
      error: errorMessage(error, "deploy submission requires reconciliation"),
    });

    return {
      nextStatus: "WAITING_CONFIRMATION",
      txIds: deployResult.txIds,
      resultPayload: toJournalRecord(deployResult),
      error: `Deploy submitted but local persistence requires reconciliation: ${errorMessage(
        error,
        "unknown local persistence error",
      )}`,
    };
  }
}

export async function confirmDeployAction(
  input: ConfirmDeployActionInput,
): Promise<ConfirmDeployActionResult> {
  const action = await input.actionRepository.get(input.actionId);
  if (action === null) {
    throw new Error(`Deploy action not found: ${input.actionId}`);
  }

  assertDeployAction(action);
  const now = nowTimestamp(input.now);
  const walletLock = input.walletLock ?? new WalletLock();

  if (
    action.status === "DONE" ||
    action.status === "TIMED_OUT" ||
    action.status === "FAILED" ||
    action.status === "ABORTED"
  ) {
    const resultPayload = DeployActionResultPayloadSchema.safeParse(action.resultPayload);
    const existingPosition =
      resultPayload.success
        ? await input.stateRepository.get(resultPayload.data.positionId)
        : null;

    return {
      action,
      position: existingPosition,
      outcome: "UNCHANGED",
    };
  }

  if (action.status !== "WAITING_CONFIRMATION") {
    throw new Error(
      `Deploy confirmation expected WAITING_CONFIRMATION, received ${action.status}`,
    );
  }

  const deployResult = DeployActionResultPayloadSchema.parse(action.resultPayload);
  const positionLock = input.positionLock ?? new PositionLock();

  return walletLock.withLock(action.wallet, () =>
    positionLock.withLock(deployResult.positionId, async () => {
      const latestAction = await input.actionRepository.get(action.actionId);
      if (latestAction === null) {
        throw new Error(`Deploy action disappeared during confirmation: ${action.actionId}`);
      }

      assertDeployAction(latestAction);

      if (
        latestAction.status === "DONE" ||
        latestAction.status === "TIMED_OUT" ||
        latestAction.status === "FAILED" ||
        latestAction.status === "ABORTED"
      ) {
        return {
          action: latestAction,
          position: await input.stateRepository.get(deployResult.positionId),
          outcome: "UNCHANGED" as const,
        };
      }

      if (latestAction.status !== "WAITING_CONFIRMATION") {
        throw new Error(
          `Deploy confirmation expected WAITING_CONFIRMATION, received ${latestAction.status}`,
        );
      }

      const payload = DeployActionRequestPayloadSchema.parse(latestAction.requestPayload);
      const pendingPosition = await input.stateRepository.get(deployResult.positionId);
      const confirmedPosition = await input.dlmmGateway.getPosition(
        deployResult.positionId,
      );

      if (
        pendingPosition !== null &&
        pendingPosition.status === "OPEN" &&
        confirmedPosition !== null &&
        confirmedPosition.status === "OPEN"
      ) {
        const openPosition = buildOpenPosition({
          confirmedPosition,
          pendingPosition,
          actionId: latestAction.actionId,
          now,
        });
        await input.stateRepository.upsert(openPosition);

        const reconcilingAction = {
          ...latestAction,
          status: transitionActionStatus(latestAction.status, "RECONCILING"),
        } satisfies Action;
        await input.actionRepository.upsert(reconcilingAction);

        const doneAction = {
          ...reconcilingAction,
          status: transitionActionStatus(reconcilingAction.status, "DONE"),
          resultPayload: toJournalRecord({
            ...deployResult,
            confirmedPositionId: openPosition.positionId,
          }),
          completedAt: now,
          error: null,
        } satisfies Action;
        await input.actionRepository.upsert(doneAction);

        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "DEPLOY_CONFIRMED",
          actor: latestAction.requestedBy,
          wallet: latestAction.wallet,
          positionId: openPosition.positionId,
          actionId: latestAction.actionId,
          before: toJournalRecord({
            action: latestAction,
            position: pendingPosition,
          }),
          after: toJournalRecord({
            action: doneAction,
            position: openPosition,
          }),
          txIds: doneAction.txIds,
          resultStatus: doneAction.status,
          error: null,
        });

        return {
          action: doneAction,
          position: openPosition,
          outcome: "CONFIRMED",
        };
      }

      if (
        pendingPosition === null ||
        pendingPosition.status !== "DEPLOYING" ||
        confirmedPosition === null ||
        confirmedPosition.status !== "OPEN"
      ) {
        const nextPosition = buildReconciliationRequiredPositionFromDeployData({
          action: latestAction,
          payload,
          positionId: deployResult.positionId,
          now,
          sourcePosition: pendingPosition ?? confirmedPosition,
        });
        await input.stateRepository.upsert(nextPosition);

        const timedOutAction = {
          ...latestAction,
          status: transitionActionStatus(latestAction.status, "TIMED_OUT"),
          error:
            pendingPosition === null
              ? `Deploy confirmation requires reconciliation because local pending position is missing for ${deployResult.positionId}`
              : pendingPosition.status !== "DEPLOYING"
                ? `Deploy confirmation requires reconciliation because local position status is ${pendingPosition.status} for ${deployResult.positionId}`
              : confirmedPosition === null
                ? `Deploy confirmation not found for position ${deployResult.positionId}`
                : `Deploy confirmation returned non-open status ${confirmedPosition.status} for ${deployResult.positionId}`,
          completedAt: now,
        } satisfies Action;

        await input.actionRepository.upsert(timedOutAction);

        await appendJournalEvent(input.journalRepository, {
          timestamp: now,
          eventType: "DEPLOY_TIMED_OUT",
          actor: latestAction.requestedBy,
          wallet: latestAction.wallet,
          positionId: deployResult.positionId,
          actionId: latestAction.actionId,
          before: toJournalRecord({
            action: latestAction,
            position: pendingPosition,
          }),
          after: toJournalRecord({
            action: timedOutAction,
            position: nextPosition,
          }),
          txIds: latestAction.txIds,
          resultStatus: timedOutAction.status,
          error: timedOutAction.error,
        });

        return {
          action: timedOutAction,
          position: nextPosition,
          outcome: "TIMED_OUT",
        };
      }

      const openPosition = buildOpenPosition({
        confirmedPosition,
        pendingPosition,
        actionId: latestAction.actionId,
        now,
      });
      await input.stateRepository.upsert(openPosition);

      const reconcilingAction = {
        ...latestAction,
        status: transitionActionStatus(latestAction.status, "RECONCILING"),
      } satisfies Action;
      await input.actionRepository.upsert(reconcilingAction);

      const doneAction = {
        ...reconcilingAction,
        status: transitionActionStatus(reconcilingAction.status, "DONE"),
        resultPayload: toJournalRecord({
          ...deployResult,
          confirmedPositionId: openPosition.positionId,
        }),
        completedAt: now,
        error: null,
      } satisfies Action;
      await input.actionRepository.upsert(doneAction);

      await appendJournalEvent(input.journalRepository, {
        timestamp: now,
        eventType: "DEPLOY_CONFIRMED",
        actor: latestAction.requestedBy,
        wallet: latestAction.wallet,
        positionId: openPosition.positionId,
        actionId: latestAction.actionId,
        before: toJournalRecord({
          action: latestAction,
          position: pendingPosition,
        }),
        after: toJournalRecord({
          action: doneAction,
          position: openPosition,
        }),
        txIds: doneAction.txIds,
        resultStatus: doneAction.status,
        error: null,
      });

      return {
        action: doneAction,
        position: openPosition,
        outcome: "CONFIRMED",
      };
    }),
  );
}
