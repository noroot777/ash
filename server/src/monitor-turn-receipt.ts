// 回合里交出去的哨兵结果**到没到 agent 手上**,唯一认的证据:它自己那条会话的事件流里记着那次
// 工具返回(monitor-turn-handoff.ts ②)。
//
// 为什么不认别的:服务端能写下的每一笔(「已交」、「返回构造完了」、失败时的「退回」)都只证明
// 服务端这一侧做到了哪一步 —— 返回之后还隔着 MCP 进程、执行器、一条可能随时断掉的通道,而失败
// 之后补的那一笔写入本身也会失败。执行器把工具返回原文写进事件流(claude 的 stream-json、codex
// 的事件流都是),所以返回里夹一个随机回执号,事件流里出现了它 = 它收到了;没出现,不管服务端
// 当时以为自己做到了哪一步,都按没收到算。
//
// 回执号是随机的,命令输出、文档里不可能事先写着它;只用 ASCII,JSON 转义不会改动它。
// 放在结果的**最前面**:返回太长被执行器截断时,截掉的是尾巴。
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.js";

/** 事件流里记得下工具返回原文的执行器。别的执行器拿不出回执,不做回合内交付(照老路唤醒)。 */
export const RECEIPT_AGENTS: ReadonlySet<string> = new Set(["claude", "codex"]);

export const newHand = (): string => randomBytes(6).toString("hex");
export const receiptMark = (hand: string): string => `[ash-handoff:${hand}]`;
const MARK = /\[ash-handoff:([0-9a-f]{12})\]/g;

/**
 * 这条会话的事件流里出现过的回执号(只看 `since` 之后还写过的那几份)。读不到的文件 = 没有证据。
 *
 * 一条会话可能有好几份事件流(每回合一份;codex 的常驻会话可能一直写在开头那份里),回执号是
 * 随机的,所以全看一遍也不会认错。
 */
export function receivedHands(taskId: string, sessionId: string, since: string): Set<string> {
  const dir = join(RUNS_DIR, taskId);
  const seen = new Set<string>();
  let names: string[];
  try { names = readdirSync(dir); } catch { return seen; }
  const floor = Date.parse(since) - 1_000;
  for (const name of names) {
    if (!name.startsWith(`${sessionId}-`) || !name.endsWith(".agent-out.jsonl")) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < floor) continue;
      for (const m of readFileSync(path, "utf8").matchAll(MARK)) seen.add(m[1]!);
    } catch {
      // 读不到就是没有证据:按没收到算,宁可再送一遍
    }
  }
  return seen;
}

/** 这几行里,哪些的回执在它们各自那条会话的事件流里出现过。 */
export function receivedRows<T extends { turnHandoff: { hand: string; session: string; at: string } | null }>(
  taskId: string, rows: T[],
): Set<T> {
  const bySession = new Map<string, Set<string>>();
  const received = new Set<T>();
  for (const row of rows) {
    const h = row.turnHandoff;
    if (!h) continue;
    let seen = bySession.get(h.session);
    if (!seen) bySession.set(h.session, seen = receivedHands(taskId, h.session, h.at));
    if (seen.has(h.hand)) received.add(row);
  }
  return received;
}
