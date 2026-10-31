// 重启后收拾被打断的任务（从 orchestrator.ts 拆出，纯行数拆分）。
// **必须在 reattachRunningTasks 之后调用**（index.ts 保证顺序），理由见函数注释。
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { db } from "./db/index.js";
import { sessions, sessionTurns, tasks } from "./db/schema.js";
import { recordTurnSpan } from "./session-turns.js";
import { clearTaskStallFlags } from "./session-stall-flag.js";
import { restoreStallVerdict } from "./turn-stall-persist.js";
import { clearStallFailure } from "./turn-stall-verdict.js";
import { claimReconcileTurn } from "./runs.js";
import { setTaskStatus } from "./status.js";
import { startTeam } from "./team/session.js";
import { reconcileTurnBaseline } from "./turn-baseline.js";
import { now } from "./util.js";
import { interruptCliGoal } from "./task-cli-state.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { cleanupClaudeGoalContext } from "./executors/claude-goal.js";

// On (re)start nothing is actually running, so any task still in an in-flight
// status was interrupted (e.g. the server restarted mid-run). Mark those failed
// so they're recoverable via retry/reply instead of being stuck forever.
// awaiting_review is left alone — its gate can still be resolved after a restart.
// 例外一:团队任务(mode:"team")没有「失败」这回事 —— 调度台进程随 server 一起
// 死了,但 CLI 会话还在,下次有人说话就 --resume 接回。落 idle(待命)。
// 例外二:被打断的是续聊回合(followUpFrom 非空)→ 回到续聊前的终态,别把一个
// 早就完成的任务记成 failed。
// **逐个走 setTaskStatus 单点**(而不是一条 UPDATE 批量改):它维护
// startedAt/endedAt、广播 task.status,并且触发队列推进 —— 否则重启把队列 head
// 打成 failed 之后没有任何人去推,整条串行队列就一直停在那等(实测:重启后
// 后面的任务再也不会自动开始,得手点一次「运行分组」)。
export async function reconcileInterrupted(): Promise<void> {
  // **必须在 reattachRunningTasks 之后调用**（index.ts 保证顺序）。被成功接管的
  // 任务此刻有活的 handle，isRunning 为真 —— 它们绝不能再被当成「被打断」判
  // failed：那会让一个正在干活的 agent 在界面上显示失败，用户一点重试就会有
  // 第二个 agent 进同一个 worktree。那道闸现在长在 reconcileInterruptedTask 里
  //（原子预占 + 临界区内重读），这里只负责**扫谁**和**汇总日志**。
  const orphaned = await db.select().from(tasks).where(inArray(tasks.status, ["running", "queued"]));
  if (!orphaned.length) return;
  const teamIds: string[] = [];
  let failed = 0;
  let followUps = 0;
  let pendingAdvances = 0;
  // 批量入口不自己写一份结算,一律走单条入口 —— 两份判据只要漂移一次,漂的那条就是会把
  // 正在干活的任务写成 failed 的那条（第 1 轮审查 F3）。
  for (const t of orphaned) {
    if (!(await reconcileInterruptedTask(t.id))) continue; // 已经有人在跑/正在起跑 → 归他
    if (t.mode === "team") teamIds.push(t.id);
    else if (t.followUpFrom) followUps++;
    else if (t.queueAdvanceRequest?.resumePromptGeneration === t.resumePromptGeneration) pendingAdvances++;
    else failed++;
  }
  if (!failed && !followUps && !pendingAdvances && !teamIds.length) return;
  console.log(
    `[ash] reconciled ${failed} interrupted task(s) → failed` +
      (followUps ? `, ${followUps} follow-up turn(s) → 原终态` : "") +
      (pendingAdvances ? `, ${pendingAdvances} pending advance(s) → 起跑前状态` : "") +
      (teamIds.length ? `, ${teamIds.length} team task(s) → idle` : ""),
  );
  wakeInterruptedLeads(teamIds);
}

