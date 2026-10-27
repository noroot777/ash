// 历史回填的 trace 那一半：把旧 claude 会话 trace 里那几条 usage 事件读出来、改写成真实
// 增量。账那一半在 claude-usage-repair.ts，提交协议在 claude-usage-apply.ts。
//
// **为什么非得改数据、不能在读侧算**：气泡上的「本轮」读的就是 trace 里这条事件。旧
// claude trace 存的是整条线程的累计快照，而它们一条不缺地都标着 `incremental`（当时的
// 代码认为 claude 本来就是增量），标记没有分辨力。曾经试过在读侧按数据形状判（整串不降
// + 末条等于会话汇总），被审查当场证伪：那个恒等式只对「已回填、此后没再续聊」的会话
// 成立，随便续一轮，整条历史的气泡就集体弹回累计值；跨 ash 会话行的线程更是永远凑不出。
// **一条旧记录的含义不能随「以后会不会续聊」改变** —— 所以真实增量必须逐条写回数据里。
//
// 这个文件只管单份文件的三件事：**算**（prepare，不落盘）、**写**（write）、**还原**
// （restore）。「谁跟谁一起成败」是提交协议的事，归 claude-usage-apply.ts。
//
// 三条自保：
// ① 只动被判定要改的那几条 usage 行，其余行**原样保留**（按行处理，不整份重新序列化）；
// ② 第一次改写前把原文件留一份 `.pre-usage-repair` 备份；
// ③ **校验的是内容身份，不只是位置**：每条编辑都带着计划当时读到的原值，对不上就整份
//    不动。只核对「第 n 条 usage 命中了」是不够的 —— 计划之后文件要是被追加或改过，
//    同一个下标上很可能已经是另一份数字，照写就是拿陈旧计划盖掉新内容（第 2 轮审查 F2）。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { TokenUsage, UsageAccountingMark } from "@ash/shared";
import { parseSessionTrace, readableRunPath, sessionTracePath } from "./transcript.js";

/** 落盘口径：undefined / incremental 都是「改口径之前的旧账」，见 shared 的 UsageAccountingMark。 */
export type LegacyMark = UsageAccountingMark | undefined;
export const isLegacyMark = (mark: LegacyMark): boolean => mark === undefined || mark === "incremental";

export type UsageTraceEntry = {
  at: string;
  sessionId: string;
  /** 这是本文件里第几条 usage 事件（从 0 起）。改写时按它定位，所以必须和读的时候用同一套校验。 */
  index: number;
  usage: TokenUsage;
  mark: LegacyMark;
};

export type TraceUsageEdit = {
  index: number;
  /** 计划当时在这个位置读到的原值 —— 写之前要逐项核对，防止拿陈旧计划盖掉新内容。 */
  expected: TokenUsage;
  expectedMark: LegacyMark;
  usage: TokenUsage;
  accounting: UsageAccountingMark;
};
export type SessionTraceRewrite = {
  taskId: string;
  sessionId: string;
  /** 这条会话属于哪条 CLI 线程 —— 成败按线程整组算，见 claude-usage-apply.ts。 */
  cliSessionId: string;
  edits: TraceUsageEdit[];
};

export const TRACE_BACKUP_SUFFIX = ".pre-usage-repair";

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "turns"] as const;
const sameReported = (a: TokenUsage, b: TokenUsage) =>
  TOKEN_FIELDS.every((key) => a[key] === b[key]) && (a.costUsd ?? null) === (b.costUsd ?? null);

/**
 * 从一条会话的 trace 里把 usage 事件按顺序取回来。**读不到文件返回 null（≠ 空数组）**：
 * 「这条会话一轮都没报账」和「它的 trace 丢了」必须分开，后者不能被当成可重算的完整历史。
 */
