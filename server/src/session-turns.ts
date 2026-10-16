import { and, eq, isNull, sql } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { sessionTurns, sessions } from "./db/schema.js";
import { id } from "./util.js";
// 回合区间的**写入端**。读取端在 `task-artifact-windows.ts`（产物归属按时间认人），表的语义写在
// `db/schema-sessions.ts` 的 `sessionTurns` 上，这里不复述。
//
// 为什么单独一个文件而不是直接在各执行路径里 insert：single / duet / team 三条路各自
// 收尾（`single-run.ts`、`duet/turn.ts`、`team/session-consumer.ts`），同一件事落三份
// 就会漂移——其中一条忘了写，那类任务的产物归属就静默退回「按 session 寿命认」，而那是
// 看不出来的（面板只是多列几个别人的东西）。
//
// 一个回合的生命周期是**两步**，别只做一半：
//   ① `openTurn` —— 开始那一刻，往表里落一行「开了，还没收口」，同一批里把计数加上。
//   ② `recordTurnSpan` —— 收尾那一刻，按同一身份把 `ended_at` 补上。
// 只做第二步（原来的样子）就等于「写失败 = 什么都没发生」：后来成功的一轮一落账，读端
// 再也看不出中间少过东西,那一轮做出来的图被静默滤掉（第 4 轮审查必须修 1）。
//
// 起跑入口有**八处**（task-run 的 fresh run、orchestrator 的新建与复用、team/session 的
// 新建与复用、team/session-consumer 的 beginTurn、duet/turn 的新建与复用），所以这里要的是
// **一个入口承担全部不变量**,而不是指望八处都手写对：
//   • 回合起点字段从下面两个 helper 取,别在调用处手写;
//   • **计数只在 `openTurn` 里加**,而且加数的条件是「这个身份还不存在」——于是同一个起点
//     被开两次（团队那边先 `openLead`、紧接着又用同一个 `turnStart` 调 `beginTurn`）只会
//     计一次。第 4 轮把加数放在字段 helper 里,那条路上重复调用凭空多出一轮,于是那条会话
//     永远报「缺一个回合记录」（第 5 轮审查必须修 2.1）。
//   • 整批写失败时记一笔 `turns_lost`：行和计数同批写之后两边同生共死,对账再也看不出缺口,
//     只有写端自己知道刚才漏了一轮（第 5 轮审查必须修 2.3）。
//
// 还有一件**只有写端知道**的事：这一刻到底哪些回合真的在跑。库里「开始了没收口」这一个
// 事实下面压着两种完全相反的情况——正在写，和当初崩了没来得及收口。任务状态分不出它们
// （同一个任务后来又跑起来时，`running` 对两者都成立），所以活动身份只能由写端在内存里
// 登记：`markTurnActive` / `clearTurnActive`，进程一重启就全部清空——那正是语义所要的，
// ash 重启后确实没有任何回合还在跑，旧的未收口身份一律回到「未知」（第 5 轮审查必须修 1）。

/**
 * 这一刻真的在跑的回合身份：`session_id` → 该会话正在进行的那些 `started_at`。
 *
 * **为什么是内存而不是库**：库里存不下「还活着」这个事实——写它的那一刻之后进程随时可能
 * 没了，而没了的时候没人改得动那一行（真实的重启对账只把任务落 failed，不伪造旧回合的
 * 收尾时刻，那是**合理保留未知**）。内存登记的生命周期恰好等于「这个进程还在跑这个回合」。
 *
 * 读端据此判 live：只有登记在册的身份才算还在写，同一个任务名下别的未收口身份一律留在
 * 「未知」那一档。重启后接回仍在跑的 agent（`reattach.ts`）会重新登记——那是真事实。
 *
 * **登记和注销是一对资源操作,注销必须覆盖全部出口**：只在正常收尾那条路上注销是不够的——
 * 回合可能因为 stream 抛错、结算写库失败、被停、接回失败、调度台被换掉而根本走不到收尾
 * 函数。残留的登记会让读端把一条早就死掉的会话当成「还在写」：任务下一次跑起来时它从那个
 * 老起点一路开到无穷,中间歇着的几个钟头里别人做的东西全被认成它的,还不标 approx
 * （第 6 轮审查必须修 1）。所以 `closeSessionTurns` / `closeTaskTurns` 挂在各入口的
 * `finally` 和收尾函数的**开头**（不等写库成功),三条单飞/duet/team 的路都走得到。
 */
