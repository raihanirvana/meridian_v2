import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { PriceGateway } from "../../adapters/pricing/PriceGateway.js";
import type { WalletGateway } from "../../adapters/wallet/WalletGateway.js";
import { type Action } from "../../domain/entities/Action.js";
import { PositionSchema } from "../../domain/entities/Position.js";
import {
  PortfolioStateSchema,
  type PortfolioState,
} from "../../domain/entities/PortfolioState.js";
import { type Position } from "../../domain/entities/Position.js";
import { deriveDrawdownState } from "../../domain/rules/riskRules.js";

const ACTIVE_CAPITAL_STATUSES = new Set<Position["status"]>([
  "DEPLOYING",
  "OPEN",
  "MANAGEMENT_REVIEW",
  "HOLD",
  "CLAIM_REQUESTED",
  "CLAIMING",
  "CLAIM_CONFIRMED",
  "PARTIAL_CLOSE_REQUESTED",
  "PARTIAL_CLOSING",
  "PARTIAL_CLOSE_CONFIRMED",
  "REBALANCE_REQUESTED",
  "CLOSING_FOR_REBALANCE",
  "CLOSE_REQUESTED",
  "CLOSING",
  "CLOSE_CONFIRMED",
  "REDEPLOY_REQUESTED",
  "REDEPLOYING",
  "RECONCILIATION_REQUIRED",
  "RECONCILING",
]);

const PENDING_ACTION_STATUSES = new Set<Action["status"]>([
  "QUEUED",
  "RUNNING",
  "WAITING_CONFIRMATION",
  "RECONCILING",
  "RETRY_QUEUED",
]);

function uniqueTokenMints(position: Position): string[] {
  return [...new Set([
    position.tokenXMint,
    position.tokenYMint,
    position.baseMint,
    position.quoteMint,
  ])];
}

function isSameUtcDay(left: string, right: string): boolean {
  return left.slice(0, 10) === right.slice(0, 10);
}

function parsePositionSnapshot(value: unknown): Position | null {
  const parsed = PositionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function deriveDailyRealizedPnlFromJournal(input: {
  wallet: string;
  now: string;
  events: Awaited<ReturnType<JournalRepository["list"]>>;
}): number {
  return input.events
    .filter(
      (event) =>
        event.wallet === input.wallet && isSameUtcDay(event.timestamp, input.now),
    )
    .reduce((total, event) => {
      const beforePosition = parsePositionSnapshot(event.before);
      const afterPosition = parsePositionSnapshot(event.after);
      const beforeRealized = beforePosition?.realizedPnlUsd ?? 0;
      const afterRealized = afterPosition?.realizedPnlUsd ?? 0;
      return total + (afterRealized - beforeRealized);
    }, 0);
}

function toExposurePct(valueUsd: number, totalEquityUsd: number): number {
  if (totalEquityUsd <= 0) {
    return 0;
  }

  return (Math.max(valueUsd, 0) / totalEquityUsd) * 100;
}

function diffMinutes(from: string, to: string): number | null {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return null;
  }

  return Math.max(0, Math.floor((toMs - fromMs) / 60_000));
}

function resolveCircuitBreakerLifecycle(input: {
  now: string;
  dailyLossPct: number;
  dailyLossLimitPct: number;
  cooldownMin: number;
  previousPortfolioState: PortfolioState | null;
}): Pick<
  PortfolioState,
  | "circuitBreakerState"
  | "circuitBreakerActivatedAt"
  | "circuitBreakerCooldownStartedAt"
> {
  if (input.dailyLossPct >= input.dailyLossLimitPct) {
    return {
      circuitBreakerState: "ON",
      circuitBreakerActivatedAt:
        input.previousPortfolioState?.circuitBreakerActivatedAt ?? input.now,
      circuitBreakerCooldownStartedAt: null,
    };
  }

  if (input.previousPortfolioState?.circuitBreakerState === "ON") {
    return {
      circuitBreakerState: "COOLDOWN",
      circuitBreakerActivatedAt:
        input.previousPortfolioState.circuitBreakerActivatedAt ?? input.now,
      circuitBreakerCooldownStartedAt:
        input.previousPortfolioState.circuitBreakerCooldownStartedAt ?? input.now,
    };
  }

  if (input.previousPortfolioState?.circuitBreakerState === "COOLDOWN") {
    const cooldownStartedAt =
      input.previousPortfolioState.circuitBreakerCooldownStartedAt ??
      input.previousPortfolioState.circuitBreakerActivatedAt ??
      input.now;
    const cooldownMinutes = diffMinutes(cooldownStartedAt, input.now);

    if (cooldownMinutes !== null && cooldownMinutes < input.cooldownMin) {
      return {
        circuitBreakerState: "COOLDOWN",
        circuitBreakerActivatedAt:
          input.previousPortfolioState.circuitBreakerActivatedAt ?? null,
        circuitBreakerCooldownStartedAt: cooldownStartedAt,
      };
    }
  }

  return {
    circuitBreakerState: "OFF",
    circuitBreakerActivatedAt: null,
    circuitBreakerCooldownStartedAt: null,
  };
}

