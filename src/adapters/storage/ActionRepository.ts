import { ActionSchema, type Action } from "../../domain/entities/Action.js";
import { transitionActionStatus } from "../../domain/stateMachines/actionLifecycle.js";

import { FileStore, type FileStoreOptions } from "./FileStore.js";

export interface ActionRepositoryOptions extends FileStoreOptions {
  filePath: string;
}

export interface UpsertByIdempotencyKeyResult {
  action: Action;
  created: boolean;
}

export interface ClaimNextForProcessingResult {
  previousAction: Action;
  claimedAction: Action;
}

export class ActionStoreCorruptError extends Error {
  public constructor(
    message: string,
    public readonly filePath: string,
    public override readonly cause: unknown,
  ) {
    super(message);
    this.name = "ActionStoreCorruptError";
  }
}

function parseActions(raw: string, filePath: string): Action[] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    const reason =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "unknown JSON parse failure";
    throw new ActionStoreCorruptError(
      `action file is corrupt (invalid JSON): ${reason}`,
      filePath,
      error,
    );
  }

  const result = ActionSchema.array().safeParse(parsedJson);
  if (!result.success) {
    throw new ActionStoreCorruptError(
      `action file is corrupt (schema mismatch): ${result.error.message}`,
      filePath,
      result.error,
    );
  }

  return result.data;
}

export class ActionRepository {
  private readonly fileStore: FileStore;
  private readonly filePath: string;

  public constructor(options: ActionRepositoryOptions) {
    this.fileStore = options.fs
      ? new FileStore({ fs: options.fs })
      : new FileStore();
    this.filePath = options.filePath;
  }

  public async list(): Promise<Action[]> {
    const raw = await this.fileStore.readText(this.filePath);
    if (raw === null) {
      return [];
    }

    return parseActions(raw, this.filePath);
  }

  public async get(actionId: string): Promise<Action | null> {
    const actions = await this.list();
    return actions.find((action) => action.actionId === actionId) ?? null;
  }

  public async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<Action | null> {
    const actions = await this.list();
    return (
      actions.find((action) => action.idempotencyKey === idempotencyKey) ?? null
    );
  }

  public async listByStatuses(statuses: Action["status"][]): Promise<Action[]> {
    const actions = await this.list();
    const allowedStatuses = new Set(statuses);

    return actions
      .filter((action) => allowedStatuses.has(action.status))
      .sort((left, right) => {
        const requestedAtOrder = left.requestedAt.localeCompare(
          right.requestedAt,
        );
        if (requestedAtOrder !== 0) {
          return requestedAtOrder;
        }

        return left.actionId.localeCompare(right.actionId);
      });
  }

  public async upsert(action: Action): Promise<void> {
    const validated = ActionSchema.parse(action);
    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const actions = raw === null ? [] : parseActions(raw, this.filePath);
      const nextActions = actions.filter(
        (currentAction) => currentAction.actionId !== validated.actionId,
      );
      nextActions.push(validated);

      const stableOrder = [...ActionSchema.array().parse(nextActions)].sort(
        (left, right) => left.actionId.localeCompare(right.actionId),
      );

      return JSON.stringify(stableOrder, null, 2);
    });
  }

  public async upsertByIdempotencyKey(
    action: Action,
  ): Promise<UpsertByIdempotencyKeyResult> {
    const validated = ActionSchema.parse(action);
    let resolvedAction = validated;
    let created = true;

    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const actions = raw === null ? [] : parseActions(raw, this.filePath);
      const existingAction =
        actions.find(
          (currentAction) =>
            currentAction.idempotencyKey === validated.idempotencyKey,
        ) ?? null;

      if (existingAction !== null) {
        resolvedAction = existingAction;
        created = false;
        return raw ?? JSON.stringify([], null, 2);
      }

      const nextActions = [...actions, validated];
      const stableOrder = [...ActionSchema.array().parse(nextActions)].sort(
        (left, right) => left.actionId.localeCompare(right.actionId),
      );

      return JSON.stringify(stableOrder, null, 2);
    });

    return {
      action: resolvedAction,
      created,
    };
  }

  public async replaceAll(actions: Action[]): Promise<void> {
    const validated = ActionSchema.array().parse(actions);
    const stableOrder = [...validated].sort((left, right) =>
      left.actionId.localeCompare(right.actionId),
    );

    await this.fileStore.writeTextAtomic(
      this.filePath,
      JSON.stringify(stableOrder, null, 2),
    );
  }

  public async claimNextForProcessing(
    statuses: Action["status"][],
    startedAt: string,
  ): Promise<ClaimNextForProcessingResult | null> {
    const allowedStatuses = new Set(statuses);
    let claimResult: ClaimNextForProcessingResult | null = null;

    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const actions = raw === null ? [] : parseActions(raw, this.filePath);
      const sortedActions = [...actions].sort((left, right) => {
        const requestedAtOrder = left.requestedAt.localeCompare(
          right.requestedAt,
        );
        if (requestedAtOrder !== 0) {
          return requestedAtOrder;
        }

        return left.actionId.localeCompare(right.actionId);
      });
      const nextAction =
        sortedActions.find((action) => allowedStatuses.has(action.status)) ??
        null;

      if (nextAction === null) {
        return raw ?? JSON.stringify([], null, 2);
      }

      const claimedAction = ActionSchema.parse({
        ...nextAction,
        status: transitionActionStatus(nextAction.status, "RUNNING"),
        startedAt,
        completedAt: null,
      });
      claimResult = {
        previousAction: nextAction,
        claimedAction,
      };

      const nextActions = actions.map((action) =>
        action.actionId === claimedAction.actionId ? claimedAction : action,
      );
      const stableOrder = [...ActionSchema.array().parse(nextActions)].sort(
        (left, right) => left.actionId.localeCompare(right.actionId),
      );

      return JSON.stringify(stableOrder, null, 2);
    });

    return claimResult;
  }
}
