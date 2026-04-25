import type { RuntimePolicyStore } from "../../adapters/config/RuntimePolicyStore.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import type { PerformanceRepositoryInterface } from "../../adapters/storage/PerformanceRepository.js";
import type { PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import type { SignalWeightsStore } from "../../adapters/storage/SignalWeightsStore.js";
import type { LessonHook } from "../usecases/finalizeClose.js";

import { createRecordPositionPerformanceLessonHook } from "./PerformanceLessonHook.js";

export function createPerformanceLessonHook(input: {
  performanceRepository: PerformanceRepositoryInterface;
  lessonRepository: LessonRepositoryInterface;
  poolMemoryRepository?: PoolMemoryRepository;
  journalRepository: JournalRepository;
  runtimePolicyStore?: RuntimePolicyStore;
  signalWeightsStore?: SignalWeightsStore;
  config: { darwin: { enabled: boolean } };
  now: () => string;
  idGen: () => string;
}): LessonHook {
  return createRecordPositionPerformanceLessonHook({
    lessonRepository: input.lessonRepository,
    performanceRepository: input.performanceRepository,
    journalRepository: input.journalRepository,
    ...(input.poolMemoryRepository === undefined
      ? {}
      : { poolMemoryRepository: input.poolMemoryRepository }),
    ...(input.runtimePolicyStore === undefined
      ? {}
      : { runtimePolicyStore: input.runtimePolicyStore }),
    ...(input.signalWeightsStore === undefined
      ? {}
      : { signalWeightsStore: input.signalWeightsStore }),
    darwinEnabled: input.config.darwin.enabled,
    idGen: input.idGen,
  });
}
