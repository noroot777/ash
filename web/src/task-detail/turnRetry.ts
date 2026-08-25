import type { FreeReviewRun, TaskListItem } from "@ash/shared";
import type { ConversationItem } from "./conversationModel.ts";

// 「上一回合崩了」的判据，和会话尾栏那颗重试按钮共用一份。判据必须跟服务端
// `server/src/task-retry-turn.ts` 的 `retryTurnRejection` 对齐 —— 两边说法不一样，
// 按钮就成了「点了永远 409」。
//
// 存在的理由：续聊回合、自由工作流的自动修复回合与审查回合非正常结束时，任务状态**不变**
// （服务端只在正文里留一句「续聊回合异常结束(退出码 N),任务状态保持「已完成」不变」）。于是
// 任务停在 done，头部那颗「重试」不出现（它只认 failed），整页没有任何能重来的入口。
//
// 只挂在**最后一条 agent 气泡**上：会话尾巴才是「上一回合」，中间那些崩过的回合后面早
// 已经跑过别的了，给它们按钮等于骗人。
//
// 服务端另有三道闸这里判不了（分组暂停、同队列前面还没跑完、上一回合那条执行器 profile
// 后来被改过或删了）：那三样前端手上没有权威数据，按钮照出，点下去由 409 如实说明原因。

export type TurnRetryKind = "turn" | "review";
export type TurnRetryTarget = { sessionId: string; kind: TurnRetryKind; exitStatus: number };

/**
 * 这条自由工作流的审查链能不能重跑上一回合（镜像服务端 `freeReviewRetryBlocker`）。
 *
 * 只认一种形状：最近一条 run 停在 failed、且它当前那一轮停在 error —— 那正是「审查回合
 * 异常结束、自动复审已停止」留下的痕迹。已给出结论的轮次是正常结局，要再看一遍得派新一轮。
 */
export function freeReviewRetryable(reviews: FreeReviewRun[] | undefined): boolean {
  const run = reviews?.[0]; // 服务端按 createdAt 倒序给，第一条就是最近这条链
  if (!run || run.status !== "failed") return false;
  return run.rounds.some((round) => round.round === run.currentRound && round.status === "error");
}

export function turnRetryTarget(
  task: TaskListItem,
  items: ConversationItem[],
  // 自由工作流的审查链状态（来自共享缓存的 useFreeWorkflowState，不额外发请求）。
  // 不给 = 按「审查链不可重跑」处理，reviewer 会话上就不出按钮。
  opts: { reviewRetryable?: boolean } = {},
): TurnRetryTarget | null {
  // duet/团队各有自己的回合形状（gate、常驻调度台），服务端也只接单飞。
  if (task.mode !== "single" || task.archived) return null;
  if (task.status === "running" || task.status === "queued") return null;
  // 遗留的提问 / 检查点续跑指令各有自己的入口（答复、继续），带着它们重投会让等答复的
  // 那条链收不了尾。
  if (task.question || task.resumePrompt) return null;
  // 就地验证轮还挂着号 = 那一轮没出结论，它是旁路回合，重跑它得走验证那条路。
  if (task.verifyRound != null) return null;
  const last = [...items].reverse().find((item) => item.kind === "agent");
  if (last?.kind !== "agent") return null;
  const session = last.session;
  if (!session) return null;
  // **主动停止/暂停也会留下非零退出码**（CLI 吃 SIGTERM 后按 signal 写 exit 1）。那不是崩溃，
  // 它们的入口是头部那颗「运行」；只有服务端记下的 stoppedAs 分得开这两者。
  if (session.stoppedAs) return null;
  const exitStatus = session.exitStatus;
  // exitStatus 为 null = 回合还没结算（或 server 重启时断的），那不是「异常结束」。
  if (exitStatus == null || exitStatus === 0) return null;
  if (session.role === "reviewer") {
    // 自由工作流的审查回合崩了：按钮把**那一轮**重新拉起来（同一位审查者续跑），而不是
    // 拿任务自己的实现 agent 顶上。链本身不在「异常结束」状态就不给按钮。
    if (task.workflowMode !== "free" || !opts.reviewRetryable) return null;
    return { sessionId: session.id, kind: "review", exitStatus };
  }
  // 剩下的只放行普通实现回合：lead/voiceA/voiceB 这些身份连「上一回合」的形状都不同。
  if (session.role !== "single") return null;
  // 旁路回合（就地验证、`/compact` 这类 CLI 原生命令）重投会按任务当前配置另跑一段普通
  // 回合，跑的根本不是那一轮的验证者；它们各有自己的重来入口。
  if (session.sideTurn) return null;
  // failed 归头部那颗「重试」，canceled/paused/backlog 归「运行」。
  if (task.status !== "done") return null;
  return { sessionId: session.id, kind: "turn", exitStatus };
}
