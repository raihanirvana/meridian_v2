import { z } from "zod";

import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { PriceGateway } from "../../adapters/pricing/PriceGateway.js";
import type { WalletGateway } from "../../adapters/wallet/WalletGateway.js";
import type { Action } from "../../domain/entities/Action.js";
import { type PortfolioState } from "../../domain/entities/PortfolioState.js";
import {
  type PortfolioRiskPolicy,
} from "../../domain/rules/riskRules.js";
import type { Actor } from "../../domain/types/enums.js";
import type { ActionQueue } from "../services/ActionQueue.js";
import { buildPortfolioState } from "../services/PortfolioStateBuilder.js";

import {
  requestClose,
  type CloseActionRequestPayload,
} from "./requestClose.js";
import {
  requestDeploy,
  DeployActionRequestPayloadSchema,
  type DeployActionRequestPayload,
} from "./requestDeploy.js";
import {
  requestRebalance,
  RebalanceActionRequestPayloadSchema,
  type RebalanceActionRequestPayload,
} from "./requestRebalance.js";

const OperatorCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("STATUS"),
  }),
  z.object({
    kind: z.literal("POSITIONS"),
  }),
  z.object({
    kind: z.literal("PENDING_ACTIONS"),
  }),
  z.object({
    kind: z.literal("REQUEST_CLOSE"),
    positionId: z.string().min(1),
    payload: z.object({
      reason: z.string().min(1),
    }),
  }),
  z.object({
    kind: z.literal("REQUEST_DEPLOY"),
    payload: DeployActionRequestPayloadSchema,
  }),
  z.object({
    kind: z.literal("REQUEST_REBALANCE"),
    positionId: z.string().min(1),
    payload: RebalanceActionRequestPayloadSchema,
  }),
]);

export type OperatorCommand = z.infer<typeof OperatorCommandSchema>;

export interface OperatorCommandParseInput {
  raw: string;
}

export interface ExecuteOperatorCommandInput {
  command: OperatorCommand;
  wallet: string;
  requestedBy?: Actor;
  requestedAt?: string;
  actionQueue: ActionQueue;
  stateRepository: StateRepository;
  actionRepository: ActionRepository;
  journalRepository: JournalRepository;
  walletGateway: WalletGateway;
  priceGateway: PriceGateway;
  riskPolicy: PortfolioRiskPolicy;
  previousPortfolioState?: PortfolioState | null;
}

export interface OperatorCommandExecutionResult {
  command: OperatorCommand["kind"];
  text: string;
  actionId: string | null;
}

const PENDING_ACTION_STATUSES = new Set<Action["status"]>([
  "QUEUED",
  "RUNNING",
  "WAITING_CONFIRMATION",
  "RECONCILING",
  "RETRY_QUEUED",
]);

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message.length > 0
        ? `invalid JSON payload: ${error.message}`
        : "invalid JSON payload",
    );
  }
}

function stripLeadingSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

function requireCapture(
  value: string | undefined,
  label: string,
): string {
  if (value === undefined) {
    throw new Error(`invalid ${label} command`);
  }

  return value;
}

export function parseOperatorCommand(
  input: OperatorCommandParseInput,
): OperatorCommand {
  const raw = input.raw.trim();
  if (raw.length === 0) {
    throw new Error("command cannot be empty");
  }

  const normalized = stripLeadingSlash(raw);

  if (normalized === "status") {
    return OperatorCommandSchema.parse({ kind: "STATUS" });
  }

  if (normalized === "positions") {
    return OperatorCommandSchema.parse({ kind: "POSITIONS" });
  }

  if (normalized === "pending-actions") {
    return OperatorCommandSchema.parse({ kind: "PENDING_ACTIONS" });
  }

  const closeMatch = normalized.match(/^close\s+(\S+)\s+(.+)$/s);
  if (closeMatch !== null) {
    const [, positionId, reason] = closeMatch;
    return OperatorCommandSchema.parse({
      kind: "REQUEST_CLOSE",
      positionId: requireCapture(positionId, "close"),
      payload: {
        reason: requireCapture(reason, "close").trim(),
      } satisfies CloseActionRequestPayload,
    });
  }

  const deployMatch = normalized.match(/^deploy\s+(.+)$/s);
  if (deployMatch !== null) {
    const [, payloadRaw] = deployMatch;
    return OperatorCommandSchema.parse({
      kind: "REQUEST_DEPLOY",
      payload: DeployActionRequestPayloadSchema.parse(
        safeJsonParse(requireCapture(payloadRaw, "deploy")),
      ) satisfies DeployActionRequestPayload,
    });
  }

  const rebalanceMatch = normalized.match(/^rebalance\s+(\S+)\s+(.+)$/s);
  if (rebalanceMatch !== null) {
    const [, positionId, payloadRaw] = rebalanceMatch;
    return OperatorCommandSchema.parse({
      kind: "REQUEST_REBALANCE",
      positionId: requireCapture(positionId, "rebalance"),
      payload: RebalanceActionRequestPayloadSchema.parse(
        safeJsonParse(requireCapture(payloadRaw, "rebalance")),
      ) satisfies RebalanceActionRequestPayload,
    });
  }

  throw new Error(
    "unknown command; supported commands: status, positions, pending-actions, close, deploy, rebalance",
  );
}

