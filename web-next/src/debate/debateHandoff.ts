import type { Session, Task, TaskStatus } from "@harness/shared";
import { normalizeDebateConfig, taskDisplayStatus } from "@harness/shared";
import type { DebateGate, DebateTurn } from "./debateState.ts";

export function latestDebateGate(turns: DebateTurn[], open: boolean): DebateGate | null {
  const lastA = [...turns].reverse().find((turn) => turn.speaker === "A");
  const lastB = [...turns].reverse().find((turn) => turn.speaker === "B");
  if (!lastA && !lastB) return null;
  const consensusBy = lastA?.raised && lastB?.raised && lastA.agrees && lastB.agrees
    ? "both"
    : lastA?.raised && lastA.agrees ? "A"
      : lastB?.raised && lastB.agrees ? "B" : undefined;
  return {
    gate: "G1",
    open,
    consensus: !!consensusBy,
    consensusBy,
    conclusionA: lastA?.conclusion ?? null,
    conclusionB: lastB?.conclusion ?? null,
  };
}

function latestSession(sessions: Session[], role: "debaterA" | "debaterB"): Session | undefined {
  return sessions.filter((session) => session.role === role)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function transcriptLines(sessions: Session[]): string[] {
  const a = latestSession(sessions, "debaterA");
  const b = latestSession(sessions, "debaterB");
  if (!a?.transcriptPath || !b?.transcriptPath) {
    throw new Error("完整辩论记录路径尚未就绪，未创建团队；请稍后重试");
  }
  return [
    "## 完整辩论记录（执行前必读）",
    "调度者：先完整阅读以下两份记录，再拆解任务并派发执行者。",
    `- 辩手 A：\`${a.transcriptPath}\``,
    `- 辩手 B：\`${b.transcriptPath}\``,
  ];
}

function statusLine(status: TaskStatus, gate: DebateGate | null): string {
  const label = taskDisplayStatus(status, null, false).label;
  if (status === "done" && gate?.consensus) return "辩论已结束，当前结论已收敛。";
  if (status === "done") return "辩论已结束，但没有记录为双方共识；执行前请处理残余分歧。";
  if (status === "failed" || status === "canceled") return `辩论以“${label}”结束；请只在现有证据支持的范围内执行。`;
  return `辩论当前状态：${label}。`;
}

function lastText(turns: DebateTurn[], speaker: "A" | "B"): string {
  return [...turns].reverse().find((turn) => turn.speaker === speaker && turn.text.trim())?.text.trim() ?? "（尚无完整发言）";
}

export function buildDebateHandoffBody(
  task: Task,
  gate: DebateGate | null,
  turns: DebateTurn[],
  sessions: Session[],
  note: string,
): string {
  const config = normalizeDebateConfig(task.debate);
  const original = config.topic.trim() || task.body.trim() || task.title;
  const resolvedGate = gate ?? latestDebateGate(turns, task.status === "awaiting_review");
  const lines = [
    "请接手下面这场辩论的结果，先拆解工作，再组织团队执行并验证交付。",
    "",
    "## 原辩题",
    `辩论标题：${task.title}`,
    original,
    "",
    ...transcriptLines(sessions),
    "",
    "## 当前状态与结论",
    statusLine(task.status, resolvedGate),
    resolvedGate?.conclusionA ? `- 辩手 A：${resolvedGate.conclusionA}` : "- 辩手 A：未留下明确结论",
    resolvedGate?.conclusionB ? `- 辩手 B：${resolvedGate.conclusionB}` : "- 辩手 B：未留下明确结论",
    "",
    "## 双方最后一轮完整发言",
    "### 辩手 A",
    lastText(turns, "A"),
    "",
    "### 辩手 B",
    lastText(turns, "B"),
  ];
  if (note.trim()) lines.push("", "## 交接附言", note.trim());
  lines.push("", `来源辩论任务 ID：${task.id}`);
  return lines.join("\n");
}
