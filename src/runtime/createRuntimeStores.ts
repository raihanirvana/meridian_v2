import { ActionRepository } from "../adapters/storage/ActionRepository.js";
import { JournalRepository } from "../adapters/storage/JournalRepository.js";
import {
  FileLessonRepository,
  type LessonRepositoryInterface,
} from "../adapters/storage/LessonRepository.js";
import {
  FilePerformanceRepository,
  type PerformanceRepositoryInterface,
} from "../adapters/storage/PerformanceRepository.js";
import {
  FilePoolMemoryRepository,
  type PoolMemoryRepository,
} from "../adapters/storage/PoolMemoryRepository.js";
import { FileSignalWeightsStore, type SignalWeightsStore } from "../adapters/storage/SignalWeightsStore.js";
import { StateRepository } from "../adapters/storage/StateRepository.js";
import {
  FileRuntimePolicyStore,
  type RuntimePolicyStore,
} from "../adapters/config/RuntimePolicyStore.js";
import { type ScreeningPolicy } from "../domain/rules/screeningRules.js";
import {
  ensureDataDir,
  type MeridianPaths,
} from "../infra/config/paths.js";
import {
  FileSchedulerMetadataStore,
  type SchedulerMetadataStore,
} from "../infra/scheduler/SchedulerMetadataStore.js";
import { ActionQueue } from "../app/services/ActionQueue.js";

export interface RuntimeStores {
  paths: MeridianPaths;
  stateRepository: StateRepository;
  actionRepository: ActionRepository;
  journalRepository: JournalRepository;
  lessonRepository: LessonRepositoryInterface;
  performanceRepository: PerformanceRepositoryInterface;
  runtimePolicyStore: RuntimePolicyStore;
  poolMemoryRepository: PoolMemoryRepository;
  signalWeightsStore: SignalWeightsStore;
  schedulerMetadataStore: SchedulerMetadataStore;
  actionQueue: ActionQueue;
}

export interface CreateRuntimeStoresInput {
  baseScreeningPolicy: ScreeningPolicy;
  dataDir?: string;
  now?: () => string;
}

export function createRuntimeStores(
  input: CreateRuntimeStoresInput,
): RuntimeStores {
  const paths = ensureDataDir(input.dataDir);
  const stateRepository = new StateRepository({
    filePath: paths.positionsFilePath,
  });
  const actionRepository = new ActionRepository({
    filePath: paths.actionsFilePath,
  });
  const journalRepository = new JournalRepository({
    filePath: paths.journalFilePath,
  });
  const lessonRepository = new FileLessonRepository({
    filePath: paths.lessonsFilePath,
  });
  const performanceRepository = new FilePerformanceRepository({
    filePath: paths.lessonsFilePath,
  });
  const runtimePolicyStore = new FileRuntimePolicyStore({
    filePath: paths.policyOverridesFilePath,
    basePolicy: input.baseScreeningPolicy,
  });
  const poolMemoryRepository = new FilePoolMemoryRepository({
    filePath: paths.poolMemoryFilePath,
  });
  const signalWeightsStore = new FileSignalWeightsStore({
    filePath: paths.signalWeightsFilePath,
  });
  const schedulerMetadataStore = new FileSchedulerMetadataStore({
    filePath: paths.schedulerMetadataFilePath,
  });
  const actionQueue = new ActionQueue({
    actionRepository,
    journalRepository,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  return {
    paths,
    stateRepository,
    actionRepository,
    journalRepository,
    lessonRepository,
    performanceRepository,
    runtimePolicyStore,
    poolMemoryRepository,
    signalWeightsStore,
    schedulerMetadataStore,
    actionQueue,
  };
}
