// 历史回填的 trace 那一半：把旧 claude 会话 trace 里那几条 usage 事件读出来、改写成真实
// 增量。账那一半在 claude-usage-repair.ts。
//
// **为什么非得改数据、不能在读侧算**：气泡上的「本轮」读的就是 trace 里这条事件。旧
// claude trace 存的是整条线程的累计快照，而它们一条不缺地都标着 `incremental`（当时的
// 代码认为 claude 本来就是增量），标记没有分辨力。曾经试过在读侧按数据形状判（整串不降
// + 末条等于会话汇总），被审查当场证伪：那个恒等式只对「已回填、此后没再续聊」的会话
// 成立，随便续一轮，整条历史的气泡就集体弹回累计值；跨 ash 会话行的线程更是永远凑不出。
// **一条旧记录的含义不能随「以后会不会续聊」改变** —— 所以真实增量必须逐条写回数据里。
//
// 改写的四条自保：
// ① 只动被判定要改的那几条 usage 行，其余行**原样保留**（按行处理，不整份重新序列化）；
// ② 第一次改写前把原文件留一份 `.pre-usage-repair` 备份；
// ③ **先把所有文件验一遍、再动手写**：读不到、索引对不上、只存在于只读回退目录的，
//    在验的那一遍就被挑出来，不会写到一半才发现；
// ④ **按 CLI 线程整组成败**：一条线程里只要有一份 trace 验不过，这条线程的 trace 一份
//    都不改（它的账也跟着不改，见 claude-usage-repair 的 applyClaudeUsageRepair）。
//    理由是「一半改过一半没改」比「都没改」坏得多：剩下那半截累计值的上一份基线已经
//    被改成增量了，下一次回填再也算不回真实增量。
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

export type TraceUsageEdit = { index: number; usage: TokenUsage; accounting: UsageAccountingMark };
export type SessionTraceRewrite = {
  taskId: string;
  sessionId: string;
  /** 这条会话属于哪条 CLI 线程 —— 成败按线程整组算，见文件头第 ④ 条。 */
  cliSessionId: string;
  edits: TraceUsageEdit[];
};
export type TraceRewriteResult = {
  files: number;
  entries: number;
  failures: string[];
  /** 这些 CLI 线程的 trace 一份都没改，它们的账也不许改。 */
  failedThreads: Set<string>;
};

export const TRACE_BACKUP_SUFFIX = ".pre-usage-repair";

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

/** 把一行 trace 里的 usage 换成真实增量。认不出 / 不是 usage 的行原样返回。 */
function rewriteLine(line: string, edit: TraceUsageEdit): string | null {
  const parsed = parseSessionTrace(line)[0];
  if (!parsed || parsed.event.kind !== "usage") return null;
  return JSON.stringify({
    ...parsed,
    event: { ...parsed.event, usage: edit.usage, accounting: edit.accounting },
  });
}

type Prepared = { rewrite: SessionTraceRewrite; path: string; original: string; next: string; applied: number };

/** 把一份 trace 的新内容算出来，但不落盘。认不出就返回失败说明。 */
function prepare(rewrite: SessionTraceRewrite): Prepared | string {
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
    const next = rewriteLine(line, edit);
    if (next === null) {
      broken = `${where}：第 ${cursor} 条 usage 行改写不了`;
      return line;
    }
    applied += 1;
    return next;
  });
  if (broken) return broken;
  // 索引对不上说明这份 trace 跟计划读到的不是同一份（文件变过，或计划读的是回退目录里
  // 的另一份）。半份改写比不改写坏得多，整份跳过。
  if (applied !== rewrite.edits.length) {
    return `${where}：计划改 ${rewrite.edits.length} 条 usage，文件里只对上 ${applied} 条，整份不动`;
  }
  return { rewrite, path, original, next: lines.join("\n"), applied };
}

export function applyTraceRewrites(rewrites: readonly SessionTraceRewrite[]): TraceRewriteResult {
  const failures: string[] = [];
  const failedThreads = new Set<string>();
  const prepared: Prepared[] = [];
  // 第一遍：只验不写。
  for (const rewrite of rewrites) {
    if (rewrite.edits.length === 0) continue;
    const result = prepare(rewrite);
    if (typeof result === "string") {
      failures.push(result);
      failedThreads.add(rewrite.cliSessionId);
      continue;
    }
    prepared.push(result);
  }
  // 第二遍：只写「整条线程都验过」的那些。
  let files = 0;
  let entries = 0;
  for (const item of prepared) {
    if (failedThreads.has(item.rewrite.cliSessionId)) {
      failures.push(`${item.rewrite.taskId}/${item.rewrite.sessionId}：同一条 CLI 线程里有别的 trace 验不过，整条线程都不改`);
      continue;
    }
    try {
      const backup = `${item.path}${TRACE_BACKUP_SUFFIX}`;
      if (!existsSync(backup)) writeFileSync(backup, item.original);
      const temp = `${item.path}.repair-tmp`;
      writeFileSync(temp, item.next);
      renameSync(temp, item.path);
    } catch (error) {
      // 走到这里说明磁盘出了问题。这条线程已经写下的那几份只能靠 .pre-usage-repair
      // 备份人工回滚 —— 把它报出来，别让它看起来像成功。
      failures.push(`${item.rewrite.taskId}/${item.rewrite.sessionId}：写回失败（${(error as Error).message}）`);
      failedThreads.add(item.rewrite.cliSessionId);
      continue;
    }
    files += 1;
    entries += item.applied;
  }
  return { files, entries, failures, failedThreads };
}
