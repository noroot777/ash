// 看门狗熔断掉的那一轮:**「这一轮是失败的」这个结论本身**,按回合身份存着。
//
// 跟 `turn-failure.ts` 不是一件事(名字别看混):那边讲的是**一个回合连起跑都没成**时用户
// 那边能看见什么;这里讲的是**一个已经在跑的回合被我们判了死刑**,而这个判决要怎么传到结算。
//
// 为什么要单独存一份,而不是让各条链各自记一个布尔(第 1 轮审查第 2 条,已实测):熔断是
// 「我们主动杀掉一个还在跑的回合」,而**被杀的进程报不出非零退出码** ——
//   · claude 走信号退出时 `claude-stream.ts` 写的是 `code ?? 0`,信号退出 `code` 是 null,
//     于是退出码 **0**;
//   · codex 的 `kill()` 会置 `stopRequested`,它自己那份失败诊断跟着被咽掉;
//   · 团队常驻台更彻底:`endTurn` 走的是执行器自己报的 turnEnd,那条路**无条件**记
//     `outcome:"completed"`。
// 三条路叠起来的后果是同一个:时间线上红着写「已终止本回合并按失败结算」,而回合区间记
// `completed`、任务落 `done` —— 看门狗说过的话一句都没兑现。所以结论不能靠退出码反推,得由
// **下结论的那一方**写下来,再由 span / 会话 / 任务结算三处各自读。
//
// 键是 `(sessionId, turnStartedAt)` 这个**回合身份**而不是 sessionId:常驻台一条会话跑很多
// 轮,只有熔断掉的那一轮该算失败,下一轮正常答完仍然是成功(同一个理由见 turn-stall.ts 的
// 持有者+回合双判,以及 session-waiting.ts 的换台闸)。
//
// 本模块只管**内存**那一半,一个字都不碰库 —— 这让整套判据能被纯状态机钉住
// (test-turn-stall.ts 不需要库,也就不可能误连生产库)。
//
// 但判决**不能只有内存这一半**(审查 F3,已实测两个独立消费进程):这里原先写着「跨 server
// 重启那一种本来就走另一条路:重启后接回 → 进程没了 → 按真实非零退出判失败」,那个前提是
// 错的 —— **detached 的 agent 活得过 server 重启**(executors/detached.ts,ash 的既有能力)。
// 进程没死,它会被接管;新进程的这个 Map 是空的,上游一恢复并正常答完,这一轮就按
// `completed` 结算、任务落 `done`,而用户早已看到「已自动终止本回合并按失败结算」。
// 持久那一半在 `turn-stall-persist.ts`(落盘 + 接管时装回来),注册进来,不反过来把 db 拖进
// 状态机。
//
// **而「持久」的判据是落盘,不是「调过写库函数」**(第 1 轮审查 F1,已实测两个独立消费进程):
// 库里那一格的写要排在别人的长事务后面(`db/node-sqlite-client.ts` 的 `whenIdle`),排着的时候
// 既没抛错也没落盘;消费者在这段窗口退出,那笔写和这张 Map 一起消失,下一个进程读到
// `stall_reason=NULL` 就把它解释成「没熔断过」。所以判决的事实落在一个不可能排在别人事务后面
// 的地方(`turn-stall-journal.ts`:另一个文件、同步写、写完 fsync),库那一格降级成给界面和接口
// 读的投影。这里只认一件事:**注册进来的那一半必须在返回之前把事实存住,并如实报它存住了没有**。
import { now } from "./util.js";

export interface StallVerdict {
  /** 判失败的原因原文(熔断诊断那一段),给结算侧需要时转述。 */
  reason: string;
  at: string;
  /**
   * **这一次停滞的起点**,也就是持久标记的 CAS 身份(`session-stall-flag.ts`:只有置上它的
   * 那一次停滞撤得动)。
   *
   * 为什么它属于判决、而不是让接管那一路现编一个:接管一个已被判熔断的回合时要把这份没兑现
   * 完的终止义务放回状态机,而那条记录的 `since` 决定它结束时撤得掉哪一个标记。现编一个
   * 「接管这一刻」出来,撤的就是个不存在的身份 —— 那是拿我们自己不知道的值冒充事实。
   */
  since: string;
  /**
   * 这份判决**存住了没有**(`StallDurability` 的 `durable` 那一档)。
   *
   * 挂在判决上而不是让下结论那一处拿个局部变量传着走:三处读判决的地方(终止、恢复、结算)
   * 都有资格问这一句,而「问得到」是它们能不能如实对用户说话的前提。
   */
  durable: boolean;
}

interface Entry extends StallVerdict {
  /**
   * 这个回合身份**退场**的时刻(`null` = 还在跑)。
   *
   * 由 `turn-stall.ts` 在那条停滞记录离开状态机时填(真实收口、摘牌、或被新一轮顶掉)——
   * 也就是「不会再有人往这一轮里写东西了」那一刻。回收只看它,见 ORPHAN_MS。
   */
  retiredAt: string | null;
}

