// 熔断判决的**持久那一半**:让「这一轮已经被判失败」跨得过 server 重启。
//
// 为什么要分成多个文件:判据与判决本体(`turn-stall.ts` / `turn-stall-verdict.ts`)是**纯内存**
// 的,一个字节都不落 —— 那让回合级停滞的整套判据能被纯状态机测试钉住(test-turn-stall.ts 不
// 需要库,也就不可能误连生产库,更不会在生产数据目录旁边写出一个日志文件)。落盘与落库要引
// 路径和 db,所以单独住在这里,注册进去,不反过来把它们拖进状态机。
//
// 要解决的事:**detached 执行器活得过 server 重启**(`executors/detached.ts`,ash 的既有能力)。
// 判决原先只活在进程内存里,于是存在这样一条路 —— 看门狗判了熔断、终止请求还没兑现(codex 的
// kill 先发 interrupt,另设 2 秒回收)时 server 退出;重启后接管那个仍然存活的进程,新进程的
// Map 空着;上游恰好恢复并正常答完,这一轮就按 `completed` 结算、任务落 `done`。退出码重建不出
// 这个事实(被我们杀掉的进程多半 exit 0),所以判决本身必须按回合身份存住。
//
// **事实存在日志里,不在库那一格里**(第 1 轮审查 F1,已实测两个独立消费进程)。库的写要过
// `whenIdle`(`db/node-sqlite-client.ts`:写不许借别人的事务),别人开着长事务时这条 UPDATE 排在
// 队里 —— 既没抛错也没落盘。消费者在这段窗口退出,排着的写和内存判决一起消失,下一个进程读到
// `stall_reason=NULL` 就把它解释成「没熔断过」:不再兑现终止义务,上游一恢复又把这一轮写成
// `completed`。所以:
//   · 判决的事实 → `turn-stall-journal.ts`(另一个文件、同步写、写完 fsync,不可能排在事务后面);
//   · 库那一格 → 降级成同一笔顺手补的**第二份记录**(给 SQL 取证和将来的读者;今天它没有别的
//     读者),排队和写失败都不影响结论。
// 恢复时两边都读:哪一边有判决都算有(判据仍是「有判决 **且** 这一行还没收口」)。
//
// 边界:**只有单飞这条链需要恢复**。团队常驻台重启后走的是重开台(`restartImpact` 把 team
// 记进 `resumes`,不接管存活进程),duet 的回合断了就是断了 —— 那两条链上没有「接管一个仍在
// 跑、且已被判熔断的回合」这条路可走,所以不给它们接恢复。落盘本身无害,但也没必要。
import { dbClient } from "./db/index.js";
import { appendStallVerdict, compactStallJournal, readStallJournal, type StallVerdictRecord } from "./turn-stall-journal.js";
import {
  adoptStallFailure, clearStallFailure, liveStallVerdicts, loadStallFailures, setStallVerdictPersister,
  stallFailure, type StallVerdict,
} from "./turn-stall-verdict.js";
import { now } from "./util.js";

// **加载这个模块就等于装上了持久化。**
//
// 为什么是模块初始化、而不是某处显式调一次:显式装配只在它那条启动路径上成立 —— 换个入口
// (回归脚本、将来的 worker/子命令)跑同一条消费链,判决就静默只活在内存里,直到某次重启把它
// 丢掉才看得见。而那正是审查 F3 的形状,不该靠「记得装」来避免。
//
// 也不能让每条消费链自己传一笔:那样新增一条链默认就是「不落盘」,同样没有任何东西提醒作者。
// 「这一轮被判了失败」是判决本身的属性,不是某条链的可选增强。
//
// 判据与判决本体仍然一个字节都不落:它们只认一个可注册的钩子,没注册时(纯状态机测试)什么都
// 不做。盘和库只从**这个**文件进来,而谁 import 它、谁就连着它们 —— `index.ts` 启动时 import
// 一次,保证连一条消费链都还没起来时就已经装上。
setStallVerdictPersister((verdict) => {
  // **同步落盘那一笔就是判决的事实**,它成了才算存住 —— 返回值如实带回去(契约见
  // `markStallFailure`:返回即落盘,不许发起一笔异步写然后报成功)。
  const journaled = appendStallVerdict(verdict);
  // 库那一格异步补一份:它可能排在别人的长事务后面,而那恰好是它不能承载事实的原因。
  void projectStallVerdictToDb(verdict.sessionId, verdict.turnStartedAt, verdict.reason, journaled);
  return journaled;
});