const activeTurns = new Map<string, Set<string>>();
/** `task_id` → 它名下登记过活动身份的会话。只为 `closeTaskTurns` 服务（finally 里只拿得到 taskId）。 */
const sessionsByTask = new Map<string, Set<string>>();
/**
 * 每条会话**已经关闭到哪个起点**（含）。
 *
 * 作用是挡住「迟到的开始事件把一个已经退出的作用域重新登记成活动」：消费循环已经收尾、
 * 调度台已经摘牌之后,仍可能有一个排在后面的异步回调去调 `openTurn`。回合起点在同一条
 * 会话上单调递增,所以「起点不晚于已关闭到的那一刻」就是迟到的凭据。时钟回拨时这里会
 * 多挡一次（退化成「不登记」= 读端照未知披露）,那是安全方向。
 */
const closedThrough = new Map<string, string>();
/** 这几张表只在本进程生命周期内有意义;跑过几千条会话的长命进程别让它无限涨。 */
const CLOSED_MEMORY_LIMIT = 4096;

/** 登记「这条会话的这个回合正在跑」。已经关闭过的身份不再登记（迟到事件不许复活作用域）。 */
export function markTurnActive(input: {
  sessionId: string;
  taskId: string;
  startedAt: string | null | undefined;
}): void {
  const { sessionId, taskId, startedAt } = input;
  if (!startedAt) return;
  const closed = closedThrough.get(sessionId);
  if (closed && startedAt <= closed) return; // 迟到：这个作用域已经退出了
  const seen = activeTurns.get(sessionId);
  if (seen) seen.add(startedAt);
  else activeTurns.set(sessionId, new Set([startedAt]));
  const peers = sessionsByTask.get(taskId);
  if (peers) peers.add(sessionId);
  else sessionsByTask.set(taskId, new Set([sessionId]));
}

/** 记下「这条会话关闭到这一刻为止」，并顺手给内存封顶。 */
function rememberClosed(sessionId: string, startedAt: string): void {
  const prev = closedThrough.get(sessionId);
  if (!prev || startedAt > prev) closedThrough.set(sessionId, startedAt);
  if (closedThrough.size <= CLOSED_MEMORY_LIMIT) return;
  // 满了就从最早插入的那半开始丢（Map 保持插入序）。丢掉的只是「挡迟到事件」这层保险,
  // 而那些会话早就不在跑了,真有迟到回调也进不来。
  let drop = Math.floor(closedThrough.size / 2);
  for (const key of closedThrough.keys()) {
    if (drop-- <= 0) break;
    if (!activeTurns.has(key)) closedThrough.delete(key);
  }
}

/** 注销：收尾（或者确认不再跑）之后调。幂等——同一回合可能被收两次（接回、旧调度台）。 */
export function clearTurnActive(sessionId: string, startedAt: string | null | undefined): void {
  if (!startedAt) return;
  rememberClosed(sessionId, startedAt);
  const seen = activeTurns.get(sessionId);
  if (!seen) return;
  seen.delete(startedAt);
  if (!seen.size) activeTurns.delete(sessionId);
}

/**
 * 这条会话名下**全部**活动身份一次注销。
 *
 * 用在「这条消费循环结束了」的地方（各入口的 finally、收尾函数开头、调度台摘牌/关台）：
 * 那一刻不必知道具体是哪个回合,也不该依赖写库成功——会话都不在跑了,它名下不可能还有
 * 回合在写。
 */
export function closeSessionTurns(sessionId: string): void {
  const seen = activeTurns.get(sessionId);
  if (seen) for (const at of [...seen]) clearTurnActive(sessionId, at);
  else {
    // 没有活动身份也要留下「已关闭」的水位,否则迟到的开始事件照样能把它登记回来。
    const now = new Date().toISOString();
    rememberClosed(sessionId, now);
  }
}

/**
 * 这个任务名下全部会话的活动身份一次注销。
 *
 * 各入口的 `finally` 只拿得到 `taskId`（`sessId` 声明在 try 里面）,而「这一次调用结束了」
 * 恰好等于「这一轮不再有任何回合在写」——单飞/续聊一个任务同时只有一条会话在跑,duet 的
 * 两个角色串行发言,团队调度台不走这两条路。
 */
export function closeTaskTurns(taskId: string): void {
  const peers = sessionsByTask.get(taskId);
  if (!peers) return;
  for (const sessionId of [...peers]) closeSessionTurns(sessionId);
  sessionsByTask.delete(taskId);
}

/** 这条会话此刻正在跑的回合起点。空集 = 它名下没有任何回合在跑（读端据此不给 live）。 */
export function activeTurnStarts(sessionId: string): ReadonlySet<string> {
  return activeTurns.get(sessionId) ?? EMPTY_STARTS;
}

const EMPTY_STARTS: ReadonlySet<string> = new Set<string>();