const failures = new Map<string, Entry>();

/**
 * 一份判决**现在存住了没有** —— 这是 `markStallFailure` 的返回值,trip 的措辞按它定。
 *
 * - `durable`         已经落盘,这一轮的结论跨得过 server 重启。
 * - `lost-on-restart` 落盘失败(磁盘满/权限)。那一轮**仍然该停**,内存里的判决也钉好了,
 *                     丢掉的只是「跨重启还认得它」—— 所以不拦终止,但必须在用户看到的诊断里
 *                     如实说一句,不许静默。
 * - `not-persisted`   压根没注册持久化:纯状态机测试的常态。生产里不会是这一档(模块加载即
 *                     注册,`index.ts` 在任何消费链起来之前就 import 过),所以它**不**算
 *                     「落盘失败」,也不该让每份单元测试期望里都挂一句假警报。
 */
export type StallDurability = "durable" | "lost-on-restart" | "not-persisted";

/**
 * 判决的**持久那一半**,模块加载时注册一次(`turn-stall-persist.ts`)。
 *
 * 为什么是注册式、而不是让每条消费链自己传一笔:那样新增一条链时默认就是「不落盘」,而且
 * **没有任何东西会提醒作者** —— 判决静默只活在内存里,直到某次重启把它丢掉才看得见。
 * 「这一轮被判了失败」是判决本身的属性,不是某条链的可选增强,所以归这个模块自己管。
 *
 * 仍然做成可注册的,是为了让本模块与 `turn-stall.ts` 保持**纯内存、不碰库也不碰盘** —— 那让
 * 整套判据能被纯状态机钉住(test-turn-stall.ts 不需要库,也就不可能误连生产库,更不会在生产
 * 数据目录旁边写出一个日志文件)。没注册时这里是 null,一个字节都不落。
 *
 * **返回值是契约**:`true` 只能在事实确实存住之后给。返回即落盘 —— 发起一笔异步写然后报
 * `true`,就是 F1 那个根上错的判据本身。
 */
type StallVerdictPersister = (
  verdict: Omit<StallVerdict, "durable"> & { sessionId: string; turnStartedAt: string },
) => boolean;
let persister: StallVerdictPersister | null = null;

export function setStallVerdictPersister(fn: StallVerdictPersister | null): void {
  persister = fn;
}

/**
 * 回收**只认生命周期**:一条判决要么还归某个在跑的回合,要么已经退场够久了。
 *
 * 这一处被打回过两次,两次都是「拿淘汰策略代替生命周期」:
 *   · 第 2 轮是条数水位(KEEP=64,超了扔最老的)—— 扔掉的恰恰是还没结算那一条。断网会同时
 *     波及很多台,实测 65 个回合先全部熔断、再统一收到结束回执时,最早那一轮的判决已经被挤掉,
 *     `endTurn` 读不到于是记成 `completed`(1 completed / 64 failed)。
 *   · 第 3 轮是纯年龄 TTL —— **老不等于孤立**。`ASH_STALL_TRIP_GRACE_MS=0`(产品允许的配置)
 *     关掉了强制回收,于是一个熔断过、`interrupt` 没人理的回合可以继续活着;跨过 6 小时、或者
 *     主机休眠把墙钟往前一跳,下一次熔断的写入就会把那条**仍然有人要读**的判决扫掉,旧回合
 *     后来真收到 turnEnd 时读到 null,照样写 `completed`(第 3 轮审查 F3,已实测)。
 *
 * 所以年龄只能用在**已经退场**的那些上:`retiredAt` 由状态机在那条停滞记录离开 `stalls` 时
 * 填(真实收口 / 摘牌 / 被新一轮顶掉),填上就意味着「这一轮不会再产生事件了」,余下只剩那条
 * 消费链自己来销账(`clearStallFailure`)。链要是半路没了(进程被硬杀、异常绕过结算),这条
 * 记录就等 ORPHAN_MS 之后被顺手清掉 —— 这才是「明确孤立」。
 *
 * **还在跑的一条都不碰**,所以条数上界就是「同时卡着的回合数」,一条几百字节;跨 server 重启
 * 这张表本来是空的(进程内状态),所以也不存在越攒越多那回事。
 */
const ORPHAN_MS = 6 * 60 * 60_000;

const key = (sessionId: string, turnStartedAt: string): string => `${sessionId}\u0000${turnStartedAt}`;

/**
 * 顺手清掉**已退场且已经够老**的那些(写入时做,不另起计时器:这张表只在熔断时被写,频率极低)。
 *
 * `retiredAt === null` = 这一轮还在跑,**一个字都不许碰** —— 判据见 ORPHAN_MS 那段。
 */
function sweepOrphans(cutoffMs: number): void {
  for (const [k, verdict] of failures) {
    if (verdict.retiredAt === null) continue;
    const at = Date.parse(verdict.retiredAt);
    // 时间戳读不出来就留着:宁可多留一条孤立记录,也不能因为解析失败丢掉一条活判决。
    if (Number.isFinite(at) && at <= cutoffMs) failures.delete(k);
  }
}

