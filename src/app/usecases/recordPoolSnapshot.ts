import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import { type PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import {
  PoolMemoryEntrySchema,
  PoolSnapshotSchema,
  type PoolMemoryEntry,
  type PoolSnapshot,
} from "../../domain/entities/PoolMemory.js";

export interface RecordPoolSnapshotInput {
  poolMemoryRepository: PoolMemoryRepository;
  journalRepository?: JournalRepository;
  poolAddress: string;
  name: string;
  baseMint: string | null;
  snapshot: PoolSnapshot;
}

export async function recordPoolSnapshot(
  input: RecordPoolSnapshotInput,
): Promise<PoolMemoryEntry> {
  const snapshot = PoolSnapshotSchema.parse(input.snapshot);
  const updated = await input.poolMemoryRepository.upsert(
    input.poolAddress,
    (current) =>
      PoolMemoryEntrySchema.parse({
        ...(current ?? {
          poolAddress: input.poolAddress,
          name: input.name,
          baseMint: input.baseMint,
          totalDeploys: 0,
          deploys: [],
          avgPnlPct: 0,
          winRatePct: 0,
          lastDeployedAt: null,
          lastOutcome: null,
          notes: [],
          snapshots: [],
        }),
        snapshots: [...(current?.snapshots ?? []), snapshot].slice(-48),
      }),
  );

  await input.journalRepository?.append({
    timestamp: snapshot.ts,
    eventType: "POOL_MEMORY_UPDATED",
    actor: "system",
    wallet: "system",
    positionId: snapshot.positionId,
    actionId: null,
    before: null,
    after: {
      poolAddress: updated.poolAddress,
      snapshotCount: updated.snapshots.length,
      latestPositionId: snapshot.positionId,
    },
    txIds: [],
    resultStatus: "SNAPSHOT_RECORDED",
    error: null,
  });

  return updated;
}
