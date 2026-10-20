// 完成确认这一刻的两问，都只关于哨兵：
//
//  ① **还有会被这次完成毁掉的东西吗** —— 有就不许完成（`monitorsBlockingComplete`）。
//  ② **这一回合亲手撤掉过哨兵吗** —— 撤过就在时间线上留一行（`noteMonitorsDropped`）。
//
// 为什么是两问而不是一问：它们堵的是同一件事的两条路径。一条是「挂着哨兵直接收工」，闸
// 能当场拦住；另一条是「先 stop_monitor 再 complete_task」—— 那是合法动作的合法组合，拦
// 不得也不该拦（哨兵确实可能已经没用了），但用户有权一眼看见这个取舍，而不是事后去翻
// trace 才挖得出来。2026-10-20 的真实现场（任务 u7nb4wnGcX2O）走的正是第二条：挂上哨兵
// 10 秒后自撤、5 秒后把同一条等待命令换成活不过本回合的内置后台任务，最后两边都没拿到
// 结果。只做①的话，这种情形在界面上依旧一声不响。
//
// ── ①拦的集合 = 完成那一刻**真会被毁掉**的集合 ────────────────────────────────────
//
// 这是本文件唯一容易写错的地方，而且**有两类**，第一版只认了第一类（第 1 轮审查 F2）：
//
// **第一类:还在跑的进程**。任务落终态时 `stopMonitorsForTask` 把它们停掉。但它并不收走
// 所有哨兵：**属于一次仍在进行的审查的那些有豁免**（任务终态 ≠ 审查结束，见
// monitor-reclaim.ts）。闸必须用同一份判据，否则两边一漂移就会出现两种错：拦了却不收
// （审查者挂的哨兵白白把执行者的完成堵死，而它本来就活得过这次完成），或者收了却不拦
// （回到今天这个缺口）。判据就一句：`sourceReviewRun` 指向的那一轮审查此刻还活着 ⇒ 这条
// 哨兵不受这次完成影响。
//
// **第二类:已经出了结果、但还没送到执行者手上的那几条**。「进程不再 running」推不出
// 「结果已经被消费」—— 哨兵的事件先进待发送托盘（`scheduled_messages`，origin 为
// `monitor:<id>`），任务正在跑的时候送不进去，要等下一次它空下来。哨兵可以先自己退出，
// 这一批结果还排在那里。而任务一落终态，`cancelPendingMonitorEvents` 会把它们整批作废：
// 哨兵卡片上写着「命令自己跑完了」，执行者一个字都没见到。审查实测（F2）就是这条：
// `printf 'RESULT_READY\n'` 的哨兵已经 exited、消息正文有 RESULT_READY、complete 照旧
// 200、结算落 done、那条消息变成 canceled。
//
// **第三类:结局已经写定、那条结束通知还没入队的**（第 1 轮审查 F1）。前两类之间原来是有缝
// 的:哨兵的结束是「把行写成终态」加「把【哨兵结束】排进待发送」两件事,中间还隔着写时间线
// 那一笔 await。那一瞬第一类看不见它（已经不是 running）、第二类也看不见（消息还没入队),
// 于是闸放行、任务落 done、紧接着的入队被终态挡回 —— 一条没有 stdout 的命令唯一能告诉执行者
// 「等到了」的通知就此蒸发（实测 `F1_END_RESULT_HANDOFF`:statusAtSeam=exited、pendingBefore=0、
// complete 200、settlement=done、messagesAfter=[]）。
//
// 补的办法不是在闸上再加一个 if（那只是把这一个窗口糊住,离线收尾那条对称路径照旧漏),而是
// **让生产侧在产出结果的那一刻就留下一笔闸看得见的责任**:收尾把凭证跟终态写进同一条 UPDATE,
// 入队成功之后才销（schema-monitors.ts 的 `result_handoff_at`、monitor-events.ts 的
// `deliverResultHandoff`）。于是从结果产出到持久入队,任何一刻这三类里至少有一类看得见它。
//
// 三类都只挡「这一次完成」，不是永久锁：撤掉 / 收下来看一眼 / 用户在待发送托盘里删掉 /
// 对它调 stop_monitor 明确放弃，任一件做完闸自己就开（**不是**按事件计数大于零就算已处理
// —— 计数只在投递被接受时才涨，正好是这里要护的那一批还没涨的）。
import { and, desc, eq, isNotNull, isNull, like } from "drizzle-orm";
import { monitorEventTally } from "@ash/shared/monitor-silence";
import { monitorIdFromOrigin } from "@ash/shared/monitor";
import { db } from "./db/index.js";
import { monitorLogBytes } from "./monitors.js";
import { monitors, scheduledMessages, sessions } from "./db/schema.js";
import { appendTaskTimeline } from "./task-timeline.js";

