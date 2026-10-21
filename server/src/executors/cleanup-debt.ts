// **「这一次运行的后代没收干净」—— 一条摆在库里的事实。**
//
// 为什么非得落盘,见 `db/schema-sessions.ts` 里 `agent_cleanup_debts` 的注释。这一份是那张
// 表的读写层加上**重试**:开机扫一遍、用户也能自己点一次。
//
// 一句话的规矩:**只有确证清空才销账**。记号那一问答 `none`(问全了、一个带着这次记号的
// 进程都没有)而且追踪文件也没有持有者 —— 只有这一档才删行。`suspected`(macOS 看得见
// 却给不出落点)、`unprovable`(这一问自己没答出来)一律留着,并且如实说出来:那是
// 「还没收干净」,不是「收干净了」。
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, dbClient } from "../db/index.js";
import { agentCleanupDebts } from "../db/schema.js";
import { now } from "../util.js";
import { processUnitEvidence, type UnitEvidence } from "../proc.js";
import { describeEvidence, signalMembers } from "./escapees.js";
import { probeFileHolders, type HolderProbe } from "./track-evidence.js";
import {
  mergeCleanupResults, residueFromProbe, type CleanupResult,
} from "./kill.js";

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

export type CleanupDebtInput = {
  /** `null` = 这一次运行没有记号(升级前建的老会话行)⇒ 退回路径线索当键,见 `debtKey`。 */
  unitToken: string | null;
  taskId?: string;
  sessionId?: string;
  rootPid?: number | null;
  rootStartedAt?: string | null;
  trackPath?: string | null;
  outPath?: string | null;
  /** `remaining` = 确证还有成员活着;`unknown` = 这一轮问不清楚。 */
  state: "remaining" | "unknown";
  detail: string;
  unitVerdict: UnitEvidence["verdict"];
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
  if (dbClient.closed) return "failed";           // 有线索、只是这一刻没处写
  return withDebtKey(key, () => noteDebtRow(key, input));
}

