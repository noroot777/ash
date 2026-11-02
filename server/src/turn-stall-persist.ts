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
// 恢复时两边都读:哪一边有判决都算有(判据是「有判决 **且** 这份判决还没销账」—— 销账是判决
// 日志自己的一种记录,由结算之后那一句 `clearStallFailure` 追加,不是任何代理指标)。
//
// 边界:**只有单飞这条链需要恢复**。团队常驻台重启后走的是重开台(`restartImpact` 把 team
// 记进 `resumes`,不接管存活进程),duet 的回合断了就是断了 —— 那两条链上没有「接管一个仍在
// 跑、且已被判熔断的回合」这条路可走,所以不给它们接恢复。落盘本身无害,但也没必要。
import { dbClient } from "./db/index.js";
import {
  appendStallDischarge, appendStallVerdict, compactStallJournal, pendingStallVerdicts, readStallJournal,
  stallIdentityKey,
} from "./turn-stall-journal.js";
import {
  adoptStallFailure, liveStallVerdicts, loadStallFailures, markUnverifiedTurn,
  setStallVerdictPersister, stallFailure, type StallVerdict,
} from "./turn-stall-verdict.js";
import { turnOpenedHere } from "./session-turns.js";
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
setStallVerdictPersister({
  append: (verdict) => {
    // **同步落盘那一笔就是判决的事实**,它成了才算存住 —— 返回值如实带回去(契约见
    // `markStallFailure`:返回即落盘,不许发起一笔异步写然后报成功)。
    const journaled = appendStallVerdict(verdict);
    // 库那一格异步补一份:它可能排在别人的长事务后面,而那恰好是它不能承载事实的原因。
    void projectStallVerdictToDb(verdict.sessionId, verdict.turnStartedAt, verdict.reason, journaled);
    return journaled;
  },
  // 销账也落盘:判决的回收条件是「权威结算确认过」,而唯一知道这件事的就是调 `clearStallFailure`
  // 的那一处。不落这一笔,压缩就只能回头去找一个代理指标 —— 而那正是 F1(见该文件头第四条)。
  discharge: (sessionId, turnStartedAt) => {
    appendStallDischarge(sessionId, turnStartedAt);
  },
});

/**
 * **装载也在模块加载里做**:把盘上**还没销账的**判决一次性读进内存,之后结算侧照常只读内存。
 *
 * 为什么是一次性装载、而不是每个读取点各读一遍文件(上一版的做法,第 5 轮审查 F1):
 * 「读不出来」要不要影响结论,是个**全局**判断 —— 「这台 ash 还核得了自己的判决吗」。摊到每个
 * 读取点各写一次 try/catch,默认行为必然又退化成「读不到就当没有」:实测把日志改成不可读
 * (EACCES)之后接管一个仍然存活的回合,恢复静默失败,上游一恢复这一轮就记成 `completed`、
 * 任务落 `done`,而用户那边「已自动终止本回合」的红字还在。
 *
 * 所以读不出来这件事在这里被**记下来**(`journalUnavailable`),由 `restoreStallVerdict` 带给
 * 调用方:核实不了的时候不许把一轮升级成成功。
 *
 * 已经销账的那些**连内存都不进**:它们的结算早就落完了,再装回来只会让启动对账又念一遍那句
 * 诊断。销账记录本身随后由压缩清掉。
 */
