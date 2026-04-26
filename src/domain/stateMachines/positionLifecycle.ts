import { type PositionStatus, PositionStatusSchema } from "../types/enums.js";

const BASE_POSITION_TRANSITIONS = {
  DRAFT: ["DEPLOY_REQUESTED"],
  DEPLOY_REQUESTED: ["DEPLOYING", "FAILED", "ABORTED"],
  DEPLOYING: ["OPEN", "RECONCILIATION_REQUIRED", "FAILED", "ABORTED"],
  OPEN: ["MANAGEMENT_REVIEW"],
  MANAGEMENT_REVIEW: [
    "HOLD",
    "CLAIM_REQUESTED",
    "PARTIAL_CLOSE_REQUESTED",
    "REBALANCE_REQUESTED",
    "CLOSE_REQUESTED",
    "RECONCILIATION_REQUIRED",
  ],
  HOLD: [
    "OPEN",
    "MANAGEMENT_REVIEW",
    "CLOSE_REQUESTED",
    "RECONCILIATION_REQUIRED",
  ],
  CLAIM_REQUESTED: ["CLAIMING", "FAILED", "ABORTED"],
  CLAIMING: ["CLAIM_CONFIRMED", "RECONCILIATION_REQUIRED", "FAILED", "ABORTED"],
  CLAIM_CONFIRMED: ["OPEN", "MANAGEMENT_REVIEW", "RECONCILING"],
  PARTIAL_CLOSE_REQUESTED: ["PARTIAL_CLOSING", "FAILED", "ABORTED"],
  PARTIAL_CLOSING: [
    "PARTIAL_CLOSE_CONFIRMED",
    "RECONCILIATION_REQUIRED",
    "FAILED",
    "ABORTED",
  ],
  PARTIAL_CLOSE_CONFIRMED: ["OPEN", "CLOSE_REQUESTED", "RECONCILING"],
  REBALANCE_REQUESTED: ["CLOSING_FOR_REBALANCE", "FAILED", "ABORTED"],
  CLOSING_FOR_REBALANCE: [
    "CLOSE_CONFIRMED",
    "RECONCILIATION_REQUIRED",
    "FAILED",
    "ABORTED",
  ],
  CLOSE_REQUESTED: ["CLOSING", "FAILED", "ABORTED"],
  CLOSING: ["CLOSE_CONFIRMED", "RECONCILIATION_REQUIRED", "FAILED", "ABORTED"],
  CLOSE_CONFIRMED: ["RECONCILING"],
  REDEPLOY_REQUESTED: ["REDEPLOYING", "FAILED", "ABORTED"],
  REDEPLOYING: ["OPEN", "RECONCILIATION_REQUIRED", "FAILED", "ABORTED"],
  RECONCILIATION_REQUIRED: ["RECONCILING", "FAILED", "ABORTED"],
  RECONCILING: [
    "OPEN",
    "MANAGEMENT_REVIEW",
    "HOLD",
    "CLOSED",
    "FAILED",
    "ABORTED",
  ],
  CLOSED: [],
  FAILED: ["RECONCILIATION_REQUIRED", "ABORTED"],
  ABORTED: [],
} satisfies Record<PositionStatus, PositionStatus[]>;

const GLOBAL_ESCALATION_TARGETS = new Set<PositionStatus>([
  "RECONCILIATION_REQUIRED",
  "FAILED",
  "ABORTED",
]);

const TERMINAL_ESCALATION_TARGETS = new Set<PositionStatus>([
  "FAILED",
  "ABORTED",
]);

export const POSITION_ESCALATION_REASONS = [
  "operator_abort",
  "startup_recovery",
  "fatal_validation",
  "manual_circuit_breaker",
  "reconciliation_terminal",
] as const;

export type PositionEscalationReason =
  (typeof POSITION_ESCALATION_REASONS)[number];

export const POSITION_LIFECYCLE: Readonly<
  Record<PositionStatus, readonly PositionStatus[]>
> = BASE_POSITION_TRANSITIONS;

export type PositionTransitionFlow = "normal_close" | "rebalance";

export interface PositionTransitionContext {
  flow?: PositionTransitionFlow;
  escalationReason?: PositionEscalationReason;
}

export function canTransitionPositionStatus(
  from: PositionStatus,
  to: PositionStatus,
  context: PositionTransitionContext = {},
): boolean {
  PositionStatusSchema.parse(from);
  PositionStatusSchema.parse(to);

  if (from === "CLOSED" || from === "ABORTED") {
    return false;
  }

  const baseTableAllows = POSITION_LIFECYCLE[from].includes(to);

  if (
    from === "CLOSE_CONFIRMED" &&
    to === "REDEPLOY_REQUESTED" &&
    context.flow === "rebalance"
  ) {
    return true;
  }

  if (GLOBAL_ESCALATION_TARGETS.has(to)) {
    if (to === "RECONCILIATION_REQUIRED") {
      return true;
    }

    if (baseTableAllows) {
      return true;
    }

    return context.escalationReason !== undefined;
  }

  return baseTableAllows;
}

export function transitionPositionStatus(
  from: PositionStatus,
  to: PositionStatus,
  context?: PositionTransitionContext,
): PositionStatus {
  if (!canTransitionPositionStatus(from, to, context)) {
    if (
      TERMINAL_ESCALATION_TARGETS.has(to) &&
      from !== "CLOSED" &&
      from !== "ABORTED" &&
      !POSITION_LIFECYCLE[from].includes(to) &&
      context?.escalationReason === undefined
    ) {
      throw new Error(
        `Direct position transition ${from} -> ${to} requires an explicit escalationReason`,
      );
    }

    throw new Error(`Invalid position transition: ${from} -> ${to}`);
  }

  return to;
}

export function transitionRebalancePositionStatus(
  from: PositionStatus,
  to: PositionStatus,
): PositionStatus {
  return transitionPositionStatus(from, to, { flow: "rebalance" });
}

export function transitionClosePositionStatus(
  from: PositionStatus,
  to: PositionStatus,
): PositionStatus {
  return transitionPositionStatus(from, to, { flow: "normal_close" });
}
