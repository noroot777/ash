// **「这一次运行的后代没收干净」—— 一条摆在库里的事实。**
//
// 为什么非得落盘,见 `db/schema-sessions.ts` 里 `agent_cleanup_debts` 的注释。这一份是那张
// 表的读写层加上**重试**:开机扫一遍、用户也能自己点一次。
//
// 一句话的规矩:**只有确证清空才销账** —— 「根」和「后代」两问都得有正面答案。那一问怎么
// 问、什么才算答出来,全在 `cleanup-debt-judge.ts`(判据)+ `cleanup-result.ts`(代数)两份里;
// 这一份只拿它的结论办三件事:销账(删行)、收档(盖戳留行)、留着(记下这一刻停在哪)。
// 「这个平台答不了」「这一行没记启动时刻」一律不是「收干净了」(第 4 轮审查 F1)。
//
// 这一份同时是**责任交接层**,两头都在这里收口(第 3 轮审查 F2):
//  · 清空证明对应**哪一版证据**,销账只针对那一版 —— 读、判、写在同一把键锁里,行上带
//    `version` 当交叉校验,对不上就一行不动(见 `settleIfStillEmpty`/`pushDebtLocked`);
//  · **落库失败不等于责任消失** —— 写不进去的那一笔留在内存里接着扛(`pendingNotes`),
//    每次清扫先补投一遍,并且在清扫结果里如实报出「还有几笔只在内存里」。
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, dbClient } from "../db/index.js";
import { agentCleanupDebts } from "../db/schema.js";
import { now } from "../util.js";
import { processUnitEvidence, type UnitEvidence } from "../proc.js";
import { signalMembers } from "./escapees.js";
import { cleanupDetail, openOf, type CleanupOpen, type CleanupResult } from "./cleanup-result.js";
// **判据在隔壁那一份**:这里只管账本的读写,「这一刻算不算空、该销还是该收档」问它。
import {
  debtDisposition, debtKey, isMarked, judgeDebtRow, openMembersOf, serializeOpenMembers,
  type CleanupDebtClues, type DebtRow,
} from "./cleanup-debt-judge.js";

/** 行上已经点过名的那几个号(读不出来、或者这一行还不存在 ⇒ 空)。 */
async function readOpenMembers(key: string): Promise<readonly CleanupOpen[]> {
  const read = await readDebtRow(key);
  return read.ok && read.row ? openMembersOf(read.row.openMembers) : [];
}

/** 两份名单按号并起来(行上那份在前:它是更早点的名,`why` 保留最初那一句)。 */
function mergeOpenMembers(
  held: readonly CleanupOpen[], fresh: readonly CleanupOpen[],
): CleanupOpen[] {
  const byPid = new Map<number, CleanupOpen>();
  for (const one of [...held, ...fresh]) if (!byPid.has(one.pid)) byPid.set(one.pid, one);
  return [...byPid.values()];
}

// ── 同一个键上的读-判-写必须串起来 ──────────────────────────────────────────────
//
// 销账是**按这一刻的证据**删一整行,所以它只有在「我读到的那份证据到我下手为止没被人动过」
// 时才成立。两条并发路径会破掉这个前提:两次清扫同时推同一笔,或者一次清扫正在取证、
// 清理路径同时又往同一个键上 `noteCleanupDebt` 写进了新的路径线索 —— 前者的快照里没有
// 那条新线索,却照样按同一个键把行删了(第 2 轮审查 F1 的「账目版本」那一条)。
//
// 全仓对这张表的读写都在这一个模块里、同一个进程里,所以按键排队就够了,不必上 DB 级
// 的版本列。代价是同键的操作要等前一个做完(清扫那一档含 2 秒补刀窗口),而那恰好是想要
// 的语义:宁可等,不要把别人刚落下的证据当不存在。
const debtKeyTails = new Map<string, Promise<unknown>>();

function withDebtKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = debtKeyTails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);                  // 前一个失败也要接着跑
  const tail = run.catch(() => { /* 队列只管顺序,不管成败 */ });
  debtKeyTails.set(key, tail);
  void tail.then(() => { if (debtKeyTails.get(key) === tail) debtKeyTails.delete(key); });
  return run;
}