const discharged = new Set<string>();
const journalUnavailable = ((): string | null => {
  const read = readStallJournal();
  for (const record of read.discharges) discharged.add(stallIdentityKey(record.sessionId, record.turnStartedAt));
  // 读出来多少先装多少 —— 坏了一行不该连带丢掉同一份日志里其它完好的判决。
  const loaded = loadStallFailures(pendingStallVerdicts(read));
  if (read.status === "unavailable") {
    console.warn(`[ash] 熔断判决日志有内容读不出来,这台 ash 核不了自己的判决:${read.why}`);
    return read.why;
  }
  if (loaded) console.log(`[ash] 从判决日志装回 ${loaded} 条还没结算的熔断判决`);
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
 * 这一轮的**权威结束原因**:给每一个「回合结算入口」共用的那一句问话。
 *
 * 调用方:单飞消费开头(`single-run.ts`,fresh run 与接管共用那一份)、启动对账
 * (`task-reconcile.ts`,没有可接管的进程、或者接管后消费循环自己挂了)。F3 那条就是因为对账
 * 那一路没问过这一句 —— 持续目标被写成「因服务中断已暂停」,熔断过的那一轮 `outcome` 留空。
 *
 * 判据是「有判决 **且** 这份判决还没销账」。**不许拿回合区间的开闭代替后半句**(第 1 轮审查
 * F1,已实测):区间收口只证明执行流结束了,而单飞那条链落完区间之后还要补录 MCP、保存持续
 * 目标,隔着好几个 await 才轮到任务结算。按「`ended_at` 非空 ⇒ 结算完了」判的那一版,进程在
 * 这段窗口里退出,盘上留下「区间已 failed、任务仍 running」,下次启动压缩把判决删掉、恢复又只
 * 枚举还开着的区间 —— 于是一个已经提示过「已自动终止」的持续目标回来显示「暂停中 + 继续」。
 * 销账记录由 `clearStallFailure` 在结算之后落(见 turn-stall-journal.ts 文件头第四条),已经
 * 销账的判决连内存都不进,所以这里只剩「有没有」这一问。
 *
 * **「这是上一个进程留下来的回合吗」由事实回答,不要调用方申报**:本进程开过那一行开始记录的
 * 就是全新起跑(`turnOpenedHere`,登记在 `openTurn` 里)。只有留下来的那一类才可能背着没兑现的
 * 义务,也只有它需要 `unverifiable` —— 全新起跑的回合身份此刻刚生成,盘上不可能有它的判决,读不
 * 出来也推不出任何结论,再报一句只会把每次日志故障放大成一片假失败。
 *
 * 上一版在这里收一个 `adopted` 布尔,由三个调用点各自申报。那个默认值落在**不安全那一侧**:
 * 新增一条消费路径忘了传,恢复就静默退回「读不到就当没有」—— 而那正是 F1 本身。现在忘不掉了。
 *
 * **返回只有一个轴:判决,或者没有。**「核实不了」在这里当场铸成一份 `kind: "unverified"` 的
 * 判决 —— 它本来就是一种结局(「这一轮的权威结局不是成功」),而不是另一种返回形状。上一版把它
 * 做成并列的第三档,代价当场就出现了:接管失败转对账时(reattach.ts 的 finally),对账第二次
 * 来问,内存里已经有那份 `unverified` 记录,于是它走「有判决」那一支、被用**熔断**的措辞念了
 * 出来 —— 一句假话。一个轴之后,措辞处处按 `verdict.kind` 挑,不存在第二种读法。
 */
export async function restoreStallVerdict(
  sessionId: string,
  turnStartedAt: string | null | undefined,
): Promise<StallVerdict | null> {
  if (!turnStartedAt) return null;
  const carriedOver = !turnOpenedHere(sessionId, turnStartedAt);
  // 内存这张表在模块加载时就从日志装满了,所以这一问同时覆盖「本进程刚判的」和「上一个进程判的」。
  const held = stallFailure(sessionId, turnStartedAt);
  if (held) return held;
  // 销账过的不再是判决:它的结算早就落完了,再拿出来等于拿一份旧判决去压一轮新的执行。
  if (discharged.has(stallIdentityKey(sessionId, turnStartedAt))) return null;
  let unreadable = carriedOver ? journalUnavailable : null;
  // 日志没有,库那一格仍可能有:判决落盘成了而投影排队失败是一种,反过来也是一种。
  let reason = "";
  try {
    const read = await dbClient.execute({
      sql: "SELECT stall_reason FROM session_turns WHERE session_id = :sid AND started_at = :at LIMIT 1",
      args: { sid: sessionId, at: turnStartedAt },
    });
    if (typeof read.rows.at(0)?.stall_reason === "string") reason = read.rows.at(0)!.stall_reason as string;
  } catch (error) {
    console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 的回合行没读出来`
      + "(落盘的判决仍然算数):", error);
    // 问不到也**不许解释成「已经结算完了」**:那又是一次「拿读不到当成没发生」。
    if (carriedOver) unreadable = unreadable ?? `回合行读不出来:${String(error)}`;
  }
  if (reason) {
    // 停滞起点只有日志里记着(库那一格只有原因原文)。退回判决时刻是**诚实的退路**:那一路撤
    // 不掉上一个进程置的持久标记,但也绝不会去撤别人的 —— 判据见 StallVerdict.since。
    const at = now();
    adoptStallFailure(sessionId, turnStartedAt, { reason, at, since: at });
    const adoptedVerdict = stallFailure(sessionId, turnStartedAt);
    if (adoptedVerdict) return adoptedVerdict;
  }
  // 核实不了就在这儿登记:**不许让调用方自己记得铸一份**(同 `carriedOver` 那条,忘了就退回
  // 「读不到就当没有」)。登记进同一张表,结算侧那一句 `stallFailure` 不改一个字就会把它算进去。
  return unreadable ? markUnverifiedTurn(sessionId, turnStartedAt, unreadable) : null;
}

/**
 * 现在还有哪些**没销账的失败义务**,各自落在哪个任务上 —— 给启动对账用。
 *
 * 为什么恢复不能只从 `session_turns` 的开放行出发(第 1 轮审查 F1 的两个实例):
 *   · 区间**提前收口**:执行流结束了、任务还没落位,进程在这中间退出 —— 行在,但不开着;
 *   · 开始行**压根没落下**:`openTurn` 那一批写失败(库坏了/磁盘满),而看门狗照样能熔断并
 *     把判决落盘 —— 连行都没有。
 * 两种都是「义务还在、却查不到人」。所以身份集合由**判决自己**给出,任务由会话行反查:判决的
 * 键是 `(sessionId, turnStartedAt)`,而 `sessions.task_id` 是这个会话归谁的权威记录。
 *
 * 会话行也读不出来的那些只能跳过(任务都认不出来,没有能落位的对象),但要报一句 —— 那说明库
 * 坏得比判决日志更厉害,不该静默。
 */
export async function pendingStallObligations(): Promise<{ sessionId: string; turnStartedAt: string; taskId: string }[]> {
  const live = liveStallVerdicts();
  if (!live.length) return [];
  const owners = new Map<string, string>();
  for (const sessionId of new Set(live.map((v) => v.sessionId))) {
    try {
      const read = await dbClient.execute({
        sql: "SELECT task_id FROM sessions WHERE id = :sid LIMIT 1",
        args: { sid: sessionId },
      });
      const taskId = read.rows.at(0)?.task_id;
      if (typeof taskId === "string") owners.set(sessionId, taskId);
      else console.warn(`[ash] 会话 ${sessionId} 背着一条没结算的熔断判决,但库里没有这条会话行 —— 落位无从下手`);
    } catch (error) {
      console.warn(`[ash] 会话 ${sessionId} 的归属任务没读出来,这条熔断判决这次落不了位:`, error);
    }
  }
  return live.flatMap((v) => {
    const taskId = owners.get(v.sessionId);
    return taskId ? [{ ...v, taskId }] : [];
  });
}

/**
 * 启动期把判决日志压到**只剩还没销账的那些**。
 *
 * 判据整个住在日志那一层(销账是它自己的一种记录),所以这里既不问库、也不认识「回合区间」——
 * 上一版正是在这儿把判据换成了「区间收口了没有」那个代理指标(第 1 轮审查 F1)。
 *
 * **必须排在任何消费链起来之前**(`index.ts`:紧跟在本模块 import 之后、`reattachRunningTasks`
 * 之前)。那一刻本进程还没作出过任何判决,也没有任何人在读,所以这一步不可能跟读者打架;
 * `turn-stall-journal.ts` 的读-改-写也正是靠这个前提加单实例锁才成立的。
 */
export async function compactStallVerdicts(): Promise<{ kept: number; dropped: number } | null> {
  const result = compactStallJournal();
  if (result?.dropped) console.log(`[ash] 判决日志已压缩:留下 ${result.kept} 条未结算,清掉 ${result.dropped} 条已销账记录`);
  return result;
}
