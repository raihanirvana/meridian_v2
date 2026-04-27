import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { Action } from "../../domain/entities/Action.js";
import type { JournalEvent } from "../../domain/entities/JournalEvent.js";
import { transitionActionStatus } from "../../domain/stateMachines/actionLifecycle.js";
import { type ActionStatus } from "../../domain/types/enums.js";
import { PositionLock } from "../../infra/locks/positionLock.js";
import { WalletLock } from "../../infra/locks/walletLock.js";

import {
  createQueuedAction,
  type CreateQueuedActionInput,
} from "./ActionService.js";

export interface ActionQueueOptions {
  actionRepository: ActionRepository;
  journalRepository?: JournalRepository;
  walletLock?: WalletLock;
  positionLock?: PositionLock;
  now?: () => string;
}

export interface QueueExecutionResult {
  nextStatus: Extract<
    ActionStatus,
    "WAITING_CONFIRMATION" | "FAILED" | "ABORTED"
  >;
  resultPayload?: Record<string, unknown> | null;
  txIds?: string[];
  error?: string | null;
}

export type QueueActionHandler = (
  action: Action,
) => Promise<QueueExecutionResult>;

const PROCESSABLE_STATUSES = ["QUEUED", "RETRY_QUEUED"] as const;
const TERMINAL_STATUSES = new Set<ActionStatus>([
  "DONE",
  "FAILED",
  "ABORTED",
  "TIMED_OUT",
]);

function toSafeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim().length > 0
      ? error.message
      : "unknown handler error";
  }

  const value = String(error).trim();
  return value.length > 0 ? value : "unknown handler error";
}

export class ActionQueue {
  private readonly actionRepository: ActionRepository;
  private readonly journalRepository: JournalRepository | null;
  private readonly walletLock: WalletLock;
  private readonly positionLock: PositionLock;
  private readonly now: () => string;
  private readonly claimedActionIds = new Set<string>();
  private paused = false;

