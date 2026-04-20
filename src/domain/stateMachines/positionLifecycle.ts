import {
  type PositionStatus,
  PositionStatusSchema,
} from "../types/enums.js";

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
  HOLD: ["OPEN", "MANAGEMENT_REVIEW", "CLOSE_REQUESTED", "RECONCILIATION_REQUIRED"],
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
  CLOSE_CONFIRMED: ["RECONCILING", "REDEPLOY_REQUESTED"],
  REDEPLOY_REQUESTED: ["REDEPLOYING", "FAILED", "ABORTED"],
  REDEPLOYING: ["OPEN", "RECONCILIATION_REQUIRED", "FAILED", "ABORTED"],
  RECONCILIATION_REQUIRED: ["RECONCILING", "FAILED", "ABORTED"],
  RECONCILING: ["OPEN", "MANAGEMENT_REVIEW", "HOLD", "CLOSED", "FAILED", "ABORTED"],
  CLOSED: [],
  FAILED: ["RECONCILIATION_REQUIRED", "ABORTED"],
  ABORTED: [],
} satisfies Record<PositionStatus, PositionStatus[]>;

const GLOBAL_POSITION_ESCALATIONS = new Set<PositionStatus>([
  "RECONCILIATION_REQUIRED",
  "FAILED",
  "ABORTED",
]);

export const POSITION_LIFECYCLE: Readonly<
  Record<PositionStatus, readonly PositionStatus[]>
> = BASE_POSITION_TRANSITIONS;

export function canTransitionPositionStatus(
  from: PositionStatus,
  to: PositionStatus,
): boolean {
  PositionStatusSchema.parse(from);
  PositionStatusSchema.parse(to);

  if (GLOBAL_POSITION_ESCALATIONS.has(to) && from !== "CLOSED" && from !== "ABORTED") {
    return true;
  }

  return POSITION_LIFECYCLE[from].includes(to);
}

export function transitionPositionStatus(
  from: PositionStatus,
  to: PositionStatus,
): PositionStatus {
  if (!canTransitionPositionStatus(from, to)) {
    throw new Error(`Invalid position transition: ${from} -> ${to}`);
  }

  return to;
}
