// 重启后收拾被打断的任务（从 orchestrator.ts 拆出，纯行数拆分）。
// **必须在 reattachRunningTasks 之后调用**（index.ts 保证顺序），理由见函数注释。
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { db } from "./db/index.js";
import { sessions, sessionTurns, tasks } from "./db/schema.js";
import { recordTurnSpan } from "./session-turns.js";
import { clearTaskStallFlags } from "./session-stall-flag.js";
import { stallReconcileText, stallReconcileUnverifiableText } from "./turn-stall-text.js";
import { pendingStallObligations, restoreStallVerdict } from "./turn-stall-persist.js";
import { stallIdentityKey } from "./turn-stall-journal.js";
import { failedTurnLanding } from "./settle-landing.js";
import { claimReconcileTurn } from "./runs.js";
import { setTaskStatus } from "./status.js";
import { startTeam } from "./team/session.js";
import { reconcileTurnBaseline } from "./turn-baseline.js";
import { now } from "./util.js";
import { interruptCliGoal } from "./task-cli-state.js";
import { appendTaskTimeline, alertLine } from "./task-timeline.js";
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
  const flying = await db.select().from(tasks).where(inArray(tasks.status, ["running", "queued"]));
  // **扫谁不能只由任务状态决定**(第 1 轮审查 F1):还有一类是「盘上留着一条没销账的失败义务」。
  // 两个实例都走这条路 —— 区间提前收口、开始行压根没落下 —— 共同点是任务状态仍在飞,所以
  // 多半已经在上面那批里;但义务自己给出的身份是下面 `interruptedTurnVerdict` 真正要用的东西,
  // 而且任务状态要是也漂了(例如上一版留下的 `paused`),只有这一条能把它捞回来。
  const obligations = await pendingStallObligations();
  const byId = new Map(flying.map((t) => [t.id, t] as const));
  for (const owner of new Set(obligations.map((o) => o.taskId))) {
    if (byId.has(owner)) continue;
    const [task] = await db.select().from(tasks).where(eq(tasks.id, owner));
    if (task) byId.set(owner, task);
  }
  const orphaned = [...byId.values()];
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
  const advance = t.queueAdvanceRequest;
  const pendingAdvance = advance && advance.resumePromptGeneration === t.resumePromptGeneration;
  if (t.nativeTurn && !t.goalTurn) {
    const [session] = await db.select().from(sessions).where(eq(sessions.taskId, t.id)).orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt));
    await interruptCliGoal(t, session?.agentType ?? t.agentType ?? "claude");
  }
  // 持续目标的善后要先做:它的结果(留住了没有)本身是落位的一个输入。
  let goalHeld = false;
  let goalFollowUpFrom: TaskStatus | null = null;
  if (t.goalTurn) {
    const [session] = await db.select().from(sessions).where(eq(sessions.taskId, t.id)).orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt));
    goalHeld = await interruptCliGoal(t, session?.agentType ?? t.agentType ?? "claude");
    if (!goalHeld) {
      // 压根没启动起来的持续目标:回到它起跑前的状态(库里那行此刻才是权威的)。
      const [restored] = await db.select().from(tasks).where(eq(tasks.id, t.id));
      goalFollowUpFrom = (restored?.followUpFrom as TaskStatus | null) ?? null;
    }
    if (session?.agentType === "claude" && session.commandLine) cleanupClaudeGoalContext(session.commandLine);
    // 熔断过的那一轮不许说成「暂停」:那句话替用户表达了「它在等你」,而这一轮是我们自己判
    // 失败的 —— 两个结论里用户看到的那个说它在等人,正是 F3 的形状。那一句由下面统一补。
    if (!ashFailure.note) {
      await appendTaskTimeline(t.id, alertLine(goalHeld
        ? "持续目标因服务中断已暂停；任务和历史保留，使用 /goal resume 续跑。"
        : "持续目标尚未启动就遇到服务中断；已恢复起跑前的目标状态。"));
    }
  }
  // **落位优先级不在这儿定**(第 1 轮审查 F2,已实测):这一处原先是一行三元表达式,而正常结算
  // 那边是一串分支顺序 —— 两份一漂,同一个事实就按进了哪个入口给出两种结论:一个已完成的任务被
  // 一次失败续聊打断,不重启收尾保住 `done`,重启收尾却整个降成 `failed`。恢复层只提供事实,
  // 优先级归 `settle-landing.ts` 一处(它同时也挡住了「残留的队列占位抵消一轮确凿失败」那一支)。
  const back = failedTurnLanding({
    ashFailed: !!ashFailure.note,
    followUpFrom: (t.followUpFrom as TaskStatus | null) ?? goalFollowUpFrom,
    queueAdvancePrev: pendingAdvance ? (advance.prevStatus as TaskStatus) : null,
    goalHeld,
  });
  // 回合输入事实(原终态、原生回合标记、完成确认)**跟落位同一条 UPDATE** 消费
  // (第 2 轮审查 F2,已实测)。原先是先清、后面几步才写状态:两者之间进程一没,
  // `followUpFrom` 已经永久消失而任务还是 running —— 重启后的对账只能把一个本该回到 `done`
  // 的任务落成 failed,而 `failedTurnLanding` 这时拿到的事实已经是残的,纯函数再对也救不回来。
  // 起跑侧一直就是一笔写完的(`guarded-turn-start.ts`),结算侧照它对齐。
  const consume = (t.goalTurn || t.followUpFrom || t.nativeTurn || t.completeConfirmedAt)
    ? { followUpFrom: null, nativeTurn: false as const, completeConfirmedAt: null }
    : undefined;
  // 被打断的回合可能已经走完 write-ahead（基线落盘、验收快照清空）：这里就是它的
  // 结算，必须把基线消费掉——工作目录没动过就整套挂回 stage/合并快照/尾段进度。
  // 只恢复 status 的话，基线躺在磁盘上等下一个真人回合 recordTurnBaseline 直接覆盖，
  // 已验收事实从「暂时不显示」变成永久丢失（审查实测复现）。
  // 这一轮的结局说给用户:**每一条路都要说**,不只持续目标那一支 —— 普通回合落 failed 时,
  // 时间线上同样只有那条来自上一个进程的红字,不说清「这一轮为什么是失败的」就只能让人去查
  // 一个不存在的崩溃。
  if (ashFailure.note) await appendTaskTimeline(t.id, alertLine(ashFailure.note));
  await reconcileTurnBaseline(t.id, false);
  // 旧会话的停滞标记在这里撤:置标记的那个消费者早就没了,没人来撤(第 5 轮审查 F5)。留着
  // 的话,用户换执行器重试时新会话只清自己那一行,旧行重新满足「任务在跑」的 EXISTS,卡片上
  // 那颗红环凭空亮起来。这一刻任务名下确实没有活句柄(调用方的闸保证),所以一律清干净。
  await clearTaskStallFlags(t.id);
  await setTaskStatus(t.id, back, {
    ...(pendingAdvance ? { quietAdvance: true } : {}),
    ...(consume ? { consume } : {}),
    // 失败义务在**这一笔**兑现:落位写进库了才销账,没写到行就一个字都不销。
    settleStallTurns: ashFailure.settled,
  });
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
async function interruptedTurnVerdict(taskId: string): Promise<InterruptedVerdict> {
  // 身份集合由**三边**给,而且刻意互不依赖 —— 每一边单独瞎掉时另外两边照样认得出这一轮:
  //
  //   · **还没收尾的会话**(`sessions.ended_at IS NULL`)的当前回合身份,以及这条会话最新的
  //     那一行回合记录。这是本轮审查 F1 补上的那一边:前两边都带着一个自己证明不了的前提 ——
  //     「区间还开着」证明不了「这一轮没有待结算的责任」(执行流先收口、任务还没落位时退出,
  //     区间已经 failed 却没人把它算进任务),而「日志读得出来」更是条件而非事实(日志一坏,
  //     pending 身份就是空的,于是那一轮**压根进不了询问**:库里 `outcome=failed` 和
  //     `stall_reason` 明明都还在,结论却被当成「没有失败」,持续目标回来显示「暂停中 + 继续」)。
  //     会话没收尾是这两者都不依赖的事实:置标记的那个消费者没了,没人来给它收尾。
  //
  //   · 还开着的回合行 —— **全看一遍**,不是只看最新那一条:一个任务可以同时有多条会话各开着
  //     一轮(讨论模式的两个声部就是),背着判决的那一个未必是最后开始的。
  //
  //   · 盘上没销账的失败义务 —— 上面两边都给不出的那一类在这儿(上一链 F1,已实测):开始行
  //     压根没落下(`openTurn` 那一批写失败,而看门狗照样熔断并落了判决),而且任务状态自己也漂了
  //     (例如上一版留下的 `paused`)时,只有这一条能把它捞回来。
  //
  // **为什么限定在「还没收尾的会话」**:这是防止「把全部历史失败区间一概重放到最新任务」的那道
  // 边界。一个任务跑过几十轮、每轮都正常收口之后又被起跑,那些老回合属于**已经收尾的会话**;
  // 它们早就各自结算过了,再去问一遍等于拿一份旧判决去压一轮新的执行(日志一旦不可读,库那一格
  // 的旧原文还会被当成判决采纳)。所以边界按会话生命周期划,不按条数或年龄猜。
  const rows = await db.select().from(sessionTurns).where(eq(sessionTurns.taskId, taskId));
  // 键的口径跟判决日志同一份(`stallIdentityKey`)—— 两边各手拼一遍迟早漂。
  const byIdentity = new Map(rows.map((r) => [stallIdentityKey(r.sessionId, r.startedAt), r]));
  const identities = new Map<string, { sessionId: string; startedAt: string; cwd: string | null }>();
  const remember = (sessionId: string, startedAt: string | null, cwd: string | null): void => {
    if (!startedAt) return;
    const k = stallIdentityKey(sessionId, startedAt);
    if (identities.has(k)) return;
    identities.set(k, { sessionId, startedAt, cwd: cwd ?? byIdentity.get(k)?.cwd ?? null });
  };
  for (const row of rows) {
    if (row.endedAt == null) remember(row.sessionId, row.startedAt, row.cwd);
  }
  const live = await db.select().from(sessions).where(and(eq(sessions.taskId, taskId), isNull(sessions.endedAt)));
  for (const session of live) {
    // 会话行上记着的那一轮:**开始行可能压根没落下**(写库整批失败),这时它是唯一说得出身份的地方。
    remember(session.id, session.turnStartedAt, session.cwd);
    // 这条会话最新的那一行:覆盖「投入 ≠ 正在执行」那一类 —— 会话行上写的是刚投进来的下一轮,
    // 而真卡住、真背着判决的是前一轮(见 session-stall-flag.ts 的同一条口径)。
    const newest = rows.filter((r) => r.sessionId === session.id)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).at(0);
    if (newest) remember(newest.sessionId, newest.startedAt, newest.cwd);
  }
  for (const owed of await pendingStallObligations()) {
    if (owed.taskId !== taskId) continue;
    remember(owed.sessionId, owed.turnStartedAt, null);
  }
  const notes: string[] = [];
  /** 这一轮认下来、等落位那一笔去兑现的失败义务(见下面那段「这里不销账」)。 */
  const settled: { sessionId: string; turnStartedAt: string }[] = [];
  for (const turn of [...identities.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))) {
    // 「这是上一个进程留下来的回合吗」由 `restoreStallVerdict` 自己从事实认(本进程开过那一行
    // 开始记录没有),这里一个字都不用申报 —— 对账既可能碰到上一个进程留下来的回合,也可能碰到
    // 本进程刚起跑、消费循环却在初始化段挂掉的那种,两者该得到不同答案。
    const verdict = await restoreStallVerdict(turn.sessionId, turn.startedAt);
    if (!verdict) continue;
    // **措辞不在这儿写**:同一个结论在两处各说一遍,迟早说成两件事(这条链上出过的事故全是
    // 这个形状)。共同那一句和判决原文的格式归 turn-stall.ts 一处出,这里只挑收场。
    notes.push(verdict.kind === "tripped"
      ? stallReconcileText(verdict)
      : stallReconcileUnverifiableText(verdict.reason));
    // 已经确凿收在 `failed` 上的那一行不重写:它的 `ended_at` 是当时真实的收尾时刻,改成「现在」
    // 等于把一段不存在的执行时间算给它。其余三种都要写 —— 还开着的、行压根不存在的、以及收在
    // 非 failed 结局上却背着判决的(那一份结论比区间里记的那个更权威)。
    const existing = byIdentity.get(stallIdentityKey(turn.sessionId, turn.startedAt));
    if (!(existing?.endedAt != null && existing.outcome === "failed")) {
      await recordTurnSpan({
        sessionId: turn.sessionId, taskId, cwd: turn.cwd, startedAt: turn.startedAt,
        endedAt: existing?.endedAt ?? now(), outcome: "failed",
      });
    }
    // **这里不销账**(第 2 轮审查 F1,已实测)。判决的回收条件是「这个执行身份的任务落位已经
    // 持久确认」,而这一刻任务那一行还是 running:后面还隔着持续目标善后、输入事实消费、时间线、
    // 基线恢复才轮到落位。在这儿销掉,等于把那个条件换成「我打算去落位」—— 中间重启一次、或者
    // 任何一个 await 抛一次,盘上就留下「任务仍 running、义务已销账」,下一次启动只看到一个
    // 已经闭合的回合,持续目标回来显示「暂停中 + 继续」。
    // 身份交给落位那一笔去兑现(`setTaskStatus` 的 `settleStallTurns`),不是「记得待会儿再调
    // 一句」:靠调用顺序的那一版已经被这条链上每一轮审查否过一次。
    settled.push({ sessionId: turn.sessionId, turnStartedAt: turn.startedAt });
  }
  return { note: notes.length ? notes.join("\n\n") : null, settled };
}

