import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import type { PerformanceRepositoryInterface } from "../../adapters/storage/PerformanceRepository.js";
import type { PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { SignalWeightsStore } from "../../adapters/storage/SignalWeightsStore.js";
import type { RuntimePolicyStore } from "../../adapters/config/RuntimePolicyStore.js";
import type { SchedulerMetadataStore } from "../../infra/scheduler/SchedulerMetadataStore.js";

import {
  generateRuntimeReport,
  type RuntimeReport,
} from "./generateRuntimeReport.js";

export interface StartupChecklistItem {
  item: string;
  ok: boolean;
  detail: string;
}

export interface RunStartupRecoveryChecklistInput {
  wallet: string;
  stateRepository: StateRepository;
  actionRepository: ActionRepository;
  journalRepository: JournalRepository;
  lessonRepository?: LessonRepositoryInterface;
  performanceRepository?: PerformanceRepositoryInterface;
  poolMemoryRepository?: PoolMemoryRepository;
  runtimePolicyStore?: RuntimePolicyStore;
  signalWeightsStore?: SignalWeightsStore;
  schedulerMetadataStore?: SchedulerMetadataStore;
  now?: string;
}

export interface StartupRecoveryChecklistResult {
  wallet: string;
  checkedAt: string;
  status: "HEALTHY" | "UNSAFE";
  checklist: StartupChecklistItem[];
  report: RuntimeReport;
}

async function checkItem(
  item: string,
  check: () => Promise<string>,
): Promise<StartupChecklistItem> {
  try {
    return {
      item,
      ok: true,
      detail: await check(),
    };
  } catch (error) {
    return {
      item,
      ok: false,
      detail: error instanceof Error ? error.message : "unknown startup error",
    };
  }
}

export async function runStartupRecoveryChecklist(
  input: RunStartupRecoveryChecklistInput,
): Promise<StartupRecoveryChecklistResult> {
  const checkedAt = input.now ?? new Date().toISOString();
  const checklist: StartupChecklistItem[] = [];

  checklist.push(await checkItem("positions_store", async () => {
    const positions = await input.stateRepository.list();
    return `${positions.length} position(s) readable`;
  }));
  checklist.push(await checkItem("actions_store", async () => {
    const actions = await input.actionRepository.list();
    return `${actions.length} action(s) readable`;
  }));
  checklist.push(await checkItem("journal_store", async () => {
    const events = await input.journalRepository.list();
    return `${events.length} journal event(s) readable`;
  }));

  if (input.lessonRepository !== undefined) {
    checklist.push(await checkItem("lesson_store", async () => {
      const lessons = await input.lessonRepository!.list();
      return `${lessons.length} lesson(s) readable`;
    }));
  }

  if (input.performanceRepository !== undefined) {
    checklist.push(await checkItem("performance_store", async () => {
      const summary = await input.performanceRepository!.summary();
      return `${summary.totalPositionsClosed} performance record(s) summarized`;
    }));
  }

  if (input.poolMemoryRepository !== undefined) {
    checklist.push(await checkItem("pool_memory_store", async () => {
      const entries = await input.poolMemoryRepository!.listAll();
      return `${entries.length} pool memory entr(y/ies) readable`;
    }));
  }

  if (input.runtimePolicyStore !== undefined) {
    checklist.push(await checkItem("runtime_policy_store", async () => {
      const snapshot = await input.runtimePolicyStore!.snapshot();
      return `${Object.keys(snapshot.overrides).length} runtime override(s) readable`;
    }));
  }

  if (input.signalWeightsStore !== undefined) {
    checklist.push(await checkItem("signal_weights_store", async () => {
      const snapshot = await input.signalWeightsStore!.snapshot();
      return `${Object.keys(snapshot.weights).length} signal weight(s) readable`;
    }));
  }

  if (input.schedulerMetadataStore !== undefined) {
    checklist.push(await checkItem("scheduler_metadata_store", async () => {
      const snapshot = await input.schedulerMetadataStore!.snapshot();
      return `${Object.keys(snapshot.workers).length} worker state(s) readable`;
    }));
  }

  const report = await generateRuntimeReport({
    wallet: input.wallet,
    stateRepository: input.stateRepository,
    actionRepository: input.actionRepository,
    ...(input.lessonRepository === undefined
      ? {}
      : { lessonRepository: input.lessonRepository }),
    ...(input.performanceRepository === undefined
      ? {}
      : { performanceRepository: input.performanceRepository }),
    ...(input.poolMemoryRepository === undefined
      ? {}
      : { poolMemoryRepository: input.poolMemoryRepository }),
    ...(input.schedulerMetadataStore === undefined
      ? {}
      : { schedulerMetadataStore: input.schedulerMetadataStore }),
    now: checkedAt,
  });

  const hasFailedCheck = checklist.some((item) => !item.ok);

  return {
    wallet: input.wallet,
    checkedAt,
    status: hasFailedCheck || report.health === "UNSAFE" ? "UNSAFE" : "HEALTHY",
    checklist,
    report,
  };
}