// 一个被打断的任务怎么结算:状态回落、持续目标/续聊/原生回合各自的善后、基线消费。
// 批量版(重启时扫全库)和单任务版(接管之后才暴露出来的那种中断)共用这一份。
async function settleInterruptedTask(t: typeof tasks.$inferSelect): Promise<void> {
  if (await (await import("./regression-settlement.js")).recordInterruptedRegressionReview(t)) return;
  // **这一路也要问一句「这一轮的权威结束原因是什么」**(第 5 轮审查 F3,已实测)。
  // 接管那条路问过了(single-run.ts),对账这条路原先没问 —— 于是一个被看门狗判了熔断、
  // 进程随后没活到接管的持续目标,在这里被写成「因服务中断已暂停」:界面显示暂停中 + 继续,
  // 回合区间 `outcome` 留空,而判决明明还在日志里读得出来。落位不是「多一种重启时间组合」,
  // 是**同一个权威结局在另一个结算入口没被接上**。
  const ashFailure = await interruptedTurnVerdict(t.id);
  let back = ashFailure ? "failed"
    : (t.followUpFrom as TaskStatus | null) ?? (t.goalTurn ? "paused" : "failed");
  const advance = t.queueAdvanceRequest;
  const pendingAdvance = advance && advance.resumePromptGeneration === t.resumePromptGeneration;
  if (pendingAdvance) back = advance.prevStatus as TaskStatus;
  if (t.nativeTurn && !t.goalTurn) {
    const [session] = await db.select().from(sessions).where(eq(sessions.taskId, t.id)).orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt));
    await interruptCliGoal(t, session?.agentType ?? t.agentType ?? "claude");
  }
  if (t.goalTurn) {
    const [session] = await db.select().from(sessions).where(eq(sessions.taskId, t.id)).orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt));
    const held = await interruptCliGoal(t, session?.agentType ?? t.agentType ?? "claude");
    if (!held) {
      const [restored] = await db.select().from(tasks).where(eq(tasks.id, t.id));
      back = ashFailure ? "failed" : (restored?.followUpFrom as TaskStatus | null) ?? "failed";
    }
    if (session?.agentType === "claude" && session.commandLine) cleanupClaudeGoalContext(session.commandLine);
    // 熔断过的那一轮不许说成「暂停」:那句话替用户表达了「它在等你」,而这一轮是我们自己判
    // 失败的 —— 两个结论里用户看到的那个说它在等人,正是 F3 的形状。那一句由下面统一补。
    if (!ashFailure) {
      await appendTaskTimeline(t.id, held
        ? "持续目标因服务中断已暂停；任务和历史保留，使用 /goal resume 续跑。"
        : "持续目标尚未启动就遇到服务中断；已恢复起跑前的目标状态。");
    }
  }
  if (t.goalTurn || t.followUpFrom || t.nativeTurn || t.completeConfirmedAt) {
    await db
      .update(tasks)
      .set({ followUpFrom: null, nativeTurn: false, completeConfirmedAt: null, updatedAt: now() })
      .where(eq(tasks.id, t.id));
  }
  // 被打断的回合可能已经走完 write-ahead（基线落盘、验收快照清空）：这里就是它的
  // 结算，必须把基线消费掉——工作目录没动过就整套挂回 stage/合并快照/尾段进度。
  // 只恢复 status 的话，基线躺在磁盘上等下一个真人回合 recordTurnBaseline 直接覆盖，
  // 已验收事实从「暂时不显示」变成永久丢失（审查实测复现）。
  // 这一轮的结局说给用户:**每一条路都要说**,不只持续目标那一支 —— 普通回合落 failed 时,
  // 时间线上同样只有那条来自上一个进程的红字,不说清「这一轮为什么是失败的」就只能让人去查
  // 一个不存在的崩溃。
  if (ashFailure) await appendTaskTimeline(t.id, ashFailure.note);
  await reconcileTurnBaseline(t.id, false);
  // 旧会话的停滞标记在这里撤:置标记的那个消费者早就没了,没人来撤(第 5 轮审查 F5)。留着
  // 的话,用户换执行器重试时新会话只清自己那一行,旧行重新满足「任务在跑」的 EXISTS,卡片上
  // 那颗红环凭空亮起来。这一刻任务名下确实没有活句柄(调用方的闸保证),所以一律清干净。
  await clearTaskStallFlags(t.id);
  await setTaskStatus(t.id, back, pendingAdvance ? { quietAdvance: true } : undefined);
}

/**
 * 这个任务**被打断的那一轮**有没有一个 ash 自己认定的失败结局,顺带把那一轮收口。
 *
 * 判据跟接管那条路共用同一个单点(`restoreStallVerdict`),所以两边不可能漂:一边读得到判决、
 * 另一边把同一轮写成「暂停中」这种事,只会在各写一份判据的时候发生。
 *
 * 收口这一下是必须的,不只是落位好看:回合区间的 `outcome` 留空意味着「不知道」,而我们这里
 * 恰恰知道 —— 判决就在手上。留空的话窄出口和面板都只能回头去猜进程退出码,而被我们杀掉的
 * CLI 多半报的是 0。
 */