type MonitorFacts = {
  id: string;
  label: string;
  events: number;
  /** 日志文件这一刻有多少字节(`null` = 读不出来)。**不是投递游标**,见 `monitorLogBytes`。 */
  logBytes: number | null;
  endedReason: string | null;
};

const MONITOR_COLUMNS = {
  id: monitors.id, description: monitors.description, command: monitors.command,
  events: monitors.events, offset: monitors.offset,
  endedAt: monitors.endedAt, endedReason: monitors.endedReason, endedBy: monitors.endedBy,
  logPath: monitors.logPath, resultsAbandonedAt: monitors.resultsAbandonedAt,
  resultHandoffAt: monitors.resultHandoffAt,
  sourceReviewRun: monitors.sourceReviewRun, sourceReviewRound: monitors.sourceReviewRound,
};

type MonitorRow = {
  id: string; description: string; command: string;
  events: number; offset: number; logPath: string;
  endedAt: string | null; endedReason: string | null; endedBy: string | null;
  resultsAbandonedAt: string | null;
  resultHandoffAt: string | null;
  sourceReviewRun: string | null; sourceReviewRound: number | null;
};

/** 描述是 agent 自己写的「我在盯什么」，没写就退回命令原文（跟 `liveMonitorSummary` 同一口径）。 */
const labelOf = (r: { description: string | null; command: string }): string =>
  (r.description ?? "").trim() || r.command.trim();

const factsOf = (r: MonitorRow): MonitorFacts => ({
  id: r.id, label: labelOf(r), events: r.events,
  logBytes: monitorLogBytes(r.logPath), endedReason: r.endedReason,
});

/**
 * 这条哨兵活得过这次完成吗。
 *
 * 跟 `stopMonitorsForTask` 的 `kept` 同一份判据（`intent === "task-settled"` 那一档）：属于
 * 一次仍在进行的审查的哨兵既不该拦住完成，也不该被算进「撤了几个」—— 它根本不是这次完成
 * 的受害者。
 */
async function sparedByReview(r: Pick<MonitorRow, "sourceReviewRun" | "sourceReviewRound">): Promise<boolean> {
  if (r.sourceReviewRun === null) return false;
  const { isReviewSourceActive } = await import("./monitor-session.js");
  return await isReviewSourceActive(r.sourceReviewRun, r.sourceReviewRound);
}

/** 第一类：还在盯的进程。 */
async function liveMonitors(taskId: string): Promise<MonitorFacts[]> {
  const rows = await db.select(MONITOR_COLUMNS).from(monitors)
    .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "ash"), eq(monitors.status, "running")));
  const live: MonitorFacts[] = [];
  for (const r of rows) if (!await sparedByReview(r)) live.push(factsOf(r));
  return live;
}

/**
 * 第二类：还排在待发送托盘里、没送到执行者手上的哨兵结果。
 *
 * **带投递租约的那一行也算**。`cancelPendingMonitorEvents` 放过它（它归抢下租约的那位投递者），
 * 但投递者起这一轮时会按最新状态自己撤回并取消（`pending-messages.ts` 的 `monitorWakeGuard`）
 * —— 对「结果还会不会到执行者手上」这一问，两条路的答案是同一个「不会」。
 *
 * 行还在、哨兵行已经没了（被删/被清）的，照样算：那条消息仍会被作废，而消息本身就是结果。
 *
 * **已经被明确放弃的那几条除外**（`results_abandoned_at` 非空 —— 有人对它调过 `stop_monitor`）。
 * 不排除的话，闸给出的那条出路「不要了就 stop_monitor 再 complete_task」自己就走不通：
 * `stop_monitor` **不会**把已经攒在缓冲里的行取消（monitor-stop.ts：那些是已经发生的事实，
 * 任务还活着就该推完），于是停的那一刻刚好有几行进了托盘，complete 接着被这一类拦住，而
 * agent 手上再没有第三个动作可用。
 *
 * **判据是那句话本身，不是进程的结束来源**（第 2 轮审查 R2-3）：上一版认 `ended_by='actor'`，
 * 而那一列只有 running 分支写得到 —— 对一条已经 `exited` 的哨兵，`stop_monitor` 一个字都写不
 * 进去，于是文案承诺的出路对它永远无效。放弃连理由一起落库、并留在时间线上，所以它是看得见
 * 的，不是偷偷丢掉。
 */