/**
 * **装载也在模块加载里做**:把盘上的判决一次性读进内存,之后结算侧照常只读内存。
 *
 * 为什么是一次性装载、而不是每个读取点各读一遍文件(上一版的做法,第 5 轮审查 F1):
 * 「读不出来」要不要影响结论,是个**全局**判断 —— 「这台 ash 还核得了自己的判决吗」。摊到每个
 * 读取点各写一次 try/catch,默认行为必然又退化成「读不到就当没有」:实测把日志改成不可读
 * (EACCES)之后接管一个仍然存活的回合,恢复静默失败,上游一恢复这一轮就记成 `completed`、
 * 任务落 `done`,而用户那边「已自动终止本回合」的红字还在。
 *
 * 所以读不出来这件事在这里被**记下来**(`journalUnavailable`),由 `restoreStallVerdict` 带给
 * 调用方:核实不了的时候不许把一轮升级成成功。
 */
const journalUnavailable = ((): string | null => {
  const read = readStallJournal();
  // 读出来多少先装多少 —— 坏了一行不该连带丢掉同一份日志里其它完好的判决。
  const loaded = loadStallFailures(read.records);
  if (read.status === "unavailable") {
    console.warn(`[ash] 熔断判决日志有内容读不出来,这台 ash 核不了自己的判决:${read.why}`);
    return read.why;
  }
  // 这一刻还不知道哪些已经结算完了(压缩那一步才问库),所以别说成「未结算」。
  if (loaded) console.log(`[ash] 从判决日志装回 ${loaded} 条熔断判决(已结算的随后压缩时清掉)`);
  return null;
})();

/**
 * 把判决补一份到 `session_turns.stall_reason` —— 跟回合的其它事实放在一起,便于 SQL 取证,
 * 也给将来的读者留个口子(今天除了 `restoreStallVerdict` 没有别的读者)。
 *
 * **它不是事实来源**,所以这里既不抛也不重试:排队、失败、零行,都只影响库里那一格,判决本身
 * 已经在日志里了(见文件头)。零行要报一句 —— 那说明这个回合身份在库里压根没有行,是个夹具或
 * 时序问题,不该静默。
 *
 * `journaled` 得照实传进来(N1):主日志也失败的时候,「判决本身已落盘」这句话是**假的** ——
 * 那正是「这一轮的判决一份副本都没有」那种最该看清的时刻,运维日志不能在那儿说反话。
 */
export async function projectStallVerdictToDb(
  sessionId: string,
  turnStartedAt: string,
  reason: string,
  journaled: boolean,
): Promise<void> {
  const fallback = journaled ? "判决本身已落盘,不影响结算" : "**判决日志也没写成,这一轮的结论只在内存里**";
  try {
    const written = await dbClient.execute({
      sql: "UPDATE session_turns SET stall_reason = :reason WHERE session_id = :sid AND started_at = :at",
      args: { reason, sid: sessionId, at: turnStartedAt },
    });
    if (!written.rowsAffected) {
      console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 在 session_turns 里没有对应行,`
        + `熔断判决没能投影到库(${fallback})`);
    }
  } catch (error) {
    console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 的熔断判决没能投影到库`
      + `(${fallback}):`, error);
  }
}

/**
 * 读一次判决的三种结果 —— **「核实不了」必须跟「没有」分开**(第 5 轮审查 F1 的根)。
 *
 * - `verdict`      这一轮背着一份没兑现的终止义务。
 * - `unverifiable` 判决核实不了(日志读不出来、回合行也读不到)。**不是**「没有判决」:这一轮
 *                  不许按成功结算,但也不该被当成熔断过那样杀掉 —— 我们不知道它熔断过没有。
 * - `null`         确实没有。
 */
export type StallRestore =
  | { kind: "verdict"; verdict: StallVerdict }
  | { kind: "unverifiable"; why: string }
  | null;

/**
 * 这一轮的**权威结束原因**:给每一个「回合结算入口」共用的那一句问话。
 *
 * 三个调用方:接管一个仍然存活的回合(`single-run.ts`)、启动对账(`task-reconcile.ts`,没有可
 * 接管的进程、或者接管后消费循环自己挂了)。F3 那条就是因为对账那一路没问过这一句 —— 持续目标
 * 被写成「因服务中断已暂停」,熔断过的那一轮 `outcome` 留空。
 *
 * 判据是「有判决 **且** 这一行还没收口」:收口过的行说明那一轮已经结算完了,判决早该销账,
 * 再拿出来等于拿一份旧判决去压一轮新的执行(同一个理由见 turn-stall-verdict.ts 的键为什么
 * 是回合身份而不是 sessionId)。
 *
 * `adopted` = 「这个回合身份是上一个进程留下来的」。只有这一类才可能背着没兑现的义务,也只有
 * 它需要 `unverifiable`:全新起跑的回合身份此刻刚生成,盘上不可能有它的判决,读不出来也推不出
 * 任何结论,再报一句只会把每次日志故障放大成一片假失败。
 */
