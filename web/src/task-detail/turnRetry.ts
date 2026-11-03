import type { FreeReviewRun, Session, TaskListItem } from "@ash/shared";
import { turnEndedAbnormally } from "@ash/shared/turn-outcome";
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
/** 「继续本轮审查」认的那一轮审查：哪条链、第几轮、这一轮此刻的代次（服务端原样核对）。 */
export type ReviewRetryIdentity = { runId: string; round: number; generation: string | null };
/**
 * exitStatus 可能是 0/null：审查档不看退出码（见下），按钮文案据此换说法。
 * 审查档的 `sessionId` 只是「续哪条审查会话的上下文」，可能为 null（一条都没有）；认人靠 `review`。
 */
export type TurnRetryTarget =
  | { kind: "turn"; sessionId: string; exitStatus: number | null }
  | { kind: "review"; sessionId: string | null; exitStatus: number | null; review: ReviewRetryIdentity };

/**
 * 这条自由工作流的审查链此刻能不能「继续本轮审查」，能就给出那一轮的身份。
 *
 * 判据整份在服务端（`freeReviewRetryBlocker`：异常结束，或者送达说不清、等用户拿主意），它在
 * 状态里把结论连同代次发下来（`FreeReviewRound.retry`）。这里不再镜像一份 if —— 镜像就是在等
 * 两边漂开。
 */
export function freeReviewRetryIdentity(reviews: readonly FreeReviewRun[] | null | undefined): ReviewRetryIdentity | null {
  const run = reviews?.[0]; // 服务端按 createdAt 倒序给，第一条就是最近这条链
  const current = run?.rounds.find((round) => round.round === run.currentRound);
  return run && current?.retry ? { runId: run.id, round: current.round, generation: current.retry.generation } : null;
}

/** 最近一次回合跑在哪条会话上 —— 与服务端 `latestSessionOf` 同一口径（按最近一次回合起点）。 */
function latestSessionOf(sessions: Session[]): Session | null {
  const turnAt = (session: Session) => session.turnStartedAt ?? session.startedAt;
  return [...sessions].sort((left, right) => turnAt(left).localeCompare(turnAt(right))).at(-1) ?? null;
}

export function turnRetryTarget(
  task: TaskListItem,
  items: ConversationItem[],
  // `reviewRetry` = 能继续的那一轮审查（freeReviewRetryIdentity，来自共享缓存的
  // useFreeWorkflowState，不额外发请求）。不给 = 审查档一颗都不出。
  // `sessions` = 这个任务的会话行：审查档拿它找「续哪条审查会话」。
  opts: { reviewRetry?: ReviewRetryIdentity | null; sessions?: Session[] } = {},
): TurnRetryTarget | null {
  // duet/团队各有自己的回合形状（gate、常驻调度台），服务端也只接单飞。
  if (task.mode !== "single" || task.archived) return null;
  if (task.status === "running" || task.status === "queued") return null;
  // 遗留的提问 / 检查点续跑指令各有自己的入口（答复、继续），带着它们重投会让等答复的
  // 那条链收不了尾。
  if (task.question || task.resumePrompt) return null;
  // 就地验证轮还挂着号 = 那一轮没出结论，它是旁路回合，重跑它得走验证那条路。
  if (task.verifyRound != null) return null;
  const turn = crashedTurnTarget(task, items, opts.sessions);
  if (turn) return turn;
  // **审查档认那一轮审查，不认气泡、也不认「最新会话」**（服务端同口径，理由整段在
  // server/src/free-review-retry-identity.ts）：一句没说就断掉的审查回合不产生气泡；审查等着
  // 用户拿主意时又跑了一条 `/compact`，最新会话就成了那条旁路回合 —— 两种都不该让还在等人的
  // 那一轮失去入口。排在普通回合之后：上一回合是一次崩掉的普通回合时，那颗「重试」才是用户
  // 眼前那件事。
  if (!opts.reviewRetry || task.workflowMode !== "free") return null;
  const reviewer = latestSessionOf((opts.sessions ?? []).filter((session) => session.role === "reviewer"));
  // 手动停掉的审查回合不是「没出结论」，入口是「运行」（服务端同样 409）。
  if (reviewer?.stoppedAs) return null;
  return { kind: "review", sessionId: reviewer?.id ?? null, exitStatus: reviewer?.exitStatus ?? null, review: opts.reviewRetry };
}

/** 普通回合那一档：最后一条 agent 气泡的会话异常结束了。审查会话不归这里。 */
function crashedTurnTarget(task: TaskListItem, items: ConversationItem[], sessions?: Session[]): TurnRetryTarget | null {
  const last = [...items].reverse().find((item) => item.kind === "agent");
  if (last?.kind !== "agent") return null;
  const session = last.session;
  if (!session) return null;
  // 服务端只重跑**最近一次回合**那条会话：气泡后面还有没出声的回合（比如一句没说就断掉的
  // 审查），这条气泡就不是「上一回合」，给它按钮只会换来 409。
  if (sessions && latestSessionOf(sessions)?.id !== session.id) return null;
  // **主动停止/暂停也会留下非零退出码**（CLI 吃 SIGTERM 后按 signal 写 exit 1）。那不是崩溃，
  // 它们的入口是头部那颗「运行」；只有服务端记下的 stoppedAs 分得开这两者。
  if (session.stoppedAs) return null;
  const exitStatus = session.exitStatus;
  // 审查会话归审查档：它**不看退出码**，审查链自己记着「这一轮有没有给出结论」才是权威判据。
  // CLI 打完「API Error: Connection lost mid-response」照样 exit 0，拿退出码当门槛的话，时间线
  // 上明写「未能正常给出结论，已停止自动链」，界面上却一个能重来的入口都没有（2026-09-11 实测）。
  if (session.role === "reviewer") return null;
  // 「算不算异常结束」**跟服务端读同一份判据**（`@ash/shared/turn-outcome`，三个信号的
  // 优先级写在那里）。两边各写一份 if 就是在等下一次漂开 —— 审查 F2 要修的那一条恰恰是
  // 同一句判据在两端各错一次（都只看退出码，于是被看门狗终止、以 exit 0 收流的那一轮
  // 既没有按钮、点了也 409）。
  if (!turnEndedAbnormally({ exitStatus, turnOutcome: session.turnOutcome, stoppedAs: session.stoppedAs })) {
    return null;
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
