import { z } from "zod";

export const ActorSchema = z.enum(["system", "operator", "ai"]);

export const PositionStatusSchema = z.enum([
  "DRAFT",
  "DEPLOY_REQUESTED",
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
  "CLOSED",
  "FAILED",
  "ABORTED",
]);

export const ActionTypeSchema = z.enum([
  "DEPLOY",
  "CLOSE",
  "PARTIAL_CLOSE",
  "CLAIM_FEES",
  "REBALANCE",
  "SWAP",
  "SYNC",
  "CANCEL_REBALANCE",
]);

export const ActionStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "WAITING_CONFIRMATION",
  "RECONCILING",
  "DONE",
  "FAILED",
  "ABORTED",
  "TIMED_OUT",
  "RETRY_QUEUED",
]);

export const CandidateDecisionSchema = z.enum([
  "REJECTED_HARD_FILTER",
  "PASSED_HARD_FILTER",
  "SHORTLISTED",
  "SELECTED",
  "REJECTED_EXPOSURE",
]);

export const ManagementActionSchema = z.enum([
  "HOLD",
  "CLAIM_FEES",
  "PARTIAL_CLOSE",
  "REBALANCE",
  "CLOSE",
  "RECONCILE_ONLY",
]);

export const ReconciliationOutcomeSchema = z.enum([
  "RECONCILED_OK",
  "REQUIRES_RETRY",
  "MANUAL_REVIEW_REQUIRED",
]);

export const DrawdownStateSchema = z.enum([
  "NORMAL",
  "WARNING",
  "LIMIT_REACHED",
]);

export const CircuitBreakerStateSchema = z.enum([
  "OFF",
  "ON",
  "COOLDOWN",
]);

export type Actor = z.infer<typeof ActorSchema>;
export type PositionStatus = z.infer<typeof PositionStatusSchema>;
export type ActionType = z.infer<typeof ActionTypeSchema>;
export type ActionStatus = z.infer<typeof ActionStatusSchema>;
export type CandidateDecision = z.infer<typeof CandidateDecisionSchema>;
export type ManagementAction = z.infer<typeof ManagementActionSchema>;
export type ReconciliationOutcome = z.infer<typeof ReconciliationOutcomeSchema>;
export type DrawdownState = z.infer<typeof DrawdownStateSchema>;
export type CircuitBreakerState = z.infer<typeof CircuitBreakerStateSchema>;
