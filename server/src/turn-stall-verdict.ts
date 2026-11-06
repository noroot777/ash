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

/**
 * 「ash 认定这一轮不成功」的**原因种类** —— 判决自己带着它,结算侧照它挑落位说明。
 *
 * **只有这一份枚举**(第 2 轮续聊自审):上一版在结算侧另定义了一份(`upstream_stall` /
 * `unverified_verdict`),由消费链在中间做一次手工三元映射。那种形状的代价是加第三种原因时
 * 映射点的 `else` 会静默把它当成第一种 —— 两份同义枚举之间的翻译,错了编译器一声不响。现在
 * 结算原因直接引用这个类型,措辞表按它穷举(`Record<StallVerdictKind, string>`),加一种就编译不过。
 */
export type StallVerdictKind = "tripped" | "unverified" | "background_timeout" | "background_lost" | "background_unverified";

export interface StallVerdict {
  /**
   * 这一轮**为什么不能按成功结算**:
   * - `tripped`    看门狗确凿判了它熔断(上游连不上,只有错误事件)。
   * - `unverified` 结局核实不了(接管上一个进程留下的回合时判决日志读不出来)。两者落位一样
   *                (都是 failed、都不许凭确认升级),但对用户说的话必须不一样 —— 拿熔断那段
   *                「整段时间里只收到重试类错误」去描述一次日志故障就是编事实。
   * - `background_timeout` 执行器等名下的后台工作等到时限还没跑完、收了台(不经看门狗,由
   *                执行器自己的 `RunHandle.failure()` 交出来,只在内存里)。
   * - `background_lost` 后台工作还没跑完,进程就自己没了(同样由执行器的 `failure()` 交出来)。
   *                退出码是 0 也不代表它们跑完了。
   * - `background_unverified` 进程退出时后台工作跑没跑完核实不了(接管时读不出之前的输出)。
   *                不能说成「没跑完」,也不能当成跑完了。
   */
  kind: StallVerdictKind;
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

const failures = new Map<string, StallVerdict>();

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
 *
 * `discharge` 是**销账**那一半,跟 `append` 成对:判决的持久那一份也得在结算完成时被勾掉,
 * 否则下次启动它会被重新读回来。为什么销账也必须走这里、而不是让压缩那一侧现算一个判据,
 * 见 `turn-stall-journal.ts` 文件头第四条 —— 简单说:回收条件只有「权威结算确认过」这一个,
 * 而唯一知道这件事的就是 `clearStallFailure` 的调用者。
 */
interface StallVerdictPersister {
  append(verdict: Omit<StallVerdict, "durable" | "kind"> & { sessionId: string; turnStartedAt: string }): boolean;
  discharge(sessionId: string, turnStartedAt: string): void;
}
let persister: StallVerdictPersister | null = null;

export function setStallVerdictPersister(fn: StallVerdictPersister | null): void {
  persister = fn;
}

/**
 * **回收只有一个条件:这一轮结算完了** —— 也就是 `clearStallFailure`,由三条消费链各自在写完
 * 结局之后调。除此之外一个字都不删:没有条数水位,也没有年龄时效。
 *
 * 这一处被打回过三次,三次都是**拿一个代理指标冒充「判决已经没有读者了」**:
 *   · 第 2 轮是条数水位(KEEP=64,超了扔最老的)—— 扔掉的恰恰是还没结算那一条。断网会同时
 *     波及很多台,实测 65 个回合先全部熔断、再统一收到结束回执时,最早那一轮的判决已经被挤掉,
 *     `endTurn` 读不到于是记成 `completed`(1 completed / 64 failed)。
 *   · 第 3 轮换成纯年龄 TTL —— **老不等于孤立**。`ASH_STALL_TRIP_GRACE_MS=0`(产品允许的配置)
 *     关掉了强制回收,于是一个熔断过、`interrupt` 没人理的回合可以继续活着;跨过 6 小时、或者
 *     主机休眠把墙钟往前一跳,下一次熔断的写入就会把那条**仍然有人要读**的判决扫掉,旧回合
 *     后来真收到 turnEnd 时读到 null,照样写 `completed`(第 3 轮审查 F3,已实测)。
 *   · 第 5 轮打回的是「退场 + 年龄」这个组合(F2):`retiredAt` 由状态机在摘牌时填,而**摘牌只
 *     证明那条记录不再代表这个会话,不证明旧消费循环已经读过判决** —— 常驻台换台后旧流收尾
 *     延迟、再跨过时效,`closeLead` 要读的那条判决就被扫掉了。磁盘那一侧的同类实例是按条数
 *     轮转覆盖上一代。
 *
 * 所以这一版不再找「更好的代理指标」,而是**取消代理**:只有读者自己销账才回收。代价是链要是
 * 半路没了(进程被硬杀、异常绕过结算),这一条会留在内存里直到进程结束 —— 上界是「本进程内
 * 熔断过、却始终没走完结算的回合数」,每条几百字节。那本身就是个该查的异常,而且那一轮的回合行
 * 也还开着:下次启动照样从日志里把它读回来。宁可占这点内存,也不要再丢一条判决。
 */
const key = (sessionId: string, turnStartedAt: string): string => `${sessionId}\u0000${turnStartedAt}`;

function remember(verdict: StallVerdict & { sessionId: string; turnStartedAt: string }): void {
  const { sessionId, turnStartedAt, ...rest } = verdict;
  failures.set(key(sessionId, turnStartedAt), rest);
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
      return persister.append({ sessionId, turnStartedAt, reason, since: since ?? at, at }) ? "durable" : "lost-on-restart";
    } catch (error) {
      console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 的熔断判决没能存住:`, error);
      return "lost-on-restart";
    }
  })();
  remember({ sessionId, turnStartedAt, kind: "tripped", reason, at, since: since ?? at, durable: durability === "durable" });
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
  verdict: Omit<StallVerdict, "durable" | "kind">,
): void {
  // 装回来的这一份**按定义是存住的** —— 它正是从进程外读出来的。
  remember({ sessionId, turnStartedAt, kind: "tripped", ...verdict, durable: true });
}

/**
 * 「这一轮的结局**核实不了**」—— 接管一个上一个进程留下来的回合、而判决日志读不出来时走这条
 * (`turn-stall-persist.ts` 的 `unverifiable`)。
 *
 * 为什么记进**同一张表**、而不是在消费链那边另起一个标志位:这张表的含义本来就是「这一轮的
 * 权威结局不是成功」,熔断只是得出这个结论的一种方式。进了这张表,结算侧那一句
 * `stallFailure(...)` 不用改一个字就会把它算进去 —— 而另起一个标志位就得在每条消费链上各抄一
 * 份判据,那正是上一轮用户点出来的「只打补丁」。
 *
 * 跟熔断判决的区别只在**不杀进程**:我们不知道它熔断过没有,所以不去兑现一个不确定的终止义务
 * (调用方因此不走 `resumeTrippedTurn`)。已经有判决的不覆盖 —— 那一份是确凿的。
 *
 * `durable` 记 false 并且不落盘:这一条是从「日志读不出来」现推出来的,下次启动照样推得出来,
 * 存它没有意义。
 *
 * `reason` 存的是**原始起因**(「日志读不出来,因为 EACCES…」),不是对用户说的那句话:同一份
 * 记录要被两处用不同收场念出来(消费那一路进程还活着、对账那一路原进程已经不在),措辞归
 * `turn-stall.ts` 一处出。已经有判决的不覆盖 —— 那一份是确凿的。
 */
export function markUnverifiedTurn(sessionId: string, turnStartedAt: string, why: string): StallVerdict {
  const k = key(sessionId, turnStartedAt);
  const held = failures.get(k);
  if (held) return held;
  const verdict: StallVerdict = { kind: "unverified", reason: why, at: now(), since: now(), durable: false };
  failures.set(k, verdict);
  return verdict;
}

/** 这个回合身份有没有被看门狗判过失败。读不清掉 —— 同一轮有三处要读(span/会话/任务)。 */
export function stallFailure(sessionId: string, turnStartedAt: string | null): StallVerdict | null {
  if (!turnStartedAt) return null;
  return failures.get(key(sessionId, turnStartedAt)) ?? null;
}

/**
 * 这一轮结算完了:销账。
 *
 * **这是唯一的出口** —— 三条链都得调(单飞在 settle 之后、团队在 endTurn/closeLead 逐轮、
 * 讨论在 recordTurnSpan 之后)。漏掉的那一条会一直留着(判据见上),所以漏的后果是占内存,
 * 不是丢判决 —— 这个方向是刻意选的。
 *
 * **内存和盘上这两份一起销**(第 1 轮审查 F1,已实测):落盘那一份原先是由压缩那一侧「现算一个
 * 判据」决定扔不扔的,而它拿到的最好用的指标是回合区间收口了没有 —— 区间收口只证明执行流结束,
 * 不证明任务落位。于是「区间已 failed、任务仍 running」那个窗口里退出的进程,留下的判决下次启动
 * 就被压缩删掉了。现在销账是一条**落盘的记录**,由这个唯一出口追加:它只在结算写完之后被调到,
 * 所以回收条件就是「权威结算确认过」本身,不再是它的影子。
 *
 * 只在**真的销掉了一条**时才去落那一笔:绝大多数回合压根没有判决,无条件追加等于每轮都往日志里
 * 写一行废记录。
 *
 * **谁该直接调这个、谁不该**(第 2 轮审查 F1 之后划清):
 *   • 直接调 —— 回合区间自己就是权威结局的那几条链:duet 的一轮发言、团队那台的一个回合、
 *     以及单飞那条链在 `settleTaskStatus` 返回之后的那一句。它们的失败由各自的区间/返回值承载,
 *     跟任务那一行什么时候落位无关。
 *   • **不要直接调** —— 以「任务落位」为权威结局的恢复链(启动对账)。那一路要走
 *     `setTaskStatus` 的 `settleStallTurns`:销账与落位在同一次写库里完成,所以不存在
 *     「义务已销、落位未写」的缝。对账原先在算出落位之前就调了这里,后面还隔着持续目标善后、
 *     输入事实消费、时间线和基线恢复 —— 那段路上任何一次重启或抛错都会让一个提示过
 *     「已自动终止」的持续目标回来显示「暂停中 + 继续」(第 2 轮审查 F1,已实测)。
 */
export function clearStallFailure(sessionId: string, turnStartedAt: string | null): void {
  if (!turnStartedAt) return;
  if (!failures.delete(key(sessionId, turnStartedAt))) return;
  try {
    persister?.discharge(sessionId, turnStartedAt);
  } catch (error) {
    // 销账失败只意味着下次启动会把这条判决读回来(偏保守那一侧),不该掀翻正在收尾的结算。
    console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 的判决销账失败:`, error);
  }
}

