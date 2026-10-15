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
 * 往一张「按插入顺序淘汰」的 Set 里记一个**可重新推导的结论**，顺手把最老的挤掉。
 *
 * 给判定缓存用（例如「这个 tool_use 不是 Monitor」）：键来自来源侧，天然没有上限，而缺了
 * 淘汰就是一条长期运行的内存泄漏。JS 的 Set 保持插入顺序，所以 `values().next()` 就是最老
 * 的那条；想让「用过的」活得久一点就先 `delete` 再 `add`（下面就是这么做的）。
 *
 * **装一次性事实的缓冲不能用这个。** 那种东西来源侧不会重发，挤掉就是永久丢失；满了必须
 * 背压（停下来等它被消化），而不是淘汰——判据和经过见
 * `claude-monitor-scan.ts` 的 `LATE_CAP`。
 */
export function addCapped<T>(set: Set<T>, value: T, cap: number): void {
  set.delete(value);
  set.add(value);
  while (set.size > cap) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}
