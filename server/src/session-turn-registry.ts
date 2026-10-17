import { dbClient } from "./db/index.js";
import { now } from "./util.js";
// 回合身份的**内存登记层**：这一刻哪些回合真的在跑、下一个起点发给谁、哪些身份已经终结。
//
// 为什么这半截必须在内存里：库里「开始了没收口」这一个事实下面压着两种完全相反的情况——
// 正在写，和当初崩了没来得及收口。任务状态分不出它们（同一个任务后来又跑起来时，`running`
// 对两者都成立），所以活动身份只能由写端自己登记：`markTurnActive` / `clearTurnActive`，
// 进程一重启就全部清空——那正是语义所要的，ash 重启后确实没有任何回合还在跑，旧的未收口
// 身份一律回到「未知」（第 5 轮审查必须修 1）。
//
// 为什么从 `session-turns.ts` 里搬出来：那个文件把「登记」和「落账」两件事合在一处,每轮审查
// 又都要往不变量上加字,写到 657 行已经贴着单文件上限（根 CLAUDE.md 700 行）。对外**仍然只有
// 一个入口** —— `session-turns.ts` 把这里的公开函数原样再导出一遍,调用方一个字都不用改,
// 所以「一个入口承担全部不变量」那条仍然成立,这里只是它的实现文件。
//
// 落账那半截（`openTurn` / `recordTurnSpan` / 欠账 / 原子批）在 `session-turns.ts`,
// 读取端在 `task-artifact-windows.ts`,表的语义在 `db/schema-sessions.ts`。

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
 *
 * **怎么判一处新入口有没有做对**（第 7 轮审查必须修 1）：每个登记都必须有**恰好一个所有者
 * 作用域**,而所有者的每一个出口都注销。所有者只有两种形态,别混着用：
 *   • **登记它的那次函数调用**（单飞 `task-run`/`orchestrator`、`duet/turn` 的一轮发言、
 *     `reattach` 的那次接管）——那就必须有一道 `try/finally` **从拿到身份的那一刻**罩到
 *     函数末尾。只罩住消费循环是不够的:中间那段初始化（建目录、开写流）抛出来就绕过去了,
 *     duet 的 F1 就是这么漏的。
 *   • **一个活得比调用更长的对象**（团队那台 `Lead`:注销在 `endTurn`/`closeLead`/
 *     `retireLead`）——这种情况下**先把所有者挂上线,再去拿身份**。顺序反了,中间那段组装
 *     一抛就留下一个谁都不会来注销的登记,而这种泄漏在测试里是哑的（面板只是多列几个
 *     别人的东西）。
 */
const activeTurns = new Map<string, { taskId: string; starts: Set<string> }>();
/**
 * `task_id` → 它名下**此刻**有活动身份的会话。只为 `closeTaskTurns` 服务（各入口的 finally
 * 里只拿得到 taskId）。
 *
 * 跟着活动集合一起**对称回收**：一条会话的最后一个身份注销掉时,它从这张表里一并删掉,任务
 * 名下空了就把任务条目也删掉。所以这张表的大小等于「当下真的在跑的会话数」,不随进程跑过
 * 多少任务增长。不对称的那一版只有 `closeTaskTurns` 会删,而 duet 走 `closeSessionTurns`、
 * 团队走 `clearTurnActive`,两条路都不碰它:一个长命进程跑过的每条会话 id 都会永久留下,
 * 任务后来删掉也不回收（第 7 轮审查 N1）。`activeTurns` 里存 `taskId` 就是为了让
 * `clearTurnActive` 这种拿不到 taskId 的注销也能做这件事——一条会话行只属于一个任务,
 * 登记时那个 taskId 就是权威值。
 */
const sessionsByTask = new Map<string, Set<string>>();
/**
 * 每条会话的两道**水位**,一个条目装一对,**绝不许分家**：
 *
 *   • `last` —— 这条会话上已经见过的最大回合起点。下一次分配必须**严格大于**它
 *     （`nextTurnStart`）,于是「一条被接受的输入对应一份独立生命周期」这个前提成立：队列、
 *     唯一键和活动册都按起点认人,起点一撞,三样东西同时把两轮合成一轮（第 2 轮审查 F1）。
 *   • `closed` —— **已经关闭到哪个起点**（含）。挡住「迟到的开始信息把一个已经终结的身份重新
 *     登记成活动」：消费循环已经收尾、调度台已经摘牌、甚至这一轮刚刚被 `turnEnd` 关掉之后,
 *     仍可能有一个排在后面的异步回调去开这一轮（团队开台就是这个形状:先持有首轮身份,再隔着
 *     两次写库才轮到 `beginTurn`）。起点严格递增,所以「不晚于已关闭到的那一刻」就是迟到的凭据。
 *
 * 为什么必须装在同一个条目里：两张表各自淘汰时,`last` 先被丢掉就会分配出一个不大于 `closed`
 * 的起点,那一轮当场被当成迟到的拒掉——明明是新回合,活动册上却一个身份都没有。
 *
 * 顺带把墙钟回拨也挡住了：回拨之后 `now()` 可能落在 `closed` 之前,而分配器只认水位,不认时钟。
 */
