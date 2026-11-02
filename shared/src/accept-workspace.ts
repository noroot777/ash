export type AcceptanceAutoCommitDecision = {
  action: "commit" | "skip" | "disabled";
  reason: string;
};

export type AcceptanceAutoCommitOutcome = {
  status: "committed" | "skipped" | "failed";
  reason: string;
  sha?: string;
};

export function acceptanceAutoCommitMessage(outcome: AcceptanceAutoCommitOutcome): string {
  if (outcome.status === "skipped") return `已跳过验收前自动提交：${outcome.reason}`;
  if (outcome.status === "failed") return `验收前自动提交未完成：${outcome.reason}`;
  return `验收前已自动提交任务改动${outcome.sha ? `（${outcome.sha.slice(0, 8)}）` : ""}：${outcome.reason}`;
}
