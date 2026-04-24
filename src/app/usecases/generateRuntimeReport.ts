import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import type {
  PerformanceRepositoryInterface,
  PerformanceSummary,
} from "../../adapters/storage/PerformanceRepository.js";
import type { PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import type { PriceGateway } from "../../adapters/pricing/PriceGateway.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { SchedulerMetadata } from "../../domain/entities/SchedulerMetadata.js";
import type { SchedulerMetadataStore } from "../../infra/scheduler/SchedulerMetadataStore.js";

import { scanRuntimeAlerts, type RuntimeAlert } from "./scanRuntimeAlerts.js";

export interface RuntimeReport {
  wallet: string;
  generatedAt: string;
  health: "HEALTHY" | "UNSAFE";
  displayMode: "USD" | "SOL";
  solPriceUsd: number | null;
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
  dailyPnlUsd: number | null;
  dailyPnlSol: number | null;
  dailyProfitTargetSol: number | null;
  dailyProfitTargetReached: boolean;
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
  priceGateway?: PriceGateway;
  schedulerMetadataStore?: SchedulerMetadataStore;
  dailyProfitTargetSol?: number;
  solMode?: boolean;
  now?: string;
  stuckActionThresholdMinutes?: number;
  runningWorkerThresholdMinutes?: number;
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function startOfUtcDay(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00.000Z`;
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
  const performanceSummary =
    input.performanceRepository === undefined
      ? null
      : await input.performanceRepository.summary();
  const dailyPerformance =
    input.performanceRepository === undefined
      ? null
      : await input.performanceRepository.list({
          sinceIso: startOfUtcDay(generatedAt),
        });
  const lessons =
    input.lessonRepository === undefined
      ? null
      : await input.lessonRepository.list();
  const poolMemory =
    input.poolMemoryRepository === undefined
      ? null
      : await input.poolMemoryRepository.listAll();
  const solPriceQuote =
    input.priceGateway === undefined
      ? null
      : await input.priceGateway.getSolPriceUsd();
  const scheduler =
    input.schedulerMetadataStore === undefined
      ? null
      : await input.schedulerMetadataStore.snapshot();

  const positionsByStatus = countBy(
    positions.map((position) => position.status),
  );
  const actionsByStatus = countBy(actions.map((action) => action.status));
  const actionsByType = countBy(actions.map((action) => action.type));
  const openPositions = positions.filter(
    (position) => position.status === "OPEN",
  ).length;
  const pendingActions = actions.filter((action) =>
    [
      "QUEUED",
      "RUNNING",
      "WAITING_CONFIRMATION",
      "RECONCILING",
      "RETRY_QUEUED",
    ].includes(action.status),
  ).length;
  const pendingReconciliationPositions = positions.filter(
    (position) =>
      position.status === "RECONCILIATION_REQUIRED" ||
      position.needsReconciliation,
  ).length;
  const cooldownPools =
    poolMemory === null
      ? null
      : poolMemory.filter((entry) => entry.cooldownUntil !== undefined).length;
  const dailyPnlUsd =
    dailyPerformance === null
      ? null
      : dailyPerformance.reduce((sum, record) => sum + record.pnlUsd, 0);
  const dailyPnlSol =
    dailyPnlUsd === null ||
    solPriceQuote === null ||
    solPriceQuote.priceUsd <= 0
      ? null
      : dailyPnlUsd / solPriceQuote.priceUsd;
  const dailyProfitTargetReached =
    input.dailyProfitTargetSol !== undefined &&
    dailyPnlSol !== null &&
    dailyPnlSol >= input.dailyProfitTargetSol;
  const profitTargetAlerts = dailyProfitTargetReached
    ? [
        {
          kind: "DAILY_PROFIT_TARGET" as const,
          severity: "WARN" as const,
          title: "Daily profit target reached",
          body:
            `Daily realized pnl reached ${dailyPnlSol!.toFixed(4)} SOL` +
            ` against target ${input.dailyProfitTargetSol!.toFixed(4)} SOL.`,
        },
      ]
    : [];

  const issues = [
    ...(pendingReconciliationPositions > 0
      ? [
          `${pendingReconciliationPositions} position(s) still need reconciliation`,
        ]
      : []),
    ...(alerts.length > 0
      ? alerts.map((alert) => `${alert.kind}: ${alert.title}`)
      : []),
  ];

  return {
    wallet: input.wallet,
    generatedAt,
    health: issues.length === 0 ? "HEALTHY" : "UNSAFE",
    displayMode: input.solMode === true ? "SOL" : "USD",
    solPriceUsd: solPriceQuote?.priceUsd ?? null,
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
    dailyPnlUsd,
    dailyPnlSol,
    dailyProfitTargetSol: input.dailyProfitTargetSol ?? null,
    dailyProfitTargetReached,
    scheduler,
    issues,
    alerts: [...alerts, ...profitTargetAlerts],
  };
}