/**
 * **没能落账的开始意图**：`session_id` → 那几个连一行都没写进去的回合起点。
 *
 * 为什么光靠库里的 `turns_lost` 不够：开始那一批整个回滚之后,补写这个标记的目标**还是刚刚
 * 写失败的那个库**,它很可能一起失败——那就只剩一句日志。而下一轮一落账,成功计数和成功
 * 身份数又重新相等,读端于是宣称完整,中间那一轮做出来的图被静默滤掉（第 6 轮审查必须修 2）。
 *
 * 所以未确认的意图先留在内存里：读端把它直接算进缺口（哪怕库里一个字都没有）,下一次开回合
 * 时再试着补成持久的 `turns_lost`。库恢复了就补上,库一直不可写就一直按未知披露。进程同时
 * 被杀且库从未写成那一笔才会真丢——那一档物理上没有别的办法,不装作记住了。
 */
const unconfirmed = new Map<string, Set<string>>();

/** 这条会话有几个开始意图还没被确认落账（读端把它算进缺口）。 */
export function unconfirmedTurns(sessionId: string): number {
  return unconfirmed.get(sessionId)?.size ?? 0;
}

function rememberUnconfirmed(sessionId: string, startedAt: string): void {
  const seen = unconfirmed.get(sessionId);
  if (seen) seen.add(startedAt);
  else unconfirmed.set(sessionId, new Set([startedAt]));
}

/**
 * 把欠着的「漏了一轮」补成库里的 `turns_lost`。开回合时先试一次：库恢复了就不再依赖内存。
 *
 * 补成功才从内存移除,所以同一笔账**不会**两边各算一次（读端 = `turns_lost` + 内存未确认）。
 */
async function flushUnconfirmed(sessionId: string): Promise<void> {
  const owed = unconfirmed.get(sessionId);
  if (!owed?.size) return;
  const count = owed.size;
  try {
    await db.update(sessions)
      .set({ turnsLost: sql`COALESCE(${sessions.turnsLost}, 0) + ${count}` })
      .where(eq(sessions.id, sessionId));
    unconfirmed.delete(sessionId);
  } catch (error) {
    // 还是写不进去：账留在内存里,读端照样看得见缺口。
    console.warn(`[ash] 欠着的 ${count} 笔「漏了一个回合」还没补进库（这一段按未知披露）: ${String(error)}`);
  }
}

/**
 * 新建会话行时的回合字段。
 *
 * **不含计数**：那是 `openTurn` 的事（同一批里加，条件是身份还不存在）。这里只声明
 * 「这条会话没有升级前的未知历史」——`turns_base_approx = 0` 同时兼作迁移的幂等标记，
 * 回填只认 `turns_base IS NULL`。
 */
export const freshTurnFields = (at: string) => ({
  turnStartedAt: at,
  turnsBase: 0,
  turnsBaseApprox: false,
});

/**
 * 复用同一行会话、又开一个回合时要刷的字段。
 *
 * `endedAt: null` 也在这里：会话重新开跑就不再是「已收尾」,漏掉它的那一处会让读端把这条
 * 会话当成结束了的（区间按老的收尾时刻截断）。计数同样不在这里加，理由见文件头。
 */
export const resumedTurnFields = (_at: string) => ({
  turnStartedAt: _at,
  endedAt: null as string | null,
});

/**
 * 回合**开始**：落一行「从 X 开始、还没收口」，同一批里把 `turns_started` 加上。
 *
 * **绝不抛**，理由同 `recordTurnSpan`：这一行只影响产物面板的归属精度,而调用它的地方正在
 * 起跑。写不进去就记一笔 `turns_lost`,读端据此照实说「有一次运行连开始都没留下记录」。
 *
 * **幂等**：同一 (session_id, started_at) 再调一次既不插行也不加数（唯一索引挡插入、
 * `NOT EXISTS` 挡加数）。接回、重试、团队那边同起点再开一次台都会重放同一个身份。
 */
export async function openTurn(input: {
  sessionId: string;
  taskId: string;
  cwd: string | null | undefined;
  startedAt: string | null | undefined;
}): Promise<void> {
  if (!input.startedAt) return;
  // 先登记活动身份：登记得比写库早一点没有坏处（读端还要求任务在 running/queued），
  // 反过来晚一点就有——那个窗口里面板会把正在写的这一轮算成「崩了没收口」。
  markTurnActive({ sessionId: input.sessionId, taskId: input.taskId, startedAt: input.startedAt });
  // 上一轮欠着的「漏了一个回合」在这里补：那时库正坏着,现在也许好了。放在新回合落账**之前**,
  // 这样「后来成功的一轮」永远不会先把两个数凑相等再让欠账无声无息（第 6 轮审查必须修 2）。
  await flushUnconfirmed(input.sessionId);
  const args = {
    row: id(),
    sid: input.sessionId,
    task: input.taskId,
    cwd: input.cwd ?? null,
    at: input.startedAt,
  };
  try {
    // **一个原子批,顺序不能换**：加数在前,它的 `NOT EXISTS` 问的是插入**之前**的状态；
    // 插在前就永远加不上数了。两条同生共死,所以不存在「行写上了计数没加」这种中间态——
    // 那种中间态在这里全是错的方向（计数偏小正好抵掉真缺口）。
    await dbClient.batch([
      {
        sql: `UPDATE sessions SET turns_started = COALESCE(turns_started, 0) + 1
                WHERE id = :sid
                  AND NOT EXISTS (
                    SELECT 1 FROM session_turns WHERE session_id = :sid AND started_at = :at
                  )`,
        args: { sid: args.sid, at: args.at },
      },
      {
        sql: `INSERT OR IGNORE INTO session_turns (id, session_id, task_id, cwd, started_at, ended_at)
                VALUES (:row, :sid, :task, :cwd, :at, NULL)`,
        args,
      },
    ]);
  } catch (error) {
    await noteTurnLost(input.sessionId, input.startedAt, error);
  }
}

