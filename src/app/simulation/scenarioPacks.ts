import type { Action } from "../../domain/entities/Action.js";
import type { JournalEvent } from "../../domain/entities/JournalEvent.js";
import type { Position } from "../../domain/entities/Position.js";
import type { ManagementPolicy } from "../../domain/rules/managementRules.js";
import type { PortfolioRiskPolicy } from "../../domain/rules/riskRules.js";
import type { RebalanceActionRequestPayload } from "../usecases/requestRebalance.js";

import {
  createReplaySuccess,
  type ReplaySimulationFixture,
} from "./ReplaySimulationGateway.js";

export interface SimulationScenarioPack {
  name:
    | "stop_loss"
    | "rebalance"
    | "timeout_reconciliation"
    | "circuit_breaker";
  fixture: ReplaySimulationFixture;
  managementPolicy: ManagementPolicy;
  riskPolicy: PortfolioRiskPolicy;
  rebalancePlanner?: (input: {
    position: Position;
  }) => RebalanceActionRequestPayload | null;
}

const WALLET = "wallet_sim_001";

const baseManagementPolicy: ManagementPolicy = {
  stopLossUsd: 20,
  maxHoldMinutes: 0,
  maxOutOfRangeMinutes: 0,
  claimFeesThresholdUsd: 100,
  partialCloseEnabled: false,
  partialCloseProfitTargetUsd: 0,
  rebalanceEnabled: true,
  maxRebalancesPerPosition: 3,
};

const baseRiskPolicy: PortfolioRiskPolicy = {
  minReserveUsd: 10,
  dailyLossLimitPct: 20,
  circuitBreakerCooldownMin: 180,
  maxCapitalUsagePct: 90,
  maxPoolExposurePct: 70,
  maxTokenExposurePct: 80,
  maxConcurrentPositions: 5,
  maxNewDeploysPerHour: 5,
  maxRebalancesPerPosition: 3,
};

function buildPosition(overrides: Partial<Position>): Position {
  return {
    positionId: "pos_sim_001",
    poolAddress: "pool_sim_001",
    tokenXMint: "mint_x",
    tokenYMint: "mint_y",
    baseMint: "mint_base",
    quoteMint: "mint_quote",
    wallet: WALLET,
    status: "OPEN",
    openedAt: "2026-04-21T00:00:00.000Z",
    lastSyncedAt: "2026-04-21T00:00:00.000Z",
    closedAt: null,
    deployAmountBase: 1,
    deployAmountQuote: 0.5,
    currentValueBase: 1,
    currentValueUsd: 100,
    feesClaimedBase: 0,
    feesClaimedUsd: 0,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    rebalanceCount: 0,
    partialCloseCount: 0,
    strategy: "bid_ask",
    rangeLowerBin: 10,
    rangeUpperBin: 20,
    activeBin: 15,
    outOfRangeSince: null,
    lastManagementDecision: null,
    lastManagementReason: null,
    lastWriteActionId: null,
    needsReconciliation: false,
    ...overrides,
  };
}

function buildQueuedDeployAction(): Action {
  return {
    actionId: "act_sim_deploy_001",
    type: "DEPLOY",
    status: "QUEUED",
    wallet: WALLET,
    positionId: null,
    idempotencyKey: "sim:deploy:001",
    requestPayload: {
      poolAddress: "pool_timeout_001",
      tokenXMint: "mint_x",
      tokenYMint: "mint_y",
      baseMint: "mint_base",
      quoteMint: "mint_quote",
      amountBase: 1,
      amountQuote: 0.5,
      strategy: "bid_ask",
      rangeLowerBin: 10,
      rangeUpperBin: 20,
      initialActiveBin: 15,
      estimatedValueUsd: 60,
    },
    resultPayload: null,
    txIds: [],
    error: null,
    requestedAt: "2026-04-21T02:00:00.000Z",
    startedAt: null,
    completedAt: null,
    requestedBy: "system",
  };
}

function buildDailyLossJournalEvent(input: {
  timestamp: string;
  beforeRealizedPnlUsd: number;
  afterRealizedPnlUsd: number;
}): JournalEvent {
  const before = buildPosition({
    positionId: "pos_closed_loss_001",
    status: "OPEN",
    currentValueUsd: 30,
    realizedPnlUsd: input.beforeRealizedPnlUsd,
  });
  const after = buildPosition({
    positionId: "pos_closed_loss_001",
    status: "CLOSED",
    closedAt: input.timestamp,
    currentValueUsd: 0,
    realizedPnlUsd: input.afterRealizedPnlUsd,
  });

  return {
    timestamp: input.timestamp,
    eventType: "CLOSE_FINALIZED",
    actor: "system",
    wallet: WALLET,
    positionId: "pos_closed_loss_001",
    actionId: "act_closed_loss_001",
    before,
    after,
    txIds: ["tx_closed_loss_001"],
    resultStatus: "DONE",
    error: null,
  };
}