async function interruptedTurnVerdict(taskId: string): Promise<{ note: string } | null> {
  // **还开着的回合全看一遍**,不是只看最新那一条:一个任务可以同时有多条会话各开着一轮
  // (讨论模式的两个声部就是),背着判决的那一个未必是最后开始的。只看一条的话,另一条的
  // 判决就跟着这次对账一起失效了 —— 而它的回合行会被留在「不知道」那一档。
  const open = await db
    .select()
    .from(sessionTurns)
    .where(and(eq(sessionTurns.taskId, taskId), isNull(sessionTurns.endedAt)))
    .orderBy(desc(sessionTurns.startedAt));
  const notes: string[] = [];
  for (const turn of open) {
    // `adopted: true` —— 这些回合身份确实是上一个进程留下来的,所以「判决核实不了」那一档在这里
    // 同样成立:读不出日志时不许把这一轮说成正常结束(同一条判据见 restoreStallVerdict)。
    const restored = await restoreStallVerdict(turn.sessionId, turn.startedAt, true);
    if (!restored) continue;
    notes.push(restored.kind === "verdict"
      ? "本回合在上次 ash 运行期间已被判定上游连不上并按失败结算,服务重启后原进程已不在,"
        + `按失败收尾。原判决(${restored.verdict.at}):${restored.verdict.reason}`
      : `本回合是上次 ash 中断时留下的,而本次启动读不出熔断判决日志(${restored.why}),`
        + "无法确认它当时有没有被判失败 —— 按未完成收尾,不记成完成。");
    await recordTurnSpan({
      sessionId: turn.sessionId, taskId, cwd: turn.cwd, startedAt: turn.startedAt,
      endedAt: now(), outcome: "failed",
    });
    clearStallFailure(turn.sessionId, turn.startedAt); // 这一轮结算完了,销账
  }
  return notes.length ? { note: notes.join("\n\n") } : null;
}

// 单个任务的「被打断」结算。给**接管成功之后才暴露出来**的那种中断用:
// reattachRunningTasks 把消费循环 `void` 出去就返回了,紧随其后的 reconcileInterrupted
// 那一刻看到 isRunning 为真,正确地跳过了它 —— 可那条消费循环随后在初始化段抛了错。进程
// 已经收掉、登记也注销了,却再也没有人来结算这个任务:它永远停在 running,界面上一个转着
// 的任务,既不会有输出,也停不掉,重试都点不了(第 1 轮审查 F1)。
// 闸与批量版同源:只动此刻确实「状态在飞、手上却没有活句柄」的那一条,所以正常收尾(消费
// 循环已经落了终态)和被别人接着跑起来的,走到这里都是空转。
// 返回值 = 「这一条确实是被打断、而且这次由我结算的」。调用方据此知道那次接管最终没成,
// 可以把它从「已接管」名单里撤下来(见 reattach.ts)。
//
// **判定与写状态必须在同一段临界区里**,所以第一步是原子预占这个任务的回合锁
// (claimReconcileTurn),而不是查一下 isRunning 就往下走:claim 发生在 trackRun 之前,
// 「手上没有句柄」证明不了「没有人正在起跑」;而查完到写库之间隔着好几个 await(读任务行、
// 读会话行、interruptCliGoal、基线),新回合完全来得及合法插进来 —— 结果是一个刚起跑的任务
// 被写成 failed:界面显示失败、agent 照样在跑,队列还跟着错推一格(第 1 轮审查 F3 给出的
// 两种交错)。占住锁之后新回合起不来,这段读-判-写就是真临界区;占不到 = 这条任务此刻归
// 别人,我们一个字都不改。
export async function reconcileInterruptedTask(taskId: string): Promise<boolean> {
  const release = claimReconcileTurn(taskId);
  if (!release) return false;
  try {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    if (!task || !["running", "queued"].includes(task.status)) return false;
    if (task.mode === "team") {
      await setTaskStatus(taskId, "idle");
      return true;
    }
    await settleInterruptedTask(task);
    console.log(`[ash] 已结算被打断的任务 ${taskId}(状态在飞,手上却没有活句柄)`);
    return true;
  } finally {
    release();
    await (await import("./regression-settlement.js")).reconcileRegressionSettlements(taskId)
      .catch((error) => console.error(`[ash] 中断审查收尾待重试 ${taskId}:`, error));
  }
}

// 被打断在「正在思考/派活」当口的团队调度台，重启后必须主动叫醒一次。
//
// 平时调度台是被执行者事件唤醒的（提问 / 失败 / reportBack 完成，见
// team/inbox.ts）。但如果它被打断时手头那批执行者**已经全部跑完**，就再也没有
// 人会来敲它的门了 —— 它会一直 idle 躺着，只能等用户自己去戳一下。这是重启在
// 团队链路上唯一真正会「卡住」的地方。
//
// 只叫醒 teamIds（重启时正好是 running/queued 的那些，即确实被打断在半途）。
// 本来就 idle 的不动：它没有未竟的一轮，叫它等于白烧一次模型调用。
// startTeam 走的是 deliver → 内存里没有 lead → openLead 的 --resume 接回，
// 调度者会收到「你被中断过」的提示，自己 list_tasks 看现状。
function wakeInterruptedLeads(teamIds: string[]): void {
  if (!teamIds.length) return;
  // 稍等一下再叫：让 server 先把启动流程走完（含上面的接管），调度者一睁眼
  // 看到的执行者状态才是最终的，不会基于半截快照做决策。
  const t = setTimeout(() => {
    for (const teamId of teamIds) {
      void startTeam(teamId).catch((err) =>
        console.error(`[ash] 唤醒被打断的团队调度台 ${teamId} 失败:`, err),
      );
    }
    console.log(`[ash] 已叫醒 ${teamIds.length} 个被打断的团队调度台`);
  }, 3000);
  (t as { unref?: () => void }).unref?.();
}