const watermarks = new Map<string, { last: string; closed: string | null }>();
/** 这张表只在本进程生命周期内有意义;跑过几千条会话的长命进程别让它无限涨。 */
const WATERMARK_LIMIT = 4096;

/** 下一毫秒。同一条会话上撞了起点就往后顶——顶的是**身份**,区间数据差的那 1ms 无人可见。 */
function bumpIso(at: string): string {
  const ms = Date.parse(at);
  if (Number.isFinite(ms)) return new Date(ms + 1).toISOString();
  // 解析不出来（库被手改过、别的格式）：退回「现在」。它仍可能不大于那个怪字符串,那一档
  // 的唯一性只剩唯一索引兜着（插不进去 = 不重复计数）,读端照未知披露,不假装记上了。
  return now();
}

/** 把一个见过的起点纳入分配水位,并返回这条会话的水位条目。 */
function noteStartSeen(sessionId: string, startedAt: string): { last: string; closed: string | null } {
  const seen = watermarks.get(sessionId);
  if (seen) {
    if (startedAt > seen.last) seen.last = startedAt;
    return seen;
  }
  const fresh = { last: startedAt, closed: null };
  watermarks.set(sessionId, fresh);
  capWatermarks();
  return fresh;
}

/**
 * 这条会话的**下一个回合起点**。八处起跑入口一律从这里取,别自己调 `now()`。
 *
 * 为什么不另造一个 uuid 当身份：`(session_id, started_at)` 已经是库里的唯一键、活动册的键、
 * 所有权队列的元素和 trace/日志的文件名,换一套 id 要同时迁移这四样,而缺陷本身只是「这个
 * 字符串不保证唯一」。所以在**这一层**把它变成真唯一的身份:时间仍然是区间数据（最多差几
 * 毫秒,所有区间判据都带 `TURN_SKEW_MS` 级余量）,唯一性由水位保证而不是由时钟碰巧保证。
 */
export function nextTurnStart(sessionId: string, preferred: string = now()): string {
  const seen = watermarks.get(sessionId);
  const at = seen && preferred <= seen.last ? bumpIso(seen.last) : preferred;
  noteStartSeen(sessionId, at);
  return at;
}

/**
 * 把这条会话**在库里已经用过的最晚起点**接回分配水位。复用一条历史会话之前调一次
 * （续聊、讨论复用那一行、团队开台接回),就在取 `nextTurnStart` 之前。
 *
 * 为什么必须有这一步：水位只活在进程内存里（见 `watermarks`)。重启之后那张表是空的,墙钟
 * 又恰好回拨到上一轮开工的同一毫秒时,`nextTurnStart` 会把那个历史身份原样再发一遍——开始
 * 行被唯一键合进旧行、收尾看见「已经收过口」直接返回,于是新的这一轮在库里一个字都没有,
 * 读端照旧行那个几秒的区间去筛,这一轮做出来的图静默消失,连一句「算不准」都没有
 * （第 1 轮审查 F2）。
 *
 * **这只是让碰撞不发生,不是碰撞的唯一防线**：真撞上了（这一步没跑、库读不到、水位被淘汰过)
 * 由写端照实记一笔持久欠账,读端把那一段降级成未知（见 `writeTurnRow` 的 `collided`）。
 *
 * **不抛**：接不回来只是少一道保险,而调用它的地方正在起跑。
 */
export async function primeTurnStarts(sessionId: string): Promise<void> {
  try {
    const seen = await dbClient.execute({
      sql: `SELECT MAX(at) AS last FROM (
              SELECT MAX(started_at) AS at FROM session_turns WHERE session_id = :sid
              UNION ALL
              SELECT turn_started_at AS at FROM sessions WHERE id = :sid
            )`,
      args: { sid: sessionId },
    });
    const last = seen.rows[0]?.last;
    if (typeof last === "string" && last) noteStartSeen(sessionId, last);
  } catch (error) {
    console.warn(`[ash] 回合起点水位没从库里接回（真撞上历史身份时照未知披露）: ${String(error)}`);
  }
}

/**
 * 登记「这条会话的这个回合正在跑」。
 *
 * **返回收下了没有**：`false` = 这个身份已经终结（或者压根没有起点）,调用方据此不许把它当成
 * 一个在跑的回合——所有权层的 `holdTurn` 就是看这个返回值决定入不入队,两份账因此同源。只有
 * 这个函数知道「关闭到哪了」,判据留在这一层,八处开始入口才不必各记一份（第 2 轮审查 F2）。
 */
