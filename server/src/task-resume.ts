// 「运行/重试/队列推进」时选 resume 还是 fresh（从 orchestrator.ts 拆出，纯行数拆分）。
// 依赖方向单向：这里 import orchestrator，orchestrator 不回头 import 这里。
import { eq } from "drizzle-orm";
import type { AgentType } from "@harness/shared";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { now } from "./util.js";
import { continueTask, runTask, RESUME_PROMPT, type ResumeReason } from "./orchestrator.js";
import { freeReviewResumeOptions } from "./free-workflow.js";

// Decide between a fresh run and a resume when (re)starting a single task. A task
// that was interrupted keeps a session row with a cliSessionId (server restart
// leaves exitStatus null; manual stop / non-zero exit keep the id too) — resume
// THAT session so the agent continues from where it stopped, like the user typing
// 继续. A never-started task (no resumable session) runs fresh. paused 任务带着
// agent 写下的 resumePrompt 进来 —— 把它当作 user 输入回灌给 CLI 会话再清空，所以
// 不会反复触发同一段 prompt。Tail-returns the delegate so callers (esp. the
// scheduler) keep chaining on the same promise.
export async function resumeOrRunTask(
  taskId: string,
  opts: { reason?: ResumeReason } = {},
): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.mode !== "single") return runTask(taskId); // duets/missing → unchanged path
  // 检查点续跑：resumePrompt 当 user 消息回灌同一会话，先清空避免再次 settle 时又认成
  // paused（调度器会先标 queued，不能只看 paused）。reviewing run 挂着 = 中断的是审查
  // 回合：续跑必须带回 reviewer 身份与配置，否则以 single 恢复实现会话，审查链收不了尾。
  if (task.resumePrompt) {
    const rp = task.resumePrompt;
    const reviewerRoute = await freeReviewResumeOptions(taskId);
    await db.update(tasks).set({ resumePrompt: null, updatedAt: now() }).where(eq(tasks.id, taskId));
    const started = await continueTask(taskId, rp, { system: opts.reason ?? "run", ...(reviewerRoute ?? {}) });
    if (!started) {
      // 回合被别人抢了（典型：上一回合的 turn 还没 release）：checkpoint 指令一个字都没
      // 送出去，必须放回原位等下一次触发——清了不回写就是永久丢失（审查实测复现）。
      await db.update(tasks).set({ resumePrompt: rp, updatedAt: now() }).where(eq(tasks.id, taskId));
    }
    return;
  }
  const agent = (task.agentType as AgentType) ?? "claude";
  const prev = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
    .filter((s) => s.agentType === agent)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .at(0);
  if (prev?.cliSessionId) {
    const reviewerRoute = await freeReviewResumeOptions(taskId);
    await continueTask(taskId, RESUME_PROMPT, { system: opts.reason ?? "run", ...(reviewerRoute ?? {}) });
    return;
  }
  return runTask(taskId); // no resumable session → fresh
}