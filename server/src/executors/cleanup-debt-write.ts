// **把这一刻的结论写回行上 —— 以及写不进去的时候谁来接**。
//
// 为什么单独一个文件:这三个写入动作(销账删行 / 收档盖戳 / 记下进展)原来住在
// cleanup-debt.ts,谁都能直接调,于是「写一下」和「写不进去的那一笔归谁」是两件可以分开做
// 的事 —— 第 13 轮审查实测的就是分开那一下:`touchDebtRow` 返回 false 被忽略,那一轮刚
// 确证过的 exact 成员只活在调用方的局部变量里,函数一返回就没了(读数:行还在、
// `open_members=null`、待投清单 0 笔,下一次清扫按「没有未排除的号」把行真的 DELETE 了,
// 而那个进程仍 alive、心跳文件 49→54 还在涨)。
//
// 所以这一份只导出**一个**出口 `applyDebtDisposition`:三个写入函数是文件私有的,外面
// `import` 不到(不是「约定不要直接调」,是编译期拿不到那半边)。每一条路都在同一个
// switch 里配好了失败兜底,想写一句不兜的都没有地方放。
//
// 不变量,一句话:**「尝试写入」不等于「身份已经接住」**。每一个还没核销的身份,必须在
// 已确认落下的 `open_members` 或者进程内待投清单里至少有一个落脚处。
//
// 还有一档是「写了、可名单没接住」:行上原有的那份 JSON 读不出来时这一列一个字都不许动
// (「读不出来」和「原来就没有」的处置相反),于是这一轮的身份同样要走兜底 ——
// `touchDebtRow` 因此答三档,只有 `written` 算接住了。
//
// 两个坑,都在 `DebtWriteHooks` 的注释里:兜底**必须无锁**(这条链已经持着 `withDebtKey`,
// 再去等同键的落账入口就是自等待),以及收档**成功**也得把名单写上去(它是「不再自动
// 重试」的那一档,这一遍新认下的成员如果不落盘,重启之后谁都不知道它是谁)。
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, dbClient } from "../db/index.js";
import { agentCleanupDebts } from "../db/schema.js";
import { now } from "../util.js";
import type { UnitEvidence } from "../proc.js";
import { cleanupDetail, openOf, type CleanupResult } from "./cleanup-result.js";
import {
  debtDisposition, openMembersOf, serializeOpenMembers,
  type DebtRow, type JudgedDebt,
} from "./cleanup-debt-judge.js";

/** 这一行这一轮落到哪一档。跟 `SweepVerdict` 的同名三档对齐。 */
export type DebtWriteOutcome = "settled" | "closed" | "left";

/**
 * 写入这一层需要宿主提供的两件事。**都由 cleanup-debt.ts 那边实现** —— 内存那两份记录
 * (待投清单、已落库序号)住在那里,这一份只管库。
 */
export type DebtWriteHooks = {
  /** 销账删行成功 ⇒ 这个键的内存记录一起清掉,免得它们无限长。 */
  forget(key: string): void;
  /**
   * **没落下**:这一轮判定里那几个还没核销的身份,此刻唯一的落脚处。
   *
   * 必须是**无锁**的一句(直接往进程内清单里放,排一次补投就够):这条链上游已经持着
   * 这个键的 `withDebtKey`,兜底如果走落账入口 `noteCleanupDebt`,它会去等同一把键锁 ——
   * 那是自等待,整条清扫挂死(第 13 轮审查在修复层级里专门点了这个)。
   */
  hold(debt: DebtRow, judged: JudgedDebt): void;
};

/**
 * **这一行该销、该收档、还是该留着** —— 写库的唯一入口。
 *
 * 判据不在这里(`debtDisposition` 说),这一份只负责「按那个结论落地,并且保证落不下去的
 * 时候身份有人接」。三条路的兜底各有讲究:
 *
 *  · `settle` —— 判空成立才会走到这儿,所以 `openOf(result)` 本来就是空的;兜底那一句是
 *    空操作,留着是为了**不让这条路成为例外**(将来判据变松时它自动跟着兜);
 *  · `close`  —— 收档是「追不下去了、行留着不再自动重试」。**成功也要写名单**:这一遍
 *    `markerResidue` 可能刚认下几个 exact 成员,它们比行上原来记的更具体,不落盘就只剩
 *    在内存里;写失败再走兜底;
 *  · `left`   —— 记进展。第 13 轮实测那一条:写失败必须兜。
 */
export async function applyDebtDisposition(
  debt: DebtRow, judged: JudgedDebt, hooks: DebtWriteHooks,
): Promise<DebtWriteOutcome> {
  const { result, after } = judged;
  switch (debtDisposition(judged)) {
    case "settle": {
      if (await settleDebtRow(debt.unitToken, debt.version)) {
        hooks.forget(debt.unitToken);
        return "settled";
      }
      // 删不掉就还是欠着:「写失败」不许在计数上长成「销账成功」(第 3 轮审查 N9)。
      hooks.hold(debt, judged);
      return "left";
    }
    case "close": {
      if (await closeDebtRow(debt, result)) return "closed";
      hooks.hold(debt, judged);
      return "left";
    }
    default: {
      // **只有 `written` 算接住了**:`open-not-taken`(行上那份坏了、这一列没动)跟写失败
      // 一样,这一轮的身份还没有落脚处。
      if (await touchDebtRow(debt, result, after.verdict) !== "written") hooks.hold(debt, judged);
      return "left";
    }
  }
}

/**
 * 销账删行,**条件是「还是我判的那一版」**(见 schema 的 version)。
 *
 * 返回删没删到。版本对不上 = 判定与下手之间有人往这个键上落了新证据,这一刀就不该下:
 * 行留着,下一轮重新取证。写失败同样返回 false —— 「删失败」不许长成「销账成功」。
 */
