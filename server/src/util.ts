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
