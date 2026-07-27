import type { Task, TaskStatus } from "@harness/shared";
import { normalizeDebateConfig } from "@harness/shared";
import { STATUS_META } from "./constants";
import type { DebateGate, DebateTurn } from "./debateState";

const TEAM_COMMAND = /^\/team\b/i;

export function isTeamCommand(text: string): boolean {
  return TEAM_COMMAND.test(text.trim());
}

export function teamCommandNote(text: string): string {
  return text.trim().replace(TEAM_COMMAND, "").trim();
}

export function latestDebateGate(turns: DebateTurn[], open: boolean): DebateGate | null {
  const lastA = [...turns].reverse().find((turn) => turn.speaker === "A");
  const lastB = [...turns].reverse().find((turn) => turn.speaker === "B");
  if (!lastA && !lastB) return null;
  return {
    gate: "G1",
    open,
    consensus: !!(lastA?.raised && lastB?.raised && lastA?.agrees && lastB?.agrees),
    conclusionA: lastA?.conclusion ?? null,
    conclusionB: lastB?.conclusion ?? null,
  };
}

function conclusionLines(gate: DebateGate | null): string[] {
  const a = gate?.conclusionA?.trim();
  const b = gate?.conclusionB?.trim();
  if (gate?.consensus && a && b && a === b) return [`共识结论：${a}`];
  const lines: string[] = [];
  if (a) lines.push(`- 辩手 A：${a}`);
  if (b) lines.push(`- 辩手 B：${b}`);
  return lines.length ? lines : ["（双方尚未留下明确的结论文本）"];
}

function statusLine(status: TaskStatus, gate: DebateGate | null): string {
  if (status === "done" && gate?.consensus) return "辩论已结束，双方已达成共识。";
  if (status === "done") return "辩论已结束，但未记录为双方达成共识；请结合双方结论执行并自行处理分歧。";
  if (status === "failed") return "辩论因失败而结束，未达成共识；请结合现有双方结论判断可执行范围。";
  if (status === "canceled") return "辩论已取消，未达成最终共识；请结合取消前的双方结论判断可执行范围。";
  if (gate?.consensus) {
    return `辩论尚未结束（当前状态：${STATUS_META[status].label}），但双方当前已报告达成共识。`;
  }
  return `辩论尚未结束且当前未达成共识（当前状态：${STATUS_META[status].label}），双方结论如下；执行前请自行裁决分歧。`;
}

export function buildDebateHandoffBody(
  task: Task,
  gate: DebateGate | null,
  turns: DebateTurn[],
  command: string,
): string {
  const topic = normalizeDebateConfig(task.debate)?.topic?.trim();
  const original = topic || task.body.trim() || task.title;
  const resolvedGate = gate ?? latestDebateGate(turns, task.status === "awaiting_review");
  const note = teamCommandNote(command);
  const lines = [
    "请接手下面这场辩论的结果，先拆解工作，再组织团队执行并验证交付。",
    "",
    "## 原辩题",
    `辩论标题：${task.title}`,
    original,
    "",
    "## 辩论结论与当前状态",
    statusLine(task.status, resolvedGate),
    ...conclusionLines(resolvedGate),
  ];
  if (note) lines.push("", "## 用户交接附言", note);
  lines.push("", `来源辩论任务 ID：${task.id}`);
  return lines.join("\n");
}