export function readUsageTrace(taskId: string, sessionId: string): UsageTraceEntry[] | null {
  let text: string;
  try {
    text = readFileSync(readableRunPath(sessionTracePath(taskId, sessionId)), "utf8");
  } catch {
    return null;
  }
  const entries: UsageTraceEntry[] = [];
  for (const entry of parseSessionTrace(text)) {
    if (entry.event.kind !== "usage") continue;
    const event = entry.event as { kind: "usage"; usage: TokenUsage; accounting?: UsageAccountingMark };
    entries.push({ at: entry.at, sessionId, index: entries.length, usage: event.usage, mark: event.accounting });
  }
  return entries;
}

/** 算好但没落盘的一份改写。`original` 留着是为了失败时还原。 */
export type PreparedTrace = {
  rewrite: SessionTraceRewrite;
  path: string;
  original: string;
  next: string;
  applied: number;
};

/** 把一份 trace 的新内容算出来，但不落盘。认不出就返回失败说明（string）。 */
export function prepareTraceRewrite(rewrite: SessionTraceRewrite): PreparedTrace | string {
  const path = sessionTracePath(rewrite.taskId, rewrite.sessionId);
  const where = `${rewrite.taskId}/${rewrite.sessionId}`;
  // 预览实例的 RUNS_FALLBACK_DIR 指着主仓的 data/runs；本实例没有这份文件时读会回退到
  // 那边，但写**绝不允许**落在别人的历史上。
  if (readableRunPath(path) !== path) return `${where}：trace 只存在于只读回退目录，不改写`;
  let original: string;
  try {
    original = readFileSync(path, "utf8");
  } catch (error) {
    return `${where}：读不到 trace（${(error as Error).message}）`;
  }
  const byIndex = new Map(rewrite.edits.map((item) => [item.index, item]));
  let cursor = -1;
  let applied = 0;
  let broken: string | null = null;
  const lines = original.split("\n").map((line) => {
    if (!line.trim() || broken) return line;
    const parsed = parseSessionTrace(line)[0];
    if (!parsed || parsed.event.kind !== "usage") return line;
    cursor += 1;
    const edit = byIndex.get(cursor);
    if (!edit) return line;
    const event = parsed.event as { kind: "usage"; usage: TokenUsage; accounting?: UsageAccountingMark };
    if (!sameReported(event.usage, edit.expected) || event.accounting !== edit.expectedMark) {
      broken = `${where}：第 ${cursor} 条 usage 跟计划当时读到的不一样（文件在这期间变过），整份不动`;
      return line;
    }
    applied += 1;
    return JSON.stringify({ ...parsed, event: { ...event, usage: edit.usage, accounting: edit.accounting } });
  });
  if (broken) return broken;
  // 命中数对不上说明这份 trace 跟计划读到的不是同一份。半份改写比不改写坏得多，整份跳过。
  if (applied !== rewrite.edits.length) {
    return `${where}：计划改 ${rewrite.edits.length} 条 usage，文件里只对上 ${applied} 条，整份不动`;
  }
  return { rewrite, path, original, next: lines.join("\n"), applied };
}

/** 落盘（临时文件 + rename）。成功返回 null，失败返回说明。 */
export function writePreparedTrace(item: PreparedTrace): string | null {
  const where = `${item.rewrite.taskId}/${item.rewrite.sessionId}`;
  try {
    const backup = `${item.path}${TRACE_BACKUP_SUFFIX}`;
    if (!existsSync(backup)) writeFileSync(backup, item.original);
    const temp = `${item.path}.repair-tmp`;
    writeFileSync(temp, item.next);
    renameSync(temp, item.path);
    return null;
  } catch (error) {
    return `${where}：写回失败（${(error as Error).message}）`;
  }
}

/** 把已经写下去的那一份还原成原内容。成功返回 null，失败返回说明。 */
export function restorePreparedTrace(item: PreparedTrace): string | null {
  const where = `${item.rewrite.taskId}/${item.rewrite.sessionId}`;
  try {
    const temp = `${item.path}.repair-rollback`;
    writeFileSync(temp, item.original);
    renameSync(temp, item.path);
    return null;
  } catch (error) {
    return `${where}：回滚失败，文件仍是改写后的内容（${(error as Error).message}）`;
  }
}