/** 只给回归测试。 */
export function __resetStallFailures(): void {
  failures.clear();
}

/**
 * 启动时把**落盘的那些**装进内存(`turn-stall-persist.ts` 在模块加载时调一次)。
 *
 * 为什么是启动一次性装载、而不是每次读判决时各自去读一遍文件:「读不出来」要不要影响结论,是
 * 个**全局**判断(「这台 ash 还核得了自己的判决吗」);摊到每个读取点各写一次 try/catch,默认
 * 行为必然又退化成「读不到就当没有」—— 那正是第 5 轮审查 F1 指的那条。装载完成之后,内存这张
 * 表就是判决的全集,结算侧照常只读内存,一个字都不用改。
 *
 * 已经在表里的不覆盖:那是本进程刚作出的判决,比盘上那份新。
 */
export function loadStallFailures(
  records: { sessionId: string; turnStartedAt: string; reason: string; at: string; since?: string }[],
): number {
  let loaded = 0;
  for (const record of records) {
    const k = key(record.sessionId, record.turnStartedAt);
    if (failures.has(k)) continue;
    failures.set(k, { kind: "tripped", reason: record.reason, at: record.at, since: record.since ?? record.at, durable: true });
    loaded += 1;
  }
  return loaded;
}

/**
 * 现在还有哪些回合身份背着判决 —— 给**压缩**那一侧用(`compactStallJournal` 的保留名单要跟这张
 * 表口径一致),也给回归测试用。
 */
export function liveStallVerdicts(): { sessionId: string; turnStartedAt: string }[] {
  return [...failures.keys()].map((k) => {
    const [sessionId, turnStartedAt] = k.split("\u0000");
    return { sessionId, turnStartedAt };
  });
}
