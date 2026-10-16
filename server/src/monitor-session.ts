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
import { freeReviewRuns, monitors, sessions, tasks } from "./db/schema.js";
import { isSameProcess } from "./proc.js";
import { restoreResumePrompt, takeResumePrompt } from "./task-resume-prompt.js";

/** 能带进 `continueTask` 的那两种角色。别的(团队、duet)不表达,退回默认。 */
const WAKEABLE_ROLES = new Set(["single", "reviewer"]);

/** 起它的那次审查已经收尾了。措辞跟终态那条分开:原因不同,出路也不同。 */
const REVIEW_FINISHED = "起这个哨兵的那次审查已经结束，它的事件不再唤醒任务";

/**
 * 「这个哨兵能不能挂上、它是谁挂的」——创建入口要的两件事，一次算完。
 *
 * 合成一个函数而不是两个，是因为它们本来就是同一个问题的两面：**终态任务上一个哨兵能挂
 * 上，唯一的理由就是某一次审查还在进行**（见下面的豁免），那么它当然属于那一次审查。分开
 * 算就会出现「靠审查豁免挂上、却没记住是哪次审查」——而后面三处都要那条身份(F1/F2)。
 *
 * ── 豁免：任务跑完了，但审查这件事还没完 ──────────────────────────────────────
 *
 * 自由工作流的审查跑在一个已经 done 的任务上（旁路回合，终态原样不动），光看状态会把
 * 审查者要挂的哨兵全拒掉 —— 而那恰恰是最需要哨兵的场景（见 shared 里 `activeReview`）。
 * **只有被状态拦下来时才去查审查**：绝大多数调用在任务还活着时发生，那时一次库都不多查。
 */
export async function monitorSourceGate(
  task: { id: string; status: string; archived?: boolean | null },
): Promise<{ blocked: string | null; role: string | null; reviewRun: string | null }> {
  const blocked = monitorBlockedReason(task);
  // 归档不吃审查豁免(任务都收柜子了,审查链也没有续下去的地方),也就不必查任何东西。
  if (task.archived) return { blocked, role: null, reviewRun: null };
  const live = await liveSessionRole(task.id);
  // 被状态拦下来时一定要查(那是豁免的唯一依据);活会话是审查者时也要查(要记住是哪次)。
  const reviewRun = blocked || live === "reviewer" ? await reviewingRunId(task.id) : null;
  // **认不出活会话、任务又处于终态**：那就是「审查者按提示 pause 了一轮等外部结果，这会儿
  // 用户在面板上又补挂一个哨兵」——此刻一个 agent 进程都没有，活会话那条线索问不出东西，
  // 而它能挂上来本身就说明是那次审查豁免放它进来的。不认这一条，它会以默认的 `single`
  // 入队，把**实现者**叫起来跑一轮，审查那条会话继续等不到人（第 1 轮审查 F2 第 3 条）。
  const role = live ?? (blocked && reviewRun ? "reviewer" : null);
  return {
    blocked: blocked && reviewRun ? null : blocked,
    role,
    // 执行者自己挂的哨兵不绑审查:它的命跟着任务走,审查结束与它无关。
    reviewRun: role === "reviewer" ? reviewRun : null,
  };
}

/**
 * 事件出口（`pushToTask`）与唤醒前最后一道闸（`monitorWakeGuard`）共用的那一份：
 * **这一条**哨兵现在还能不能唤醒任务。
 *
 * 判据是「起它的那次审查还在不在」，不是「这个任务上有没有任意一条审查在跑」。后者会把
 * 上一轮遗留的事件重新解释成新一轮审查的输入（第 1 轮审查 F2 列的同类实例），而两轮之间
 * 该不该唤醒的答案本来就可能不同。
 */
export async function monitorWakeGate(
  task: { id: string; status: string; archived?: boolean | null },
  sourceReviewRun: string | null,
): Promise<string | null> {
  const blocked = monitorBlockedReason(task);
  if (!blocked || task.archived) return blocked;
  if (!sourceReviewRun) return blocked;              // 执行者挂的:照终态老规矩
  return await isReviewRunActive(sourceReviewRun) ? null : REVIEW_FINISHED;
}

/** 起哨兵这一刻,活着的那条会话是什么角色。`null` = 认不出来(没有活会话、角色不在上面
 * 那两种、或者同时活着好几条):**宁可按老样子叫执行者,也不猜一个会把审查链带偏的角色**
 * —— 猜错时那一轮会在错误的会话上烧一个真回合,而且审查仍然醒不过来。 */
async function liveSessionRole(taskId: string): Promise<string | null> {
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

/** 这个任务上**正在进行**的那次自由工作流审查（`reviewing` 是持久状态）。 */
async function reviewingRunId(taskId: string): Promise<string | null> {
  if (dbClient.closed) return null;
  const rows = await db
    .select({ id: freeReviewRuns.id })
    .from(freeReviewRuns)
    .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.status, "reviewing")));
  return rows.at(0)?.id ?? null;
}

/** **这一次**审查还在进行吗。 */
export async function isReviewRunActive(runId: string): Promise<boolean> {
  if (dbClient.closed) return false;
  const rows = await db
    .select({ status: freeReviewRuns.status })
    .from(freeReviewRuns)
    .where(eq(freeReviewRuns.id, runId));
  return rows.at(0)?.status === "reviewing";
}

/**
 * 这条**哨兵事件**的来源审查还在进行吗（投递扫描那一层的豁免）。
 *
 * 投递判定本体是纯函数（`deliveryVerdict`，单测直接喂字面量），不碰库；所以「来源审查还在
 * 不在」这件事由扫描侧查好了填进去。查的是**这条事件所属哨兵**记下的那次 run，不是「这个
 * 任务上有没有任意一条 reviewing」——后者会把上一轮遗留的事件当成新一轮的输入。
 */
