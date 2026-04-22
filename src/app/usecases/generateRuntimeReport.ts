import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import type { PerformanceRepositoryInterface, PerformanceSummary } from "../../adapters/storage/PerformanceRepository.js";
import type { PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { SchedulerMetadata } from "../../domain/entities/SchedulerMetadata.js";
import type { SchedulerMetadataStore } from "../../infra/scheduler/SchedulerMetadataStore.js";

import {
  scanRuntimeAlerts,
  type RuntimeAlert,
} from "./scanRuntimeAlerts.js";

export interface RuntimeReport {
  wallet: string;
  generatedAt: string;
  health: "HEALTHY" | "UNSAFE";
  positionsByStatus: Record<string, number>;
  actionsByStatus: Record<string, number>;
  actionsByType: Record<string, number>;
  openPositions: number;
  pendingActions: number;
  pendingReconciliationPositions: number;
  lessonsCount: number | null;
  poolsTracked: number | null;
  cooldownPools: number | null;
  performanceSummary: PerformanceSummary | null;
  scheduler: SchedulerMetadata | null;
  issues: string[];
  alerts: RuntimeAlert[];
}

export interface GenerateRuntimeReportInput {
  wallet: string;
  stateRepository: StateRepository;
  actionRepository: ActionRepository;
  lessonRepository?: LessonRepositoryInterface;
  performanceRepository?: PerformanceRepositoryInterface;
  poolMemoryRepository?: PoolMemoryRepository;
  schedulerMetadataStore?: SchedulerMetadataStore;
  now?: string;
  stuckActionThresholdMinutes?: number;
  runningWorkerThresholdMinutes?: number;
}

function countBy<T extends string>(
  values: T[],
): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

export async function generateRuntimeReport(
  input: GenerateRuntimeReportInput,
): Promise<RuntimeReport> {
  const generatedAt = input.now ?? new Date().toISOString();
  const positions = (await input.stateRepository.list()).filter(
    (position) => position.wallet === input.wallet,
  );
  const actions = (await input.actionRepository.list()).filter(
    (action) => action.wallet === input.wallet,
  );
  const alerts = await scanRuntimeAlerts({
    wallet: input.wallet,
    actionRepository: input.actionRepository,
    stateRepository: input.stateRepository,
    ...(input.schedulerMetadataStore === undefined
      ? {}
      : { schedulerMetadataStore: input.schedulerMetadataStore }),
    now: generatedAt,
    ...(input.stuckActionThresholdMinutes === undefined
      ? {}
      : { stuckActionThresholdMinutes: input.stuckActionThresholdMinutes }),
    ...(input.runningWorkerThresholdMinutes === undefined
      ? {}
      : { runningWorkerThresholdMinutes: input.runningWorkerThresholdMinutes }),
  });
  const performanceSummary = input.performanceRepository === undefined
    ? null
    : await input.performanceRepository.summary();
  const lessons = input.lessonRepository === undefined
    ? null
    : await input.lessonRepository.list();
  const poolMemory = input.poolMemoryRepository === undefined
    ? null
    : await input.poolMemoryRepository.listAll();
  const scheduler = input.schedulerMetadataStore === undefined
    ? null
    : await input.schedulerMetadataStore.snapshot();

  const positionsByStatus = countBy(positions.map((position) => position.status));
  const actionsByStatus = countBy(actions.map((action) => action.status));
  const actionsByType = countBy(actions.map((action) => action.type));
  const openPositions = positions.filter((position) => position.status === "OPEN").length;
  const pendingActions = actions.filter((action) =>
    ["QUEUED", "RUNNING", "WAITING_CONFIRMATION", "RECONCILING", "RETRY_QUEUED"].includes(
      action.status,
    )
  ).length;
  const pendingReconciliationPositions = positions.filter(
    (position) =>
      position.status === "RECONCILIATION_REQUIRED" || position.needsReconciliation,
  ).length;
  const cooldownPools = poolMemory === null
    ? null
    : poolMemory.filter((entry) => entry.cooldownUntil !== undefined).length;

  const issues = [
    ...(pendingReconciliationPositions > 0
      ? [`${pendingReconciliationPositions} position(s) still need reconciliation`]
      : []),
    ...(alerts.length > 0
      ? alerts.map((alert) => `${alert.kind}: ${alert.title}`)
      : []),
  ];

  return {
    wallet: input.wallet,
    generatedAt,
    health: issues.length === 0 ? "HEALTHY" : "UNSAFE",
    positionsByStatus,
    actionsByStatus,
    actionsByType,
    openPositions,
    pendingActions,
    pendingReconciliationPositions,
    lessonsCount: lessons?.length ?? null,
    poolsTracked: poolMemory?.length ?? null,
    cooldownPools,
    performanceSummary,
    scheduler,
    issues,
    alerts,
  };
}
