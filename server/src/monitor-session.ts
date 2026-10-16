// 「这个哨兵是哪条会话起的」——哨兵醒来时该叫谁。
//
// 一个任务同时可以有两条会话:执行者那条(`single`)和审查者那条(`reviewer`,审查是**旁路
// 回合**,跑在自己的会话上)。而哨兵唯一的出口是「唤醒这个任务」——唤醒哪一条,由
// `scheduled_messages.session_role` 决定,缺省是 `single`。
//
// 所以审查者挂的哨兵如果不记来源,醒来时叫的是执行者:那一轮既续不上审查(审查链还停在
// reviewing 等它续跑,见 free-workflow.ts 的 `task.question || task.resumePrompt` 守卫),
// 又凭空让执行者跑了一轮。用户 2026-10-16 问的「审查应该停在这等唤醒」的后半截就是它。
//
// ── 判据:**此刻还活着的那条会话** ──────────────────────────────────────────────
//
// `start_monitor` 是 agent 在自己回合里调的 MCP 工具,所以调用发生的这一刻,它那条会话的
// agent 进程必然活着,而别的会话上一轮的进程早已退出。`sessions.agent_pid` 每回合被下一轮
// 覆盖这件事在这里**不是问题**:我们查的就是当代,当场查当场写,中间没有写库队列。
// (对比 claude 投影那一侧——那边是流事件排队落库,晚一步读到的就是下一代人的凭据,所以
// 它必须在流开始那一刻冻住身份,见 claude-monitor-origin.ts 的文件头。)
//
// pid 会被复用,所以判死活跟别处同一份:pid + 进程启动时刻一起对上(`isSameProcess`)。
import { and, eq } from "drizzle-orm";
import { monitorBlockedReason, monitorIdFromOrigin } from "@ash/shared/monitor";
import { db, dbClient } from "./db/index.js";
import { freeReviewRuns, sessions, tasks } from "./db/schema.js";
import { isSameProcess } from "./proc.js";
import { takeResumePrompt } from "./task-resume-prompt.js";

/** 能带进 `continueTask` 的那两种角色。别的(团队、duet)不表达,退回默认。 */
const WAKEABLE_ROLES = new Set(["single", "reviewer"]);

/**
 * 起哨兵这一刻,活着的那条会话是什么角色。
 *
 * `null` = 认不出来(没有活会话、角色不在上面那两种、或者同时活着好几条)。一律退回调用方
 * 的默认值,也就是这一列加上之前的老行为——**宁可按老样子叫执行者,也不猜一个会把审查链
 * 带偏的角色**:猜错时那一轮会在错误的会话上烧一个真回合,而且审查仍然醒不过来。
 */
export async function monitorSourceRole(taskId: string): Promise<string | null> {
  if (dbClient.closed) return null;
  const rows = await db
    .select({ role: sessions.role, pid: sessions.agentPid, startedAt: sessions.agentStartedAt })
    .from(sessions)
    .where(eq(sessions.taskId, taskId));
  const live = rows.filter((r) => !!r.pid && isSameProcess(r.pid, r.startedAt ?? null));
  const roles = new Set(live.map((r) => r.role).filter((role) => WAKEABLE_ROLES.has(role)));
  // 两条都活着时分不清是谁调的——那种情况下猜一个还不如退回默认(见函数头)。
  return roles.size === 1 ? [...roles][0]! : null;
}

/**
 * 「这个任务现在能不能用哨兵」——创建入口、推送出口、投递闸共用的那一份。
 *
 * 在 `monitorBlockedReason` 之上多问一句**审查还在不在进行**：自由工作流的审查跑在一个
 * 已经 done 的任务上（旁路回合，终态原样不动），光看状态会把审查者要挂的哨兵全拒掉 ——
 * 而那恰恰是最需要哨兵的场景（见 shared 里 `activeReview` 那段）。
 *
 * **只有被状态拦下来时才去查审查**：绝大多数调用在任务还活着时发生，那时一次库都不用多查。
 */
export async function monitorTaskGate(
  task: { id: string; status: string; archived?: boolean | null },
): Promise<string | null> {
  const blocked = monitorBlockedReason(task);
  if (!blocked || task.archived) return blocked;      // 归档不吃审查豁免
  return await hasActiveReview(task.id) ? null : blocked;
}

/** 这个任务上有没有一条**正在进行**的自由工作流审查（`reviewing` 是持久状态）。 */
export async function hasActiveReview(taskId: string): Promise<boolean> {
  if (dbClient.closed) return false;
  const rows = await db
    .select({ id: freeReviewRuns.id })
    .from(freeReviewRuns)
    .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.status, "reviewing")));
  return rows.length > 0;
}

/**
 * 哨兵把任务叫醒的那一轮，要把 agent 当初**留给自己**的那段续跑交代一起喂回去。
 *
 * `start_monitor` 的说明就是这么许诺 agent 的：「起了哨兵的那一轮用 pause_task 收尾，
 * resumePrompt 写清被哨兵叫醒后该干什么」。但哨兵事件走的是投递链路（`byBackend`），而
 * 消费检查点那一条只认真人消息（见 orchestrator 里 `takeResumePrompt` 那一处的条件），
 * 于是两件事都落空了：
 * - agent 收到的只有一行事件，自己写的交代一个字都看不到；
 * - 那段交代**永远留在库里**，任务从此显示「在等续跑」，派审 / 预约 / 修复 / 预览整排
 *   按钮被那条门禁灰掉，`startFreeReview` 也一直 409（见 task-resume-prompt.ts 顶部）。
 *   审查者按说明 pause 一轮等套件，结论给完了任务还是卡着。
 *
 * 所以这一轮**既要喂、也要取走**：`append` 拼进这一次的输入，`consume` 在确认送达之后
 * 才调（起跑失败时原样留着，下一次重投还能用）。CAS 按读到的那段值比对，中途 agent 换了
 * 新的一段就不动它。
 */
export async function monitorWakeCheckpoint(
  message: { taskId: string; origin: string | null },
): Promise<{ append: string; consume: () => Promise<void> } | null> {
  if (dbClient.closed || monitorIdFromOrigin(message.origin) === null) return null;
  const checkpoint = (await db
    .select({ resumePrompt: tasks.resumePrompt })
    .from(tasks)
    .where(eq(tasks.id, message.taskId))).at(0)?.resumePrompt;
  if (!checkpoint) return null;
  return {
    append: `\n\n【你当初留下的续跑交代】${checkpoint}`,
    consume: async () => { await takeResumePrompt(message.taskId, checkpoint); },
  };
}
