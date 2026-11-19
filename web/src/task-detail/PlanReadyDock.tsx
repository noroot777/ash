import type { Task } from "@ash/shared";
import type { ConversationItem } from "./conversationModel.ts";
import type { ProposedPlanData } from "../components/ProposedPlan.tsx";
import "../components/proposed-plan.css";

export type ReadyPlan = {
  plan: ProposedPlanData;
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
};

export function readyPlanFor(task: Task, items: ConversationItem[]): ReadyPlan | null {
  if (!task.codexPlanMode || task.mode !== "single" || task.archived || task.question || ["running", "queued"].includes(task.status)) return null;
  const last = [...items].reverse().find((item) => item.kind === "agent");
  if (!last || last.kind !== "agent" || last.agentType !== "codex" || last.sessionRole !== "single" || !last.endedAt || last.interrupted || last.reviewer) return null;
  if (last.turnOutcome === "failed" || last.turnOutcome === "stopped" || last.session?.stoppedAs || (!last.turnOutcome && (last.session?.exitStatus ?? 0) !== 0)) return null;
  const executorId = last.session?.executorId ?? null;
  if (!task.codexPlanScopes?.some((scope) => scope.executorId === executorId)) return null;
  const plan = last.segments.flatMap((segment) => segment.events).filter((event) => event.plan).at(-1)?.plan;
  if (!plan || plan.status !== "complete" || !plan.text.trim()) return null;
  return { plan, executorId, model: last.run?.model ?? null, reasoningEffort: last.run?.reasoningEffort ?? null };
}

export function PlanReadyDock({ ready, busy, onImplement, onRevise }: {
  ready: ReadyPlan;
  busy: boolean;
  onImplement: (ready: ReadyPlan) => void;
  onRevise: () => void;
}) {
  return (
    <section className="plan-ready-dock" aria-label="计划已就绪">
      <strong>实施此计划？</strong>
      <div className="plan-ready-actions">
        <button type="button" disabled={busy} onClick={() => onImplement(ready)}>{busy ? "正在开始…" : "实施此计划"}</button>
        <button type="button" disabled={busy} onClick={onRevise}>继续修改</button>
      </div>
    </section>
  );
}