export type { CleanupDebtClues, DebtRow } from "./cleanup-debt-judge.js";
export { markerResidue } from "./cleanup-debt-judge.js";

export type CleanupDebtInput = CleanupDebtClues & {
  taskId?: string;
  sessionId?: string;
  rootPid?: number | null;
  rootStartedAt?: string | null;
  /**
   * `remaining` = 确证还有成员活着;`unknown` = 这一轮问不清楚;
   * `silent` = 这一问**没有可用的证据来源**(见 cleanup-result.ts 顶部的四档)。
   */
  state: "remaining" | "unknown" | "silent";
  detail: string;
  unitVerdict: UnitEvidence["verdict"];
  /**
   * 这一轮点名了、却排除不掉的号(见 `cleanup-result.ts` 的 `CleanupOpen`)。
   *
   * **落库时跟行上已有的那份并起来,从不覆盖掉**:同一条判据,「这一次知道得更多」才配写
   * 进去 —— 一个号从这一轮的名单里消失有两种原因,「它退了」和「它的父子边这一刻变得读得
   * 出来了(被重父到 1 号名下)」,后者一点也没证明它不属于这次运行。真正的核销只走
   * `openResidue` 那一问(第 8 轮审查 F1-A)。
   */
  open?: readonly CleanupOpen[];
};

/**
 * 记一笔:这一次运行**还不能证明收干净了**。
 *
 * 排在清理路径的每一条「没问清楚 / 还有残留」分支上。返回的三档要分开说,别再折成布尔
 * (第 2 轮审查 F1 末条):`untrackable` = 这一次运行连一条可追的线索都没有(失败桩、没有
 * 真实进程的合成句柄),记下来也没人处置得了;`failed` = **有线索、但库没写进去**,那是
 * 一次真正的责任丢失,日志必须这么说。上一版两档都印成「没有可追的线索」,把写库故障
 * 说成了「本来就没什么可追的」。
 *
 * 同一次运行反复欠账只占一行(记号是主键):覆盖的是「最近一次停在哪一档」,`attempts`
 * 由清扫侧累加。**收档不是终局** —— 又有新证据落到同一个记号上,说明「追不下去」这个
 * 判断过期了,把戳撤掉重新开追(判据同哨兵债表)。
 */
export async function noteCleanupDebt(
  input: CleanupDebtInput,
): Promise<"noted" | "untrackable" | "failed"> {
  const key = debtKey(input);
  if (!key) return "untrackable";
  // **每一笔落账带一个序号**(第 4 轮审查 N3):待投清单上那几笔是「还没落库的旧结论」,
  // 而同一个键上随后可能已经有更新的结论落进去了。没有序号时两者长得一样,补投会把新线索
  // (比如换过的输出文件路径)盖回旧的那一版。
  const seq = ++noteSeq;
  if (dbClient.closed) {                          // 有线索、只是这一刻没处写
    keepPendingNote(key, input, seq);
    return "failed";
  }
  const verdict = await withDebtKey(key, () => writeNote(key, input, seq));
  if (verdict === "failed") keepPendingNote(key, input, seq);
  return verdict;
}

// ── 写不进去的那一笔,内存里接着扛 ────────────────────────────────────────────────
//
// 「还没收干净」这件事的责任交接只有落库一条路跨得过重启,所以**落库失败是一次真正的责任
// 丢失**:上一版如实打了日志就结束了,那一笔既不在库里也不在任何人手上,后面哪一次清扫都
// 不会再想起它(第 3 轮审查 F2)。库写失败多半是瞬时的(锁、磁盘满、关库竞态),所以这里
// 留一份进程内的待投清单:定时补投,每次清扫开头也补投一遍,并且把「还剩几笔只在内存里」
// 写进清扫结果 —— 它跨不过重启这一点藏不住,但至少在本进程里不再是丢了。
const pendingNotes = new Map<string, PendingNote>();
type PendingNote = { input: CleanupDebtInput; seq: number };
/** 落账的单调序号:同一个键上「哪一版结论更新」只认它(见 `noteCleanupDebt`)。 */
let noteSeq = 0;
/** 这个键上**已经落库的最新一版**是第几号 —— 比它旧的补投一律作废。 */
const landedSeq = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 30_000;

