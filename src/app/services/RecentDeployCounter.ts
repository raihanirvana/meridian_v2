import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { Action } from "../../domain/entities/Action.js";

const COUNTED_DEPLOY_STATUSES = new Set<Action["status"]>([
  "QUEUED",
  "RUNNING",
  "WAITING_CONFIRMATION",
  "RECONCILING",
  "DONE",
  "RETRY_QUEUED",
]);

export interface CountRecentNewDeploysInput {
  wallet: string;
  actionRepository: ActionRepository;
  now?: string;
  windowMinutes?: number;
}

export async function countRecentNewDeploys(
  input: CountRecentNewDeploysInput,
): Promise<number> {
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  const windowMinutes = input.windowMinutes ?? 60;
  const windowStartMs = nowMs - windowMinutes * 60_000;
  const actions = await input.actionRepository.list();

  return actions.filter((action) => {
    if (action.wallet !== input.wallet || action.type !== "DEPLOY") {
      return false;
    }

    if (!COUNTED_DEPLOY_STATUSES.has(action.status)) {
      return false;
    }

    const requestedAtMs = Date.parse(action.requestedAt);
    if (Number.isNaN(requestedAtMs) || Number.isNaN(nowMs)) {
      return false;
    }

    return requestedAtMs >= windowStartMs && requestedAtMs <= nowMs;
  }).length;
}