/**
 * 被打断的那一轮的权威结局 —— 外加**这一轮认下来、还没兑现的失败义务**。
 *
 * 为什么把义务一起交出来而不是在里面销掉:回收条件是「任务落位已经持久确认」,这个函数只认得出
 * 「这一轮失败过」,认不出「任务落到哪儿了」。两件事分给两个人,中间那段 await 才不会变成一条
 * 「义务已销、落位未写」的缝(第 2 轮审查 F1)。
 */
type InterruptedVerdict = {
  /** 用户看得见的那一句(没有 ash 判定的失败结局就是 null)。 */
  note: string | null;
  settled: { sessionId: string; turnStartedAt: string }[];
};

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
      // **待命与上一轮失败是两个轴,前者替代不了后者**(本轮审查 F1 的对称实例)。这一支原先
      // 直接写 `idle` 就返回:不问已经装回来的判决、不给上一轮的区间一个结局、也不兑现那份
      // 义务。于是一台被看门狗判了熔断的调度台重启后回到待命,而那一轮在盘上是
      // `ended_at=null, outcome=null`、判决还欠着 —— 用户看不出上一轮失败过,下一次启动还会
      // 把同一份判决读回来。
      // 团队任务**仍然回待命**(既有策略没错,也不该把整台粗暴改成 failed),只是先把回合那一
      // 轴收掉:`interruptedTurnVerdict` 把区间收在 failed 上,结论进时间线,义务跟着这一笔
      // 落位一起兑现(`settleStallTurns`,见 status.ts)。
      const verdict = await interruptedTurnVerdict(taskId);
      if (verdict.note) await appendTaskTimeline(taskId, alertLine(verdict.note));
      await setTaskStatus(taskId, "idle", { settleStallTurns: verdict.settled });
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
