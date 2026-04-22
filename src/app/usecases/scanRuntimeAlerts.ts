import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type {
  SchedulerMetadataStore,
} from "../../infra/scheduler/SchedulerMetadataStore.js";

const PENDING_ACTION_STATUSES = new Set<string>([
  "QUEUED",
  "RUNNING",
  "WAITING_CONFIRMATION",
  "RECONCILING",
  "RETRY_QUEUED",
]);

export interface RuntimeAlert {
  kind:
    | "STUCK_ACTION"
    | "PENDING_RECONCILIATION"
    | "STUCK_WORKER";
  severity: "WARN" | "CRITICAL";
  title: string;
  body: string;
}

export interface ScanRuntimeAlertsInput {
  wallet: string;
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  schedulerMetadataStore?: SchedulerMetadataStore;
  now?: string;
  stuckActionThresholdMinutes?: number;
  runningWorkerThresholdMinutes?: number;
}

function ageMinutes(fromIso: string, nowIso: string): number {
  const fromMs = Date.parse(fromIso);
  const nowMs = Date.parse(nowIso);

  if (Number.isNaN(fromMs) || Number.isNaN(nowMs)) {
    return 0;
  }

  return Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
}

export async function scanRuntimeAlerts(
  input: ScanRuntimeAlertsInput,
): Promise<RuntimeAlert[]> {
  const now = input.now ?? new Date().toISOString();
  const stuckActionThresholdMinutes = input.stuckActionThresholdMinutes ?? 30;
  const runningWorkerThresholdMinutes = input.runningWorkerThresholdMinutes ?? 30;
  const actions = (await input.actionRepository.list()).filter(
    (action) => action.wallet === input.wallet,
  );
  const positions = (await input.stateRepository.list()).filter(
    (position) => position.wallet === input.wallet,
  );

  const alerts: RuntimeAlert[] = [];

  const stuckActions = actions
    .filter((action) => PENDING_ACTION_STATUSES.has(action.status))
    .filter((action) => {
      const anchor = action.startedAt ?? action.requestedAt;
      return ageMinutes(anchor, now) >= stuckActionThresholdMinutes;
    })
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));

  if (stuckActions.length > 0) {
    const oldest = stuckActions[0]!;
    alerts.push({
      kind: "STUCK_ACTION",
      severity: "CRITICAL",
      title: "Stuck action detected",
      body:
        `${stuckActions.length} action(s) have been pending for at least ` +
        `${stuckActionThresholdMinutes} minutes. Oldest: ${oldest.actionId} ` +
        `(${oldest.type}/${oldest.status}).`,
    });
  }

  const pendingReconcile = positions.filter(
    (position) =>
      position.status === "RECONCILIATION_REQUIRED" || position.needsReconciliation,
  );
  if (pendingReconcile.length > 0) {
    alerts.push({
      kind: "PENDING_RECONCILIATION",
      severity: "WARN",
      title: "Pending reconciliation detected",
      body:
        `${pendingReconcile.length} position(s) need reconciliation. ` +
        `Example: ${pendingReconcile[0]!.positionId}.`,
    });
  }

  if (input.schedulerMetadataStore !== undefined) {
    const schedulerSnapshot = await input.schedulerMetadataStore.snapshot();
    for (const workerState of Object.values(schedulerSnapshot.workers)) {
      if (workerState.status !== "RUNNING" || workerState.lastStartedAt === null) {
        continue;
      }

      if (
        ageMinutes(workerState.lastStartedAt, now) < runningWorkerThresholdMinutes
      ) {
        continue;
      }

      alerts.push({
        kind: "STUCK_WORKER",
        severity: "WARN",
        title: "Scheduler worker appears stuck",
        body:
          `${workerState.worker} has been RUNNING for at least ` +
          `${runningWorkerThresholdMinutes} minutes.`,
      });
    }
  }

  return alerts;
}
