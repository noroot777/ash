import type { Session, Task, TaskStatus } from "@harness/shared";
import { normalizeDuetConfig } from "@harness/shared/duet";
import { taskDisplayStatus } from "@harness/shared";
import type { DuetGate, DuetTurn } from "./duetState.ts";

export function latestDuetGate(turns: DuetTurn[], open: boolean): DuetGate | null {
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

function latestSession(sessions: Session[], role: "voiceA" | "voiceB"): Session | undefined {
  return sessions.filter((session) => session.role === role)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function transcriptLines(sessions: Session[]): string[] {
  const a = latestSession(sessions, "voiceA");
  const b = latestSession(sessions, "voiceB");
  if (!a?.transcriptPath || !b?.transcriptPath) {
    throw new Error("完整讨论记录路径尚未就绪，未创建团队；请稍后重试");
  }
  return [
    "## 完整讨论记录（执行前必读）",
    "调度者：先完整阅读以下两份记录，再拆解任务并派发执行者。",
    `- 讨论者 A：\`${a.transcriptPath}\``,
    `- 讨论者 B：\`${b.transcriptPath}\``,
  ];
}

function statusLine(status: TaskStatus, gate: DuetGate | null): string {
  const label = taskDisplayStatus(status, null, false).label;
  if (status === "done" && gate?.consensus) return "讨论已结束，当前结论已收敛。";
  if (status === "done") return "讨论已结束，但没有记录为双方共识；执行前请处理残余分歧。";
  if (status === "failed" || status === "canceled") return `讨论以“${label}”结束；请只在现有证据支持的范围内执行。`;
  return `讨论当前状态：${label}。`;
}

function lastText(turns: DuetTurn[], speaker: "A" | "B"): string {
  return [...turns].reverse().find((turn) => turn.speaker === speaker && turn.text.trim())?.text.trim() ?? "（尚无完整发言）";
}

// 收敛后的合稿(共同方案)是讨论的正式产出;有它就整段带给调度者,双方最后
// 发言只作过程证据。老讨论(改名前)没有合稿轮,退回结论两行 + 双方发言。
// **过时的合稿不作数**:回炉后重新合稿失败时,留下的还是反馈前的旧方案,
// 判据是合稿轮次不早于最后一次 A/B 发言轮次。
function latestPlan(turns: DuetTurn[]): string | null {
  const lastVoiceRound = turns.reduce(
    (max, turn) => (turn.speaker === "A" || turn.speaker === "B" ? Math.max(max, turn.round) : max),
    0,
  );
  return [...turns].reverse().find((turn) =>
    turn.speaker === "synthesis" && !turn.error && turn.text.trim() && turn.round >= lastVoiceRound,
  )?.text.trim() ?? null;
}

export function buildDuetHandoffBody(
  task: Task,
  gate: DuetGate | null,
  turns: DuetTurn[],
  sessions: Session[],
  note: string,
): string {
  const config = normalizeDuetConfig(task.duet);
  const original = config.topic.trim() || task.body.trim() || task.title;
  const resolvedGate = gate ?? latestDuetGate(turns, task.status === "awaiting_review");
  const plan = latestPlan(turns);
  const lines = [
    "请接手下面这场讨论的结果，先拆解工作，再组织团队执行并验证交付。",
    "",
    "## 原议题",
    `讨论标题：${task.title}`,
    original,
    "",
    ...transcriptLines(sessions),
    "",
    "## 当前状态与结论",
    statusLine(task.status, resolvedGate),
    resolvedGate?.conclusionA ? `- 讨论者 A：${resolvedGate.conclusionA}` : "- 讨论者 A：未留下明确结论",
    resolvedGate?.conclusionB ? `- 讨论者 B：${resolvedGate.conclusionB}` : "- 讨论者 B：未留下明确结论",
    ...(plan ? ["", "## 共同方案（讨论的正式产出，拆解执行以它为准）", plan] : []),
    "",
    "## 双方最后一轮完整发言",
    "### 讨论者 A",
    lastText(turns, "A"),
    "",
    "### 讨论者 B",
    lastText(turns, "B"),
  ];
  if (note.trim()) lines.push("", "## 交接附言", note.trim());
  lines.push("", `来源讨论任务 ID：${task.id}`);
  return lines.join("\n");
}