const rebalanceRedeployPayload: RebalanceActionRequestPayload = {
  reason: "range invalid",
  redeploy: {
    poolAddress: "pool_sim_002",
    tokenXMint: "mint_x",
    tokenYMint: "mint_y",
    baseMint: "mint_base",
    quoteMint: "mint_quote",
    amountBase: 0.9,
    amountQuote: 0.45,
    strategy: "bid_ask",
    rangeLowerBin: 30,
    rangeUpperBin: 40,
    initialActiveBin: 35,
    estimatedValueUsd: 100,
  },
};

export function createStopLossScenarioPack(): SimulationScenarioPack {
  const positionId = "pos_stop_loss_001";
  return {
    name: "stop_loss",
    fixture: {
      wallet: WALLET,
      initialPositions: [
        buildPosition({
          positionId,
          currentValueUsd: 75,
          unrealizedPnlUsd: -25,
        }),
      ],
      initialActions: [],
      initialJournalEvents: [],
      steps: [
        {
          timestamp: "2026-04-21T00:00:00.000Z",
          walletBalanceSol: 1,
          solPriceUsd: 40,
          onChainPositions: [
            buildPosition({
              positionId,
              currentValueUsd: 75,
              unrealizedPnlUsd: -25,
            }),
          ],
          signalsByPositionId: {},
        },
        {
          timestamp: "2026-04-21T00:05:00.000Z",
          walletBalanceSol: 1,
          solPriceUsd: 40,
          onChainPositions: [
            buildPosition({
              positionId,
              status: "CLOSE_CONFIRMED",
              currentValueUsd: 0,
              unrealizedPnlUsd: 0,
              realizedPnlUsd: -25,
              closedAt: "2026-04-21T00:05:00.000Z",
              lastSyncedAt: "2026-04-21T00:05:00.000Z",
            }),
          ],
          signalsByPositionId: {},
        },
      ],
      deployResponses: [],
      closeResponses: [],
      claimFeesResponses: [],
      partialCloseResponses: [],
      poolInfoByPool: {},
    },
    managementPolicy: baseManagementPolicy,
    riskPolicy: baseRiskPolicy,
  };
}

export function createRebalanceScenarioPack(): SimulationScenarioPack {
  const oldPositionId = "pos_rebalance_old_001";
  const newPositionId = "pos_rebalance_new_001";
  return {
    name: "rebalance",
    fixture: {
      wallet: WALLET,
      initialPositions: [
        buildPosition({
          positionId: oldPositionId,
          currentValueUsd: 120,
          activeBin: 25,
          rangeLowerBin: 10,
          rangeUpperBin: 20,
          outOfRangeSince: "2026-04-21T00:00:00.000Z",
        }),
      ],
      initialActions: [],
      initialJournalEvents: [],
      steps: [
        {
          timestamp: "2026-04-21T00:00:00.000Z",
          walletBalanceSol: 1,
          solPriceUsd: 50,
          onChainPositions: [
            buildPosition({
              positionId: oldPositionId,
              currentValueUsd: 120,
              activeBin: 25,
              rangeLowerBin: 10,
              rangeUpperBin: 20,
              outOfRangeSince: "2026-04-21T00:00:00.000Z",
            }),
          ],
          signalsByPositionId: {
            [oldPositionId]: {
              forcedManualClose: false,
              severeTokenRisk: false,
              liquidityCollapse: false,
              severeNegativeYield: false,
              claimableFeesUsd: 0,
              expectedRebalanceImprovement: true,
              dataIncomplete: false,
            },
          },
        },
        {
          timestamp: "2026-04-21T00:05:00.000Z",
          walletBalanceSol: 1,
          solPriceUsd: 50,
          onChainPositions: [
            buildPosition({
              positionId: oldPositionId,
              status: "CLOSE_CONFIRMED",
              currentValueUsd: 120,
              unrealizedPnlUsd: 0,
              realizedPnlUsd: 10,
              closedAt: "2026-04-21T00:05:00.000Z",
              lastSyncedAt: "2026-04-21T00:05:00.000Z",
            }),
            buildPosition({
              positionId: newPositionId,
              poolAddress: "pool_sim_002",
              rangeLowerBin: 30,
              rangeUpperBin: 40,
              activeBin: 35,
              currentValueUsd: 100,
              rebalanceCount: 1,
              openedAt: "2026-04-21T00:05:00.000Z",
              lastSyncedAt: "2026-04-21T00:05:00.000Z",
            }),
          ],
          signalsByPositionId: {},
        },
        {
          timestamp: "2026-04-21T00:10:00.000Z",
          walletBalanceSol: 1,
          solPriceUsd: 50,
          onChainPositions: [
            buildPosition({
              positionId: newPositionId,
              poolAddress: "pool_sim_002",
              rangeLowerBin: 30,
              rangeUpperBin: 40,
              activeBin: 35,
              currentValueUsd: 100,
              rebalanceCount: 1,
              openedAt: "2026-04-21T00:05:00.000Z",
              lastSyncedAt: "2026-04-21T00:10:00.000Z",
            }),
          ],
          signalsByPositionId: {},
        },
      ],
      deployResponses: [
        createReplaySuccess({
          actionType: "DEPLOY",
          positionId: newPositionId,
          txIds: ["tx_redeploy_001"],
        }),
      ],
      closeResponses: [],
      claimFeesResponses: [],
      partialCloseResponses: [],
      poolInfoByPool: {},
    },
    managementPolicy: baseManagementPolicy,
    riskPolicy: baseRiskPolicy,
    rebalancePlanner: ({ position }) => {
      if (position.positionId !== oldPositionId) {
        return null;
      }

      return rebalanceRedeployPayload;
    },
  };
}