export interface BuildPortfolioStateInput {
  wallet: string;
  minReserveUsd: number;
  dailyLossLimitPct: number;
  circuitBreakerCooldownMin: number;
  stateRepository: StateRepository;
  actionRepository: ActionRepository;
  journalRepository: JournalRepository;
  walletGateway: WalletGateway;
  priceGateway: PriceGateway;
  previousPortfolioState?: PortfolioState | null;
  now?: string;
}

export async function buildPortfolioState(
  input: BuildPortfolioStateInput,
): Promise<PortfolioState> {
  const now = input.now ?? new Date().toISOString();
  const [positions, actions, journalEvents, walletBalanceSnapshot, solPriceQuote] =
    await Promise.all([
      input.stateRepository.list(),
      input.actionRepository.list(),
      input.journalRepository.list(),
      input.walletGateway.getWalletBalance(input.wallet),
      input.priceGateway.getSolPriceUsd(),
    ]);

  const walletPositions = positions.filter(
    (position) => position.wallet === input.wallet,
  );
  const activePositions = walletPositions.filter((position) =>
    ACTIVE_CAPITAL_STATUSES.has(position.status),
  );
  const totalPositionValueUsd = activePositions.reduce(
    (total, position) => total + position.currentValueUsd,
    0,
  );
  const idleWalletUsd = walletBalanceSnapshot.balanceSol * solPriceQuote.priceUsd;
  const totalEquityUsd = idleWalletUsd + totalPositionValueUsd;
  const reservedBalance = Math.min(
    idleWalletUsd,
    Math.max(input.minReserveUsd, 0),
  );
  const availableBalance = Math.max(idleWalletUsd - reservedBalance, 0);
  const pendingActions = actions.filter(
    (action) =>
      action.wallet === input.wallet &&
      PENDING_ACTION_STATUSES.has(action.status),
  ).length;
  const dailyRealizedPnl = deriveDailyRealizedPnlFromJournal({
    wallet: input.wallet,
    now,
    events: journalEvents,
  });
  const dailyLossPct =
    totalEquityUsd <= 0
      ? 0
      : (Math.max(-dailyRealizedPnl, 0) / totalEquityUsd) * 100;
  const drawdownState = deriveDrawdownState({
    dailyLossPct,
    dailyLossLimitPct: input.dailyLossLimitPct,
  });
  const circuitBreakerSnapshot = resolveCircuitBreakerLifecycle({
    now,
    dailyLossPct,
    dailyLossLimitPct: input.dailyLossLimitPct,
    cooldownMin: input.circuitBreakerCooldownMin,
    previousPortfolioState: input.previousPortfolioState ?? null,
  });

  const exposureByPool: Record<string, number> = {};
  const exposureByToken: Record<string, number> = {};

  for (const position of activePositions) {
    const exposurePct = toExposurePct(position.currentValueUsd, totalEquityUsd);
    exposureByPool[position.poolAddress] =
      (exposureByPool[position.poolAddress] ?? 0) + exposurePct;

    for (const tokenMint of uniqueTokenMints(position)) {
      exposureByToken[tokenMint] =
        (exposureByToken[tokenMint] ?? 0) + exposurePct;
    }
  }

  return PortfolioStateSchema.parse({
    walletBalance: totalEquityUsd,
    reservedBalance,
    availableBalance,
    openPositions: activePositions.length,
    pendingActions,
    dailyRealizedPnl,
    drawdownState,
    circuitBreakerState: circuitBreakerSnapshot.circuitBreakerState,
    circuitBreakerActivatedAt: circuitBreakerSnapshot.circuitBreakerActivatedAt,
    circuitBreakerCooldownStartedAt:
      circuitBreakerSnapshot.circuitBreakerCooldownStartedAt,
    exposureByToken,
    exposureByPool,
  });
}
