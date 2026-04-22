import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import type { PerformanceRepositoryInterface } from "../../adapters/storage/PerformanceRepository.js";
import type { PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import type { PriceGateway } from "../../adapters/pricing/PriceGateway.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { NotifierGateway, NotificationResult } from "../../adapters/telegram/NotifierGateway.js";
import type { SchedulerMetadataStore } from "../../infra/scheduler/SchedulerMetadataStore.js";
import { runWithSchedulerMetadata } from "../../infra/scheduler/runWithSchedulerMetadata.js";

import {
  generateRuntimeReport,
  type RuntimeReport,
} from "../usecases/generateRuntimeReport.js";
import { renderDailyBriefing } from "../usecases/renderDailyBriefing.js";
import { sendOperatorAlert } from "../usecases/sendOperatorAlert.js";

export interface ReportingWorkerInput {
  wallet: string;
  stateRepository: StateRepository;
  actionRepository: ActionRepository;
  lessonRepository?: LessonRepositoryInterface;
  performanceRepository?: PerformanceRepositoryInterface;
  poolMemoryRepository?: PoolMemoryRepository;
  priceGateway?: PriceGateway;
  schedulerMetadataStore?: SchedulerMetadataStore;
  notifierGateway?: NotifierGateway;
  alertRecipient?: string;
  dailyProfitTargetSol?: number;
  solMode?: boolean;
  briefingEmoji?: boolean;
  stuckActionThresholdMinutes?: number;
  runningWorkerThresholdMinutes?: number;
  intervalSec?: number;
  triggerSource?: "cron" | "manual" | "startup";
  now?: () => string;
}

export interface ReportingWorkerResult {
  report: RuntimeReport;
  briefingText: string;
  deliveredAlerts: NotificationResult[];
  skippedBecauseAlreadyRunning: boolean;
}

export async function runReportingWorker(
  input: ReportingWorkerInput,
): Promise<ReportingWorkerResult> {
  const scheduled = await runWithSchedulerMetadata({
    ...(input.schedulerMetadataStore === undefined
      ? {}
      : { schedulerMetadataStore: input.schedulerMetadataStore }),
    worker: "reporting",
    ...(input.triggerSource === undefined
      ? {}
      : { triggerSource: input.triggerSource }),
    ...(input.intervalSec === undefined
      ? {}
      : { intervalSec: input.intervalSec }),
    ...(input.now === undefined ? {} : { now: input.now }),
    run: async () => {
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
        ...(input.priceGateway === undefined
          ? {}
          : { priceGateway: input.priceGateway }),
        ...(input.schedulerMetadataStore === undefined
          ? {}
          : { schedulerMetadataStore: input.schedulerMetadataStore }),
        ...(input.dailyProfitTargetSol === undefined
          ? {}
          : { dailyProfitTargetSol: input.dailyProfitTargetSol }),
        ...(input.solMode === undefined ? {} : { solMode: input.solMode }),
        now: input.now?.() ?? new Date().toISOString(),
        ...(input.stuckActionThresholdMinutes === undefined
          ? {}
          : { stuckActionThresholdMinutes: input.stuckActionThresholdMinutes }),
        ...(input.runningWorkerThresholdMinutes === undefined
          ? {}
          : { runningWorkerThresholdMinutes: input.runningWorkerThresholdMinutes }),
      });

      const deliveredAlerts: NotificationResult[] = [];
      const briefingText = renderDailyBriefing({
        report,
        ...(input.briefingEmoji === undefined
          ? {}
          : { emoji: input.briefingEmoji }),
      });
      if (
        input.notifierGateway !== undefined &&
        input.alertRecipient !== undefined &&
        report.alerts.length > 0
      ) {
        for (const alert of report.alerts) {
          deliveredAlerts.push(
            await sendOperatorAlert({
              notifierGateway: input.notifierGateway,
              recipient: input.alertRecipient,
              title: alert.title,
              body: alert.body,
            }),
          );
        }
      }

      return {
        report,
        briefingText,
        deliveredAlerts,
      };
    },
  });

  if (scheduled.status === "SKIPPED_ALREADY_RUNNING") {
    const report = await generateRuntimeReport({
      wallet: input.wallet,
      stateRepository: input.stateRepository,
      actionRepository: input.actionRepository,
      ...(input.performanceRepository === undefined
        ? {}
        : { performanceRepository: input.performanceRepository }),
      ...(input.priceGateway === undefined
        ? {}
        : { priceGateway: input.priceGateway }),
      ...(input.schedulerMetadataStore === undefined
        ? {}
        : { schedulerMetadataStore: input.schedulerMetadataStore }),
      ...(input.dailyProfitTargetSol === undefined
        ? {}
        : { dailyProfitTargetSol: input.dailyProfitTargetSol }),
      ...(input.solMode === undefined ? {} : { solMode: input.solMode }),
      now: input.now?.() ?? new Date().toISOString(),
    });
    return {
      report,
      briefingText: renderDailyBriefing({
        report,
        ...(input.briefingEmoji === undefined
          ? {}
          : { emoji: input.briefingEmoji }),
      }),
      deliveredAlerts: [],
      skippedBecauseAlreadyRunning: true,
    };
  }

  return {
    report: scheduled.result.report,
    briefingText: scheduled.result.briefingText,
    deliveredAlerts: scheduled.result.deliveredAlerts,
    skippedBecauseAlreadyRunning: false,
  };
}
