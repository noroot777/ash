import { and, eq, isNull } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { sessionTurns } from "./db/schema.js";
import { id, now } from "./util.js";
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
//   • 整批写失败时**按身份**记一笔欠账：行和计数同批写之后两边同生共死,对账再也看不出缺口,
//     只有写端自己知道刚才漏了一轮（第 5 轮审查必须修 2.3）。欠的是**那一行开始记录**,库
//     一恢复就按同一个身份补上去——压成一个无身份的计数的话,同一个身份后来重试成功也消不掉
//     它,读端只能继续把整条会话寿命算成宽的（第 1 轮审查 F2,见 `unconfirmed`）。
//   • **回合起点在这里分配**（`nextTurnStart`）,起跑入口不许自己取 `now()`：墙钟毫秒不是身份。
//     同一条会话上两次投递撞在同一毫秒,时间字符串就是同一个值——所有权层的队列把两轮合成一个
//     位置、唯一键把两行合成一行,于是后开那一轮被前一轮的结束事件当场收口,它真正干活那段落进
//     空洞,做出来的东西永久漏在清单外（第 2 轮审查 F1）。
//   • **结束不可逆**：`markTurnActive` 返回「收下了没有」,不晚于已关闭水位的开始信息一律拒掉。
//     迟到的开始回调只能**补持久记录**（`openTurn` 照写那一行）,不许把一个已经终结的身份重新
//     登记成活动——重新登记出来的那个幽灵会被下一次结束消耗掉,真正刚结束的身份则一直留在册上,
//     读端把区间开到无穷（第 2 轮审查 F2）。所有开始入口共用这一条,靠的就是都从这儿过。
//   • **行与计数同批、消账按身份**：开始、收尾补插、幂等重放三条路都走 `persistTurn`,落成了就
//     划掉**那一个**身份的欠账。少这一条,收尾补插出来的完整记录仍被当成缺口,读端照 `missing>0`
//     把整条会话寿命重新算进候选区间,停工期间别人做的东西又被收进来（第 2 轮审查 F3）。
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
  else {
    // 没有活动身份也要留下「已关闭」的水位,否则迟到的开始事件照样能把它登记回来。
    rememberClosed(sessionId, now());
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

/**
 * **没能落账的开始意图**：`session_id` → 那几个连一行都没写进去的回合**身份**（起点 → 它
 * 当时的 task / cwd）。
 *
 * 为什么光靠库里那一笔标记不够：开始那一批整个回滚之后,补标记的目标**还是刚刚写失败的那个
 * 库**,它很可能一起失败——那就只剩一句日志。而下一轮一落账,成功计数和成功身份数又重新
 * 相等,读端于是宣称完整,中间那一轮做出来的图被静默滤掉（第 6 轮审查必须修 2）。所以未确认
 * 的意图先留在内存里：读端把它直接算进缺口（哪怕库里一个字都没有）,下一次开回合时再试着
 * 持久化。进程同时被杀且库从未写成那一笔才会真丢——那一档物理上没有别的办法,不装作记住了。
 *
 * **为什么连 task / cwd 一起记下来**：要补的是**那一行开始记录本身**,不是一个「少了一轮」
 * 的数字。原先 `flushUnconfirmed` 把这些意图压成 `sessions.turns_lost` 上的一个计数,身份就
 * 此丢了——同一个身份后来重试成功（库恢复后的重试、团队那边先开台再 `beginTurn` 用的都是
 * **同一个** `turnStart`）,那个计数还挂在那儿,读端照它把整条会话寿命算成宽的,两轮之间歇
 * 着的那段时间里别人做的图又被收进来,面板还谎称「有一次连开始都没留下记录」（第 1 轮审查
 * F2）。按身份补行,所以「消账」这个动作也必须**按身份**（`confirmTurn`）：补上的那一行就
 * 是那一轮的记录,它和后来的重试、以及收尾那下发现开始行不在时的补插,走的是同一个幂等批
 * （`persistTurn`）——谁先成功都只留一行、只加一次数,成功的那一个把它自己那笔欠账划掉。整条
 * 会话一把清是错的:清的那一刻另一个身份可能刚欠上账,它会被连带抹掉（第 2 轮审查 F3 的同类
 * 并发位置 C4）。补上之后那一轮从「整段会话都算不准」升级成「开了没收口」——末端估到下一个
 * 回合起点,窄得多,照实标 approx;而走**补插**那条路补齐的是一行完整记录,连那一句「算不准」
 * 都不必再说。
 */
const unconfirmed = new Map<string, Map<string, { taskId: string; cwd: string | null }>>();

/** 这条会话有几个开始意图还没被确认落账（读端把它算进缺口）。 */
export function unconfirmedTurns(sessionId: string): number {
  return unconfirmed.get(sessionId)?.size ?? 0;
}

function rememberUnconfirmed(input: TurnStartInput): void {
  const { sessionId, taskId, cwd, startedAt } = input;
  const who = { taskId, cwd: cwd ?? null };
  const seen = unconfirmed.get(sessionId);
  if (seen) seen.set(startedAt, who);
  else unconfirmed.set(sessionId, new Map([[startedAt, who]]));
}

/**
 * 把欠着的那几个身份补成真正的开始行。开回合时先试一次：库恢复了就不再依赖内存。
 *
 * **逐个身份各自成败**：一个补成了就由 `persistTurn` 按身份划掉,剩下的留着下次再试。补成功
 * 才移除,所以同一笔账不会两边各算一次（读端 = 库里的行 + 内存未确认）。
 *
 * **迭代的是快照,消的是那一个身份**：下面每一笔都要 await,这期间另一条路完全可以往同一张
 * Map 里加一个新身份（它自己的开始批刚失败）。照「这一轮 flush 完了就把整条会话清掉」做,
 * 那个刚欠上的身份会被连带抹掉——读端从此看不见它,而库里也确实没有那一行（C4）。
 */
async function flushUnconfirmed(sessionId: string): Promise<void> {
  const owed = unconfirmed.get(sessionId);
  if (!owed?.size) return;
  for (const [startedAt, who] of [...owed]) {
    try {
      await persistTurn({ sessionId, taskId: who.taskId, cwd: who.cwd, startedAt });
    } catch (error) {
      // 还是写不进去：这一笔和它后面那些都留在内存里,读端照样看得见缺口。
      console.warn(`[ash] 欠着的 ${owed.size} 笔「漏了一个回合」还没补进库（这一段按未知披露）: ${String(error)}`);
      return;
    }
  }
}

/**
 * 这个身份在库里**确实有记录了**：划掉它那一笔欠账（只划这一个）。
 *
 * 三条路都要调：开始行写成了、收尾时补插了一行完整记录、以及发现库里早就有完整行的那次重放。
 * 漏掉后两条的后果不是少说一句提示,而是**假缺口**：读端 = 库里的行 + 内存未确认,于是一笔已经
 * 恢复的事实继续被算成缺口,整条会话寿命被重新算进候选区间,停工期间别人在同一个目录里做的东西
 * 又被收进来,面板还说「有一次连开始都没留下记录」（第 2 轮审查 F3）。
 */
function confirmTurn(sessionId: string, startedAt: string): void {
  const owed = unconfirmed.get(sessionId);
  if (!owed) return;
  owed.delete(startedAt);
  // 真空了才摘掉整条会话的条目 —— 判据是**当下**这张 Map,不是进来时的那个快照。
  if (!owed.size) unconfirmed.delete(sessionId);
}

/**
 * 新建会话行时的回合字段。
 *
 * **不含计数**：那是 `openTurn` 的事（同一批里加，条件是身份还不存在）。这里只声明
 * 「这条会话没有升级前的未知历史」——`turns_base_approx = 0` 同时兼作迁移的幂等标记，
 * 回填只认 `turns_base_approx IS NULL`（**不是** `turns_base IS NULL`：上一版就已经会写
 * `turns_base: 0` 了,照 base 判会把那一版不可信的计数当成已回填过,理由写在
 * `db/migrate-session-turns.ts` 的回填 SQL 上）。
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
  const startedAt = input.startedAt;
  // 先登记活动身份：登记得比写库早一点没有坏处,反过来晚一点就有——那个窗口里面板会把
  // 正在写的这一轮算成「崩了没收口」。
  markTurnActive({ sessionId: input.sessionId, taskId: input.taskId, startedAt });
  // 上一轮欠着的身份在这里补：那时库正坏着,现在也许好了。放在新回合落账**之前**,这样
  // 「后来成功的一轮」永远不会先把两个数凑相等再让欠账无声无息（第 6 轮审查必须修 2）。
  // 补的恰好是同一个身份时（库恢复后用同一个 `startedAt` 重试）这一步就把它落完了,下面
  // 那个批成了空操作——两条路共用一个幂等批,所以谁先成功都只留一行、只加一次数。
  await flushUnconfirmed(input.sessionId);
  try {
    await persistTurn({ ...input, startedAt });
  } catch (error) {
    await noteTurnLost({ ...input, startedAt }, error);
  }
}

/** 一个回合的身份,加上落这一行所需要的其余事实。 */
type TurnStartInput = {
  sessionId: string;
  taskId: string;
  cwd: string | null | undefined;
  startedAt: string;
};

/**
 * 「开过这一轮」的那一批写入：加计数 + 落回合行。**会抛**（调用方决定是记欠账还是重试）。
 *
 * `endedAt` 为 null = 只知道起点（`openTurn`、补欠账）；给了值 = 收尾那下才发现开始行压根不在,
 * 一次把完整的一行落下去（`recordTurnSpan` 的补插）。**两种都要加计数**：计数和行是同一件事的
 * 两面,只插行不加数等于把一笔已经恢复的事实继续记成缺口（第 2 轮审查 F3）。
 *
 * **一个原子批,顺序不能换**：加数在前,它的 `NOT EXISTS` 问的是插入**之前**的状态；插在前
 * 就永远加不上数了。两条同生共死,所以不存在「行写上了计数没加」这种中间态——那种中间态在
 * 这里全是错的方向（计数偏小正好抵掉真缺口）。
 *
 * **幂等**：同一 (session_id, started_at) 再跑一次既不插行也不加数。补欠账、团队那边同起点
 * 再开一次台、接回重试、收尾补插,走的都是这一个批。
 */
async function writeTurnRow(input: TurnStartInput, endedAt: string | null): Promise<void> {
  const args = {
    row: id(),
    sid: input.sessionId,
    task: input.taskId,
    cwd: input.cwd ?? null,
    at: input.startedAt,
    end: endedAt,
  };
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
              VALUES (:row, :sid, :task, :cwd, :at, :end)`,
      args,
    },
  ]);
}

/**
 * **按身份落账的唯一写入口**：落行 + 加数（同一个原子批）,成了就划掉这个身份的欠账。
 *
 * 开始、收尾补插、幂等重放三条路共用它。分成「开始走这个、补插走那个」的那一版,补插出来的
 * 完整记录既不进计数也不消欠账,于是读端继续按缺口把整条会话寿命算宽（第 2 轮审查 F3）。
 */
async function persistTurn(input: TurnStartInput, endedAt: string | null = null): Promise<void> {
  await writeTurnRow(input, endedAt);
  confirmTurn(input.sessionId, input.startedAt);
}

/**
 * 「这一轮整个没记上」记一笔 —— **按身份记,不是记一个数**。
 *
 * 这是唯一还知道刚才漏了一轮的地方：行和计数同批写,都失败时库里两个数仍然相等,对账一点
 * 痕迹都看不出来（第 5 轮审查必须修 2.3）。而补这一笔的目标还是刚刚写失败的那个库,所以
 * **先把身份记在内存里**（`unconfirmed`）再试持久化,写成了才把内存那笔划掉；没写成就留着,
 * 读端照样把它算进缺口,下一次开回合时再试（第 6 轮审查必须修 2）。
 *
 * 持久化的形式是**补那一行开始记录**,不是往 `sessions.turns_lost` 上加一个数：数字欠账没有
 * 身份,同一个身份后来重试成功也消不掉它,读端只能继续把整条会话寿命算成宽的（第 1 轮审查
 * F2,机制见 `unconfirmed` 的注释）。`turns_lost` 从此只是**旧版留下的只读历史**。
 */
async function noteTurnLost(input: TurnStartInput, cause: unknown): Promise<void> {
  console.warn(`[ash] 回合开始没落盘（这一轮按缺口披露）: ${String(cause)}`);
  // **先记内存,再试库**。顺序反过来就又回到「补写也失败 = 只剩日志」那一步：那一笔账从此
  // 没人记得,下一轮一落账两个数就重新相等（第 6 轮审查必须修 2）。
  rememberUnconfirmed(input);
  await flushUnconfirmed(input.sessionId);
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
 * **三条分支都要按身份确认那笔欠账**（`persistTurn` / `confirmTurn`）：补插和重放同样是「这个
 * 身份在库里确实有记录了」的证据。原先只有「再开一次回合」那条路消账,于是「开始一直失败、库
 * 恢复后直接正常收尾」这条恢复路线留下一笔永远消不掉的假缺口——两行记录都已经完整,读端却还
 * 把整条会话寿命算进候选区间,停工期间别人做的图被收进来,面板还说有一次连开始都没记上
 * （第 2 轮审查 F3）。
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
      // 开始行压根不在：一次把完整的一行落下去,而且走**开始行那个原子批**（行与计数同批,
      // 落成了按身份消账）。只 insert 不记账的那一版,补回来的完整记录在对账上仍然是个缺口。
      await persistTurn(
        { sessionId: input.sessionId, taskId: input.taskId, cwd: input.cwd, startedAt },
        input.endedAt,
      );
      return;
    }
    if (existing.some((row) => row.endedAt)) {
      // 已经收过口：那一行不动（认第一次）—— 但账要认：库里明摆着有一行完整记录,内存里却
      // 还欠着同一个身份的话,读端照样把它算成缺口。
      confirmTurn(input.sessionId, startedAt);
      return;
    }
    await db.update(sessionTurns)
      .set({ endedAt: input.endedAt, cwd: input.cwd ?? null })
      .where(and(
        eq(sessionTurns.sessionId, input.sessionId),
        eq(sessionTurns.startedAt, startedAt),
        isNull(sessionTurns.endedAt),
      ));
    confirmTurn(input.sessionId, startedAt);
  } catch (error) {
    console.warn(`[ash] 回合区间没落盘（产物归属降级为按会话寿命认）: ${String(error)}`);
  }
}
