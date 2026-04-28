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
import { logger } from "../../infra/logging/logger.js";

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
  reason?: "duplicate_position" | "suspicious_unit_mix";
  performance?: PerformanceRecord;
  lesson?: Lesson | null;
}

async function appendJournalBestEffort(
  journalRepository: JournalRepository | undefined,
  event: Parameters<JournalRepository["append"]>[0],
): Promise<void> {
  if (journalRepository === undefined) {
    return;
  }

  try {
    await journalRepository.append(event);
  } catch (error) {
    logger.warn(
      { err: error, eventType: event.eventType, positionId: event.positionId },
      "position performance journal append failed",
    );
  }
}

function isSameDerivedLesson(input: {
  existing: Lesson;
  candidate: Lesson;
}): boolean {
  return (
    input.existing.rule === input.candidate.rule &&
    input.existing.pool === input.candidate.pool &&
    input.existing.context === input.candidate.context &&
    input.existing.pnlPct === input.candidate.pnlPct &&
    input.existing.rangeEfficiencyPct === input.candidate.rangeEfficiencyPct &&
    input.existing.outcome === input.candidate.outcome
  );
}

export async function recordPositionPerformance(
  input: RecordPositionPerformanceInput,
): Promise<RecordPositionPerformanceResult> {
  const requestedPerformance = PerformanceRecordSchema.parse(input.performance);
  const isSuspicious = isSuspiciousUnitMix(requestedPerformance);

  if (isSuspicious) {
    await appendJournalBestEffort(input.journalRepository, {
      timestamp: input.now(),
      eventType: "PERFORMANCE_RECORD_SKIPPED",
      actor: "system",
      wallet: requestedPerformance.wallet,
      positionId: requestedPerformance.positionId,
      actionId: null,
      before: null,
      after: {
        reason: "suspicious_unit_mix",
        pool: requestedPerformance.pool,
        pnlPct: requestedPerformance.pnlPct,
      },
      txIds: [],
      resultStatus: "SKIPPED",
      error: "suspicious_unit_mix",
    });
    return {
      skipped: true,
      reason: "suspicious_unit_mix",
    };
  }

  const {
    inserted: insertedPerformance,
    record: performance,
  } = await input.performanceRepository.appendIfAbsent(requestedPerformance);
  if (insertedPerformance) {
    await appendJournalBestEffort(input.journalRepository, {
      timestamp: input.now(),
      eventType: "PERFORMANCE_RECORDED",
      actor: "system",
      wallet: performance.wallet,
      positionId: performance.positionId,
      actionId: null,
      before: null,
      after: {
        pool: performance.pool,
        pnlUsd: performance.pnlUsd,
        pnlPct: performance.pnlPct,
        closeReason: performance.closeReason,
        rangeEfficiencyPct: performance.rangeEfficiencyPct,
      },
      txIds: [],
      resultStatus: "RECORDED",
      error: null,
    });
  }

  const candidateLesson = deriveLesson(performance, input.now(), input.idGen);
  let lesson: Lesson | null = null;

  if (candidateLesson !== null) {
    const existingLesson = (await input.lessonRepository.list()).find(
      (currentLesson) =>
        isSameDerivedLesson({
          existing: currentLesson,
          candidate: candidateLesson,
        }),
    );
    if (existingLesson !== undefined) {
      lesson = existingLesson;
    } else {
      const insertedLesson = await input.lessonRepository.appendIfAbsentDerived(
        candidateLesson,
      );
      lesson = insertedLesson.lesson;
      if (insertedLesson.inserted) {
        await appendJournalBestEffort(input.journalRepository, {
          timestamp: input.now(),
          eventType: "LESSON_RECORDED",
          actor: "system",
          wallet: performance.wallet,
          positionId: performance.positionId,
          actionId: null,
          before: null,
          after: {
            lessonId: insertedLesson.lesson.id,
            outcome: insertedLesson.lesson.outcome,
            pnlPct: performance.pnlPct,
            pool: performance.pool,
            role: insertedLesson.lesson.role,
          },
          txIds: [],
          resultStatus: "RECORDED",
          error: null,
        });
      }
    }
  }

  return {
    performance,
    lesson,
  };
}
