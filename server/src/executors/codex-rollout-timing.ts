// codex 每次模型请求「发出 → 最后一个 token」的耗时,从 codex 自己写的 rollout 里算
// (口径见 shared/src/usage.ts 的 TokenUsage.timed)。
//
// 为什么不用 app-server 的实时通知:有些工具调用在通知里**完全看不见**(实测 2026-11-13:
// 往还在跑的命令里写输入的那种调用,既没有开始也没有结束通知,只多出一条用量),于是「下一次
// 请求的输入什么时候到齐」从通知里证明不了,看不见的工具跑多久就会被算成模型在出字。rollout
// 是 codex 续聊时喂回给模型的那份对话本身,每一次调用、每一份结果都在里面,各带写入时刻;
// 每次请求结束还有一条 `token_usage_record`(带这一次的输出量)。
//
// 一次请求的两头:
//  - 终点 = 它那条 token_usage_record 的时刻(回复收完才记账);
//  - 起点 = 上一次请求的终点(回合第一次则是回合开始),和这期间、模型开口之前写进来的每一样
//    输入(工具结果、用户消息、上下文)里最晚的那个 —— 输入齐了请求才发得出去。
//
// 这是私有格式,所以跟 codex-rollout.ts 一样失败关闭:请求窗口里有认不出的东西、缺时间戳、
// 压缩过,这一次就不计;文件里有读不出来的行,这一回合都不计。宁缺不估。
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { OutputTiming } from "@ash/shared";
import { findRollout } from "./codex-rollout.js";

/** 模型写出来的条目。 */
const OUTPUT_ITEMS = new Set(["reasoning", "function_call", "custom_tool_call", "local_shell_call", "web_search_call", "image_generation_call"]);
/** 请求发出之前就得备齐的条目:工具结果、给模型看的工具清单。消息另按角色分。 */
const INPUT_ITEMS = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output", "additional_tools"]);
/** 回合开始时写进来的上下文,同样是输入。 */
const INPUT_RECORDS = new Set(["session_meta", "turn_context", "world_state"]);

type Which = { turnId: string } | { latestSince: number };

export type CodexTurnTiming = {
  timed: OutputTiming | undefined;
  /** 这一回合在 rollout 里记了几次请求(不论计没计上),用来判断最后几行落盘了没有。 */
  requests: number;
};

/**
 * 从 rollout 的行里算一个回合。`turnId` 指名哪一回合;exec 路径拿不到回合 id,就取
 * `latestSince` 之后开始的最后一个回合(那就是这个进程跑的那一个)。找不到那一回合就是 null。
 */
export function codexTurnTiming(lines: Iterable<string>, which: Which): CodexTurnTiming | null {
  let turn: { id: string; lines: string[]; startedAt: number } | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const started = taskStarted(line);
    if (started) {
      const match = "turnId" in which ? started.id === which.turnId : started.at >= which.latestSince;
      if (match) turn = { id: started.id, lines: [], startedAt: started.at };
      else if (turn && "turnId" in which) break; // 指名的那一回合已经过去了
      else turn = null;
      continue;
    }
    turn?.lines.push(line);
  }
  return turn ? timeTurn(turn) : null;
}

function timeTurn(turn: { id: string; lines: string[]; startedAt: number }): CodexTurnTiming | null {
  let output = 0;
  let ms = 0;
  let requests = 0;
  let ready = turn.startedAt;
  let spoke = false;
  let unknown = false;
  for (const line of turn.lines) {
    let row: any;
    try { row = JSON.parse(line); } catch { return null; }
    const at = Date.parse(row?.timestamp);
    const payload = row?.payload ?? {};
    if (row?.type === "token_usage_record") {
      requests += 1;
      const out = payload.usage?.output_tokens;
      if (!unknown && spoke && payload.turn_id === turn.id && Number.isFinite(at) && Number.isInteger(out) && out > 0 && at > ready) {
        output += out;
        ms += at - ready;
      }
      // 下一次请求最早也得等这一次收完才发;这一刻没有凭据,下一次也就说不清起点。
      ready = Number.isFinite(at) ? at : Number.NaN;
      spoke = false;
      unknown = !Number.isFinite(at);
      continue;
    }
    if (row?.type === "event_msg") continue; // 给界面看的事件,不是对话本身
    const side = sideOf(row?.type, payload);
    if (!side || !Number.isFinite(at)) unknown = true;
    else if (side === "output") spoke = true;
    // 模型开口之后才写进来的输入(比如工具在回复收尾前就跑完了)归下一次请求。
    else if (!spoke) ready = Math.max(ready, at);
  }
  return { timed: output > 0 && ms > 0 ? { output, ms: Math.round(ms) } : undefined, requests };
}

function sideOf(type: unknown, payload: any): "input" | "output" | null {
  if (typeof type === "string" && INPUT_RECORDS.has(type)) return "input";
  if (type !== "response_item") return null; // compacted 之类:这次请求的输入被改写过,说不清
  if (payload.type === "message") {
    if (payload.role === "assistant") return "output";
    return payload.role === "user" || payload.role === "developer" || payload.role === "system" ? "input" : null;
  }
  if (OUTPUT_ITEMS.has(payload.type)) return "output";
  if (INPUT_ITEMS.has(payload.type)) return "input";
  return null;
}

function taskStarted(line: string): { id: string; at: number } | null {
  if (!line.includes("\"task_started\"")) return null;
  let row: any;
  try { row = JSON.parse(line); } catch { return null; }
  const payload = row?.payload;
  if (row?.type !== "event_msg" || payload?.type !== "task_started" || typeof payload.turn_id !== "string") return null;
  const at = Date.parse(row.timestamp);
  return Number.isFinite(at) ? { id: payload.turn_id, at } : null;
}

/**
 * 读盘版。rollout 是 codex 异步写的,回合结束的通知到了、最后一两行未必已经落盘:
 * `minRequests` 是这一回合实时看到过几次用量,文件里记的还不够就稍等再读,等不齐就按读到的算
 * (少的那几次只是不计,不会算错)。任何失败都只是没有速度,不影响任务。
 */
export async function readCodexTurnTiming(
  threadId: string,
  which: Which,
  configDir?: string | null,
  minRequests = 0,
): Promise<OutputTiming | undefined> {
  if (!threadId) return undefined;
  try {
    const file = await findRollout(threadId, configDir);
    if (!file) return undefined;
    let result: CodexTurnTiming | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 100));
      result = codexTurnTiming(await readLines(file), which);
      if (result && result.requests >= minRequests) break;
    }
    return result?.timed;
  } catch (error) {
    console.warn(`[ash] failed to read Codex request timing for thread ${threadId}:`, error);
    return undefined;
  }
}

async function readLines(file: string): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) lines.push(line);
  return lines;
}
