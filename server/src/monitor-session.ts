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
import { and, eq, isNull } from "drizzle-orm";
import { monitorBlockedReason, monitorIdFromOrigin } from "@ash/shared/monitor";
import { db, dbClient } from "./db/index.js";
import { freeReviewRuns, monitors, scheduledMessages, sessions, tasks } from "./db/schema.js";
import { isSameProcess } from "./proc.js";
import { announceResumePrompt } from "./task-resume-prompt.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

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
): Promise<{ blocked: string | null; role: string | null; reviewRun: string | null; reviewRound: number | null }> {
  const blocked = monitorBlockedReason(task);
  // 归档不吃审查豁免(任务都收柜子了,审查链也没有续下去的地方),也就不必查任何东西。
  if (task.archived) return { blocked, role: null, reviewRun: null, reviewRound: null };
  const live = await liveSessionRole(task.id);
  // 被状态拦下来时一定要查(那是豁免的唯一依据);活会话是审查者时也要查(要记住是哪次)。
  const review = blocked || live === "reviewer" ? await reviewingRun(task.id) : null;
  const reviewRun = review?.id ?? null;
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
    // 轮次一起记:run.id 跨轮复用,只有它认不出「这是上一轮遗留的」(见 schema 注释)。
    reviewRound: role === "reviewer" ? review?.round ?? null : null,
  };
}

/**
 * 事件出口（`pushToTask`）与唤醒前最后一道闸（`monitorWakeGuard`）共用的那一份：
 * **这一条**哨兵现在还能不能唤醒任务。
 *
 * ── 来源资格**无条件**先问，跟任务此刻什么状态无关 ──────────────────────────────
 *
 * 「起它的那次审查还在不在」是**这条事件自己的资格**，不是只在任务终态时才需要的一条额外
 * 豁免。按状态短路（非终态就直接放行）会漏掉一整条可触发路径：在一个 paused 任务上派审
 * （入口允许）→ 审查期间哨兵输出并退出、通知排队 → 审查给出结论、旁路回合把任务恢复成
 * paused → 任务没进终态，终态清理压根不跑 → 那条属于**已结束审查**的通知照旧投递，又
 * 启动一轮 reviewer 回合（第 2 轮审查 F5）。
 *
 * 轮次一起核：`run.id` 跨轮复用（`nextRound` 把同一个 run 推回 reviewing 并把轮次加 1），
 * 只有 runId 认不出「这是上一轮遗留的结果」。
 *
 * 归档是唯一一条压过来源资格的：任务都被收走了，审查链也没有续下去的地方。
 */
export async function monitorWakeGate(
  task: { id: string; status: string; archived?: boolean | null },
  // `null` = 这条哨兵没有记下来源(执行者自己挂的,或行已经不在了):照终态老规矩。
  source: { reviewRun: string | null; reviewRound?: number | null } | null,
): Promise<string | null> {
  if (task.archived) return monitorBlockedReason({ ...task, archived: true });
  if (source?.reviewRun) {
    return await isReviewSourceActive(source.reviewRun, source.reviewRound ?? null)
      ? null
      : REVIEW_FINISHED;
  }
  return monitorBlockedReason(task);                 // 执行者挂的:照终态老规矩
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

/** 这个任务上**正在进行**的那次自由工作流审查（`reviewing` 是持久状态）与它的轮次。 */
async function reviewingRun(taskId: string): Promise<{ id: string; round: number } | null> {
  if (dbClient.closed) return null;
  const rows = await db
    .select({ id: freeReviewRuns.id, round: freeReviewRuns.currentRound })
    .from(freeReviewRuns)
    .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.status, "reviewing")));
  return rows.at(0) ?? null;
}

/**
 * **这一次、这一轮**审查还在进行吗。
 *
 * `round` 为 null（存量行）时只按 run 判 —— 那是这一列加上之前的行为。给了轮次就必须
 * 对上：同一个 run 续到下一轮时，上一轮遗留的结果不再是有效输入（见 schema 的
 * `source_review_round`）。
 */
