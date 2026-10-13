import type { AgentType, SessionRole } from "@ash/shared";
import { and, desc, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { TURN_FAILED_TO_START } from "./run-prompts.js";
import { id, now } from "./util.js";

export function isDiagnosticSession(session: Pick<typeof sessions.$inferSelect,
  "cliSessionId" | "commandLine" | "turnStartedAt" | "activeMs" | "exitStatus" | "startedAt" | "endedAt"
>): boolean {
  return !session.cliSessionId
    && !session.commandLine
    && !session.turnStartedAt
    && session.activeMs === 0
    && session.exitStatus === 1
    && session.endedAt === session.startedAt;
}

export async function freshRunFailureTarget(task: typeof tasks.$inferSelect, runOwnerUserId: string | null) {
  const agentType = (task.agentType as AgentType) ?? "claude";
  const [existing] = await db.select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.taskId, task.id), eq(sessions.agentType, agentType), eq(sessions.role, "single")))
    .orderBy(desc(sessions.startedAt)).limit(1);
  if (existing) return { sessionId: existing.id, agentType, role: "single" as const };
  const sessionId = id();
  const at = now();
  await db.insert(sessions).values({
    id: sessionId, taskId: task.id, role: "single", agentType, executor: agentType,
    runOwnerUserId, cwd: null, startedAt: at, endedAt: at,
    exitStatus: 1, activeMs: 0,
  });
  return { sessionId, agentType, role: "single" as const };
}

// 一个回合挂掉之后，**用户那边能看见什么**。
//
// 老做法只发一条 SSE 错误事件就算交代过了 —— 而它带的 sessionId 是空串，前端按会话分发
// 根本落不到任何一条对话上，刷新一次更是什么都不剩。这条路径最常见的走法恰恰是「用户在
// 一个已验收的任务里发了句话，worktree 建不出来」：他看到的就是「显示已发送，然后没
// 反应」（实测任务 gsppwUacwZnn：/reply 返回 202，会话里什么都没有，状态也一动不动）。
// 按 AGENTS.md 的持久可见约定，事件照发（开着页面的人即时看到），同时补一条真气泡。
export async function reportTurnFailure(opts: {
  taskId: string;
  message: string;
  role: SessionRole;
  agentType?: AgentType;
  /**
   * 这句话**一个字都没送出去**时传原文（判据是 spawn 有没有发生）。原文得跟正常投递
   * 同一份（userText + attachmentsPrompt）：它的 user 气泡也没写进 .md，不附上就真丢了，
   * 只还文字则等于把附件吞了。spawn 之后才挂的不传 —— 那是消费阶段出的岔子，话已经在
   * agent 手里了。
   */
  undelivered?: string;
  /**
   * 这条交代属于**哪一位**。任务里可以有多条会话（用户 @ 谁就多一条），按默认的「最新
   * 会话」投递会让被 @ 的那位一片空白、另一位的时间线里冒出不属于它的失败。
   */
  target?: { sessionId?: string; agentType?: AgentType; role?: SessionRole };
}): Promise<void> {
  const { taskId, message, role, agentType } = opts;
  bus.publish({
    type: "agent.event", taskId, sessionId: opts.target?.sessionId ?? "", role, agentType,
    event: { kind: "error", message },
  });
  await appendTaskTimeline(taskId, TURN_FAILED_TO_START(message, opts.undelivered), opts.target);
}
