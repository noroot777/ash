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
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.js";

const counters = new Map<string, number>();

const TAIL_BYTES = 256 * 1024;
const SEQ_FIELD = /"seq":(\d+)/g;

function maxSeqIn(text: string): number {
  let max = 0;
  for (const match of text.matchAll(SEQ_FIELD)) max = Math.max(max, Number(match[1]));
  return max;
}

/** 一份文件里用过的最大号：先看尾巴，尾巴里没有、文件又比尾巴长，才整份读。 */
function maxSeqInFile(path: string): number {
  if (!existsSync(path)) return 0;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const read = (from: number, length: number): string => {
      const buffer = Buffer.alloc(length);
      readSync(fd!, buffer, 0, length, from);
      return buffer.toString("utf8");
    };
    const tail = maxSeqIn(read(Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES)));
    if (tail || size <= TAIL_BYTES) return tail;
    return maxSeqIn(read(0, size));
  } catch (error) {
    // 读不出来就当没有：号会从 1 起，跟盘上的撞号只影响页面去重（同号的两条认成一条），不影响落盘。
    console.warn(`[ash] 接回会话记录号失败 ${path}:`, error);
    return 0;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function recovered(taskId: string, sessionId: string): number {
  const dir = join(RUNS_DIR, taskId);
  return Math.max(maxSeqInFile(join(dir, `${sessionId}.md`)), maxSeqInFile(join(dir, `${sessionId}.trace.jsonl`)));
}

/** 这条会话的下一个记录号。 */
export function nextRecordSeq(taskId: string, sessionId: string): number {
  const next = (counters.get(sessionId) ?? recovered(taskId, sessionId)) + 1;
  counters.set(sessionId, next);
  return next;
}

/** 会话连文件一起删了：号不必再记（删任务时调）。 */
export function forgetRecordSeq(sessionId: string): void {
  counters.delete(sessionId);
}