export async function isReviewSourceActive(runId: string, round: number | null): Promise<boolean> {
  if (dbClient.closed) return false;
  const run = (await db
    .select({ status: freeReviewRuns.status, round: freeReviewRuns.currentRound })
    .from(freeReviewRuns)
    .where(eq(freeReviewRuns.id, runId))).at(0);
  if (run?.status !== "reviewing") return false;
  return round === null || run.round === round;
}

/** 一条哨兵事件的来源资格。`none` = 执行者自己挂的（按任务状态老规矩）。 */
export type MonitorSourceState = "live" | "stale" | "none";

/**
 * 这条**哨兵事件**的来源审查现在是什么状态（投递扫描那一层问的那一句）。
 *
 * 投递判定本体是纯函数（`deliveryVerdict`，单测直接喂字面量），不碰库；所以这件事由扫描侧
 * 查好了填进去。查的是**这条事件所属哨兵**记下的那次 run 与那一轮，不是「这个任务上有没有
 * 任意一条 reviewing」——后者会把上一轮遗留的事件当成新一轮的输入。
 *
 * **无条件查，不按任务状态短路**：来源失效是这条消息自己的资格问题，`paused` 任务上派的
 * 审查收了尾同样要作废它的遗留结果（第 2 轮审查 F5）。
 */
export async function monitorEventSourceState(origin: string | null): Promise<MonitorSourceState> {
  const source = await monitorEventSource(origin);
  if (!source?.reviewRun) return "none";
  return await isReviewSourceActive(source.reviewRun, source.reviewRound) ? "live" : "stale";
}

/** 这条哨兵事件所属哨兵记下的来源审查与轮次（`null` = 执行者自己挂的，或哨兵行已经没了）。 */
export async function monitorEventSource(
  origin: string | null,
): Promise<{ reviewRun: string | null; reviewRound: number | null } | null> {
  const monitorId = monitorIdFromOrigin(origin);
  if (!monitorId || dbClient.closed) return null;
  const row = (await db
    .select({ reviewRun: monitors.sourceReviewRun, reviewRound: monitors.sourceReviewRound })
    .from(monitors)
    .where(eq(monitors.id, monitorId))).at(0);
  return row ?? null;
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
  sourceReviewRound: number | null = null,
): Promise<{ agent: string; executorId: string | null; model: string | null; reasoningEffort: string | null } | null> {
  if (!sourceReviewRun || dbClient.closed) return null;
  const run = (await db
    .select({
      status: freeReviewRuns.status,
      round: freeReviewRuns.currentRound,
      agentType: freeReviewRuns.agentType,
      executorId: freeReviewRuns.executorId,
      model: freeReviewRuns.model,
      reasoningEffort: freeReviewRuns.reasoningEffort,
    })
    .from(freeReviewRuns)
    .where(eq(freeReviewRuns.id, sourceReviewRun))).at(0);
  if (!run || run.status !== "reviewing") return null;
  if (sourceReviewRound !== null && run.round !== sourceReviewRound) return null;
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
  message: { id: string; taskId: string; origin: string | null; text: string; checkpointTaken: string | null },
): Promise<{ text: string; restore: () => Promise<void> } | null> {
  if (dbClient.closed || monitorIdFromOrigin(message.origin) === null) return null;
  // **重投**(上一次取走之后一个字没送出去,或者进程直接没了):交代已经写在这条消息的正文
  // 末尾,账本列记着是哪一段。不再取第二次、也不再追加第二遍 —— 正文就是当时那一份。
  if (message.checkpointTaken) {
    const held = message.checkpointTaken;
    return { text: message.text, restore: () => restoreCheckpoint(message, held) };
  }
  const checkpoint = (await db
    .select({ resumePrompt: tasks.resumePrompt })
    .from(tasks)
    .where(eq(tasks.id, message.taskId))).at(0)?.resumePrompt;
  if (!checkpoint) return null;
  const text = message.text + checkpointNote(checkpoint);
  // **取走和落账在同一个批里**:`db.batch` 在一个 BEGIN…COMMIT 里同步跑完,中间没有 await,
  // 也就没有「清了任务行、账还没落」的缝(为什么不用 transaction 见 claude-monitor-write.ts
  // 的文件头)。缝里崩一次的代价就是那段交代两边都不在 —— 第 2 轮审查 F4。
  const [taken, logged] = await db.batch([
    // CAS 取走:只清掉上面读到的那一段(agent 中途换了新的一段就不动它)。
    db.update(tasks).set({ resumePrompt: null, updatedAt: now() })
      .where(and(eq(tasks.id, message.taskId), eq(tasks.resumePrompt, checkpoint)))
      .returning({ id: tasks.id }),
    db.update(scheduledMessages).set({ text, checkpointTaken: checkpoint })
      .where(and(eq(scheduledMessages.id, message.id), isNull(scheduledMessages.checkpointTaken)))
      .returning({ id: scheduledMessages.id }),
  ]);
  // **两半同生共死**。各自落空的理由不同,后果是同一个:
  // - 取走落空 = 读到之后、批跑到之前,另一路(真人续跑、手点运行)刚好取走了同一段。那段话
  //   已经被别人喂出去了,再喂一遍就是重复。
  // - 落账落空 = 这条消息已经不是那个样子了(被取消删掉、或者已经接走过别的一段)。只取不
  //   落账的话,那段交代就只活在返回值这个内存字符串里 —— 正是 F4 要消掉的形状。
  if (!taken.length || !logged.length) {
    if (taken.length) {
      await db.update(tasks).set({ resumePrompt: checkpoint, updatedAt: now() })
        .where(and(eq(tasks.id, message.taskId), isNull(tasks.resumePrompt)));
    }
    if (logged.length) {
      await db.update(scheduledMessages).set({ text: message.text, checkpointTaken: null })
        .where(and(eq(scheduledMessages.id, message.id), eq(scheduledMessages.checkpointTaken, checkpoint)));
    }
    return null;
  }
  await announceResumePrompt(message.taskId);
  return { text, restore: () => restoreCheckpoint(message, checkpoint) };
}