async function undeliveredResults(taskId: string): Promise<{ id: string; label: string }[]> {
  const rows = await db
    .select({ id: scheduledMessages.id, origin: scheduledMessages.origin })
    .from(scheduledMessages)
    .where(and(
      eq(scheduledMessages.taskId, taskId),
      eq(scheduledMessages.status, "pending"),
      like(scheduledMessages.origin, "monitor:%"),
    ));
  const unread: { id: string; label: string }[] = [];
  for (const r of rows) {
    const monitorId = monitorIdFromOrigin(r.origin);
    if (!monitorId) continue;
    const m = (await db.select(MONITOR_COLUMNS).from(monitors).where(eq(monitors.id, monitorId))).at(0);
    if (m?.resultsAbandonedAt) continue;
    if (m && await sparedByReview(m)) continue;
    unread.push({ id: r.id, label: m ? labelOf(m) : monitorId });
  }
  return unread;
}

/**
 * 第三类：结局已经写定、那条结束通知**还没入队**的（`result_handoff_at` 非空）。
 *
 * 这一列由收尾那一笔跟终态**同一条 UPDATE** 写下，入队成功后才销，所以它覆盖的正是前两类之间
 * 那条缝（见文件头）。它也覆盖「进程这中间死掉」：凭证留在库里，启动时按它重投
 * （`redeliverResultHandoffs`），而在重投之前闸一直看得见。
 *
 * 豁免跟前两类同口径：明确放弃过结果的（`results_abandoned_at`）不算，属于仍在进行的审查的
 * 不算。
 */
async function handoffInFlight(taskId: string): Promise<MonitorFacts[]> {
  const rows = await db.select(MONITOR_COLUMNS).from(monitors)
    .where(and(
      eq(monitors.taskId, taskId),
      eq(monitors.kind, "ash"),
      isNotNull(monitors.resultHandoffAt),
      isNull(monitors.resultsAbandonedAt),
    ));
  const inflight: MonitorFacts[] = [];
  for (const r of rows) if (!await sparedByReview(r)) inflight.push(factsOf(r));
  return inflight;
}

const nameList = (items: { label: string }[]): string => {
  const head = items.slice(0, 3).map((m) => m.label).join("、");
  return items.length > 3 ? `${head} 等 ${items.length} 个` : head;
};

/**
 * 完成资格：名下还有会被这次完成毁掉的哨兵或哨兵结果吗。返回那句拒绝的话（`null` = 放行）。
 *
 * 文案里**必须带着出路**。只说「不许」的话，agent 碰上一个永远等不到的哨兵就被锁死在这个
 * 任务上 —— 而那恰恰是最常见的一种：2026-10-20 那条哨兵等的 `^OK` 根本不会出现（被等的测试
 * 进程早没了）。所以这里既要拦住「挂着哨兵就收工」，也要把每一类的明路指出来，让它做一个
 * **有意识的**取舍，而不是撞上一堵没有门的墙。
 */
export async function monitorsBlockingComplete(taskId: string): Promise<string | null> {
  const live = await liveMonitors(taskId);
  const unread = await undeliveredResults(taskId);
  const inflight = await handoffInFlight(taskId);
  if (live.length === 0 && unread.length === 0 && inflight.length === 0) return null;
  const what = [
    live.length ? `${live.length} 个哨兵还在盯着（${nameList(live)}）` : null,
    unread.length ? `${unread.length} 条哨兵结果还排在待发送里、没送到你手上（${nameList(unread)}）` : null,
    inflight.length
      ? `${inflight.length} 条哨兵刚跑完、结束通知正在送往你手上（${nameList(inflight)}）`
      : null,
  ].filter(Boolean).join("，以及 ");
  return (
    `完成确认被拦下：你名下还有 ${what}。`
    + "任务一落 done，还在盯的会被系统一并停掉，排着没送到的会被作废 —— 两边的结果你都再也拿不到了。"
    + "按你的判断选一条出路："
    + "① 还要那个结果 → 改用 pause_task 收尾，resumePrompt 写清「被哨兵叫醒后该干什么」；"
    + "哨兵醒来、或者排着的那几条送到，都会把这条会话重新叫起来，已预约的审查也会等它；拿到结果再 complete_task。"
    + (live.length
      ? "② 还在盯的那几个不要了 → 逐个调 stop_monitor（reason 写清为什么不要了），再调 complete_task。"
      : "")
    + (unread.length
      ? "③ 排着的那几条：要么先收下来看一眼（走①），要么对它那条哨兵调 stop_monitor"
        + "（reason 写清为什么不要了）—— 对已经结束的哨兵照样管用，它只是把「必须先收下这份结果」"
        + "这条放行条件撤掉，连理由一起记进任务时间线，排着的事件该送还是会送。"
        + "用户也可以在界面的待发送托盘里直接删掉。"
      : "")
    + (inflight.length
      ? "④ 正在送的那几条：**等一下再调一次 complete_task 就行** —— 它们是刚刚跑完的哨兵的结束通知，"
        + "这一刻正在入队（通常就是下一个瞬间）。确实不要了也可以对它调 stop_monitor。"
      : "")
  );
}