function keepPendingNote(key: string, input: CleanupDebtInput, seq: number): void {
  const held = pendingNotes.get(key);
  if (held && held.seq > seq) return;             // 清单上那笔比这一笔新,别往回盖
  pendingNotes.set(key, { input, seq });          // 同一个键只留最新那一版结论
  scheduleFlush();
}

/**
 * 真正写库的那一层,**带「这一版还作不作数」的闸**(第 4 轮审查 N3)。
 *
 * 补投是「把一笔旧结论再投一次」,所以它必须先问一句:这个键上有没有更新的一版已经落库了?
 * 有 ⇒ 这一笔早就过期,直接当落完处理(把清单上那笔丢掉),绝不拿旧线索去盖新线索。
 */
async function writeNote(
  key: string, input: CleanupDebtInput, seq: number,
): Promise<"noted" | "failed"> {
  if ((landedSeq.get(key) ?? 0) > seq) {
    dropPendingNote(key, seq);
    return "noted";
  }
  const verdict = await noteDebtRow(key, input);
  if (verdict === "noted") {
    landedSeq.set(key, Math.max(landedSeq.get(key) ?? 0, seq));
    dropPendingNote(key, seq);                    // 落库成功 ⇒ 清单上那笔(不更新的)淘汰掉
  }
  return verdict;
}

/** 清单上这个键的那一笔,只在**不比刚落库的那版新**时才丢掉。 */
function dropPendingNote(key: string, seq: number): void {
  const held = pendingNotes.get(key);
  if (held && held.seq <= seq) pendingNotes.delete(key);
}

/** 这个键彻底了结(销账)时把两份内存记录一起清掉,免得它们无限长。 */
function forgetNoteBookkeeping(key: string): void {
  pendingNotes.delete(key);
  landedSeq.delete(key);
}

function scheduleFlush(): void {
  if (flushTimer || !pendingNotes.size) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingCleanupNotes();
  }, FLUSH_DELAY_MS);
  // 不拿住事件循环:这件事不该让一个本来可以退出的进程多活着。
  (flushTimer as { unref?: () => void }).unref?.();
}

/** 把内存里还扛着的那几笔再投一次。返回这一轮落进库的笔数和仍没落下的笔数。 */
export async function flushPendingCleanupNotes(): Promise<{ landed: number; pending: number }> {
  let landed = 0;
  for (const [key, note] of [...pendingNotes]) {
    if (dbClient.closed) break;
    const verdict = await withDebtKey(key, () => writeNote(key, note.input, note.seq));
    if (verdict !== "noted") continue;
    pendingNotes.delete(key);
    landed += 1;
  }
  if (pendingNotes.size) scheduleFlush();
  return { landed, pending: pendingNotes.size };
}

/** 披露用:这一刻有几笔责任只在内存里(跨不过重启)。 */
export const pendingCleanupNoteCount = (): number => pendingNotes.size;

