import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import { type PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import {
  PoolDeploySchema,
  PoolMemoryEntrySchema,
  type PoolDeploy,
  type PoolMemoryEntry,
} from "../../domain/entities/PoolMemory.js";
import {
  buildPoolRecallString,
  computePoolAggregates,
  shouldCooldown,
} from "../../domain/rules/poolMemoryRules.js";
import { logger } from "../../infra/logging/logger.js";

export interface RecordPoolDeployInput {
  poolMemoryRepository: PoolMemoryRepository;
  journalRepository?: JournalRepository;
  poolAddress: string;
  name: string;
  baseMint: string | null;
  deploy: PoolDeploy;
  now: string;
  cooldownHours?: number;
}

export async function recordPoolDeploy(
  input: RecordPoolDeployInput,
): Promise<PoolMemoryEntry> {
  const deploy = PoolDeploySchema.parse(input.deploy);
  const cooldownHours = input.cooldownHours ?? 4;
  let alreadyRecorded = false;
  const updated = await input.poolMemoryRepository.upsert(
    input.poolAddress,
    (current) => {
      const currentDeploys = current?.deploys ?? [];
      alreadyRecorded = currentDeploys.some((currentDeploy) => {
        if (
          deploy.positionId !== undefined &&
          currentDeploy.positionId === deploy.positionId
        ) {
          return true;
        }

        return (
          deploy.sourceActionId !== undefined &&
          currentDeploy.sourceActionId === deploy.sourceActionId
        );
      });
      const nextDeploys = alreadyRecorded
        ? currentDeploys
        : [...currentDeploys, deploy].slice(-50);
      const aggregates = computePoolAggregates(nextDeploys);
      const cooldownUntil = shouldCooldown({
        closeReason: deploy.closeReason,
      })
        ? new Date(
            Date.parse(input.now) + cooldownHours * 60 * 60 * 1000,
          ).toISOString()
        : current?.cooldownUntil;

      return PoolMemoryEntrySchema.parse({
        poolAddress: input.poolAddress,
        name: current?.name ?? input.name,
        baseMint: current?.baseMint ?? input.baseMint,
        deploys: nextDeploys,
        notes: current?.notes ?? [],
        snapshots: current?.snapshots ?? [],
        ...aggregates,
        ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
      });
    },
  );

  try {
    await input.journalRepository?.append({
      timestamp: input.now,
      eventType: "POOL_MEMORY_UPDATED",
      actor: "system",
      wallet: "system",
      positionId: null,
      actionId: null,
      before: null,
      after: {
        poolAddress: updated.poolAddress,
        totalDeploys: updated.totalDeploys,
        avgPnlPct: updated.avgPnlPct,
        winRatePct: updated.winRatePct,
        lastOutcome: updated.lastOutcome,
        recall: buildPoolRecallString(updated, { now: input.now }),
      },
      txIds: [],
      resultStatus: alreadyRecorded ? "UNCHANGED" : "RECORDED",
      error: null,
    });
  } catch (error) {
    logger.warn(
      { err: error, poolAddress: updated.poolAddress },
      "pool memory deploy journal append failed after persistence",
    );
  }

  return updated;
}
