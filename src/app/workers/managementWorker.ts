import {
  runManagementCycle,
  type RunManagementCycleInput,
  type RunManagementCycleResult,
} from "../usecases/runManagementCycle.js";

export type ManagementWorkerInput = RunManagementCycleInput;

export async function runManagementWorker(
  input: ManagementWorkerInput,
): Promise<RunManagementCycleResult> {
  return runManagementCycle(input);
}
