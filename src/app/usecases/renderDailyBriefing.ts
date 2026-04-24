import type { RuntimeReport } from "./generateRuntimeReport.js";

export interface RenderDailyBriefingInput {
  report: RuntimeReport;
  emoji?: boolean;
}

function formatCurrency(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return `$${value.toFixed(2)}`;
}

function formatSol(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return `${value.toFixed(4)} SOL`;
}

function prefix(enabled: boolean, value: string): string {
  return enabled ? `${value} ` : "";
}

export function renderDailyBriefing(input: RenderDailyBriefingInput): string {
  const report = input.report;
  const emoji = input.emoji === true;
  const pnlText =
    report.displayMode === "SOL"
      ? formatSol(report.dailyPnlSol)
      : formatCurrency(report.dailyPnlUsd);

  return [
    `${prefix(emoji, report.health === "HEALTHY" ? "OK" : "WARN")}Runtime briefing`,
    `${prefix(emoji, "POS")}Open positions: ${report.openPositions}`,
    `${prefix(emoji, "ACT")}Pending actions: ${report.pendingActions}`,
    `${prefix(emoji, "PNL")}Daily realized pnl: ${pnlText}`,
    `${prefix(emoji, "MEM")}Lessons: ${report.lessonsCount ?? "n/a"} | Pools tracked: ${report.poolsTracked ?? "n/a"}`,
    `${prefix(emoji, "REC")}Needs reconciliation: ${report.pendingReconciliationPositions}`,
    `${prefix(emoji, "ALR")}Alerts: ${report.alerts.length}`,
  ].join("\n");
}