export async function restoreStallVerdict(
  sessionId: string,
  turnStartedAt: string | null | undefined,
  adopted: boolean,
): Promise<StallRestore> {
  if (!turnStartedAt) return null;
  // 内存这张表在模块加载时就从日志装满了,所以这一问同时覆盖「本进程刚判的」和「上一个进程判的」。
  const held = stallFailure(sessionId, turnStartedAt);
  if (held) return { kind: "verdict", verdict: held };
  let unreadable = adopted ? journalUnavailable : null;
  // 日志没有,库那一格仍可能有:判决落盘成了而投影排队失败是一种,反过来也是一种。
  let reason = "";
  let settled = false;
  try {
    const read = await dbClient.execute({
      sql: "SELECT stall_reason, ended_at FROM session_turns WHERE session_id = :sid AND started_at = :at LIMIT 1",
      args: { sid: sessionId, at: turnStartedAt },
    });
    const row = read.rows.at(0);
    if (typeof row?.stall_reason === "string") reason = row.stall_reason;
    settled = row?.ended_at != null;
  } catch (error) {
    console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 的回合行没读出来`
      + "(落盘的判决仍然算数):", error);
    // 「还没收口」只能问库,而问不到的时候**不许解释成收口过**:那又是一次「拿读不到当成没
    // 发生」。此刻调用方正要开始消费这个回合身份,它按定义就是活的。
    if (adopted) unreadable = unreadable ?? `回合行读不出来:${String(error)}`;
  }
  if (settled) return null;
  if (reason) {
    // 停滞起点只有日志里记着(库那一格只有原因原文)。退回判决时刻是**诚实的退路**:那一路撤
    // 不掉上一个进程置的持久标记,但也绝不会去撤别人的 —— 判据见 StallVerdict.since。
    const at = now();
    adoptStallFailure(sessionId, turnStartedAt, { reason, at, since: at });
    const adoptedVerdict = stallFailure(sessionId, turnStartedAt);
    if (adoptedVerdict) return { kind: "verdict", verdict: adoptedVerdict };
  }
  return unreadable ? { kind: "unverifiable", why: unreadable } : null;
}

/**
 * 启动期把日志压到**只剩还有读者的那些**,顺手把内存里那些已经确凿结算完的也销掉。
 *
 * 「还有读者」的唯一可靠证据是**库里那一行确凿地收口了**(`ended_at` 非空)。行不在也当「还有
 * 读者」留着:回合行写失败的那种情况下,消费链手里仍然握着这个回合身份,判决照样有人要读。
 *
 * 为什么是「条数」和「年龄」都不行,见 turn-stall-verdict.ts 的回收那段 —— 同一个类问题在内存
 * 和磁盘两侧各被打回过一次。
 *
 * **必须排在任何消费链起来之前**(`index.ts`:紧跟在本模块 import 之后、`reattachRunningTasks`
 * 之前)。那一刻本进程还没作出过任何判决,也没有任何人在读,所以这一步不可能跟读者打架;
 * `turn-stall-journal.ts` 的读-改-写也正是靠这个前提加单实例锁才成立的。
 */
export async function compactStallVerdicts(): Promise<{ kept: number; dropped: number } | null> {
  const read = readStallJournal();
  if (read.status === "unavailable") return null; // 读不全就不压缩(日志那边已经警告过)
  const identities = new Map<string, StallVerdictRecord>();
  for (const record of read.records) identities.set(`${record.sessionId}\u0000${record.turnStartedAt}`, record);
  // 内存里可能还有本进程刚装载进来的那些(id 口径跟日志一致),一起纳入判定。
  for (const live of liveStallVerdicts()) {
    const k = `${live.sessionId}\u0000${live.turnStartedAt}`;
    if (!identities.has(k)) identities.set(k, { at: "", sessionId: live.sessionId, turnStartedAt: live.turnStartedAt, reason: "" });
  }
  if (!identities.size) return { kept: 0, dropped: 0 };
  const closed = new Set<string>();
  for (const sessionId of new Set([...identities.values()].map((r) => r.sessionId))) {
    try {
      const rows = await dbClient.execute({
        sql: "SELECT started_at FROM session_turns WHERE session_id = :sid AND ended_at IS NOT NULL",
        args: { sid: sessionId },
      });
      for (const row of rows.rows) {
        if (typeof row.started_at === "string") closed.add(`${sessionId}\u0000${row.started_at}`);
      }
    } catch (error) {
      // 问不出来就当「还有读者」:宁可日志大一点,也不能把一条核实不了的判决抹掉。
      console.warn(`[ash] 会话 ${sessionId} 的回合收口情况没读出来,这一批判决一条不压:`, error);
      return null;
    }
  }
  for (const k of closed) {
    const record = identities.get(k);
    if (record) clearStallFailure(record.sessionId, record.turnStartedAt);
  }
  const result = compactStallJournal((record) => !closed.has(`${record.sessionId}\u0000${record.turnStartedAt}`));
  if (result?.dropped) console.log(`[ash] 判决日志已压缩:留下 ${result.kept} 条未结算,清掉 ${result.dropped} 条已结算`);
  return result;
}
