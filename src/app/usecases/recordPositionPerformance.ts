import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import { type LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import { type PerformanceRepositoryInterface } from "../../adapters/storage/PerformanceRepository.js";
import { type Lesson } from "../../domain/entities/Lesson.js";
import {
  PerformanceRecordSchema,
  type PerformanceRecord,
} from "../../domain/entities/PerformanceRecord.js";
import {
  deriveLesson,
  isSuspiciousUnitMix,
} from "../../domain/rules/lessonRules.js";

export interface RecordPositionPerformanceInput {
  performance: PerformanceRecord;
  lessonRepository: LessonRepositoryInterface;
  performanceRepository: PerformanceRepositoryInterface;
  journalRepository?: JournalRepository;
  idGen: () => string;
  now: () => string;
}

export interface RecordPositionPerformanceResult {
  skipped?: true;
  reason?: "suspicious_unit_mix";
  performance?: PerformanceRecord;
  lesson?: Lesson | null;
}

export async function recordPositionPerformance(
  input: RecordPositionPerformanceInput,
): Promise<RecordPositionPerformanceResult> {
  const performance = PerformanceRecordSchema.parse(input.performance);

  if (isSuspiciousUnitMix(performance)) {
    return {
      skipped: true,
      reason: "suspicious_unit_mix",
    };
  }

  await input.performanceRepository.append(performance);
  const lesson = deriveLesson(performance, input.now(), input.idGen);

  if (lesson !== null) {
    await input.lessonRepository.append(lesson);
    await input.journalRepository?.append({
      timestamp: input.now(),
      eventType: "LESSON_RECORDED",
      actor: "system",
      wallet: performance.wallet,
      positionId: performance.positionId,
      actionId: null,
      before: null,
      after: {
        lessonId: lesson.id,
        outcome: lesson.outcome,
        pnlPct: performance.pnlPct,
        pool: performance.pool,
        role: lesson.role,
      },
      txIds: [],
      resultStatus: "RECORDED",
      error: null,
    });
  }

  return {
    performance,
    lesson,
  };
}