  public constructor(options: ActionQueueOptions) {
    this.actionRepository = options.actionRepository;
    this.journalRepository = options.journalRepository ?? null;
    this.walletLock = options.walletLock ?? new WalletLock();
    this.positionLock = options.positionLock ?? new PositionLock();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public pause(): void {
    this.paused = true;
  }

  public resume(): void {
    this.paused = false;
  }

  public async enqueue(input: CreateQueuedActionInput): Promise<Action> {
    const action = createQueuedAction(input);
    const enqueueResult =
      await this.actionRepository.upsertByIdempotencyKey(action);

    if (!enqueueResult.created) {
      return enqueueResult.action;
    }

    await this.appendJournalEvent({
      timestamp: this.now(),
      eventType: "ACTION_ENQUEUED",
      actor: enqueueResult.action.requestedBy,
      wallet: enqueueResult.action.wallet,
      positionId: enqueueResult.action.positionId,
      actionId: enqueueResult.action.actionId,
      before: null,
      after: enqueueResult.action as unknown as Record<string, unknown>,
      txIds: [],
      resultStatus: enqueueResult.action.status,
      error: null,
    });
    return enqueueResult.action;
  }

  public async processNext(
    handler: QueueActionHandler,
  ): Promise<Action | null> {
    if (this.paused) {
      return null;
    }

    const runningAction = await this.claimNextAction();
    if (runningAction === null) {
      return null;
    }

    try {
      return await this.walletLock.withLock(runningAction.wallet, async () => {
        const runAction = async (): Promise<Action> => {
          try {
            const executionResult = await handler(runningAction);
            return this.finalizeAction(runningAction, executionResult);
          } catch (error) {
            return this.failAction(runningAction, error);
          }
        };

        if (runningAction.positionId !== null) {
          return this.positionLock.withLock(
            runningAction.positionId,
            runAction,
          );
        }

        return runAction();
      });
    } catch (error) {
      await this.requeueRunningAction(runningAction, error);
      throw error;
    } finally {
      this.claimedActionIds.delete(runningAction.actionId);
    }
  }

  public async processAll(handler: QueueActionHandler): Promise<Action[]> {
    const processed: Action[] = [];

    while (!this.paused) {
      const next = await this.processNext(handler);
      if (next === null) {
        break;
      }

      processed.push(next);
    }

    return processed;
  }

  private async claimNextAction(): Promise<Action | null> {
    const queuedActions = await this.actionRepository.listByStatuses([
      ...PROCESSABLE_STATUSES,
    ]);
    const nextAction = queuedActions.find(
      (action) => !this.claimedActionIds.has(action.actionId),
    );

    if (!nextAction) {
      return null;
    }

    this.claimedActionIds.add(nextAction.actionId);
    try {
      return await this.markRunning(nextAction);
    } catch (error) {
      this.claimedActionIds.delete(nextAction.actionId);
      throw error;
    }
  }

  private async markRunning(action: Action): Promise<Action> {
    const runningStatus = transitionActionStatus(action.status, "RUNNING");
    const runningAction: Action = {
      ...action,
      status: runningStatus,
      startedAt: this.now(),
    };

    await this.actionRepository.upsert(runningAction);
    await this.appendJournalEvent({
      timestamp: this.now(),
      eventType: "ACTION_RUNNING",
      actor: runningAction.requestedBy,
      wallet: runningAction.wallet,
      positionId: runningAction.positionId,
      actionId: runningAction.actionId,
      before: action as unknown as Record<string, unknown>,
      after: runningAction as unknown as Record<string, unknown>,
      txIds: [],
      resultStatus: runningAction.status,
      error: null,
    });
    return runningAction;
  }

  private async requeueRunningAction(
    runningAction: Action,
    error: unknown,
  ): Promise<Action> {
    const failedStatus = transitionActionStatus(runningAction.status, "FAILED");
    const retryStatus = transitionActionStatus(failedStatus, "RETRY_QUEUED");
    const retryAction: Action = {
      ...runningAction,
      status: retryStatus,
      error: toSafeErrorMessage(error),
      completedAt: null,
    };

    await this.actionRepository.upsert(retryAction);
    await this.appendJournalEvent({
      timestamp: this.now(),
      eventType: "ACTION_RETRY_QUEUED",
      actor: retryAction.requestedBy,
      wallet: retryAction.wallet,
      positionId: retryAction.positionId,
      actionId: retryAction.actionId,
      before: runningAction as unknown as Record<string, unknown>,
      after: retryAction as unknown as Record<string, unknown>,
      txIds: retryAction.txIds,
      resultStatus: retryAction.status,
      error: retryAction.error,
    });
    return retryAction;
  }

  private async finalizeAction(
    runningAction: Action,
    executionResult: QueueExecutionResult,
  ): Promise<Action> {
    const nextStatus = transitionActionStatus(
      runningAction.status,
      executionResult.nextStatus,
    );

    const finalizedAction: Action = {
      ...runningAction,
      status: nextStatus,
      resultPayload: executionResult.resultPayload ?? null,
      txIds: executionResult.txIds ?? [],
      error: executionResult.error ?? null,
      completedAt: TERMINAL_STATUSES.has(nextStatus) ? this.now() : null,
    };

    await this.actionRepository.upsert(finalizedAction);
    await this.appendJournalEvent({
      timestamp: this.now(),
      eventType: "ACTION_FINALIZED",
      actor: finalizedAction.requestedBy,
      wallet: finalizedAction.wallet,
      positionId: finalizedAction.positionId,
      actionId: finalizedAction.actionId,
      before: runningAction as unknown as Record<string, unknown>,
      after: finalizedAction as unknown as Record<string, unknown>,
      txIds: finalizedAction.txIds,
      resultStatus: finalizedAction.status,
      error: finalizedAction.error,
    });
    return finalizedAction;
  }

  private async failAction(
    runningAction: Action,
    error: unknown,
  ): Promise<Action> {
    const failedStatus = transitionActionStatus(runningAction.status, "FAILED");
    const failedAction: Action = {
      ...runningAction,
      status: failedStatus,
      error: toSafeErrorMessage(error),
      completedAt: this.now(),
    };

    await this.actionRepository.upsert(failedAction);
    await this.appendJournalEvent({
      timestamp: this.now(),
      eventType: "ACTION_FAILED",
      actor: failedAction.requestedBy,
      wallet: failedAction.wallet,
      positionId: failedAction.positionId,
      actionId: failedAction.actionId,
      before: runningAction as unknown as Record<string, unknown>,
      after: failedAction as unknown as Record<string, unknown>,
      txIds: failedAction.txIds,
      resultStatus: failedAction.status,
      error: failedAction.error,
    });
    return failedAction;
  }

  private async appendJournalEvent(event: JournalEvent): Promise<void> {
    if (this.journalRepository === null) {
      return;
    }

    await this.journalRepository.append(event);
  }
}