async function noteDebtRow(
  key: string, input: CleanupDebtInput,
): Promise<"noted" | "failed"> {
  try {
    await db.insert(agentCleanupDebts).values({
      unitToken: key,
      taskId: input.taskId ?? "", sessionId: input.sessionId ?? "",
      rootPid: input.rootPid ?? null, rootStartedAt: input.rootStartedAt ?? null,
      trackPath: input.trackPath ?? null, outPath: input.outPath ?? null,
      state: input.state, detail: input.detail.slice(0, 2000),
      unitVerdict: input.unitVerdict,
      attempts: 0, createdAt: now(), lastAttemptAt: null,
      closedAt: null, closedNote: null,
    }).onConflictDoUpdate({
      target: agentCleanupDebts.unitToken,
      set: {
        state: input.state, detail: input.detail.slice(0, 2000),
        unitVerdict: input.unitVerdict,
        closedAt: null, closedNote: null,
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
 * 这一笔记在哪个键上。
 *
 * 首选记号 —— 它是这一次运行独有的身份,而且清扫侧能靠它重新取证。**没有记号时不是直接
 * 放弃**:升级前建的那些会话行就没有这一列,可它们同样会留下后代,而路径线索(这一次
 * 运行独有的输出文件 / 追踪文件)对它们仍然有效 —— 清扫问得出「还有没有人握着」,
 * 只是问不出「那个号是谁」。留一行能追的,比什么都不留强。
 *
 * 三条线索都没有才返回 `null`:那种记录追不出任何东西,记下来只会让披露面永久积压一条
 * 谁也处置不了的行(失败桩、没有真实进程的合成句柄就属于这一类)。
 */
function debtKey(input: CleanupDebtInput): string | null {
  if (input.unitToken) return input.unitToken;
  const path = input.outPath || input.trackPath;
  return path ? `${NO_UNIT_PREFIX}${path}` : null;
}

/** 键前缀:这一行没有记号,清扫侧据此知道「别拿记号那一问当判据」。 */
const NO_UNIT_PREFIX = "no-unit:";

/**
 * 确证清空:销账删行。**只有「全部线索都确证空」那一档配调用它**(见 `pushCleanupDebt`)。
 *
 * 走按键排队:它删的是「我读到的那份证据」对应的行,中间不许插进别人的新证据(见顶部)。
 */
export async function settleCleanupDebt(unitToken: string | null | undefined): Promise<void> {
  if (!unitToken || dbClient.closed) return;
  await withDebtKey(unitToken, () => settleDebtRow(unitToken));
}

async function settleDebtRow(unitToken: string): Promise<void> {
  if (dbClient.closed) return;
  try {
    await db.delete(agentCleanupDebts).where(eq(agentCleanupDebts.unitToken, unitToken));
  } catch { /* 下一轮清扫再说 */ }
}

/** 追到这里为止(线索本身没了):盖戳、不再重试,**但不删行** —— 它是最后的可定位身份。 */
async function closeDebtRow(unitToken: string, note: string): Promise<void> {
  if (dbClient.closed) return;
  try {
    await db.update(agentCleanupDebts)
      .set({ closedAt: now(), closedNote: note.slice(0, 500) })
      .where(and(eq(agentCleanupDebts.unitToken, unitToken), isNull(agentCleanupDebts.closedAt)));
  } catch { /* 下一轮清扫再说 */ }
}

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
  | { ok: true; settled: number; left: number; closed: number }
  /** 连「有哪几笔」都没问出来 ⇒ **不许报成 0/0/0**(那和「全扫完了,什么都没有」同形)。 */
  | { ok: false; reason: string };

export async function sweepAgentCleanupDebts(): Promise<CleanupSweepResult> {
  const open = await listOpenCleanupDebts();
  if (!open.ok) return { ok: false, reason: open.reason };
  let settled = 0, left = 0, closed = 0;
  for (const debt of open.debts) {
    const verdict = await pushCleanupDebt(debt);
    if (verdict === "settled") settled += 1;
    else if (verdict === "closed") closed += 1;
    else left += 1;
  }
  return { ok: true, settled, left, closed };
}

/**
 * 把一笔账往前推一次,**结论来自全部线索的终态合并**(第 2 轮审查 F1 的修复落点)。
 *
 * 三条线索,各自答同一种三档(`remaining` / `unknown` / `empty`),然后取最保守的那一档:
 *  · 资源记号 —— `ours` 档敢下刀(逐个打,绝不打组:孤儿的组号是那个已经死掉的根的号);
 *  · 追踪文件 —— 后代继承的高位 fd;
 *  · 输出文件 —— 根的 stdout,这一次运行独有。
 *
 * 上一版是**逐条 if 各自决定销不销账**,于是每一条都成了一个单独的出口:记号答 `none`
 * 就删行(不看两条路径)、追踪路径缺席就删行(不看输出文件 `unknown`)。审查实测的后果是
 * 后一种:后代把输出文件的名字弄丢(进程还握着那个 inode、心跳继续涨),这一问正确地答了
 * `unknown`,销账照落 —— 「局部查空」被当成了「整次运行清空」。
 *
 * 所以这里只有一个出口,判据是合并结果:
 *  · `empty`     ⇒ 销账(删行);
 *  · `unknown` 且记号确证空、且路径线索的名字本身都没了 ⇒ 收档(盖戳不删行,追到这里为止);
 *  · 其余        ⇒ 留着,记下这一刻停在哪、第几次了。
 *
 * **记号与路径都在(可能的)下刀之后才取证**:下刀前那次读数说明不了下刀后的事。
 */
function pushCleanupDebt(
  debt: typeof agentCleanupDebts.$inferSelect,
): Promise<"settled" | "closed" | "left"> {
  return withDebtKey(debt.unitToken, () => pushDebtLocked(debt));
}

async function pushDebtLocked(
  debt: typeof agentCleanupDebts.$inferSelect,
): Promise<"settled" | "closed" | "left"> {
  // `no-unit:` 开头的那些行没有记号(升级前建的老会话),记号这一问对它们永远是
  // `unprovable` —— 不能拿这一档当「还有残留」,判据只剩路径线索。
  const marked = !debt.unitToken.startsWith(NO_UNIT_PREFIX);
  const token = marked ? debt.unitToken : null;
  const opening = processUnitEvidence(token, { fresh: true });

  if (marked && opening.verdict === "ours") {
    // 自带归属证明 + 同源代次 ⇒ 这一档敢下刀。`signalMembers` 每一刀之前重核代次。
    signalMembers(opening.members, "SIGTERM");
    await new Promise((r) => { const t = setTimeout(r, 2000); (t as { unref?: () => void }).unref?.(); });
    const again = processUnitEvidence(token, { fresh: true });
    if (again.verdict === "ours") signalMembers(again.members, "SIGKILL");
  }

  const after = marked ? processUnitEvidence(token, { fresh: true }) : opening;
  const clues = await probeDebtPaths(debt);
  const result = mergeCleanupResults([markerResidue(after, marked), pathResidue(clues)]);

  if (result.kind === "empty") {
    await settleDebtRow(debt.unitToken);
    return "settled";
  }
  // 记号这边已经确证空(或者本来就没有记号),路径那边只剩「名字自己没了」这种再问多少次
  // 都一样的答案 ⇒ 能追的都追到头了。**收档不是销账**:行留着,它是最后的可定位身份。
  if (result.kind === "unknown" && (!marked || after.verdict === "none") && cluesExhausted(clues)) {
    await closeDebtRow(debt.unitToken, result.detail);
    return "closed";
  }
  await touchDebtRow(debt.unitToken, result, after.verdict);
  return "left";
}

/** 两条跨得过重启的路径线索,**一起问**(少问一条就是上面那段说的那个漏洞)。 */
async function probeDebtPaths(
  debt: typeof agentCleanupDebts.$inferSelect,
): Promise<PathClues> {
  const [track, out] = await Promise.all([
    debt.trackPath ? probeFileHolders(debt.trackPath) : Promise.resolve(null),
    debt.outPath ? probeFileHolders(debt.outPath) : Promise.resolve(null),
  ]);
  return { track, out };
}

type PathClues = { track: HolderProbe | null; out: HolderProbe | null };

/**
 * 两条路径线索合成一档。
 *
 * **它们只用于残留检测,不用于下刀** —— 「谁还握着这个文件」证明得了「还有东西在」,证明
 * 不了「那个号就是那个东西」,而重启之后这边连句柄都没有。要下刀只走记号 `ours` 那一条
 * (自带归属证明 + 同源代次)。
 */
const pathResidue = (clues: PathClues): CleanupResult => mergeCleanupResults([
  residueFromProbe("追踪文件", clues.track), residueFromProbe("输出文件", clues.out),
]);

/** 记号那一问写成同一种三档。没有记号的行上这一问**不发表意见**(合并时的单位元)。 */
function markerResidue(evidence: UnitEvidence, marked: boolean): CleanupResult {
  if (!marked) return { kind: "empty" };
  switch (evidence.verdict) {
    case "ours": case "suspected":
      return { kind: "remaining", detail: describeEvidence(evidence) };
    case "unprovable":
      return { kind: "unknown", detail: `资源记号${describeEvidence(evidence)}` };
    case "none":
      return { kind: "empty" };
  }
}

/**
 * 路径这边**还追得下去吗**。
 *
 * 要收档就得满足两条:至少有一条线索的**名字本身没了**(`lost` —— 再问多少次都是同一个
 * 答案),而且没有任何一条是「这一次没答出来、下一次还问得出来」。一条都没有记下来时
 * 同样算追不下去 —— 那种行除了这一句描述什么都没有(正常不会出现,`debtKey` 要求至少
 * 一条线索)。
 */
function cluesExhausted(clues: PathClues): boolean {
  const probes = [clues.track, clues.out].filter((p): p is HolderProbe => !!p);
  if (!probes.length) return true;
  if (!probes.some((p) => p.kind === "unknown" && p.lost)) return false;
  return !probes.some((p) => p.kind === "unknown" && !p.lost);
}

/** 留着这一笔:把这一刻停在哪、第几次了记上去。 */
async function touchDebtRow(
  unitToken: string, result: CleanupResult, verdict: UnitEvidence["verdict"],
): Promise<void> {
  if (dbClient.closed || result.kind === "empty") return;
  try {
    await db.update(agentCleanupDebts).set({
      state: result.kind, detail: result.detail.slice(0, 2000), unitVerdict: verdict,
      lastAttemptAt: now(), attempts: sql`${agentCleanupDebts.attempts} + 1`,
    }).where(eq(agentCleanupDebts.unitToken, unitToken));
  } catch { /* 下一轮再说 */ }
}
