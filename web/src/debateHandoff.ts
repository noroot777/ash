import type { Session, Task, TaskStatus } from "@harness/shared";
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

function consensusBy(lastA?: DebateTurn, lastB?: DebateTurn): DebateGate["consensusBy"] {
  if (lastA?.raised && lastB?.raised) return lastA.agrees && lastB.agrees ? "both" : undefined;
  if (lastA?.raised && lastA.agrees) return "A";
  if (lastB?.raised && lastB.agrees) return "B";
  return undefined;
}

export function latestDebateGate(turns: DebateTurn[], open: boolean): DebateGate | null {
  const lastA = [...turns].reverse().find((turn) => turn.speaker === "A");
  const lastB = [...turns].reverse().find((turn) => turn.speaker === "B");
  if (!lastA && !lastB) return null;
  const by = consensusBy(lastA, lastB);
  return {
    gate: "G1",
    open,
    consensus: !!by,
    consensusBy: by,
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

function latestTurnText(turns: DebateTurn[], speaker: "A" | "B"): string {
  return [...turns]
    .reverse()
    .find((turn) => turn.speaker === speaker && turn.text.trim())
    ?.text.trim() ?? "";
}

function latestDebaterSession(sessions: Session[], role: "debaterA" | "debaterB"): Session | undefined {
  return sessions
    .filter((session) => session.role === role)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function transcriptLines(sessions: Session[]): string[] {
  const a = latestDebaterSession(sessions, "debaterA");
  const b = latestDebaterSession(sessions, "debaterB");
  if (!a?.transcriptPath || !b?.transcriptPath) {
    throw new Error("完整辩论记录路径尚未就绪，未创建团队任务；请稍后重试");
  }
  return [
    "## 完整辩论记录（执行前必读）",
    "调度者：先用 Read 完整读完以下两份记录，再拆解任务、派发执行者。任务元信息本身不包含完整讨论。",
    `- 辩手 A 完整记录：\`${a.transcriptPath}\``,
    `- 辩手 B 完整记录：\`${b.transcriptPath}\``,
  ];
}

function finalTurnLines(turns: DebateTurn[]): string[] {
  const a = latestTurnText(turns, "A");
  const b = latestTurnText(turns, "B");
  return [
    "## 双方最后一轮完整发言",
    "### 辩手 A",
    a || "（辩手 A 尚无完整发言）",
    "",
    "### 辩手 B",
    b || "（辩手 B 尚无完整发言）",
  ];
}

function statusLine(status: TaskStatus, gate: DebateGate | null): string {
  const by = gate?.consensusBy ?? (gate?.consensus ? "both" : undefined);
  if (status === "done" && gate?.consensus) return by === "both" ? "辩论已结束，双方已确认达成共识。" : "辩论已结束，由单方声明与对方一致后收敛；请结合双方结论执行。";
  if (status === "done") return "辩论已结束，但未记录为双方达成共识；请结合双方结论执行并自行处理分歧。";
  if (status === "failed") return "辩论因失败而结束，未达成共识；请结合现有双方结论判断可执行范围。";
  if (status === "canceled") return "辩论已取消，未达成最终共识；请结合取消前的双方结论判断可执行范围。";
  if (gate?.consensus) {
    return `辩论尚未结束（当前状态：${STATUS_META[status].label}），但当前已${by === "both" ? "由双方确认共识" : "由单方声明一致而收敛"}。`;
  }
  return `辩论尚未结束且当前未达成共识（当前状态：${STATUS_META[status].label}），双方结论如下；执行前请自行裁决分歧。`;
}

export function buildDebateHandoffBody(
  task: Task,
  gate: DebateGate | null,
  turns: DebateTurn[],
  command: string,
  sessions: Session[],
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
    ...transcriptLines(sessions),
    "",
    "## 简短结论摘要与当前状态（仅作引言）",
    statusLine(task.status, resolvedGate),
    ...conclusionLines(resolvedGate),
    "",
    ...finalTurnLines(turns),
  ];
  if (note) lines.push("", "## 用户交接附言", note);
  lines.push("", `来源辩论任务 ID（仅供溯源；该任务元信息不含完整讨论）：${task.id}`);
  return lines.join("\n");
}