/**
 * 「这一轮整个没记上」记一笔。
 *
 * 这是**唯一**还知道刚才漏了一轮的地方：行和计数同批写,都失败时库里两个数仍然相等,对账
 * 一点痕迹都看不出来（第 5 轮审查必须修 2.3）。而补这一笔的目标还是刚刚写失败的那个库,所以
 * **先把意图记在内存里**（`unconfirmed`）再试持久化,写成了才把内存那笔划掉；没写成就留着,
 * 读端照样把它算进缺口,下一次开回合时再试（第 6 轮审查必须修 2）。
 */
async function noteTurnLost(sessionId: string, startedAt: string, cause: unknown): Promise<void> {
  console.warn(`[ash] 回合开始没落盘（这一轮按缺口披露）: ${String(cause)}`);
  // **先记内存,再试库**。顺序反过来就又回到「补写也失败 = 只剩日志」那一步：那一笔账从此
  // 没人记得,下一轮一落账两个数就重新相等（第 6 轮审查必须修 2）。
  rememberUnconfirmed(sessionId, startedAt);
  await flushUnconfirmed(sessionId);
}

/**
 * 记下「这一回合从 X 跑到 Y，干活的目录是 Z」。
 *
 * **绝不抛**：这一行只影响产物面板的归属精度，而调用它的地方正在做回合结算——那条路上
 * 任何意外都会变成「任务状态结算不下去」。写不进去就降级回老行为（按 session 寿命认），
 * 代价是面板可能多列几个同目录别的任务的东西，不是数据错乱。
 *
 * **按身份收口,不是追加**：有开始行就补它的 `ended_at`；没有（开始那下没写成、或者是本
 * 函数早于 `openTurn` 的老路径）才插一条完整的。已经收过口的**不覆盖**——团队那边旧调度台
 * 也可能来收一次（`closeLead`），认第一次才叫幂等,否则同一回合的收尾时刻会被改晚。
 *
 * 补插的那一支**不消 `turns_lost` 的账**：那一笔记的是「开始那一刻没记上」,而面板宁可多说
 * 一句「这一段算不准」。少说一句的代价是漏图（看不见),多说一句的代价只是多看一行提示。
 */
export async function recordTurnSpan(input: {
  sessionId: string;
  taskId: string;
  cwd: string | null | undefined;
  startedAt: string | null | undefined;
  endedAt: string;
}): Promise<void> {
  // 起点取不到就没有区间可言（宁可不记，也不要记一条起点是「现在」的假区间：那会把
  // 这一回合真正写出来的东西全判到区间之外）。
  if (!input.startedAt) return;
  const startedAt = input.startedAt;
  // 收尾了就不再是活动身份。放在写库**之前**：这一行只影响「还在写吗」的判断,写库失败时
  // 更要让它回到「未知」那一档,而不是继续被当成正在跑（区间会一直开到无穷）。
  clearTurnActive(input.sessionId, startedAt);
  try {
    const existing = await db.select({ endedAt: sessionTurns.endedAt })
      .from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.startedAt, startedAt)));
    if (!existing.length) {
      await db.insert(sessionTurns).values({
        id: id(),
        sessionId: input.sessionId,
        taskId: input.taskId,
        cwd: input.cwd ?? null,
        startedAt,
        endedAt: input.endedAt,
      }).onConflictDoNothing();
      return;
    }
    if (existing.some((row) => row.endedAt)) return; // 已经收过口：重放,不动
    await db.update(sessionTurns)
      .set({ endedAt: input.endedAt, cwd: input.cwd ?? null })
      .where(and(
        eq(sessionTurns.sessionId, input.sessionId),
        eq(sessionTurns.startedAt, startedAt),
        isNull(sessionTurns.endedAt),
      ));
  } catch (error) {
    console.warn(`[ash] 回合区间没落盘（产物归属降级为按会话寿命认）: ${String(error)}`);
  }
}
