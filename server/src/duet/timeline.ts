import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerEvent } from "@ash/shared";
import { bus } from "../bus.js";
import { RUNS_DIR } from "../paths.js";
import { now } from "../util.js";

export function recordUserTurn(
  taskId: string,
  round: number,
  text: string,
  kind: "inject" | "ask",
  target?: "A" | "B",
) {
  const at = now();
  try {
    appendFileSync(
      join(RUNS_DIR, taskId, "transcript.jsonl"),
      JSON.stringify({ round, speaker: "user", text, at, target, kind }) + "\n",
    );
  } catch {
    /* best effort */
  }
  bus.publish({ type: "duet.user", taskId, round, text, at, target, kind });
}

export function recordGateEvent(event: Extract<ServerEvent, { type: "duet.gate" }>) {
  try {
    const runDir = join(RUNS_DIR, event.taskId);
    mkdirSync(runDir, { recursive: true });
    appendFileSync(join(runDir, "transcript.jsonl"), JSON.stringify(event) + "\n");
  } catch {
    /* best effort */
  }
  bus.publish(event);
}

export function recordTurnStart(event: Extract<ServerEvent, { type: "duet.progress" }> & { phase: "start" }) {
  try {
    const runDir = join(RUNS_DIR, event.taskId);
    mkdirSync(runDir, { recursive: true });
    appendFileSync(join(runDir, "transcript.jsonl"), JSON.stringify(event) + "\n");
  } catch {
    /* best effort */
  }
  bus.publish(event);
}

/**
 * 发言**还没结束**时就得让用户看见的那一条 —— 即时落进讨论页真正读取的那份记录。
 *
 * 为什么非得有这一条(第 1 轮审查 F4):讨论页首次进入和刷新都只读 `transcript.jsonl`
 * (`transcript-reads.ts` 的 `readDuetTurns`),而一轮发言的完整记录(含 `events` 那串执行过程)
 * 要等 `runTurn` 收尾才追加。于是停滞警告出现之后、发言结束之前刷新页面,警告就不见了,只剩
 * 「正在组织本轮观点」—— 而那正是看门狗警告档承诺的「持久可见、刷新仍在」要兑现的那个场合,
 * 而且这段窗口按定义很长(上游一直连不上才会报警)。只写内存 trace + 会话 trace + SSE 不够:
 * 前者随进程走,后者讨论页不读,SSE 断线重连就从头来。
 *
 * 落的是**与实时 SSE 一模一样的那条 `agent.event`**,所以回放不需要第二套解释:前端
 * `rebuildDuetState` 把它交给同一个 `applyDuetEvent`,挂在那条还开着的发言上。等这一轮真的收尾,
 * 整轮记录(带完整 `events`)会把同一个回合整体替掉,所以不会出现两份。
 */
export function recordTurnDiagnostic(event: Extract<ServerEvent, { type: "agent.event" }>) {
  try {
    const runDir = join(RUNS_DIR, event.taskId);
    mkdirSync(runDir, { recursive: true });
    appendFileSync(join(runDir, "transcript.jsonl"), JSON.stringify(event) + "\n");
  } catch {
    /* best effort:落不下就退回「只有实时那一路」,不该掀翻正在跑的回合 */
  }
  bus.publish(event);
}
