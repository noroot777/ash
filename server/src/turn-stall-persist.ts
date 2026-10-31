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
import { appendStallVerdict, readStallVerdict, rotateStallJournal } from "./turn-stall-journal.js";
import { adoptStallFailure, setStallVerdictPersister, stallFailure, type StallVerdict } from "./turn-stall-verdict.js";
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
setStallVerdictPersister((sessionId, turnStartedAt, reason) => {
  // **同步落盘那一笔就是判决的事实**,它成了才算存住 —— 返回值如实带回去(契约见
  // `markStallFailure`:返回即落盘,不许发起一笔异步写然后报成功)。
  const journaled = appendStallVerdict({ at: now(), sessionId, turnStartedAt, reason });
  // 库那一格异步补一份:它可能排在别人的长事务后面,而那恰好是它不能承载事实的原因。
  void projectStallVerdictToDb(sessionId, turnStartedAt, reason);
  return journaled;
});

// 顺手把日志钉在水位上(只改名,不读-改-写 —— 理由见 turn-stall-journal.ts 文件头)。
rotateStallJournal();

/**
 * 把判决补一份到 `session_turns.stall_reason` —— 跟回合的其它事实放在一起,便于 SQL 取证,
 * 也给将来的读者留个口子(今天除了 `restoreStallVerdict` 没有别的读者)。
 *
 * **它不是事实来源**,所以这里既不抛也不重试:排队、失败、零行,都只影响库里那一格,判决本身
 * 已经在日志里了(见文件头)。零行要报一句 —— 那说明这个回合身份在库里压根没有行,是个夹具或
 * 时序问题,不该静默。
 */
export async function projectStallVerdictToDb(
  sessionId: string,
  turnStartedAt: string,
  reason: string,
): Promise<void> {
  try {
    const written = await dbClient.execute({
      sql: "UPDATE session_turns SET stall_reason = :reason WHERE session_id = :sid AND started_at = :at",
      args: { reason, sid: sessionId, at: turnStartedAt },
    });
    if (!written.rowsAffected) {
      console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 在 session_turns 里没有对应行,`
        + "熔断判决没能投影到库(判决本身已落盘,不影响结算)");
    }
  } catch (error) {
    console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 的熔断判决没能投影到库`
      + "(判决本身已落盘,不影响结算):", error);
  }
}

/**
 * 接管一个仍然存活的回合时,把**尚未兑现**的熔断判决装回内存。
 *
 * 判据是「有判决 **且** 这一行还没收口」:收口过的行说明那一轮已经结算完了,判决早该销账,
 * 再装回来等于拿一份旧判决去压一轮新的执行(同一个理由见 turn-stall-verdict.ts 的键为什么
 * 是回合身份而不是 sessionId)。
 *
 * 「有判决」要**两边都看**:日志是事实来源,库那一格是投影,后者可能还排在别人的事务后面。
 * 反过来「还没收口」只能问库 —— 而问不到的时候(读抛错、或者那一行压根不在)**不许把它解释成
 * 收口过**:那又是一次「拿读不到当成没发生」。此刻调用方正要开始消费这个回合身份,它按定义就
 * 是活的;宁可多兑现一次终止义务,也不能把一份真判决丢掉(F1 的教训)。
 *
 * 返回非 null = 这一轮背着一份没兑现的终止义务,调用方**必须接着把它终止掉**:判决已经作出、
 * 用户那边也已经看到「已自动终止本回合并按失败结算」,让它接着跑下去就是第二次失信。
 */
export async function restoreStallVerdict(
  sessionId: string,
  turnStartedAt: string | null | undefined,
): Promise<StallVerdict | null> {
  if (!turnStartedAt) return null;
  // 同进程里已经有了就别再翻盘和库:那一份才是最新的(这条路也走正常起跑,不只走接管)。
  const held = stallFailure(sessionId, turnStartedAt);
  if (held) return held;
  let reason = readStallVerdict(sessionId, turnStartedAt)?.reason ?? "";
  let settled = false;
  try {
    const read = await dbClient.execute({
      sql: "SELECT stall_reason, ended_at FROM session_turns WHERE session_id = :sid AND started_at = :at LIMIT 1",
      args: { sid: sessionId, at: turnStartedAt },
    });
    const row = read.rows.at(0);
    if (!reason && typeof row?.stall_reason === "string") reason = row.stall_reason;
    settled = row?.ended_at != null;
  } catch (error) {
    console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 的回合行没读出来`
      + "(落盘的判决仍然算数):", error);
  }
  if (!reason || settled) return null;
  adoptStallFailure(sessionId, turnStartedAt, reason);
  return stallFailure(sessionId, turnStartedAt);
}