async function settleDebtRow(unitToken: string, version: number): Promise<boolean> {
  if (dbClient.closed) return false;
  try {
    const result = await db.delete(agentCleanupDebts).where(and(
      eq(agentCleanupDebts.unitToken, unitToken), eq(agentCleanupDebts.version, version),
    ));
    if (rowsAffectedOf(result) > 0) return true;
    console.warn(`[ash] 销账没删到行(unit=${unitToken}、判的是第 ${version} 版):`
      + "这个键上的证据在判定之后被人动过,这一刀不下,下一轮重新取证");
    return false;
  } catch (error) {
    console.error(`[ash] 销账写失败 unit=${unitToken}:`, error);
    return false;
  }
}

/**
 * 追到这里为止(线索本身没了):盖戳、不再重试,**但不删行** —— 它是最后的可定位身份。
 *
 * 同样带版本条件:盖戳也是「按我判的那一版下的结论」,中间来了新证据就不该盖。
 *
 * **这一句不动名单那一列**,而且这是想清楚之后的决定,不是漏了:走到收档的只有
 * `result.kind === "silent"` 那一档(`debtDisposition`:`remaining` 一律 keep,`unknown`
 * 自带 retriable 也 keep),而一份 silent 的结论**不可能带着未核销的身份** —— 真有排除不掉的
 * 号时 `openResidue` 答的是 `unknown`,那条路根本到不了这里。所以写这一列只有一个效果:
 * 把行上原有的那份名单擦成空。收档又恰恰是「不再自动重试」,擦掉就再没人来补了。
 */
async function closeDebtRow(debt: DebtRow, result: CleanupResult): Promise<boolean> {
  if (dbClient.closed) return false;
  const note = cleanupDetail(result);
  try {
    const written = await db.update(agentCleanupDebts)
      .set({ closedAt: now(), closedNote: note.slice(0, 500), version: debt.version + 1 })
      .where(and(
        eq(agentCleanupDebts.unitToken, debt.unitToken), eq(agentCleanupDebts.version, debt.version),
        isNull(agentCleanupDebts.closedAt),
      ));
    if (rowsAffectedOf(written) > 0) return true;
    console.warn(`[ash] 收档没盖到戳(unit=${debt.unitToken}、判的是第 ${debt.version} 版):`
      + "要么这个键上的证据被人动过、要么已经收过档,这一轮不动它");
    return false;
  } catch (error) {
    console.error(`[ash] 收档写失败 unit=${debt.unitToken}:`, error);
    return false;
  }
}

/**
 * 留着这一笔:把这一刻停在哪、第几次了记上去。返回写没写进去。
 *
 * 也带版本条件 —— 这一句写的是「按我判的那一版,它仍然欠着」。中间来了新证据(版本已经
 * 变过)说明有更新的结论在,这一句就不该把它盖回去。
 */
async function touchDebtRow(
  debt: DebtRow, result: CleanupResult, verdict: UnitEvidence["verdict"],
): Promise<TouchOutcome> {
  if (dbClient.closed || result.kind === "empty") return "failed";
  // 行上那份读不出来 ⇒ 这一列一个字不动(见上面那段),可**这一轮的身份就没落下** ——
  // 所以这一档如实报「名单没接住」,由唯一出口把它们放回待投清单。跟落账那一侧
  // `noteDebtRow` 的 `open-not-taken` 是同一档语义。
  const held = openMembersOf(debt.openMembers).ok;
  try {
    const written = await db.update(agentCleanupDebts).set({
      state: result.kind, detail: cleanupDetail(result).slice(0, 2000), unitVerdict: verdict,
      // **这一份判定逐个核过了那几个号**(`openResidue`),所以它写得动这一列:核掉的去掉、
      // 剩下的留着。落账那一侧相反 —— 它没核过,只并不减。
      //
      // **例外:行上那份读不出来时一个字都不许动它**。`openResidue` 对坏内容答的是「核不动」
      // (一条 silent),它的 `open` 是空的 —— 那是「这一刻没核过」,不是「核完了一个不剩」。
      // 照着空名单写下去,这一列就从「坏的」变成「空的」:前者让判定答 silent、行销不掉,
      // 后者下一轮直接判空销账。于是一次 JSON 损坏被这一句升级成一笔真实的责任丢失
      // (判据同 `noteDebtRow` 那一侧:「读不出来」和「原来就没有」的处置相反)。
      ...held ? { openMembers: serializeOpenMembers(openOf(result)) } : {},
      lastAttemptAt: now(), attempts: sql`${agentCleanupDebts.attempts} + 1`,
      version: debt.version + 1,
    }).where(and(
      eq(agentCleanupDebts.unitToken, debt.unitToken),
      eq(agentCleanupDebts.version, debt.version),
    ));
    if (rowsAffectedOf(written) <= 0) return "failed";
    return held ? "written" : "open-not-taken";
  } catch (error) {
    console.error(`[ash] 这一笔清理责任的进展没记上(unit=${debt.unitToken}):`, error);
    return "failed";
  }
}

/**
 * 记进展这一句的三档。**`open-not-taken` 不是「写失败」**:叙述落了、`attempts` 也加了,
 * 只有名单那一列没动(行上原有的那份读不出来,见 `touchDebtRow`)。它跟 `failed` 的处置相同
 * (身份交回待投清单)、跟它的叙述不同,所以分开说 —— 折成布尔会让日志把「坏名单保护」
 * 印成「库写失败」。
 */
type TouchOutcome = "written" | "open-not-taken" | "failed";

/** 条件写到底改没改到行。drizzle 把底层 client 的 `rowsAffected` 原样带出来。 */
const rowsAffectedOf = (result: unknown): number =>
  Number((result as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0);
