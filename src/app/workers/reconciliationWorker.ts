import {
  reconcilePortfolio,
  type ReconcilePortfolioInput,
  type ReconcilePortfolioResult,
} from "../usecases/reconcilePortfolio.js";

export type ReconciliationWorkerInput = ReconcilePortfolioInput;

export async function runReconciliationWorker(
  input: ReconciliationWorkerInput,
): Promise<ReconcilePortfolioResult> {
  return reconcilePortfolio(input);
}