export function createTimeoutReconciliationScenarioPack(): SimulationScenarioPack {
  return {
    name: "timeout_reconciliation",
    fixture: {
      wallet: WALLET,
      initialPositions: [],
      initialActions: [buildQueuedDeployAction()],
      initialJournalEvents: [],
      steps: [
        {
          timestamp: "2026-04-21T02:00:00.000Z",
          walletBalanceSol: 2,
          solPriceUsd: 30,
          onChainPositions: [],
          signalsByPositionId: {},
        },
        {
          timestamp: "2026-04-21T02:05:00.000Z",
          walletBalanceSol: 2,
          solPriceUsd: 30,
          onChainPositions: [],
          signalsByPositionId: {},
        },
      ],
      deployResponses: [
        createReplaySuccess({
          actionType: "DEPLOY",
          positionId: "pos_timeout_001",
          txIds: ["tx_timeout_001"],
        }),
      ],
      closeResponses: [],
      claimFeesResponses: [],
      partialCloseResponses: [],
      poolInfoByPool: {},
    },
    managementPolicy: baseManagementPolicy,
    riskPolicy: baseRiskPolicy,
  };
}

export function createCircuitBreakerScenarioPack(): SimulationScenarioPack {
  const positionId = "pos_breaker_001";
  return {
    name: "circuit_breaker",
    fixture: {
      wallet: WALLET,
      initialPositions: [
        buildPosition({
          positionId,
          currentValueUsd: 60,
        }),
      ],
      initialActions: [],
      initialJournalEvents: [
        buildDailyLossJournalEvent({
          timestamp: "2026-04-21T00:00:00.000Z",
          beforeRealizedPnlUsd: 0,
          afterRealizedPnlUsd: -50,
        }),
      ],
      steps: [
        {
          timestamp: "2026-04-21T00:00:00.000Z",
          walletBalanceSol: 1,
          solPriceUsd: 40,
          onChainPositions: [
            buildPosition({
              positionId,
              currentValueUsd: 60,
            }),
          ],
          signalsByPositionId: {},
        },
        {
          timestamp: "2026-04-21T00:05:00.000Z",
          walletBalanceSol: 1,
          solPriceUsd: 40,
          onChainPositions: [
            buildPosition({
              positionId,
              status: "CLOSE_CONFIRMED",
              currentValueUsd: 0,
              unrealizedPnlUsd: 0,
              realizedPnlUsd: 0,
              closedAt: "2026-04-21T00:05:00.000Z",
              lastSyncedAt: "2026-04-21T00:05:00.000Z",
            }),
          ],
          signalsByPositionId: {},
        },
      ],
      deployResponses: [],
      closeResponses: [],
      claimFeesResponses: [],
      partialCloseResponses: [],
      poolInfoByPool: {},
    },
    managementPolicy: {
      ...baseManagementPolicy,
      stopLossUsd: 0,
    },
    riskPolicy: {
      ...baseRiskPolicy,
      dailyLossLimitPct: 20,
    },
  };
}

export const SIMULATION_SCENARIO_PACKS = [
  createStopLossScenarioPack(),
  createRebalanceScenarioPack(),
  createTimeoutReconciliationScenarioPack(),
  createCircuitBreakerScenarioPack(),
] as const;