export async function monitorEventReviewActive(origin: string | null): Promise<boolean> {
  const monitorId = monitorIdFromOrigin(origin);
  if (!monitorId || dbClient.closed) return false;
  const run = (await db
    .select({ sourceReviewRun: monitors.sourceReviewRun })
    .from(monitors)
    .where(eq(monitors.id, monitorId))).at(0)?.sourceReviewRun;
  return run ? await isReviewRunActive(run) : false;
}

/** 这条哨兵事件所属哨兵记下的来源审查（`null` = 执行者自己挂的，或哨兵行已经没了）。 */
export async function monitorEventSourceReview(origin: string | null): Promise<string | null> {
  const monitorId = monitorIdFromOrigin(origin);
  if (!monitorId || dbClient.closed) return null;
  return (await db
    .select({ sourceReviewRun: monitors.sourceReviewRun })
    .from(monitors)
    .where(eq(monitors.id, monitorId))).at(0)?.sourceReviewRun ?? null;
}

/**
 * 唤醒这一轮该用谁的执行配置跑 —— **按哨兵自己记下的那次审查**取，不是按任务的常设配置。
 *
 * 审查者完全可以是另一个执行器、另一个模型（典型：codex 审 claude 写的代码）。只带一个
 * `reviewer` 角色过去的话，`continueTask` 会按任务自己的 agentType 解析，于是**新建一条
 * claude 的 reviewer 会话**，原审查者那条上下文一个字都接不上（第 1 轮审查 F2 实测：
 * 任务 agent=claude、审查 agent=codex，唤醒后多出一条 claude reviewer）。
 *
 * `null` = 这条哨兵不属于任何审查（执行者自己挂的），按老规矩走任务配置。
 * run 已经不在 reviewing = 来源过期，调用方按「不再唤醒」处理（出口闸会先拦下来）。
 */
export async function monitorWakeExecutor(
  sourceReviewRun: string | null,
): Promise<{ agent: string; executorId: string | null; model: string | null; reasoningEffort: string | null } | null> {
  if (!sourceReviewRun || dbClient.closed) return null;
  const run = (await db
    .select({
      status: freeReviewRuns.status,
      agentType: freeReviewRuns.agentType,
      executorId: freeReviewRuns.executorId,
      model: freeReviewRuns.model,
      reasoningEffort: freeReviewRuns.reasoningEffort,
    })
    .from(freeReviewRuns)
    .where(eq(freeReviewRuns.id, sourceReviewRun))).at(0);
  if (!run || run.status !== "reviewing") return null;
  return {
    agent: run.agentType,
    executorId: run.executorId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
  };
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
 * ── 为什么是「先取走，没送出去再回填」而不是「送达后再取走」────────────────────
 *
 * 跟既有的检查点续跑同一套（`task-resume.ts`：`takeResumePrompt` → 起跑失败
 * `restoreResumePrompt`）。送达后才取走的写法有一个修不掉的窗口：`markSent` 已经落库、
 * 取走那一步却失败（库忙、进程正好被换掉），于是消息是 sent、交代还在 —— 没有任何人会
 * 再来清它，任务做完了仍被结算判成 paused，工具条整排按钮继续灰着（第 1 轮审查 F4 第 3
 * 种）。而那一步的失败又被 `onDelivered` 的 catch 当作记账错误吞掉，连日志都没有。
 *
 * 反过来「先取走」留下的窗口是「取走了但一个字没送出去」，那一种**有补偿**：`restore` 的
 * CAS 只填回自己腾出的那个空，agent 中途写了新的一段就不动它。所以这里只提供 `take` 和
 * `restore`，没有 `consume` —— 调用方必须在未送达的每条出路上回填（见两处投递点）。
 */
export async function monitorWakeCheckpoint(
  message: { taskId: string; origin: string | null },
): Promise<{ append: string; restore: () => Promise<void> } | null> {
  if (dbClient.closed || monitorIdFromOrigin(message.origin) === null) return null;
  const checkpoint = (await db
    .select({ resumePrompt: tasks.resumePrompt })
    .from(tasks)
    .where(eq(tasks.id, message.taskId))).at(0)?.resumePrompt;
  if (!checkpoint) return null;
  // CAS 取走:读到之后到这里之间隔着 await,另一路(真人续跑、手点运行)可能刚好取走了同
  // 一段。抢不到就当这一轮没有交代可带 —— 那段话已经被别人喂出去了,再喂一遍就是重复。
  if (!await takeResumePrompt(message.taskId, checkpoint)) return null;
  return {
    append: `\n\n【你当初留下的续跑交代】${checkpoint}`,
    restore: async () => { await restoreResumePrompt(message.taskId, checkpoint); },
  };
}

export async function liveMonitorSummary(
  taskId: string,
): Promise<{ count: number; labels: string[] }> {
  if (dbClient.closed) return { count: 0, labels: [] };
  const rows = await db
    .select({ description: monitors.description, command: monitors.command })
    .from(monitors)
    .where(and(
      eq(monitors.taskId, taskId),
      eq(monitors.status, "running"),
      eq(monitors.kind, "ash"),
    ));
  return {
    count: rows.length,
    // 描述是 agent 自己写的「我在盯什么」,没写就退回命令原文 —— 两个都空的行不该存在,
    // 但真遇上也不要在时间线里留一个空括号。
    labels: rows.map((r) => (r.description ?? "").trim() || r.command.trim()).filter(Boolean).slice(0, 3),
  };
}
