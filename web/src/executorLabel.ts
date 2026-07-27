import type { AgentType, Session, Task } from "@harness/shared";

const text = (v: string | null | undefined): string | null => {
  const s = v?.trim();
  return s ? s : null;
};

export function executorLabel({
  session,
  task,
  executorLabel: label,
  agentType,
  fallback = "—",
}: {
  session?: Pick<Session, "executor"> | null;
  task?: Pick<Task, "executorLabel" | "agentType"> | null;
  executorLabel?: string | null;
  agentType?: AgentType | string | null;
  fallback?: string;
}): string {
  return text(session?.executor) ?? text(label) ?? text(task?.executorLabel) ?? text(agentType) ?? text(task?.agentType) ?? fallback;
}

export function teamLeadExecutorLabel(task: Pick<Task, "team" | "executorLabel" | "agentType">, session?: Pick<Session, "executor"> | null): string {
  return (
    text(session?.executor) ??
    text(task.team?.leadExecutorLabel) ??
    text(task.executorLabel) ??
    text(task.team?.lead) ??
    text(task.agentType) ??
    "—"
  );
}

export function teamWorkerExecutorLabel(task: Pick<Task, "team">): string {
  return text(task.team?.workerExecutorLabel) ?? text(task.team?.worker) ?? "—";
}

export function executorMix(tasks: Pick<Task, "executorLabel" | "agentType">[]): string {
  const by = new Map<string, number>();
  for (const task of tasks) {
    const k = executorLabel({ task });
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by.entries()].map(([label, n]) => `${label}×${n}`).join(" · ");
}
