import type { AgentType, SessionRole } from "@harness/shared";
import { bus } from "./bus.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { TURN_FAILED_TO_START } from "./run-prompts.js";

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
    type: "agent.event", taskId, sessionId: "", role, agentType,
    event: { kind: "error", message },
  });
  // 任务第一轮就起跑失败时它还没有任何会话，appendTaskTimeline 会如实返回 false
  //（那一档至少还有 failed 状态可见），这里不额外处理。
  await appendTaskTimeline(taskId, TURN_FAILED_TO_START(message, opts.undelivered), opts.target);
}
