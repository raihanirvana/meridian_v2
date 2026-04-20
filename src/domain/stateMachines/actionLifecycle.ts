import { ActionStatusSchema, type ActionStatus } from "../types/enums.js";

const BASE_ACTION_TRANSITIONS = {
  QUEUED: ["RUNNING", "ABORTED"],
  RUNNING: ["WAITING_CONFIRMATION", "FAILED", "ABORTED"],
  WAITING_CONFIRMATION: ["RECONCILING", "TIMED_OUT", "FAILED", "ABORTED"],
  RECONCILING: ["DONE", "FAILED", "ABORTED"],
  DONE: [],
  FAILED: ["RETRY_QUEUED", "ABORTED"],
  ABORTED: [],
  TIMED_OUT: ["ABORTED"],
  RETRY_QUEUED: ["RUNNING", "ABORTED"],
} satisfies Record<ActionStatus, ActionStatus[]>;

export const ACTION_LIFECYCLE: Readonly<
  Record<ActionStatus, readonly ActionStatus[]>
> = BASE_ACTION_TRANSITIONS;

export function canTransitionActionStatus(
  from: ActionStatus,
  to: ActionStatus,
): boolean {
  ActionStatusSchema.parse(from);
  ActionStatusSchema.parse(to);

  return ACTION_LIFECYCLE[from].includes(to);
}

export function transitionActionStatus(
  from: ActionStatus,
  to: ActionStatus,
): ActionStatus {
  if (!canTransitionActionStatus(from, to)) {
    throw new Error(`Invalid action transition: ${from} -> ${to}`);
  }

  return to;
}