function renderPortfolioStatus(portfolio: PortfolioState): string {
  return [
    `wallet balance usd: ${portfolio.walletBalance.toFixed(2)}`,
    `available usd: ${portfolio.availableBalance.toFixed(2)}`,
    `reserved usd: ${portfolio.reservedBalance.toFixed(2)}`,
    `open positions: ${portfolio.openPositions}`,
    `pending actions: ${portfolio.pendingActions}`,
    `daily realized pnl usd: ${portfolio.dailyRealizedPnl.toFixed(2)}`,
    `drawdown: ${portfolio.drawdownState}`,
    `circuit breaker: ${portfolio.circuitBreakerState}`,
  ].join("\n");
}

function renderPositions(positions: Awaited<ReturnType<StateRepository["list"]>>): string {
  if (positions.length === 0) {
    return "no positions";
  }

  return positions
    .map((position) =>
      [
        position.positionId,
        position.status,
        position.poolAddress,
        position.currentValueUsd.toFixed(2),
      ].join(" | "),
    )
    .join("\n");
}

function renderPendingActions(actions: Action[]): string {
  if (actions.length === 0) {
    return "no pending actions";
  }

  return actions
    .map((action) =>
      [
        action.actionId,
        action.type,
        action.status,
        action.positionId ?? "none",
      ].join(" | "),
    )
    .join("\n");
}

export async function executeOperatorCommand(
  input: ExecuteOperatorCommandInput,
): Promise<OperatorCommandExecutionResult> {
  const requestedBy = input.requestedBy ?? "operator";
  const requestedAt = input.requestedAt ?? new Date().toISOString();

  switch (input.command.kind) {
    case "STATUS": {
      const portfolio = await buildPortfolioState({
        wallet: input.wallet,
        minReserveUsd: input.riskPolicy.minReserveUsd,
        dailyLossLimitPct: input.riskPolicy.dailyLossLimitPct,
        circuitBreakerCooldownMin: input.riskPolicy.circuitBreakerCooldownMin,
        stateRepository: input.stateRepository,
        actionRepository: input.actionRepository,
        journalRepository: input.journalRepository,
        walletGateway: input.walletGateway,
        priceGateway: input.priceGateway,
        previousPortfolioState: input.previousPortfolioState ?? null,
        now: requestedAt,
      });

      return {
        command: input.command.kind,
        text: renderPortfolioStatus(portfolio),
        actionId: null,
      };
    }
    case "POSITIONS": {
      const positions = (await input.stateRepository.list())
        .filter((position) => position.wallet === input.wallet)
        .sort((left, right) => left.positionId.localeCompare(right.positionId));

      return {
        command: input.command.kind,
        text: renderPositions(positions),
        actionId: null,
      };
    }
    case "PENDING_ACTIONS": {
      const pendingActions = (await input.actionRepository.list())
        .filter(
          (action) =>
            action.wallet === input.wallet &&
            PENDING_ACTION_STATUSES.has(action.status),
        )
        .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));

      return {
        command: input.command.kind,
        text: renderPendingActions(pendingActions),
        actionId: null,
      };
    }
    case "REQUEST_CLOSE": {
      const action = await requestClose({
        actionQueue: input.actionQueue,
        stateRepository: input.stateRepository,
        wallet: input.wallet,
        positionId: input.command.positionId,
        payload: input.command.payload,
        requestedBy,
        requestedAt,
        journalRepository: input.journalRepository,
      });

      return {
        command: input.command.kind,
        text: `close request accepted: ${action.actionId}`,
        actionId: action.actionId,
      };
    }
    case "REQUEST_DEPLOY": {
      const action = await requestDeploy({
        actionQueue: input.actionQueue,
        wallet: input.wallet,
        payload: input.command.payload,
        requestedBy,
        requestedAt,
        journalRepository: input.journalRepository,
      });

      return {
        command: input.command.kind,
        text: `deploy request accepted: ${action.actionId}`,
        actionId: action.actionId,
      };
    }
    case "REQUEST_REBALANCE": {
      const action = await requestRebalance({
        actionQueue: input.actionQueue,
        stateRepository: input.stateRepository,
        wallet: input.wallet,
        positionId: input.command.positionId,
        payload: input.command.payload,
        requestedBy,
        requestedAt,
        journalRepository: input.journalRepository,
      });

      return {
        command: input.command.kind,
        text: `rebalance request accepted: ${action.actionId}`,
        actionId: action.actionId,
      };
    }
  }
}
