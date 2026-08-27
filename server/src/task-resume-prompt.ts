// tasks.resume_prompt（检查点续跑指令）的两个 CAS 写入助手，外加它们共用的整行广播。
//
// 单独成文件是因为这一列有个别处没有的性质：**前端拿它当门禁读**。resumePrompt 非空 =
// 「任务在等续跑」，自由工作流工具条（web/src/free-workflow/FreeWorkflowToolbar.tsx 的
// waiting）据此把派审 / 预约 / 修复 / 打开预览整排按钮禁掉，后端 startFreeReview 与手动
// 修复也卡同一条判据（409）。而 SSE 只有 task.status / task.question / task.stage /
// task.title 这几种**局部**事件，没有一条带 resume_prompt；任务列表也只在首次加载和断线
// 重连时整表拉一次（web/src/lib/useTasks.ts，没有轮询）。于是直接 db.update 改这一列，
// 长开着的页面就永久停在旧值：
//   - 清空不广播 → 该亮的按钮一直灰。接力移回实测：导入把「接力前言」写进 resume_prompt
//     并广播了整行，0.13 秒后自动续跑把它取走却没广播，页面一直灰到用户手动刷新。
//   - 写入不广播 → 该灰的按钮一直亮，点下去吃后端 409。
// 复合更新里顺手改到这一列（结算、原生引导的清场与回滚）用不上下面的 CAS 助手，那些地方
// 直接调 announceResumePrompt 补一条广播。
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";

/** 把整行推给客户端。广播失败只记日志：实时通知挂了不该反过来把已经落库的写入判成失败。 */
export async function announceResumePrompt(taskId: string): Promise<void> {
  try {
    await publishTaskUpdated(taskId);
  } catch (error) {
    console.warn(`[ash] 续跑指令已更新，但实时通知失败 ${taskId}:`, error);
  }
}

/**
 * CAS 取走这段续跑指令：只清掉调用方读到的那一段。
 * 返回是否**由本次调用**清掉（false = 被另一路取走了，或 agent 刚换了新的一段）。
 */
export async function takeResumePrompt(taskId: string, expected: string): Promise<boolean> {
  const cleared = await db
    .update(tasks)
    .set({ resumePrompt: null, updatedAt: now() })
    .where(and(eq(tasks.id, taskId), eq(tasks.resumePrompt, expected)))
    .returning({ id: tasks.id });
  if (!cleared.length) return false;
  await announceResumePrompt(taskId);
  return true;
}

/**
 * CAS 回填：只填回自己腾出的那个空。这中间 agent 可能已经 pause_task 写下**新的**一段，
 * 无条件回填就是拿旧指令盖掉新指令。
 */
export async function restoreResumePrompt(taskId: string, value: string): Promise<boolean> {
  const restored = await db
    .update(tasks)
    .set({ resumePrompt: value, updatedAt: now() })
    .where(and(eq(tasks.id, taskId), isNull(tasks.resumePrompt)))
    .returning({ id: tasks.id });
  if (!restored.length) return false;
  await announceResumePrompt(taskId);
  return true;
}
