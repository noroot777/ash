// 会话记录的号（`seq`，见 shared/src/session-output.ts 的 RecordIdentity）。
//
// 一条会话在盘上是两份文件：`.md`（正文 + 一行行 sentinel）和 `.trace.jsonl`（执行过程）。两份
// 里新写下的每一条记录都从这里领**同一个号段**里的下一个号，实时事件带同一个值 —— 于是页面能
// 把两份文件按写下的先后排成一列（哪几步在哪一句插话之前），也能认出「这条实时事件就是盘上那条」，
// 不必再拿时间窗口和文字去比。
//
// 号只活在进程内存里。进程重启（或第一次碰这条会话）时从两份文件的尾巴上把用过的最大号接回来：
// 号随写入单调增长，最大的那个一定贴在文件末尾；尾巴里一个都找不到（一段特别长的正文把它挤出
// 去了）才整份读一遍。从没带过号的老会话从 1 起。同一条会话只有一个 ash 进程在写（单实例锁），
// 所以内存里这一份就是权威。
//
// 只认**记录本身的元数据**：`.md` 里的 sentinel 行（`\x1e` 开头的那种 JSON）、trace 每一行顶层的
// `seq`。正文里的字（agent 写了一段带 `"seq":…` 的 JSON 示例）不算 —— 它们没有资格决定以后的号。
// 号必须是安全整数；接不回来（读文件出错、号已经顶到安全整数上限）就**不发号**（返回 null）：
// 宁可这条会话之后的记录不带身份、页面退回老读法，也不能从一个可能撞号的低位接着发。
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.js";

// 任务 → 会话 → 已经发到的号。按任务分组：删任务时整组丢掉（forgetTaskRecordSeq）。
const counters = new Map<string, Map<string, number>>();

const TAIL_BYTES = 256 * 1024;
const SENTINEL = "\x1e";

const safeSeq = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** 一段文字里记录元数据上的最大号。`md`：只看 sentinel 行；`trace`：只看每一行顶层的 seq。切口那半行解析不过，跳过。 */
function maxSeqIn(text: string, kind: "md" | "trace"): number {
  let max = 0;
  for (const line of text.split("\n")) {
    const json = kind === "md" ? (line.startsWith(SENTINEL) ? line.slice(SENTINEL.length) : null) : line;
    if (!json || !json.includes("\"seq\"")) continue;
    try {
      const seq = safeSeq((JSON.parse(json) as { seq?: unknown }).seq);
      if (seq !== null) max = Math.max(max, seq);
    } catch { /* 不是一行完整的元数据 */ }
  }
  return max;
}

/** 一份文件里用过的最大号：先看尾巴，尾巴里没有、文件又比尾巴长，才整份读。读不出来就抛。 */
function maxSeqInFile(path: string, kind: "md" | "trace"): number {
  if (!existsSync(path)) return 0;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (from: number, length: number): string => {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, from);
      return buffer.toString("utf8");
    };
    const tail = maxSeqIn(read(Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES)), kind);
    if (tail || size <= TAIL_BYTES) return tail;
    return maxSeqIn(read(0, size), kind);
  } finally {
    closeSync(fd);
  }
}

function recovered(taskId: string, sessionId: string): number | null {
  const dir = join(RUNS_DIR, taskId);
  try {
    return Math.max(maxSeqInFile(join(dir, `${sessionId}.md`), "md"), maxSeqInFile(join(dir, `${sessionId}.trace.jsonl`), "trace"));
  } catch (error) {
    console.warn(`[ash] 接回会话记录号失败 ${taskId}/${sessionId}，这条会话之后的记录不带身份:`, error);
    return null;
  }
}

/** 这条会话的下一个记录号；接不回来、或已经发到安全整数上限时是 null（这条记录不带身份）。 */
export function nextRecordSeq(taskId: string, sessionId: string): number | null {
  const task = counters.get(taskId) ?? new Map<string, number>();
  const last = task.get(sessionId) ?? recovered(taskId, sessionId);
  if (last === null || last >= Number.MAX_SAFE_INTEGER) return null;
  task.set(sessionId, last + 1);
  counters.set(taskId, task);
  return last + 1;
}

/** 内存里记着的号作废，下次从盘上重新接（测试模拟重启用）。 */
export function forgetRecordSeq(taskId: string, sessionId: string): void {
  counters.get(taskId)?.delete(sessionId);
}

/** 任务连同会话一起删了：号不必再记（task-delete-routes 删任务时调）。 */
export function forgetTaskRecordSeq(taskId: string): void {
  counters.delete(taskId);
}