/** 交代带在正文末尾的样子。取走和回填共用这一份,否则回填时剥不干净。 */
const checkpointNote = (checkpoint: string) => `\n\n【你当初留下的续跑交代】${checkpoint}`;

/**
 * 一个字都没送出去 ⇒ 那段交代白取了，**两半一起退**：任务行上原样填回（CAS，agent 中途
 * 写了新的一段就不动它），消息正文退回原话、账本清空（于是下一次投递可以重新取一次）。
 *
 * 退不动也不丢：交代仍然写在这条消息的正文里、账本列也还指着它，下一次投递走的是上面那条
 * 重投分支，照旧带着它走。所以这里失败的唯一后果是「任务行上那一格暂时空着」—— 静默吞掉
 * 就等于谁也不知道这件事（两处调用点原来都是 `.catch(() => {})`，第 2 轮审查 F4），所以
 * 出声留一条时间线。
 */
async function restoreCheckpoint(
  message: { id: string; taskId: string; text: string },
  checkpoint: string,
): Promise<void> {
  const note = checkpointNote(checkpoint);
  const original = message.text.endsWith(note) ? message.text.slice(0, -note.length) : message.text;
  try {
    const [restored] = await db.batch([
      db.update(tasks).set({ resumePrompt: checkpoint, updatedAt: now() })
        .where(and(eq(tasks.id, message.taskId), isNull(tasks.resumePrompt)))
        .returning({ id: tasks.id }),
      db.update(scheduledMessages).set({ text: original, checkpointTaken: null })
        .where(and(eq(scheduledMessages.id, message.id), eq(scheduledMessages.checkpointTaken, checkpoint))),
    ]);
    if (restored.length) await announceResumePrompt(message.taskId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[ash] 续跑交代回填失败 ${message.taskId}:`, error);
    await appendTaskTimeline(
      message.taskId,
      `续跑交代没能放回任务行（${detail}）。它仍留在那条待发送的哨兵事件里，下一次投递会带着它走。`,
    ).catch(() => {});
  }
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
