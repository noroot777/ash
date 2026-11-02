// 「**上一次运行到底把这一轮推进到哪一步了**」—— 从 codex app-server 的完整协议日志里把接管
// 证据读回来。
//
// 为什么独立成文件:这是**接管判据的读取端**,跟 `codex-app-server.ts` 里那个「没有回合凭据
// 就当场按失败结算」(`reattachDriven`)是同一件事的两半 —— 这边负责从日志里找出 turn id,
// 那边负责在找不到时拒绝假装接管成功。两半分家读起来更清楚,也让那个已经贴着 700 行上限的
// 文件只留运行时那一半。
//
// 为什么不能只看 stdout offset:接管时 offset 可能早已越过启动通知(`thread/started`、
// `turn/started`),所以必须从头整份重放一遍;日志行可能半行、可能损坏,逐行 try/catch 跳过 ——
// 但**跳过的行要记账**:坏行里可能正是那张开始凭据(见 evidence 那一档)。
import { readFileSync } from "node:fs";
import type { CliGoal } from "@ash/shared/cli-commands";

/**
 * 重启接管时从完整协议日志找回当前 turn id；stdout offset 可能早已越过启动通知。
 *
 * `evidence` 是**这一轮有没有启动过**的三档,接管闸按它决定杀不杀(`codex-app-server.ts` 的
 * `reattachDriven` / `reattachUnverifiable`):
 *   · `started`       —— 找到了开始凭据(`turn/started` 通知,或 `turn/start` / review 的应答);
 *   · `never-started` —— 日志**读得动**、逐行扫完没有任何凭据 = 确证从未启动;
 *   · `unreadable`    —— 日志读不出来(权限/IO/文件不在)。这一档必须跟上面分开:两者混在一起
 *     时,一次磁盘故障会被诊断成「输入一个字都没到 agent」并当场杀掉一个健康回合
 *     (第 1 轮自由审查 F5 与「失败面」那一条)。
 *     **读到了、但有行解析不了**(损坏行、还没写完的半行)且没找到任何开始凭据,也落这一档
 *     (第 1 轮自由审查 F2):「文件读成功」不等于「整份记录核验过」,坏掉的那一行里可能正是
 *     开始凭据。把它说成 `never-started` 会被账本落成 refused —— 确证一个字没进去 —— 原文随即
 *     重投。说不上来就交给持续核验(./codex-app-server-adopt.ts 的 `wireAdoptionRecovery`)。
 *     肯定凭据照旧优先:找到了就是 `started`,坏行不翻盘。
 */
export function readCodexAppServerState(
  path: string,
  knownThreadId = "",
): {
  threadId: string | null; turnId: string | null; reviewTurnId?: string;
  completedTurn?: { id: string; status: string; error?: unknown }; goal?: CliGoal | null;
  evidence: "started" | "never-started" | "unreadable";
} {
  let threadId: string | null = knownThreadId || null;
  let turnId: string | null = null;
  let completedTurn: { id: string; status: string; error?: unknown } | undefined;
  let reviewTurnId: string | null = null;
  let goal: CliGoal | null | undefined;
  /**
   * 进入一个回合。**同一回合的完成事实单调**(第 1 轮自由审查 F2,实测):通知与请求应答会
   * 交错,`started → completed → turn/start 的应答` 这种顺序在实时协议里本来就有(适配器那边
   * 专门处理过「通知先到、应答迟到」)。上一版不论 id 一律清掉完成事实,于是一个已经答完的
   * 回合在重放里只剩「已开始」—— 接管后等一个永远不会再发的完成通知,任务一直停在进行中。
   * 只有**确证进入了另一个回合**才允许把完成事实清掉。
   */
  const enterTurn = (id: string): void => {
    turnId = id;
    if (completedTurn && completedTurn.id !== id) completedTurn = undefined;
  };
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // 读不出来 ≠ 没启动过(见上面 evidence 那一档)。只报一句话:整个 stack 对这个结论没用,
    // 而这一行在每次接管失败时都会出现。
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[ash] 读 Codex 协议日志 ${path} 失败，这一轮有没有启动过核实不了：${detail}`);
    return { threadId, turnId, evidence: "unreadable" };
  }
  let damaged = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let message: any;
    try { message = JSON.parse(line); } catch { damaged = true; continue; }
    if (message.params?.threadId === threadId && message.method === "thread/goal/updated") goal = message.params.goal;
    if (message.params?.threadId === threadId && message.method === "thread/goal/cleared") goal = null;
    if (message.result?.reviewThreadId === threadId && typeof message.result?.turn?.id === "string") reviewTurnId = message.result.turn.id;
    // **普通 `turn/start` 的成功应答**也是开始凭据(`{id, result:{turn:{id}}}`)。只认通知的那一版
    // 漏掉了「应答已落盘、`turn/started` 还没输出(或那一行损坏)」这个窗口,于是新接管闸会把一个
    // 已经被 agent 收下的回合当场杀掉(F5)。
    //
    // 为什么靠形状、不靠请求 id 配对:这份日志是 agent 的 **stdout**,我们发出去的请求压根不在
    // 里面,重启后也还原不出本地那个递增 id。形状够用,而且不会误收 —— `thread/start`/`resume`
    // 的应答是 `{thread:{id}}` 不带 `turn`;**日志按 (会话, 回合起点) 一轮一个文件**
    // (`detachedPathsFor`),所以不可能把上一轮的凭据算到这一轮头上。`turn/steer` 的应答同样带
    // `turn` —— 那也确实是「这一轮已经开始」的凭据。
    if (message.id !== undefined && !message.result?.reviewThreadId && typeof message.result?.turn?.id === "string") {
      enterTurn(message.result.turn.id);
    }
    if (message.method === "thread/started" && !threadId && typeof message.params?.thread?.id === "string") {
      threadId = message.params.thread.id;
    } else if (message.method === "turn/started"
      && (!threadId || message.params?.threadId === threadId)
      && typeof message.params?.turn?.id === "string") {
      threadId = message.params?.threadId ?? threadId;
      enterTurn(message.params.turn.id);
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
  const started = !!turnId || !!reviewTurnId || !!completedTurn;
  return {
    threadId, turnId,
    ...(reviewTurnId ? { reviewTurnId } : {}), ...(completedTurn ? { completedTurn } : {}),
    ...(goal !== undefined ? { goal } : {}),
    evidence: started ? "started" : damaged ? "unreadable" : "never-started",
  };
}