function remember(verdict: StallVerdict & { sessionId: string; turnStartedAt: string }): void {
  const { sessionId, turnStartedAt, ...rest } = verdict;
  failures.set(key(sessionId, turnStartedAt), { ...rest, retiredAt: null });
  const cutoff = Date.parse(rest.at) - ORPHAN_MS;
  if (Number.isFinite(cutoff)) sweepOrphans(cutoff);
}

/**
 * 看门狗熔断:把「这一轮失败」钉在这个回合身份上,并且**当场把它存住**。
 *
 * 返回的是落盘结果(见 `StallDurability`)。调用方(`turn-stall.ts` 的 trip)拿到它之后才去做
 * 不可撤销的那两件事 —— 写时间线诊断、发终止请求 —— 顺序是刻意的:那两件事一旦做出去就收不
 * 回来,而「用户看到已终止、重启后却显示已完成」正是 F1 那条路。
 *
 * **不让持久那一半抛**:落盘失败不该拦住终止 —— 那一轮确实该停。但也绝不静默:返回
 * `lost-on-restart`,由 trip 的措辞如实说出来。
 */
export function markStallFailure(
  sessionId: string,
  turnStartedAt: string,
  reason: string,
  /** 这一次停滞的起点。不给就按判决时刻算(纯状态机测试用不到它)。 */
  since?: string,
): StallDurability {
  const at = now();
  const durability = ((): StallDurability => {
    if (!persister) return "not-persisted";
    try {
      return persister({ sessionId, turnStartedAt, reason, since: since ?? at, at }) ? "durable" : "lost-on-restart";
    } catch (error) {
      console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 的熔断判决没能存住:`, error);
      return "lost-on-restart";
    }
  })();
  remember({ sessionId, turnStartedAt, reason, at, since: since ?? at, durable: durability === "durable" });
  return durability;
}

/**
 * 接管一个仍然存活的回合时,把**已经落盘过**的判决装回内存(`turn-stall-persist.ts` 的
 * `restoreStallVerdict` 调)。
 *
 * 跟 `markStallFailure` 分开,是因为这条路**不许再走一遍持久化**:事实早就在日志里,再追加
 * 一条只会让同一份判决在账本上重复,接管几次就重复几次。
 */
export function adoptStallFailure(
  sessionId: string,
  turnStartedAt: string,
  verdict: Omit<StallVerdict, "durable">,
): void {
  // 装回来的这一份**按定义是存住的** —— 它正是从进程外读出来的。
  remember({ sessionId, turnStartedAt, ...verdict, durable: true });
}

/**
 * 这个回合身份**退场了**:状态机里那条停滞记录离开了(真实收口 / 摘牌 / 被新一轮顶掉)。
 *
 * 只打时间戳,**不删**:退场之后紧接着就是那条消费链读判决、结算、再 `clearStallFailure`,
 * 这中间一个字都不能少。链要是半路没了,这条记录从此刻开始算 ORPHAN_MS 的孤立时效。
 * 没有对应判决(这一轮压根没熔断)时是空转。
 */
export function retireStallFailure(sessionId: string, turnStartedAt: string): void {
  const entry = failures.get(key(sessionId, turnStartedAt));
  if (!entry || entry.retiredAt !== null) return;
  entry.retiredAt = now();
}

/** 这个回合身份有没有被看门狗判过失败。读不清掉 —— 同一轮有三处要读(span/会话/任务)。 */
export function stallFailure(sessionId: string, turnStartedAt: string | null): StallVerdict | null {
  if (!turnStartedAt) return null;
  return failures.get(key(sessionId, turnStartedAt)) ?? null;
}

/**
 * 这一轮结算完了:销账。
 *
 * **这是唯一的正常出口** —— 三条链都得调(单飞在 settle 之后、团队在 endTurn/closeLead 逐轮、
 * 讨论在 recordTurnSpan 之后)。漏掉的那一条要等 ORPHAN_MS 才消失,而在那之前它一直占着内存,
 * 所以漏不是「没后果」,只是后果被兜住了。
 */
export function clearStallFailure(sessionId: string, turnStartedAt: string | null): void {
  if (!turnStartedAt) return;
  failures.delete(key(sessionId, turnStartedAt));
}

/** 只给回归测试。 */
export function __resetStallFailures(): void {
  failures.clear();
}

/**
 * 只给回归测试:把现存判决的时间戳往前挪 `ms`,用来跑孤立回收那一路(不然得等 6 小时)。
 * 回收发生在下一次 `markStallFailure` 里,所以测试得在挪完之后再写一条。
 */
export function __ageStallFailures(ms: number): void {
  for (const [k, verdict] of failures) {
    const shift = (iso: string | null): string | null =>
      (iso === null ? null : new Date(Date.parse(iso) - ms).toISOString());
    failures.set(k, { ...verdict, at: shift(verdict.at)!, retiredAt: shift(verdict.retiredAt) });
  }
}
