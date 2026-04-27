import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { FakeClock } from "../../src/app/simulation/FakeClock.js";
import {
  ReplaySimulationGateway,
  ReplaySimulationFixtureSchema,
  type ReplaySimulationFixture,
} from "../../src/app/simulation/ReplaySimulationGateway.js";
import {
  createCircuitBreakerScenarioPack,
  createRebalanceScenarioPack,
  createStopLossScenarioPack,
  createTimeoutReconciliationScenarioPack,
  type SimulationScenarioPack,
} from "../../src/app/simulation/scenarioPacks.js";
import { runDryRunSimulation } from "../../src/app/usecases/runDryRunSimulation.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-b17-"),
  );
  tempDirs.push(directory);
  return directory;
}

async function runScenarioPack(pack: SimulationScenarioPack) {
  const directory = await makeTempDir();
  const fixture: ReplaySimulationFixture = pack.fixture;
  const actionRepository = new ActionRepository({
    filePath: path.join(directory, "actions.json"),
  });
  const stateRepository = new StateRepository({
    filePath: path.join(directory, "positions.json"),
  });
  const journalRepository = new JournalRepository({
    filePath: path.join(directory, "journal.jsonl"),
  });
  const firstStep = fixture.steps[0];
  if (firstStep === undefined) {
    throw new Error("scenario fixture must contain at least one step");
  }
  const fakeClock = new FakeClock(firstStep.timestamp);
  const actionQueue = new ActionQueue({
    actionRepository,
    journalRepository,
    now: () => fakeClock.now(),
  });
  const replayGateway = new ReplaySimulationGateway(fixture);

  return runDryRunSimulation({
    fixture,
    fakeClock,
    replayGateway,
    actionQueue,
    actionRepository,
    stateRepository,
    journalRepository,
    managementPolicy: pack.managementPolicy,
    riskPolicy: pack.riskPolicy,
    ...(pack.rebalancePlanner === undefined
      ? {}
      : {
          rebalancePlanner: ({ position }) =>
            pack.rebalancePlanner?.({ position }) ?? null,
        }),
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("dry-run simulation harness", () => {
  it("reproduces a stop loss close lifecycle from a replay fixture", async () => {
    const result = await runScenarioPack(createStopLossScenarioPack());

    expect(result.cycles).toHaveLength(2);
    expect(result.cycles[0]?.management.positionResults).toEqual([
      expect.objectContaining({
        managementAction: "CLOSE",
        status: "DISPATCHED",
      }),
    ]);

    const finalAction = result.finalActions[0];
    const finalPosition = result.finalPositions.find(
      (position) => position.positionId === "pos_stop_loss_001",
    );

    expect(finalAction?.type).toBe("CLOSE");
    expect(finalAction?.status).toBe("DONE");
    expect(finalPosition?.status).toBe("CLOSED");
  });

  it("reproduces a rebalance close-then-redeploy lifecycle from a replay fixture", async () => {
    const result = await runScenarioPack(createRebalanceScenarioPack());

    expect(result.cycles).toHaveLength(3);
    expect(result.cycles[0]?.management.positionResults).toEqual([
      expect.objectContaining({
        managementAction: "REBALANCE",
        status: "DISPATCHED",
      }),
    ]);
    expect(
      result.cycles[1]?.reconciliation.records.some(
        (record) =>
          record.scope === "ACTION" &&
          record.outcome === "REQUIRES_RETRY" &&
          record.detail.includes("REDEPLOY_SUBMITTED"),
      ),
    ).toBe(true);

    const rebalanceAction = result.finalActions.find(
      (action) => action.type === "REBALANCE",
    );
    const oldPosition = result.finalPositions.find(
      (position) => position.positionId === "pos_rebalance_old_001",
    );
    const newPosition = result.finalPositions.find(
      (position) => position.positionId === "pos_rebalance_new_001",
    );

    expect(rebalanceAction?.status).toBe("DONE");
    expect(oldPosition?.status).toBe("CLOSED");
    expect(newPosition?.status).toBe("OPEN");
    expect(newPosition?.rebalanceCount).toBe(1);
  });

  it("reproduces a timeout into reconciliation-required state from a replay fixture", async () => {
    const result = await runScenarioPack(
      createTimeoutReconciliationScenarioPack(),
    );

    expect(result.cycles).toHaveLength(2);
    expect(
      result.cycles[1]?.reconciliation.records.some(
        (record) =>
          record.outcome === "MANUAL_REVIEW_REQUIRED" &&
          record.detail.includes("TIMED_OUT"),
      ),
    ).toBe(true);

    const deployAction = result.finalActions.find(
      (action) => action.type === "DEPLOY",
    );
    const pendingPosition = result.finalPositions.find(
      (position) => position.positionId === "pos_timeout_001",
    );

    expect(deployAction?.status).toBe("TIMED_OUT");
    expect(pendingPosition?.status).toBe("RECONCILIATION_REQUIRED");
    expect(pendingPosition?.needsReconciliation).toBe(true);
  });

  it("reproduces a circuit breaker management close from a replay fixture", async () => {
    const result = await runScenarioPack(createCircuitBreakerScenarioPack());

    expect(result.cycles).toHaveLength(2);
    expect(
      result.cycles[0]?.management.portfolioState?.circuitBreakerState,
    ).toBe("ON");
    expect(result.cycles[0]?.management.positionResults).toEqual([
      expect.objectContaining({
        managementAction: "CLOSE",
        status: "DISPATCHED",
        triggerReasons: expect.arrayContaining([
          expect.stringContaining("circuit breaker is on"),
        ]),
      }),
    ]);

    const finalAction = result.finalActions.find(
      (action) => action.type === "CLOSE",
    );
    const finalPosition = result.finalPositions.find(
      (position) => position.positionId === "pos_breaker_001",
    );

    expect(finalAction?.status).toBe("DONE");
    expect(finalPosition?.status).toBe("CLOSED");
  });

  it("rejects replay fixtures with non-monotonic timestamps", () => {
    const pack = createStopLossScenarioPack();
    const invalidFixture: ReplaySimulationFixture = {
      ...pack.fixture,
      steps: [
        pack.fixture.steps[0]!,
        {
          ...pack.fixture.steps[1]!,
          timestamp: "2026-04-20T23:59:00.000Z",
        },
      ],
    };

    expect(() => ReplaySimulationFixtureSchema.parse(invalidFixture)).toThrow(
      /monotonic/,
    );
  });

  it("replay timeout errors are deterministic and do not wait on wall clock", async () => {
    const fixture: ReplaySimulationFixture = {
      wallet: "wallet_sim_001",
      initialPositions: [],
      initialActions: [],
      initialJournalEvents: [],
      steps: [
        {
          timestamp: "2026-04-21T00:00:00.000Z",
          walletBalanceSol: 1,
          solPriceUsd: 50,
          onChainPositions: [],
          signalsByPositionId: {},
        },
      ],
      deployResponses: [
        {
          type: "timeout",
          timeoutMs: 30_000,
        },
      ],
      closeResponses: [],
      claimFeesResponses: [],
      partialCloseResponses: [],
      poolInfoByPool: {},
    };
    const replayGateway = new ReplaySimulationGateway(fixture);

    await expect(
      replayGateway.deployLiquidity({
        wallet: "wallet_sim_001",
        poolAddress: "pool_sim_001",
        amountBase: 1,
        amountQuote: 1,
        strategy: "bid_ask",
      }),
    ).rejects.toThrow("Replay timeout after 30000ms");
  });

  it("replay ambiguous deploy responses surface as ambiguous submission errors for reconciliation paths", async () => {
    const fixture: ReplaySimulationFixture = {
      wallet: "wallet_sim_001",
      initialPositions: [],
      initialActions: [],
      initialJournalEvents: [],
      steps: [
        {
          timestamp: "2026-04-21T00:00:00.000Z",
          walletBalanceSol: 1,
          solPriceUsd: 50,
          onChainPositions: [],
          signalsByPositionId: {},
        },
      ],
      deployResponses: [
        {
          type: "ambiguous",
          operation: "DEPLOY",
          positionId: "pos_amb_001",
          txIds: ["tx_amb_001"],
        },
      ],
      closeResponses: [],
      claimFeesResponses: [],
      partialCloseResponses: [],
      poolInfoByPool: {},
    };
    const replayGateway = new ReplaySimulationGateway(fixture);

    await expect(
      replayGateway.deployLiquidity({
        wallet: "wallet_sim_001",
        poolAddress: "pool_sim_001",
        amountBase: 1,
        amountQuote: 1,
        strategy: "bid_ask",
      }),
    ).rejects.toMatchObject({
      name: "AmbiguousSubmissionError",
      positionId: "pos_amb_001",
      txIds: ["tx_amb_001"],
    });
  });

  it("does not duplicate initial journal seed when dry-run simulation is executed twice on the same store", async () => {
    const directory = await makeTempDir();
    const fixture: ReplaySimulationFixture = {
      wallet: "wallet_sim_001",
      initialPositions: [],
      initialActions: [],
      initialJournalEvents: [
        {
          timestamp: "2026-04-21T00:00:00.000Z",
          eventType: "ACTION_QUEUED",
          actor: "system",
          wallet: "wallet_sim_001",
          positionId: null,
          actionId: "act_seed_001",
          before: null,
          after: { seeded: true },
          txIds: [],
          resultStatus: "QUEUED",
          error: null,
        },
      ],
      steps: [
        {
          timestamp: "2026-04-21T00:00:00.000Z",
          walletBalanceSol: 1,
          solPriceUsd: 50,
          onChainPositions: [],
          signalsByPositionId: {},
        },
      ],
      deployResponses: [],
      closeResponses: [],
      claimFeesResponses: [],
      partialCloseResponses: [],
      poolInfoByPool: {},
    };
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const fakeClock = new FakeClock("2026-04-21T00:00:00.000Z");
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
      now: () => fakeClock.now(),
    });

    const runOnce = async () =>
      runDryRunSimulation({
        fixture,
        fakeClock,
        replayGateway: new ReplaySimulationGateway(fixture),
        actionQueue,
        actionRepository,
        stateRepository,
        journalRepository,
        managementPolicy: createStopLossScenarioPack().managementPolicy,
        riskPolicy: createStopLossScenarioPack().riskPolicy,
      });

    await runOnce();
    const firstJournalCount = (await journalRepository.list()).length;
    await runOnce();
    const secondJournalCount = (await journalRepository.list()).length;

    expect(firstJournalCount).toBe(secondJournalCount);
  });
});