async function noteDebtRow(
  key: string, input: CleanupDebtInput,
): Promise<"noted" | "failed"> {
  try {
    // 行上已经点过名的那几个号**并进来**(见 `CleanupDebtInput.open`):读写都在 `withDebtKey`
    // 这把键锁里,读不出来就当这一次不知道更多,照旧只写自己这一份。
    const merged = mergeOpenMembers(await readOpenMembers(key), input.open ?? []);
    await db.insert(agentCleanupDebts).values({
      unitToken: key,
      taskId: input.taskId ?? "", sessionId: input.sessionId ?? "",
      rootPid: input.rootPid ?? null, rootStartedAt: input.rootStartedAt ?? null,
      trackPath: input.trackPath ?? null, outPath: input.outPath ?? null,
      state: input.state, detail: input.detail.slice(0, 2000),
      unitVerdict: input.unitVerdict,
      openMembers: serializeOpenMembers(merged),
      attempts: 0, version: 0, createdAt: now(), lastAttemptAt: null,
      closedAt: null, closedNote: null,
    }).onConflictDoUpdate({
      target: agentCleanupDebts.unitToken,
      set: {
        state: input.state, detail: input.detail.slice(0, 2000),
        unitVerdict: input.unitVerdict,
        openMembers: serializeOpenMembers(merged),
        closedAt: null, closedNote: null,
        // 证据换了一版:上一版的「清空证明」从这一刻起作不得数(见 schema 的 version)。
        version: sql`${agentCleanupDebts.version} + 1`,
        // 线索只在「这一次知道得更多」时覆盖:把已知的路径/启动时刻盖成 null 等于擦证据。
        ...(input.rootPid ? { rootPid: input.rootPid } : {}),
        ...(input.rootStartedAt ? { rootStartedAt: input.rootStartedAt } : {}),
        ...(input.trackPath ? { trackPath: input.trackPath } : {}),
        ...(input.outPath ? { outPath: input.outPath } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
    });
    return "noted";
  } catch (error) {
    console.error(`[ash] agent 清理责任落库失败 unit=${key}:`, error);
    return "failed";
  }
}

/**
 * 这一次运行**自己**判出了「清空」⇒ 销账。清理路径的 `empty` 分支调它。
 *
 * **它不信调用方那句「空了」就删行**(第 3 轮审查 F2):那个判断是在锁外做的,从判完到这里
 * 之间,另一次清扫可能刚把新的残留证据写到同一个键上 —— 上一版照样按键 `DELETE`,把别人
 * 刚落下的那一版证据一起删了,于是「局部的、过期的空」注销掉了「当前的、有残留」。
 *
 * 所以这里锁内自证:先看这个键上到底有没有账(绝大多数回合压根没欠过,读一次主键就返回),
 * 有账就**按行上现有的线索重新取证**,仍然确证空才删;还有残留就把这一刻记上去、行留着。
 * 顺带把键算对:按同一套线索算(`debtKey`),没有记号的那些行才销得掉(本轮 N8)。
 */
export async function settleCleanupDebt(clues: CleanupDebtClues): Promise<void> {
  const key = debtKey(clues);
  if (!key || dbClient.closed) return;
  await withDebtKey(key, () => settleIfStillEmpty(key));
}

async function settleIfStillEmpty(key: string): Promise<void> {
  const read = await readDebtRow(key);
  if (!read.ok) {
    console.warn(`[ash] 这一笔清理责任该销账、但这一刻读不出来(unit=${key}:${read.reason}):`
      + "行留着,下一轮清扫重新取证");
    return;
  }
  if (!read.row) return;                          // 从来没欠过 —— 绝大多数回合走这里
  const row = read.row;
  const judged = await judgeDebtRow(row);
  switch (debtDisposition(judged)) {
    case "settle":
      if (!await settleDebtRow(key, row.version)) {
        console.warn(`[ash] 这一笔清理责任确证空了、销账却没落下(unit=${key}):`
          + "行留着,下一轮清扫会再确证一次");
      }
      return;
    case "close":
      console.warn(`[ash] 这一笔清理责任追到这里为止(unit=${key}):${cleanupDetail(judged.result)}`
        + " —— 行留着(最后的可定位身份),不再自动重试");
      await closeDebtRow(key, row.version, cleanupDetail(judged.result));
      return;
    default:
      console.warn(`[ash] 这一笔清理责任还不能销(unit=${key}):${cleanupDetail(judged.result)}`);
      await touchDebtRow(row, judged.result, judged.after.verdict);
  }
}

/** 读这一个键上的账。**读不到和没有账是两件事**,所以分两档返回,不折成 `null`。 */
async function readDebtRow(
  key: string,
): Promise<{ ok: true; row: DebtRow | null } | { ok: false; reason: string }> {
  if (dbClient.closed) return { ok: false, reason: "数据库连接已关闭" };
  try {
    const rows = await db.select().from(agentCleanupDebts)
      .where(eq(agentCleanupDebts.unitToken, key)).limit(1);
    return { ok: true, row: rows[0] ?? null };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
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
    if (rowsAffectedOf(result) > 0) {
      forgetNoteBookkeeping(unitToken);
      return true;
    }
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
 */
async function closeDebtRow(unitToken: string, version: number, note: string): Promise<boolean> {
  if (dbClient.closed) return false;
  try {
    const result = await db.update(agentCleanupDebts)
      .set({ closedAt: now(), closedNote: note.slice(0, 500), version: version + 1 })
      .where(and(
        eq(agentCleanupDebts.unitToken, unitToken), eq(agentCleanupDebts.version, version),
        isNull(agentCleanupDebts.closedAt),
      ));
    if (rowsAffectedOf(result) > 0) return true;
    console.warn(`[ash] 收档没盖到戳(unit=${unitToken}、判的是第 ${version} 版):`
      + "要么这个键上的证据被人动过、要么已经收过档,这一轮不动它");
    return false;
  } catch (error) {
    console.error(`[ash] 收档写失败 unit=${unitToken}:`, error);
    return false;
  }
}

/** 条件写到底改没改到行。drizzle 把底层 client 的 `rowsAffected` 原样带出来。 */
const rowsAffectedOf = (result: unknown): number =>
  Number((result as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0);

/**
 * 还在追的那几笔(披露与重试入口都读它)。
 *
 * **读失败不许长成空列表**(第 2 轮审查 N3):上一版 catch 到底就 `return []`,于是「这台机器
 * 上没有欠账」和「这一问自己失败了」在接口上一模一样 —— 披露面会在数据库出问题的时候
 * 安静地显示「干干净净」,而这正是这张表存在的理由要防的那件事。所以返回的是两档,
 * 调用方必须自己决定怎么说。
 */
export type CleanupDebtListing =
  | { ok: true; debts: (typeof agentCleanupDebts.$inferSelect)[] }
  | { ok: false; reason: string };

export async function listOpenCleanupDebts(): Promise<CleanupDebtListing> {
  return listCleanupDebts(false);
}

/**
 * 披露面读这一个:**连收档的那几笔一起给**。
 *
 * 收档 = 「能追的都追到头了」,不等于「它走了」(线索的名字没了,握着那个 inode 的进程可能
 * 还在写)。上一版唯一的读取接口按 `closedAt is null` 过滤,于是收档那一刻这一笔就从用户
 * 眼前消失了 —— 跟销账在披露面上长得一模一样(第 2 轮审查 N2/F1)。行里本来就带着
 * `closedAt` / `closedNote`,交给调用方自己区分。
 */
export async function listAllCleanupDebts(): Promise<CleanupDebtListing> {
  return listCleanupDebts(true);
}

async function listCleanupDebts(includeClosed: boolean): Promise<CleanupDebtListing> {
  if (dbClient.closed) return { ok: false, reason: "数据库连接已关闭" };
  try {
    const q = db.select().from(agentCleanupDebts);
    return {
      ok: true,
      debts: includeClosed ? await q : await q.where(isNull(agentCleanupDebts.closedAt)),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 把还在追的那几笔各推一次。开机调一次,用户也能自己点(`POST /api/cleanup-debts/sweep`)。
 *
 * 每一笔重新取证,按记号那一问的四档分流:
 *  · `ours`       —— exact 档(Linux `/proc/<pid>/environ`):成员自带归属证明和代次,
 *                    **逐个下刀**(绝不打组 —— 孤儿的组号是那个已经死掉的根的号),
 *                    然后复查;空了就销账。
 *  · `none`       —— 一个都没有。追踪文件也没有持有者 ⇒ 确证清空,销账;
 *                    文件已经没了(线索断) ⇒ 盖戳收档。
 *  · `suspected`  —— macOS 看得见、给不出落点:**留着并如实报**。
 *  · `unprovable` —— 这一问自己没答出来:留着,下次开机再试。
 */
export type CleanupSweepResult =
  | {
    ok: true;
    /** 确证清空、**而且行真的删掉了**。写失败不算在这一档里(第 3 轮审查 N9)。 */
    settled: number;
    /** 重新取证之后仍然欠着 —— 包括「判出结论却没写进去」的那几笔。 */
    left: number;
    /** 能追的线索都追到头了,盖了戳。 */
    closed: number;
    /** 拿到锁之前就被清理路径自己确证销掉了(那是更强的证明,不是这一轮推动的)。 */
    vanished: number;
    /** 连这一笔的行都读不出来:这一轮它一步没动,别算进上面任何一档。 */
    stuck: number;
    /** 清扫开头补投落库的责任笔数。 */
    landedNotes: number;
    /** 仍然只在内存里扛着的责任笔数(跨不过重启,见 `pendingNotes`)。 */
    pendingNotes: number;
    /**
     * 连交接层都没加载起来、留在**清理那一侧**内存里等补交的笔数(`kill.ts` 的 `undelivered`)。
     *
     * 跟上面那个是两段路、各管一半:`pendingNotes` 是「进了这一层、库没写进去」,这一个是
     * 「压根没进这一层」。两个都跨不过重启,所以披露面上一个都不能少(第 4 轮审查 N2)。
     */
    undelivered: number;
  }
  /** 连「有哪几笔」都没问出来 ⇒ **不许报成 0/0/0**(那和「全扫完了,什么都没有」同形)。 */
  | { ok: false; reason: string };

export async function sweepAgentCleanupDebts(): Promise<CleanupSweepResult> {
  // 先把上一轮写不进去、内存里还扛着的那几笔补投一遍(见 `pendingNotes`):它们本该是库里
  // 的行,补上之后这一轮才扫得到。
  const flushed = await flushPendingCleanupNotes();
  const open = await listOpenCleanupDebts();
  if (!open.ok) return { ok: false, reason: open.reason };
  let settled = 0, left = 0, closed = 0, vanished = 0, stuck = 0;
  for (const debt of open.debts) {
    const verdict = await pushCleanupDebt(debt.unitToken);
    if (verdict === "settled") settled += 1;
    else if (verdict === "closed") closed += 1;
    else if (verdict === "vanished") vanished += 1;
    else if (verdict === "unreadable") stuck += 1;
    else left += 1;
  }
  return {
    ok: true, settled, left, closed, vanished, stuck,
    landedNotes: flushed.landed, pendingNotes: flushed.pending,
    undelivered: await undeliveredCount(),
  };
}

/**
 * 清理那一侧内存里还扛着几笔(按需加载,拿不到就如实报 0 —— 它只用于披露)。
 *
 * 为什么是按需加载:`kill.ts` 对这一层是按需加载的(见那边顶部那段),反过来静态 import
 * 会在两边之间长出一条真实的运行时环。
 */
async function undeliveredCount(): Promise<number> {
  try {
    const { undeliveredCleanupDebtCount } = await import("./kill.js");
    return undeliveredCleanupDebtCount();
  } catch {
    return 0;
  }
}

/**
 * 把一笔账往前推一次,**结论来自全部线索的终态合并**(第 2 轮审查 F1 的修复落点)。
 *
 * 四条线索分属**两个问**(判空的不变量见 cleanup-result.ts 顶部),各自答四档里的一档:
 *  · 根的号 + 启动时刻 —— 答「根」这一问,见 `rootResidue`;
 *  · 资源记号 —— `ours` 档敢下刀(逐个打,绝不打组:孤儿的组号是那个已经死掉的根的号);
 *  · 追踪文件 —— 后代继承的高位 fd;
 *  · 输出文件 —— 根的 stdout,这一次运行独有。
 *
 * 上一版是**逐条 if 各自决定销不销账**,于是每一条都成了一个单独的出口:记号答 `none`
 * 就删行(不看两条路径)、追踪路径缺席就删行(不看输出文件 `unknown`)。审查实测的后果是
 * 后一种:后代把输出文件的名字弄丢(进程还握着那个 inode、心跳继续涨),这一问正确地答了
 * `unknown`,销账照落 —— 「局部查空」被当成了「整次运行清空」。
 *
 * 所以这里只有一个出口,判据是 `debtDisposition`(销账 / 收档 / 留着,三档的判据见那一段)。
 *
 * **记号与路径都在(可能的)下刀之后才取证**:下刀前那次读数说明不了下刀后的事。
 */
type SweepVerdict = "settled" | "closed" | "left" | "vanished" | "unreadable";

function pushCleanupDebt(key: string): Promise<SweepVerdict> {
  return withDebtKey(key, () => pushDebtLocked(key));
}

async function pushDebtLocked(key: string): Promise<SweepVerdict> {
  // **行在锁内重新读**(第 3 轮审查 F2):列表那一刻的快照到这里已经隔了前面每一笔的处理
  // (各带 2 秒补刀窗口),中间清理路径完全可能往同一个键上写了新线索、或者已经自己确证
  // 销掉了这一笔。拿着锁外的旧对象取证,判的就是一份过期证据,而写回去却是当前这一行。
  const read = await readDebtRow(key);
  if (!read.ok) {
    console.warn(`[ash] 这一笔清理责任读不出来(unit=${key}:${read.reason}):这一轮没动它`);
    return "unreadable";
  }
  if (!read.row) return "vanished";               // 清理路径自己确证销掉了 —— 更强的证明
  const debt = read.row;
  // `no-unit:` 开头的那些行没有记号(升级前建的老会话),记号这一问对它们永远是
  // `unprovable` —— 不能拿这一档当「还有残留」,判据只剩路径线索。
  const marked = isMarked(key);
  const opening = processUnitEvidence(marked ? key : null, { fresh: true });

  if (marked && opening.verdict === "ours") {
    // 自带归属证明 + 同源代次 ⇒ 这一档敢下刀。`signalMembers` 每一刀之前重核代次。
    signalMembers(opening.members, "SIGTERM");
    await new Promise((r) => { const t = setTimeout(r, 2000); (t as { unref?: () => void }).unref?.(); });
    const again = processUnitEvidence(marked ? key : null, { fresh: true });
    if (again.verdict === "ours") signalMembers(again.members, "SIGKILL");
  }

  // **记号与路径都在(可能的)下刀之后才取证**:下刀前那次读数说明不了下刀后的事。
  const judged = await judgeDebtRow(debt);
  const { after, result } = judged;

  switch (debtDisposition(judged)) {
    case "settle":
      // 删不掉就还是欠着:「写失败」不许在计数上长成「销账成功」(第 3 轮审查 N9)。
      return await settleDebtRow(key, debt.version) ? "settled" : "left";
    case "close":
      return await closeDebtRow(key, debt.version, cleanupDetail(result)) ? "closed" : "left";
    default:
      await touchDebtRow(debt, result, after.verdict);
      return "left";
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
): Promise<boolean> {
  if (dbClient.closed || result.kind === "empty") return false;
  try {
    const written = await db.update(agentCleanupDebts).set({
      state: result.kind, detail: cleanupDetail(result).slice(0, 2000), unitVerdict: verdict,
      // **这一份判定逐个核过了那几个号**(`openResidue`),所以它写得动这一列:核掉的去掉、
      // 剩下的留着。落账那一侧相反 —— 它没核过,只并不减。
      openMembers: serializeOpenMembers(openOf(result)),
      lastAttemptAt: now(), attempts: sql`${agentCleanupDebts.attempts} + 1`,
      version: debt.version + 1,
    }).where(and(
      eq(agentCleanupDebts.unitToken, debt.unitToken),
      eq(agentCleanupDebts.version, debt.version),
    ));
    return rowsAffectedOf(written) > 0;
  } catch (error) {
    console.error(`[ash] 这一笔清理责任的进展没记上(unit=${debt.unitToken}):`, error);
    return false;
  }
}