/** 这个任务当前这一轮是哪条会话、什么时候开跑的。会话行跨回合复用，所以 `turnStartedAt` 才是回合锚。 */
async function currentTurn(taskId: string): Promise<{ sessionId: string; since: string } | null> {
  const row = (await db
    .select({ id: sessions.id, turnStartedAt: sessions.turnStartedAt, startedAt: sessions.startedAt })
    .from(sessions)
    .where(and(eq(sessions.taskId, taskId), isNull(sessions.endedAt)))
    .orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt))).at(0);
  const since = row?.turnStartedAt ?? row?.startedAt;
  return row && since ? { sessionId: row.id, since } : null;
}

/**
 * 完成确认落定之后：这一回合**主动**撤掉过哨兵吗。撤过就写一条时间线。
 *
 * 判据是 `ended_by = 'actor'`，不是 `status = 'stopped'`（第 1 轮审查 N1）：同一个 stopped
 * 状态下还有「推够 200 条事件自动停」和「系统回收」两种来由，拿状态当行为来源，就会把
 * 一次额度自动停说成「本回合撤掉哨兵，撤的理由『推够了 200 条事件自动停』」。
 *
 * 时间线写到**这一回合那条会话**上，不是「最新创建的那条」（N2）：一个任务里可以有多条
 * 会话（用户 @ 过谁就多一条），按最新创建投递会把这段说明写进另一位智能体的时间线里。
 *
 * 失败不往上抛：完成确认已经落库了，一条说明文字写不进去不该把它翻掉。
 */
export async function noteMonitorsDropped(taskId: string): Promise<void> {
  try {
    const turn = await currentTurn(taskId);
    if (!turn) return;
    const rows = await db.select(MONITOR_COLUMNS).from(monitors)
      .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "ash"), eq(monitors.endedBy, "actor")));
    const dropped: MonitorFacts[] = [];
    for (const r of rows) {
      // 时间窗：字符串比较成立是因为两列都是 `new Date().toISOString()`（util.ts 的 `now`），
      // 同一种定长 UTC 格式，字典序就是时间序。
      if (!(r.endedAt && r.endedAt >= turn.since)) continue;
      if (await sparedByReview(r)) continue;
      dropped.push(factsOf(r));
    }
    if (dropped.length === 0) return;
    const detail = dropped.slice(0, 3).map((m) => {
      const why = (m.endedReason ?? "").trim();
      return `${m.label}（${why ? `撤的理由「${why}」，` : ""}${monitorEventTally(m.events, m.logBytes)}）`;
    }).join("；");
    const more = dropped.length > 3 ? `，另有 ${dropped.length - 3} 个` : "";
    await appendTaskTimeline(
      taskId,
      `本回合撤掉 ${dropped.length} 个哨兵后确认完成：${detail}${more}。`
      // **只说「不再继续盯」**(第 1 轮审查 N3)。上一版写「它们在等的结果不会再回来了」,
      // 而这句话有两处说不准:一是确认成功不等于这一轮就落 done(手里还攥着人工检查点/
      // 提问时会落 paused),二是 `stop_monitor` 明确保留已经攒下的事件(monitor-stop.ts),
      // 放弃撤掉的只是「必须先收下它」这条放行条件 —— 那几条该送还是会送到。
      + "从这一刻起没人再盯着它们了,之后才产生的输出不会再有人收——还需要的话得重新挂一个哨兵"
      + "（它们停之前已经攒下、还排在待发送里的那些,该送的照旧会送到）。",
      { sessionId: turn.sessionId },
    );
  } catch (e) {
    console.error(`[ash] 记录「撤哨兵后完成」失败 task=${taskId}:`, e);
  }
}
