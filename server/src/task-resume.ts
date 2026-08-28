// 「运行/重试/队列推进」时选 resume 还是 fresh（从 orchestrator.ts 拆出，纯行数拆分）。
// 依赖方向单向：这里 import orchestrator，orchestrator 不回头 import 这里。
import { eq } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { continueTask, runTask, type ResumeReason } from "./orchestrator.js";
import { RESUME_PROMPT } from "./run-prompts.js";
import { freeReviewResumeOptions } from "./free-workflow.js";
import { restoreResumePrompt, takeResumePrompt } from "./task-resume-prompt.js";

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
  opts: { reason?: ResumeReason; turnHeld?: boolean; actingUserId?: string | null } = {},
): Promise<void> {
  // `actingUserId` 一路原样往下传:它决定这一轮烧谁的 key(§八)。这里只是个中转,
  // 不给默认值 —— 后端触发的那几路本来就该退回任务归属人。
  const acting = opts.actingUserId ?? undefined;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.mode !== "single") return runTask(taskId, { turnHeld: opts.turnHeld, actingUserId: acting }); // duets/missing → unchanged path
  // 检查点续跑：resumePrompt 当 user 消息回灌同一会话，先清空避免再次 settle 时又认成
  // paused（调度器会先标 queued，不能只看 paused）。reviewing run 挂着 = 中断的是审查
  // 回合：续跑必须带回 reviewer 身份与配置，否则以 single 恢复实现会话，审查链收不了尾。
  const rp = task.resumePrompt;
  if (rp) {
    const reviewerRoute = await freeReviewResumeOptions(taskId);
    // 取走这段 checkpoint 指令要 CAS(`resume_prompt = rp`)：读到 rp 之后到清空之间隔着
    // 至少一个 await，两路触发(HTTP /run 与队列推进)会双双读到同一段、双双清空、于是
    // 一路送出、另一路把它当「没送出去」回填，下次触发再送一遍(审查实测:同一段指令投递两次)。
    // CAS 与整行广播都在 takeResumePrompt/restoreResumePrompt 里（见那个文件顶部：这一列
    // 是前端的门禁，改了不广播，长开的页面会一直把任务读成「在等续跑」）。
    if (await takeResumePrompt(taskId, rp)) {
      const started = await continueTask(taskId, rp, { system: opts.reason ?? "run", turnHeld: opts.turnHeld, actingUserId: acting, ...(reviewerRoute ?? {}) });
      if (!started) {
        // 回合被别人抢了（典型：上一回合的 turn 还没 release）：checkpoint 指令一个字都没
        // 送出去，必须放回原位等下一次触发——清了不回写就是永久丢失（审查实测复现）。
        await restoreResumePrompt(taskId, rp);
      }
      return;
    }
    // CAS 没抢到 = 这段指令被另一路取走了(或 agent 刚换了新的一段)。**不能直接 return**:
    // turnHeld 时回合已经原子占在我头上,返回就把它永久漏掉了。落到下面的通用路径
    // (resume/fresh),turn 由 continueTask/runTask 照常接管并释放。
  }
  const agent = (task.agentType as AgentType) ?? "claude";
  const prev = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
    .filter((s) => s.agentType === agent)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .at(0);
  if (prev?.cliSessionId) {
    const reviewerRoute = await freeReviewResumeOptions(taskId);
    await continueTask(taskId, RESUME_PROMPT, { system: opts.reason ?? "run", turnHeld: opts.turnHeld, actingUserId: acting, ...(reviewerRoute ?? {}) });
    return;
  }
  return runTask(taskId, { turnHeld: opts.turnHeld, actingUserId: acting }); // no resumable session → fresh
}
