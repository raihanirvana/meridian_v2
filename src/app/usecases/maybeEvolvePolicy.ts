import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import type { PerformanceRepositoryInterface } from "../../adapters/storage/PerformanceRepository.js";
import { type RuntimePolicyStore } from "../../adapters/config/RuntimePolicyStore.js";
import { LessonSchema } from "../../domain/entities/Lesson.js";
import {
  MIN_EVOLVE_POSITIONS,
  evolveThresholds,
  type ThresholdEvolutionResult,
} from "../../domain/rules/thresholdEvolutionRules.js";

export interface MaybeEvolvePolicyInput {
  performanceRepository: PerformanceRepositoryInterface;
  runtimePolicyStore: RuntimePolicyStore;
  lessonRepository: LessonRepositoryInterface;
  journalRepository?: JournalRepository;
  now: () => string;
  idGen: () => string;
}

export type MaybeEvolvePolicyResult =
  | {
      skipped: true;
      reason: "position_count_gate";
    }
  | ({
      skipped?: false;
      positionsAtEvolution: number;
    } & ThresholdEvolutionResult);

function formatEvolutionRule(input: {
  positionsAtEvolution: number;
  changes: ThresholdEvolutionResult["changes"];
  rationale: Record<string, string>;
}): string {
  const changesText = Object.entries(input.changes)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
  const rationaleText = Object.values(input.rationale).join("; ");

  return `[AUTO-EVOLVED @ ${input.positionsAtEvolution} positions] ${changesText}${
    rationaleText.length === 0 ? "" : ` — ${rationaleText}`
  }`;
}

export async function maybeEvolvePolicy(
  input: MaybeEvolvePolicyInput,
): Promise<MaybeEvolvePolicyResult> {
  const performance = await input.performanceRepository.list();
  const positionsAtEvolution = performance.length;

  if (
    positionsAtEvolution < MIN_EVOLVE_POSITIONS ||
    positionsAtEvolution % MIN_EVOLVE_POSITIONS !== 0
  ) {
    return {
      skipped: true,
      reason: "position_count_gate",
    };
  }

  const snapshot = await input.runtimePolicyStore.snapshot();
  const evolved = evolveThresholds({
    performance,
    currentPolicy: snapshot.policy,
  });

  if (evolved === null) {
    return {
      positionsAtEvolution,
      changes: {},
      rationale: {},
    };
  }

  if (Object.keys(evolved.changes).length === 0) {
    return {
      positionsAtEvolution,
      changes: {},
      rationale: evolved.rationale,
    };
  }

  const now = input.now();
  await input.runtimePolicyStore.applyOverrides(evolved.changes, {
    lastEvolvedAt: now,
    positionsAtEvolution,
    rationale: evolved.rationale,
  });

  await input.journalRepository?.append({
    timestamp: now,
    eventType: "POLICY_EVOLVED",
    actor: "system",
    wallet: "system",
    positionId: null,
    actionId: null,
    before: null,
    after: {
      changes: evolved.changes,
      rationale: evolved.rationale,
      positionsAtEvolution,
    },
    txIds: [],
    resultStatus: "APPLIED",
    error: null,
  });

  await input.lessonRepository.append(
    LessonSchema.parse({
      id: input.idGen(),
      rule: formatEvolutionRule({
        positionsAtEvolution,
        changes: evolved.changes,
        rationale: evolved.rationale,
      }),
      tags: ["evolution", "config_change"],
      outcome: "evolution",
      role: null,
      pinned: false,
      createdAt: now,
    }),
  );

  return {
    positionsAtEvolution,
    changes: evolved.changes,
    rationale: evolved.rationale,
  };
}
