import { z } from "zod";

import type { ActionRepository } from "../../adapters/storage/ActionRepository.js";
import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { StateRepository } from "../../adapters/storage/StateRepository.js";
import type { PriceGateway } from "../../adapters/pricing/PriceGateway.js";
import type { RuntimePolicyStore } from "../../adapters/config/RuntimePolicyStore.js";
import type { LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import type { PerformanceRepositoryInterface } from "../../adapters/storage/PerformanceRepository.js";
import type { PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import type { WalletGateway } from "../../adapters/wallet/WalletGateway.js";
import type { Action } from "../../domain/entities/Action.js";
import { type PortfolioState } from "../../domain/entities/PortfolioState.js";
import {
  type PortfolioRiskPolicy,
} from "../../domain/rules/riskRules.js";
import type { Actor } from "../../domain/types/enums.js";
import { createUlid } from "../../infra/id/createUlid.js";
import type { ActionQueue } from "../services/ActionQueue.js";
import type { PolicyProvider } from "../services/PolicyProvider.js";
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
  z.object({
    kind: z.literal("LESSONS_LIST"),
    role: z.enum(["SCREENER", "MANAGER", "GENERAL"]).nullable().default(null),
    pinned: z.boolean().nullable().default(null),
    tag: z.string().min(1).nullable().default(null),
    limit: z.number().int().positive().default(30),
  }),
  z.object({
    kind: z.literal("LESSONS_PIN"),
    id: z.string().min(1),
  }),
  z.object({
    kind: z.literal("LESSONS_UNPIN"),
    id: z.string().min(1),
  }),
  z.object({
    kind: z.literal("LESSONS_ADD"),
    rule: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
    pinned: z.boolean().default(false),
    role: z.enum(["SCREENER", "MANAGER", "GENERAL"]).nullable().default(null),
  }),
  z.object({
    kind: z.literal("LESSONS_REMOVE"),
    id: z.string().min(1),
  }),
  z.object({
    kind: z.literal("LESSONS_REMOVE_BY_KEYWORD"),
    keyword: z.string().min(1),
  }),
  z.object({
    kind: z.literal("LESSONS_CLEAR"),
    confirm: z.literal(true),
  }),
  z.object({
    kind: z.literal("PERFORMANCE_SUMMARY"),
  }),
  z.object({
    kind: z.literal("PERFORMANCE_HISTORY"),
    hours: z.number().int().positive().nullable().default(null),
    limit: z.number().int().positive().default(20),
  }),
  z.object({
    kind: z.literal("POLICY_SHOW"),
  }),
  z.object({
    kind: z.literal("POLICY_RESET"),
    confirm: z.literal(true),
  }),
  z.object({
    kind: z.literal("POOL_MEMORY"),
    poolAddress: z.string().min(1),
  }),
  z.object({
    kind: z.literal("POOL_NOTE"),
    poolAddress: z.string().min(1),
    note: z.string().min(1),
  }),
  z.object({
    kind: z.literal("POOL_COOLDOWN"),
    poolAddress: z.string().min(1),
    hours: z.number().positive(),
  }),
  z.object({
    kind: z.literal("POOL_COOLDOWN_CLEAR"),
    poolAddress: z.string().min(1),
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
  lessonRepository?: LessonRepositoryInterface;
  performanceRepository?: PerformanceRepositoryInterface;
  poolMemoryRepository?: PoolMemoryRepository;
  runtimePolicyStore?: RuntimePolicyStore;
  policyProvider?: PolicyProvider;
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

  if (normalized === "performance summary") {
    return OperatorCommandSchema.parse({ kind: "PERFORMANCE_SUMMARY" });
  }

  if (normalized === "policy show") {
    return OperatorCommandSchema.parse({ kind: "POLICY_SHOW" });
  }

  if (normalized === "policy reset confirm=true") {
    return OperatorCommandSchema.parse({
      kind: "POLICY_RESET",
      confirm: true,
    });
  }

  const poolMemoryMatch = normalized.match(/^pool\s+memory\s+(\S+)$/);
  if (poolMemoryMatch !== null) {
    return OperatorCommandSchema.parse({
      kind: "POOL_MEMORY",
      poolAddress: requireCapture(poolMemoryMatch[1], "pool memory"),
    });
  }

  const poolNoteMatch = normalized.match(/^pool\s+note\s+(\S+)\s+(.+)$/s);
  if (poolNoteMatch !== null) {
    return OperatorCommandSchema.parse({
      kind: "POOL_NOTE",
      poolAddress: requireCapture(poolNoteMatch[1], "pool note"),
      note: requireCapture(poolNoteMatch[2], "pool note").trim(),
    });
  }

  const poolCooldownMatch = normalized.match(/^pool\s+cooldown\s+(\S+)\s+(\d+(?:\.\d+)?)$/);
  if (poolCooldownMatch !== null) {
    return OperatorCommandSchema.parse({
      kind: "POOL_COOLDOWN",
      poolAddress: requireCapture(poolCooldownMatch[1], "pool cooldown"),
      hours: Number(requireCapture(poolCooldownMatch[2], "pool cooldown")),
    });
  }

  const poolCooldownClearMatch = normalized.match(/^pool\s+cooldown_clear\s+(\S+)$/);
  if (poolCooldownClearMatch !== null) {
    return OperatorCommandSchema.parse({
      kind: "POOL_COOLDOWN_CLEAR",
      poolAddress: requireCapture(poolCooldownClearMatch[1], "pool cooldown_clear"),
    });
  }

  const performanceHistoryMatch = normalized.match(/^performance-history(?:\s+(\d+))?(?:\s+(\d+))?$/);
  if (performanceHistoryMatch !== null) {
    const [, hoursRaw, limitRaw] = performanceHistoryMatch;
    return OperatorCommandSchema.parse({
      kind: "PERFORMANCE_HISTORY",
      ...(hoursRaw === undefined ? {} : { hours: Number(hoursRaw) }),
      ...(limitRaw === undefined ? {} : { limit: Number(limitRaw) }),
    });
  }

  const lessonsListMatch = normalized.match(/^lessons\s+list(?:\s+(.+))?$/);
  if (lessonsListMatch !== null) {
    const tail = lessonsListMatch[1]?.trim() ?? "";
    const args = tail.length === 0 ? [] : tail.split(/\s+/);
    const payload: Record<string, unknown> = {
      kind: "LESSONS_LIST",
    };
    for (let index = 0; index < args.length; index += 1) {
      const part = args[index];
      if (part === "--role") {
        payload.role = args[index + 1] ?? null;
        index += 1;
        continue;
      }
      if (part === "--tag") {
        payload.tag = args[index + 1] ?? null;
        index += 1;
        continue;
      }
      if (part === "--limit") {
        payload.limit = Number(args[index + 1] ?? "30");
        index += 1;
        continue;
      }
      if (part === "--pinned") {
        payload.pinned = true;
      }
      if (part === "--unpinned") {
        payload.pinned = false;
      }
    }
    return OperatorCommandSchema.parse(payload);
  }

  const lessonsPinMatch = normalized.match(/^lessons\s+pin\s+(\S+)$/);
  if (lessonsPinMatch !== null) {
    return OperatorCommandSchema.parse({
      kind: "LESSONS_PIN",
      id: requireCapture(lessonsPinMatch[1], "lessons pin"),
    });
  }

  const lessonsUnpinMatch = normalized.match(/^lessons\s+unpin\s+(\S+)$/);
  if (lessonsUnpinMatch !== null) {
    return OperatorCommandSchema.parse({
      kind: "LESSONS_UNPIN",
      id: requireCapture(lessonsUnpinMatch[1], "lessons unpin"),
    });
  }

  const lessonsAddMatch = normalized.match(/^lessons\s+add\s+(.+)$/s);
  if (lessonsAddMatch !== null) {
    return OperatorCommandSchema.parse({
      kind: "LESSONS_ADD",
      rule: requireCapture(lessonsAddMatch[1], "lessons add").trim(),
    });
  }

  const lessonsRemoveMatch = normalized.match(/^lessons\s+remove\s+(\S+)$/);
  if (lessonsRemoveMatch !== null) {
    return OperatorCommandSchema.parse({
      kind: "LESSONS_REMOVE",
      id: requireCapture(lessonsRemoveMatch[1], "lessons remove"),
    });
  }

  const lessonsRemoveKeywordMatch = normalized.match(/^lessons\s+remove-by-keyword\s+(.+)$/s);
  if (lessonsRemoveKeywordMatch !== null) {
    return OperatorCommandSchema.parse({
      kind: "LESSONS_REMOVE_BY_KEYWORD",
      keyword: requireCapture(lessonsRemoveKeywordMatch[1], "lessons remove-by-keyword").trim(),
    });
  }

  if (normalized === "lessons clear confirm=true") {
    return OperatorCommandSchema.parse({
      kind: "LESSONS_CLEAR",
      confirm: true,
    });
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
    "unknown command; supported commands: status, positions, pending-actions, close, deploy, rebalance, lessons list/pin/unpin/add/remove/remove-by-keyword/clear, performance summary, performance-history, policy show, policy reset, pool memory/note/cooldown/cooldown_clear",
  );
}

function requireLessonsRepository(
  repository: LessonRepositoryInterface | undefined,
): LessonRepositoryInterface {
  if (repository === undefined) {
    throw new Error("lesson repository is required for lessons commands");
  }

  return repository;
}

function requirePerformanceRepository(
  repository: PerformanceRepositoryInterface | undefined,
): PerformanceRepositoryInterface {
  if (repository === undefined) {
    throw new Error("performance repository is required for performance commands");
  }

  return repository;
}

function requireRuntimePolicyStore(
  runtimePolicyStore: RuntimePolicyStore | undefined,
): RuntimePolicyStore {
  if (runtimePolicyStore === undefined) {
    throw new Error("runtime policy store is required for policy commands");
  }

  return runtimePolicyStore;
}

function requirePolicyProvider(
  policyProvider: PolicyProvider | undefined,
): PolicyProvider {
  if (policyProvider === undefined) {
    throw new Error("policy provider is required for policy commands");
  }

  return policyProvider;
}

function requirePoolMemoryRepository(
  repository: PoolMemoryRepository | undefined,
): PoolMemoryRepository {
  if (repository === undefined) {
    throw new Error("pool memory repository is required for pool commands");
  }

  return repository;
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
    case "LESSONS_LIST": {
      const command = input.command;
      const lessonRepository = requireLessonsRepository(input.lessonRepository);
      const lessons = (await lessonRepository.list())
        .filter((lesson) =>
          command.role === null ? true : lesson.role === null || lesson.role === command.role,
        )
        .filter((lesson) =>
          command.pinned === null ? true : lesson.pinned === command.pinned,
        )
        .filter((lesson) =>
          command.tag === null ? true : lesson.tags.includes(command.tag.toLowerCase()),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, command.limit);

      return {
        command: input.command.kind,
        text:
          lessons.length === 0
            ? "no lessons"
            : lessons
                .map((lesson) =>
                  [
                    lesson.id,
                    lesson.outcome,
                    lesson.role ?? "ALL",
                    lesson.pinned ? "PINNED" : "normal",
                    lesson.rule,
                  ].join(" | "),
                )
                .join("\n"),
        actionId: null,
      };
    }
    case "LESSONS_PIN": {
      const lessonRepository = requireLessonsRepository(input.lessonRepository);
      await lessonRepository.update(input.command.id, { pinned: true });
      return {
        command: input.command.kind,
        text: `lesson pinned: ${input.command.id}`,
        actionId: null,
      };
    }
    case "LESSONS_UNPIN": {
      const lessonRepository = requireLessonsRepository(input.lessonRepository);
      await lessonRepository.update(input.command.id, { pinned: false });
      return {
        command: input.command.kind,
        text: `lesson unpinned: ${input.command.id}`,
        actionId: null,
      };
    }
    case "LESSONS_ADD": {
      const lessonRepository = requireLessonsRepository(input.lessonRepository);
      await lessonRepository.append({
        id: createUlid(Date.parse(requestedAt)),
        rule: input.command.rule,
        tags: input.command.tags,
        outcome: "manual",
        role: input.command.role,
        pinned: input.command.pinned,
        createdAt: requestedAt,
      });
      return {
        command: input.command.kind,
        text: "lesson added",
        actionId: null,
      };
    }
    case "LESSONS_REMOVE": {
      const lessonRepository = requireLessonsRepository(input.lessonRepository);
      const removed = await lessonRepository.remove(input.command.id);
      return {
        command: input.command.kind,
        text: removed > 0 ? `lesson removed: ${input.command.id}` : `lesson not found: ${input.command.id}`,
        actionId: null,
      };
    }
    case "LESSONS_REMOVE_BY_KEYWORD": {
      const lessonRepository = requireLessonsRepository(input.lessonRepository);
      const lessons = await lessonRepository.list();
      let removed = 0;
      for (const lesson of lessons) {
        if (lesson.rule.toLowerCase().includes(input.command.keyword.toLowerCase())) {
          removed += await lessonRepository.remove(lesson.id);
        }
      }
      return {
        command: input.command.kind,
        text: `lessons removed: ${removed}`,
        actionId: null,
      };
    }
    case "LESSONS_CLEAR": {
      const lessonRepository = requireLessonsRepository(input.lessonRepository);
      const cleared = await lessonRepository.clear();
      return {
        command: input.command.kind,
        text: `lessons cleared: ${cleared}`,
        actionId: null,
      };
    }
    case "PERFORMANCE_SUMMARY": {
      const performanceRepository = requirePerformanceRepository(
        input.performanceRepository,
      );
      const summary = await performanceRepository.summary();
      return {
        command: input.command.kind,
        text: [
          `closed: ${summary.totalPositionsClosed}`,
          `total pnl usd: ${summary.totalPnlUsd.toFixed(2)}`,
          `avg pnl pct: ${summary.avgPnlPct.toFixed(2)}`,
          `win rate pct: ${summary.winRatePct.toFixed(2)}`,
        ].join("\n"),
        actionId: null,
      };
    }
    case "PERFORMANCE_HISTORY": {
      const performanceRepository = requirePerformanceRepository(
        input.performanceRepository,
      );
      const sinceIso =
        input.command.hours === null
          ? undefined
          : new Date(
              Date.parse(requestedAt) - input.command.hours * 60 * 60 * 1000,
            ).toISOString();
      const records = await performanceRepository.list({
        ...(sinceIso === undefined ? {} : { sinceIso }),
        limit: input.command.limit,
      });

      return {
        command: input.command.kind,
        text:
          records.length === 0
            ? "no performance history"
            : records
                .map((record) =>
                  [
                    record.positionId,
                    record.recordedAt,
                    record.pnlUsd.toFixed(2),
                    record.pnlPct.toFixed(2),
                    record.closeReason,
                  ].join(" | "),
                )
                .join("\n"),
        actionId: null,
      };
    }
    case "POLICY_SHOW": {
      const runtimePolicyStore = requireRuntimePolicyStore(input.runtimePolicyStore);
      const policyProvider = requirePolicyProvider(input.policyProvider);
      const snapshot = await runtimePolicyStore.snapshot();
      const resolvedPolicy = await policyProvider.resolveScreeningPolicy();

      return {
        command: input.command.kind,
        text: JSON.stringify({
          policy: resolvedPolicy,
          overrides: snapshot.overrides,
          ...(snapshot.lastEvolvedAt === undefined
            ? {}
            : { lastEvolvedAt: snapshot.lastEvolvedAt }),
          ...(snapshot.positionsAtEvolution === undefined
            ? {}
            : { positionsAtEvolution: snapshot.positionsAtEvolution }),
          rationale: snapshot.rationale,
        }, null, 2),
        actionId: null,
      };
    }
    case "POLICY_RESET": {
      const runtimePolicyStore = requireRuntimePolicyStore(input.runtimePolicyStore);
      await runtimePolicyStore.reset();
      return {
        command: input.command.kind,
        text: "policy overrides reset",
        actionId: null,
      };
    }
    case "POOL_MEMORY": {
      const poolMemoryRepository = requirePoolMemoryRepository(
        input.poolMemoryRepository,
      );
      const entry = await poolMemoryRepository.get(input.command.poolAddress);
      return {
        command: input.command.kind,
        text:
          entry === null
            ? "no pool memory"
            : JSON.stringify(entry, null, 2),
        actionId: null,
      };
    }
    case "POOL_NOTE": {
      const poolMemoryRepository = requirePoolMemoryRepository(
        input.poolMemoryRepository,
      );
      await poolMemoryRepository.addNote(
        input.command.poolAddress,
        input.command.note,
        requestedAt,
      );
      return {
        command: input.command.kind,
        text: "pool note added",
        actionId: null,
      };
    }
    case "POOL_COOLDOWN": {
      const poolMemoryRepository = requirePoolMemoryRepository(
        input.poolMemoryRepository,
      );
      const untilIso = new Date(
        Date.parse(requestedAt) + input.command.hours * 60 * 60 * 1000,
      ).toISOString();
      await poolMemoryRepository.setCooldown(input.command.poolAddress, untilIso);
      return {
        command: input.command.kind,
        text: `pool cooldown set until ${untilIso}`,
        actionId: null,
      };
    }
    case "POOL_COOLDOWN_CLEAR": {
      const poolMemoryRepository = requirePoolMemoryRepository(
        input.poolMemoryRepository,
      );
      await poolMemoryRepository.setCooldown(input.command.poolAddress, null);
      return {
        command: input.command.kind,
        text: "pool cooldown cleared",
        actionId: null,
      };
    }
  }
}
