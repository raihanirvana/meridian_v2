import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { Action } from "../../domain/entities/Action.js";
import type { JournalEvent } from "../../domain/entities/JournalEvent.js";
import type { PortfolioState } from "../../domain/entities/PortfolioState.js";
import type { Position } from "../../domain/entities/Position.js";
import type {
  ManagementPolicy,
  ManagementSignals,
} from "../../domain/rules/managementRules.js";
import type { PortfolioRiskPolicy } from "../../domain/rules/riskRules.js";
import type { Actor } from "../../domain/types/enums.js";
import { type ActionQueue } from "../services/ActionQueue.js";
import { type FakeClock } from "../simulation/FakeClock.js";
import {
  ReplaySimulationFixtureSchema,
  type ReplaySimulationFixture,
  type ReplaySimulationGateway,
} from "../simulation/ReplaySimulationGateway.js";
import { processActionQueue } from "./processActionQueue.js";
import { processCloseAction } from "./processCloseAction.js";
import { processDeployAction } from "./processDeployAction.js";
import { processRebalanceAction } from "./processRebalanceAction.js";
import { type RebalanceActionRequestPayload } from "./requestRebalance.js";
import {
  reconcilePortfolio,
  type ReconcilePortfolioResult,
} from "./reconcilePortfolio.js";
import {
  runManagementCycle,
  type RunManagementCycleResult,
} from "./runManagementCycle.js";

export interface DryRunSimulationCycleResult {
  cycle: number;
  at: string;
  reconciliation: ReconcilePortfolioResult;
  management: RunManagementCycleResult;
  processedActions: Action[];
  positions: Position[];
  actions: Action[];
}

export interface RunDryRunSimulationInput {
  fixture: ReplaySimulationFixture;
  fakeClock: FakeClock;
  replayGateway: ReplaySimulationGateway;
  actionQueue: ActionQueue;
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  journalRepository: JournalRepository;
  riskPolicy: PortfolioRiskPolicy;
  managementPolicy: ManagementPolicy;
  requestedBy?: Actor;
  previousPortfolioState?: PortfolioState | null;
  rebalancePlanner?: (input: {
    position: Position;
    portfolio: PortfolioState;
    now: string;
    signals: ManagementSignals;
  }) =>
    | Promise<RebalanceActionRequestPayload | null>
    | RebalanceActionRequestPayload
    | null;
}

export interface RunDryRunSimulationResult {
  wallet: string;
  cycles: DryRunSimulationCycleResult[];
  finalPortfolioState: PortfolioState | null;
  finalPositions: Position[];
  finalActions: Action[];
  journal: JournalEvent[];
}

async function seedFixture(input: {
  fixture: ReplaySimulationFixture;
  actionRepository: ActionRepository;
  stateRepository: StateRepository;
  journalRepository: JournalRepository;
}): Promise<void> {
  await input.stateRepository.replaceAll(input.fixture.initialPositions);
  await input.actionRepository.replaceAll(input.fixture.initialActions);

  for (const event of input.fixture.initialJournalEvents) {
    await input.journalRepository.append(event);
  }
}

export async function runDryRunSimulation(
  input: RunDryRunSimulationInput,
): Promise<RunDryRunSimulationResult> {
  const fixture = ReplaySimulationFixtureSchema.parse(input.fixture);
  await seedFixture({
    fixture,
    actionRepository: input.actionRepository,
    stateRepository: input.stateRepository,
    journalRepository: input.journalRepository,
  });

  let previousPortfolioState = input.previousPortfolioState ?? null;
  const cycles: DryRunSimulationCycleResult[] = [];

  for (const [index, step] of fixture.steps.entries()) {
    input.fakeClock.set(step.timestamp);
    input.replayGateway.useStep(index);

    const reconciliation = await reconcilePortfolio({
      actionRepository: input.actionRepository,
      stateRepository: input.stateRepository,
      dlmmGateway: input.replayGateway,
      journalRepository: input.journalRepository,
      now: () => input.fakeClock.now(),
    });

    const management = await runManagementCycle({
      wallet: fixture.wallet,
      actionQueue: input.actionQueue,
      actionRepository: input.actionRepository,
      stateRepository: input.stateRepository,
      journalRepository: input.journalRepository,
      walletGateway: input.replayGateway,
      priceGateway: input.replayGateway,
      riskPolicy: input.riskPolicy,
      managementPolicy: input.managementPolicy,
      requestedBy: input.requestedBy ?? "system",
      previousPortfolioState,
      now: () => input.fakeClock.now(),
      signalProvider: ({ position }) =>
        input.replayGateway.getSignal(position.positionId),
      ...(input.rebalancePlanner === undefined
        ? {}
        : {
            rebalancePlanner: ({ position, portfolio, now, signals }) =>
              input.rebalancePlanner?.({
                position,
                portfolio,
                now,
                signals,
              }) ?? null,
          }),
    });

    previousPortfolioState = management.portfolioState;

    const processedActions = await processActionQueue({
      actionQueue: input.actionQueue,
      handler: async (action) => {
        switch (action.type) {
          case "DEPLOY":
            return processDeployAction({
              action,
              dlmmGateway: input.replayGateway,
              stateRepository: input.stateRepository,
              journalRepository: input.journalRepository,
              now: () => input.fakeClock.now(),
            });
          case "CLOSE":
            return processCloseAction({
              action,
              dlmmGateway: input.replayGateway,
              stateRepository: input.stateRepository,
              journalRepository: input.journalRepository,
              now: () => input.fakeClock.now(),
            });
          case "REBALANCE":
            return processRebalanceAction({
              action,
              dlmmGateway: input.replayGateway,
              stateRepository: input.stateRepository,
              journalRepository: input.journalRepository,
              now: () => input.fakeClock.now(),
            });
          default:
            throw new Error(
              `Simulation handler does not support ${action.type}`,
            );
        }
      },
    });

    cycles.push({
      cycle: index + 1,
      at: step.timestamp,
      reconciliation,
      management,
      processedActions,
      positions: await input.stateRepository.list(),
      actions: await input.actionRepository.list(),
    });
  }

  return {
    wallet: fixture.wallet,
    cycles,
    finalPortfolioState: previousPortfolioState,
    finalPositions: await input.stateRepository.list(),
    finalActions: await input.actionRepository.list(),
    journal: await input.journalRepository.list(),
  };
}
