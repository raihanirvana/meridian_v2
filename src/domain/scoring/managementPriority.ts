import { z } from "zod";

export const ManagementPrioritySchema = z.enum([
  "EMERGENCY",
  "HARD_EXIT",
  "RECONCILE_ONLY",
  "MAINTENANCE_CLAIM_FEES",
  "MAINTENANCE_PARTIAL_CLOSE",
  "MAINTENANCE_REBALANCE",
  "HOLD",
]);

export type ManagementPriority = z.infer<typeof ManagementPrioritySchema>;

export const MANAGEMENT_PRIORITY_SCORES: Readonly<
  Record<ManagementPriority, number>
> = {
  EMERGENCY: 100,
  HARD_EXIT: 90,
  RECONCILE_ONLY: 80,
  MAINTENANCE_CLAIM_FEES: 70,
  MAINTENANCE_PARTIAL_CLOSE: 60,
  MAINTENANCE_REBALANCE: 50,
  HOLD: 0,
};
