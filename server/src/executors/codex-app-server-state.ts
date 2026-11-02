// 「**上一次运行到底把这一轮推进到哪一步了**」—— 从 codex app-server 的完整协议日志里把接管
// 证据读回来。
//
// 为什么独立成文件:这是**接管判据的读取端**,跟 `codex-app-server.ts` 里那个「没有回合凭据
// 就当场按失败结算」(`reattachDriven`)是同一件事的两半 —— 这边负责从日志里找出 turn id,
// 那边负责在找不到时拒绝假装接管成功。两半分家读起来更清楚,也让那个已经贴着 700 行上限的
// 文件只留运行时那一半。
//
// 为什么不能只看 stdout offset:接管时 offset 可能早已越过启动通知(`thread/started`、
// `turn/started`),所以必须从头整份重放一遍;日志行可能半行、可能损坏,逐行 try/catch 跳过。
import { readFileSync } from "node:fs";
import type { CliGoal } from "@ash/shared/cli-commands";

/** 重启接管时从完整协议日志找回当前 turn id；stdout offset 可能早已越过启动通知。 */
export function readCodexAppServerState(
  path: string,
  knownThreadId = "",
): { threadId: string | null; turnId: string | null; reviewTurnId?: string; completedTurn?: { id: string; status: string; error?: unknown }; goal?: CliGoal | null } {
  let threadId: string | null = knownThreadId || null;
  let turnId: string | null = null;
  let completedTurn: { id: string; status: string; error?: unknown } | undefined;
  let reviewTurnId: string | null = null;
  let goal: CliGoal | null | undefined;
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return { threadId, turnId }; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let message: any;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.params?.threadId === threadId && message.method === "thread/goal/updated") goal = message.params.goal;
    if (message.params?.threadId === threadId && message.method === "thread/goal/cleared") goal = null;
    if (message.result?.reviewThreadId === threadId && typeof message.result?.turn?.id === "string") reviewTurnId = message.result.turn.id;
    if (message.method === "thread/started" && !threadId && typeof message.params?.thread?.id === "string") {
      threadId = message.params.thread.id;
    } else if (message.method === "turn/started"
      && (!threadId || message.params?.threadId === threadId)
      && typeof message.params?.turn?.id === "string") {
      threadId = message.params?.threadId ?? threadId;
      turnId = message.params.turn.id;
      completedTurn = undefined;
    } else if (message.method === "turn/completed"
      && message.params?.threadId === threadId
      && typeof message.params?.turn?.id === "string"
      && (!turnId || turnId === message.params.turn.id || reviewTurnId === message.params.turn.id)
      && typeof message.params.turn.status === "string") {
      turnId = message.params.turn.id;
      completedTurn = message.params.turn;
      reviewTurnId = null;
    }
  }
  return { threadId, turnId, ...(reviewTurnId ? { reviewTurnId } : {}), ...(completedTurn ? { completedTurn } : {}), ...(goal !== undefined ? { goal } : {}) };
}