export function markTurnActive(input: {
  sessionId: string;
  taskId: string;
  startedAt: string | null | undefined;
}): boolean {
  const { sessionId, taskId, startedAt } = input;
  if (!startedAt) return false;
  // 见过的起点一律纳入分配水位:这里是**所有**身份的必经之路（含 `reattach` 从库里接回的那一个、
  // 各种重放）,所以分配器永远不会再发一个已经用过的起点,重启之后接着跑也不会。
  const mark = noteStartSeen(sessionId, startedAt);
  if (mark.closed && startedAt <= mark.closed) return false; // 迟到：这个身份已经终结了
  const seen = activeTurns.get(sessionId);
  if (seen) seen.starts.add(startedAt);
  else activeTurns.set(sessionId, { taskId, starts: new Set([startedAt]) });
  const peers = sessionsByTask.get(taskId);
  if (peers) peers.add(sessionId);
  else sessionsByTask.set(taskId, new Set([sessionId]));
  return true;
}

/** 这条会话不再有任何活动身份:两张表一起摘干净（登记那两步的镜像,见 `sessionsByTask`）。 */
function forgetSession(sessionId: string, taskId: string): void {
  activeTurns.delete(sessionId);
  const peers = sessionsByTask.get(taskId);
  if (!peers) return;
  peers.delete(sessionId);
  if (!peers.size) sessionsByTask.delete(taskId);
}

/** 记下「这条会话关闭到这一刻为止」。同一个条目里 `last` 一并抬起,两道水位不会错位。 */
function rememberClosed(sessionId: string, startedAt: string): void {
  const mark = noteStartSeen(sessionId, startedAt);
  if (!mark.closed || startedAt > mark.closed) mark.closed = startedAt;
}

/**
 * 这个身份**已经被本进程收过口了吗**。
 *
 * 用在撞号判据上（`openTurn`）：库里那条「已经收过口」的行,到底是别人（上一次运行、
 * 另一个进程）的,还是**它自己这一轮**刚刚收的——收尾与迟到的开始本来就可以交错,
 * `recordTurnSpan` 的同步开头已经把这个身份记成关闭了,所以问这道水位就分得出来。少这一问
 * 会把 F1 那个并发收尾错报成「起点撞上历史记录」,凭空多一笔缺口。
 */
export function closedAlready(sessionId: string, startedAt: string): boolean {
  const mark = watermarks.get(sessionId);
  return !!mark?.closed && startedAt <= mark.closed;
}

/** 水位表封顶。丢掉的只是「挡迟到 + 不重发起点」这层保险,而那些会话早就不在跑了。 */
function capWatermarks(): void {
  if (watermarks.size <= WATERMARK_LIMIT) return;
  // 满了就从最早插入的那半开始丢（Map 保持插入序）,还在跑的那些一律留着。
  let drop = Math.floor(watermarks.size / 2);
  for (const key of watermarks.keys()) {
    if (drop-- <= 0) break;
    if (!activeTurns.has(key)) watermarks.delete(key);
  }
}

/** 注销：收尾（或者确认不再跑）之后调。幂等——同一回合可能被收两次（接回、旧调度台）。 */
export function clearTurnActive(sessionId: string, startedAt: string | null | undefined): void {
  if (!startedAt) return;
  rememberClosed(sessionId, startedAt);
  const seen = activeTurns.get(sessionId);
  if (!seen) return;
  seen.starts.delete(startedAt);
  if (!seen.starts.size) forgetSession(sessionId, seen.taskId);
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
  if (seen) for (const at of [...seen.starts]) clearTurnActive(sessionId, at);
  // **不管手上有没有活动身份,水位都抬到「现在」**。只按活动起点抬的话,一个**已经分配、
  // 还没来得及被持有**的更晚起点会绕过这道闸被登记回来（那条身份此后谁都不会来注销）。
  // 这条路的语义就是「这条会话到此刻为止不再有任何回合在跑」,水位理应照这一刻记
  // （本轮审查不拦项）。会话之后真又开跑时分配器只会给出更晚的起点,挡不住它。
  rememberClosed(sessionId, now());
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

/**
 * 内存登记此刻占着多少条目（会话数 / 任务数）。只读探针,给回归测试钉住「空了就对称回收」
 * 这条不变量——这两张表都只代表「当下真的在跑的那些回合」,跑过的会话 id 不许留在里面
 * （第 7 轮审查 N1）。
 */
export function activeRegistrySize(): { sessions: number; tasks: number } {
  return { sessions: activeTurns.size, tasks: sessionsByTask.size };
}

/** 这条会话此刻正在跑的回合起点。空集 = 它名下没有任何回合在跑（读端据此不给 live）。 */
export function activeTurnStarts(sessionId: string): ReadonlySet<string> {
  return activeTurns.get(sessionId)?.starts ?? EMPTY_STARTS;
}

const EMPTY_STARTS: ReadonlySet<string> = new Set<string>();
