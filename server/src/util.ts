import { nanoid } from "nanoid";

export const id = () => nanoid(12);
export const now = () => new Date().toISOString();

// 任务正文里的 {{TASK_ID}} 占位符在建行时替换成真实 id（单建与批量两条路共用）。
export const taskBody = (body: string | undefined, taskId: string): string =>
  (body ?? "").replaceAll("{{TASK_ID}}", taskId);

// Agents read attachments off disk, not stdin. Append the absolute paths of any
// pasted images/files as a trailing block so the agent knows to Read them
// (Read renders images and reads files alike).
export const attachmentsPrompt = (attachments?: string[]): string =>
  attachments?.length
    ? `\n\n[用户附带的文件，请用 Read 工具查看以下本地文件]\n${attachments.map((p) => `- ${p}`).join("\n")}`
    : "";

// Execution-time accounting from a task's session rows. Each row carries the
// running total of its turns' active spans (active_ms) and the start of its
// current/last turn (turn_started_at). A task's execution time is the sum across
// its rows; `liveSince` is the start of whichever turn is live now (a row with no
// ended_at) so a client can tick `activeMs + (now − liveSince)`. measured=false
// (any row predates per-turn timing, or the task never ran) → activeMs null, so
// surfaces fall back to the lifespan instead of reporting a wrong number.
export function runsTiming(
  runs: { activeMs: number | null; turnStartedAt: string | null; endedAt: string | null }[],
): { activeMs: number | null; liveSince: string | null } {
  const measured = runs.length > 0 && runs.every((r) => r.turnStartedAt != null);
  const activeMs = measured ? runs.reduce((s, r) => s + (r.activeMs ?? 0), 0) : null;
  const liveSince = runs.find((r) => r.endedAt == null)?.turnStartedAt ?? null;
  return { activeMs, liveSince };
}

/**
 * 往一张「按插入顺序淘汰」的 Map 里放一条，顺手把最老的挤掉。
 *
 * 给**缓冲用的**表用（没等到配对事实的孤儿事实、按任务存的扫描快照之类）：它们的键来自
 * 来源侧，天然没有上限，而缺了淘汰就是一条长期运行的内存泄漏。JS 的 Map 保持插入顺序，
 * 所以 `keys().next()` 就是最老的那条。
 *
 * 想让「用过的」活得久一点就先 `delete` 再 `set`（Map 会把它挪到末尾）。
 */
export function putCapped<K, V>(map: Map<K, V>, key: K, value: V, cap: number): boolean {
  map.delete(key); // 已有就挪到末尾：重复写入的那条显然还活跃
  map.set(key, value);
  let evicted = false;
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
    evicted = true;
  }
  // **返回「挤掉过东西吗」**：缓存可以无声淘汰，一次性事实不行——调用方得有机会把那一段
  // 重读回来（第 7 轮审查：孤儿事实缓冲满了会静默丢掉来源终态）。
  return evicted;
}
