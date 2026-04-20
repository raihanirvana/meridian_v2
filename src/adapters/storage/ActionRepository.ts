import { ActionSchema, type Action } from "../../domain/entities/Action.js";

import { FileStore, type FileStoreOptions } from "./FileStore.js";

export interface ActionRepositoryOptions extends FileStoreOptions {
  filePath: string;
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

    return ActionSchema.array().parse(JSON.parse(raw));
  }

  public async get(actionId: string): Promise<Action | null> {
    const actions = await this.list();
    return actions.find((action) => action.actionId === actionId) ?? null;
  }

  public async findByIdempotencyKey(idempotencyKey: string): Promise<Action | null> {
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
        const requestedAtOrder = left.requestedAt.localeCompare(right.requestedAt);
        if (requestedAtOrder !== 0) {
          return requestedAtOrder;
        }

        return left.actionId.localeCompare(right.actionId);
      });
  }

  public async upsert(action: Action): Promise<void> {
    const validated = ActionSchema.parse(action);
    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const actions =
        raw === null ? [] : ActionSchema.array().parse(JSON.parse(raw));
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
}
