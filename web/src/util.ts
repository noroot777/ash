import type { TaskStatus } from "@harness/shared";
import { executorLabel } from "./executorLabel";

// Compact a filesystem path for display: keep the last 2–3 segments with a
// leading "…/" so long absolute paths fit in a chip/menu row. The full path
// should still be surfaced via a `title` attribute on the element.
export function shortPath(p: string | null | undefined, segments = 2): string {
  if (!p) return "";
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= segments) return p;
  return "…/" + parts.slice(-segments).join("/");
}

// Group display label "<name> · 并行/串行" — shared so the create modal and the
// task detail show groups identically.
export function groupLabel(g: { name: string; mode: string }): string {
  return `${g.name} · ${g.mode === "parallel" ? "并行" : "串行"}`;
}

// The mode badge shown on task cards/rows. /pair tasks show debate; 团队
// (mode "team") 显示强调色的「团队」；a single task shows @agent.
export function pairBadge(t: {
  mode: string;
  agentType?: string | null;
  executorLabel?: string | null;
}): { label: string; cls: string } {
  if (t.mode === "team") return { label: "团队", cls: "bg-accent/10 text-accent" };
  if (t.mode !== "debate") return { label: executorLabel({ executorLabel: t.executorLabel, agentType: t.agentType }), cls: "text-faint" };
  return { label: "debate", cls: "bg-violet-500/15 text-violet-700" };
}

// 团队任务在列表里折叠成一行时，这一行的图标该画哪个状态 —— 取「最该你管的那个」：
// 等答复 > 有人挂了 > 有人在跑 > 全完 > 调度台自己的状态。
//
// 调度台自己的状态排在最后是关键：它「待命(idle)」不代表没事，执行者可能正卡在一个
// 提问上等你。所以这个折叠值只影响**图标**，不影响这一行落在哪个状态分组里（分组还
// 是按调度台真实状态，免得一个活着的团队因为执行者全完就掉进「完成」组里）。
export function foldTeamStatus(
  lead: { status: TaskStatus; question?: string | null },
  workers: { status: TaskStatus; question?: string | null }[],
): { status: TaskStatus; awaitingAnswer: boolean } {
  const no = { awaitingAnswer: false };
  if (lead.question || workers.some((w) => w.question)) return { status: "paused", awaitingAnswer: true };
  if (workers.some((w) => w.status === "failed")) return { status: "failed", ...no };
  if (lead.status === "running" || workers.some((w) => w.status === "running" || w.status === "queued"))
    return { status: "running", ...no };
  if (workers.length && workers.every((w) => w.status === "done")) return { status: "done", ...no };
  return { status: lead.status, ...no };
}
