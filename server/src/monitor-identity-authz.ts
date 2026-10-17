// **恢复身份授权**:一条记录的 `pid_started_at` 还空着时,凭什么给这个号签一份身份。
//
// 为什么单独一层(第 17 轮审查 F1):签身份这件事有两个消费者 —— 实时回收/债务恢复那一侧的
// `completeIdentity`(monitor-reclaim-debts.ts),以及重启后认领 pid 空行的
// `adoptSpawnIdentity`(monitor-adopt.ts)。上一轮两边各写了一份政策,于是:
//
//  · `adoptSpawnIdentity` 把 `none`、`ours` 缺这个号、代次 `changed` 三种都当反证拒掉;
//  · `completeIdentity` 只拦了 `changed`,`none` 和「名单里没有这个号」都落回 `member === null`,
//    被当成「这一问没答出来」—— 于是时间锚 + 命令包含那条弱判据照样放行。
//
// 后果是实测过的:原进程退了、同号新进程在那两秒窗口里起来、命令文本又恰好包含记录的那一段,
// 它真实的启动时刻被写成旧哨兵的身份,随后按这条身份收到真实 SIGKILL
// (`round-7/refutation-retry.log`、`refutation-auto.log`:首次拒绝成功,**随后的清扫和自动
// 梯子把反证忘了**)。所以政策必须只有一份,而且反证不能只活在一次函数调用的返回值里。
//
// ── 三档资格,只有第一档签得出「可下刀的身份」 ─────────────────────────────────
//
// | 档 | 事实 | 能签出可下刀的身份吗 |
// |---|---|---|
// | `proven` | 记号在**真实环境项**里指着这个号,代次换算夹核通过 | 能 |
// | `disproved` | `none` / `ours` 名单里没有这个号 / 代次 `changed` | 不能,**连把这个号认下来都不许** |
// | `unprovable` | 这一问没答出来(展示文本档 `suspected`、`ps`/`/proc` 失败),或者这条记录**根本没有记号**(存量行) | 不能 |
//
// **「没有拿到反证」不等于「已经证明属于这次创建」**(第 18 轮审查 F1)。上一版把
// `suspected` / `unprovable` / 存量行都归成「这一问没答出来」,然后**允许它们走时间锚 + 命令
// 包含那条弱判据把启动时刻补进 `pid_started_at`** —— 而 `reclaimEvidence` 第 ② 步拿这一列当
// 归属凭证(根活着 + 启动时刻对得上 ⇒ `ours-alive` ⇒ 可以下刀),它分不出这个值是 ash 自己
// spawn 那一刻读来的,还是事后凭一个时间窗口猜出来的。实测后果:一个**没有**真实
// `ASH_MONITOR_UNIT` 环境项、只是另一个变量的值里抄着那串记号文字的陌生进程,被产品真实的
// 停止链杀掉(`cgtxRDWnCNVp/round-1/identity-ambiguous.log`)。
//
// 所以这一层现在只有一条规矩:**弱判据只有拒绝权,没有授权权**。
//  · 时间邻近、命令包含、展示文本里的记号文字 ⇒ 只配当「重试线索」和「这个号肯定不是它」
//    的否决票,一律不许往 `pid_started_at` 里写值;
//  · 签不出身份的那几档照旧**记责任、留锚、留边条、不发信号**(`unverifiable` 档:看得见、
//    停得掉、追得回,但谁都不许据此下刀)。第 10 轮 F2-B 要的「补全机会不许丢」留着 —— 锚和
//    边条都还在,记号那一问哪一刻答得出 `ours` 就哪一刻补上;它要的「补全之后就能下刀」这
//    半句被本轮推翻:**猜出来的身份不配当下刀凭证**。
//
// 反证一旦出现就要**落盘**(`identity_disproved_at`),下一次尝试、另一个消费者、重启之后都
// 不许把它退化成「未知」;而**账本读不出来时不许当成「没有反证」**(第 18 轮审查 F1 实测 B:
// 只让那一句 SELECT 抛一次,产品出了一句日志就继续放行)—— 读失败一律按「这一轮不认」处理。
//
// 反证**只收走弱判据与认号资格,不封死强凭证**:真实带着这次记号的后代落到同一个号上时,
// 记号那一问仍然会把它判成 `proven` —— 那是它自己的独立证据,不是给旧根重新授信。
import { and, eq, isNull } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { monitorReclaimDebts } from "./db/schema.js";
import { processUnitEvidence } from "./proc.js";
import { startedAtOfGeneration } from "./process-generation.js";
import { now } from "./util.js";

/** 强凭证这一问对「这个号是不是这条记录的那个进程」说了什么。 */
export type StrongIdentity =
  | { grade: "proven"; startedAt: string | null }
  | { grade: "disproved" }
  | { grade: "unanswered" }
  | { grade: "legacy" };

/**
 * 记号那一问 + 代次换算,**一处实现**。
 *
 * 记号随 `exec` 继承,所以这一次创建起的进程一定带着它:
 *  · `ours` 名单里有这个号 ⇒ 已证明。启动时刻走夹核换算(`startedAtOfGeneration`):换算答不
 *    出来就只交 `null` —— 号是证明过的,启动时刻等下一遍,**不许回落到弱判据**;
 *  · `ours` 名单里**没有**这个号 ⇒ 它不带这次创建的记号 ⇒ 反证;
 *  · `none` ⇒ 问全了、一个活进程都不带这次的记号(真实环境项必然出现在 `ps -E` 文本里,
 *    所以两个平台都可靠)⇒ 那个进程已经不在,这个号上现在是谁都与这条记录无关 ⇒ 反证;
 *  · 代次 `changed` ⇒ 这个号已经不是记号证明过的那一代 ⇒ 反证;
 *  · `suspected` / `unprovable` ⇒ 这一问没答出来。
 */
export function askStrongIdentity(pid: number, unitToken: string | null): StrongIdentity {
  if (!unitToken) return { grade: "legacy" };
  const proven = processUnitEvidence(unitToken);
  if (proven.verdict === "none") return { grade: "disproved" };
  if (proven.verdict !== "ours") return { grade: "unanswered" };
  const member = proven.members.find((candidate) => candidate.pid === pid);
  if (!member) return { grade: "disproved" };
  const converted = startedAtOfGeneration(member.pid, member.gen);
  if (converted.outcome === "changed") return { grade: "disproved" };
  return { grade: "proven", startedAt: converted.outcome === "proven" ? converted.startedAt : null };
}

/** 这一刻的授权结论。 */
export type RecoveredIdentity = {
  /** 记号那一问原话(只用于措辞和日志)。 */
  strong: StrongIdentity;
  /** 三档资格。**只有 `proven` 签得出可下刀的身份**(见文件头)。 */
  ownership: "proven" | "disproved" | "unprovable";
  /** `proven` 顺带交出来的启动时刻;换算这一刻答不出来就是 `null`(号认下来,时刻等下一遍)。 */
  startedAt: string | null;
  /**
   * 连「把这个号认下来」都不许:已经反证过,**或者反证账本这一刻读不出来**。
   *
   * 读失败不许当成「没有反证」—— 那正是实测 B 的犯法方式(一次 SELECT 异常就把一笔已经落盘
   * 的拒绝洗掉)。读不出来就什么都不认,下一遍再问。
   */
  refuse: boolean;
  /** **这一次新问出来**的反证,要跟着责任一起落盘。读失败不算:别把异常写成事实。 */
  disprovedNow: boolean;
};

/**
 * **问一遍 + 把反证记住**:两个消费者(实时回收/债务恢复的 `completeIdentity`、重启后认领的
 * `adoptSpawnIdentity`)都从这里拿授权,不自己判。
 */
export async function authorizeRecoveredIdentity(m: {
  monitorId: string; pid: number; unitToken: string | null;
}): Promise<RecoveredIdentity> {
  const strong = askStrongIdentity(m.pid, m.unitToken);
  const disprovedNow = strong.grade === "disproved";
  if (disprovedNow) await revokeWeakIdentity(m.monitorId, m.pid);
  // 这一次就反证了,就不必再去读账本(省一次查询,也省掉「读失败」这一档)。
  const ledger = disprovedNow ? "refuted" : await readIdentityRefutation(m.monitorId);
  return {
    strong,
    ownership: strong.grade === "proven" ? "proven"
      : (disprovedNow || ledger === "refuted" ? "disproved" : "unprovable"),
    startedAt: strong.grade === "proven" ? strong.startedAt : null,
    refuse: disprovedNow || ledger !== "clean",
    disprovedNow,
  };
}

/**
 * 盘上记着这个号被反证过吗。**三档,读失败不许混进「干净」那一档**(第 18 轮审查 F1 实测 B)。
 *
 * 库关了也算读不出来:那一刻什么都核实不了,而这一问的用途是「还能不能认这个号」——
 * 核实不了就不认,下一遍再问。
 */
async function readIdentityRefutation(monitorId: string): Promise<"clean" | "refuted" | "unreadable"> {
  if (dbClient.closed) return "unreadable";
  try {
    const row = (await db.select({ at: monitorReclaimDebts.identityDisprovedAt })
      .from(monitorReclaimDebts).where(eq(monitorReclaimDebts.monitorId, monitorId))).at(0);
    return row?.at ? "refuted" : "clean";
  } catch (err) {
    console.error(`[ash] 身份反证记录读不出来 monitor=${monitorId}（这一轮一律不认这个号）:`, err);
    return "unreadable";
  }
}

/**
 * 把反证钉在盘上。**只盖没盖过的那一行**(幂等),所以每个入口都可以无条件调。
 *
 * 行还没落盘时这一句影响 0 行 —— 那一侧由 `DebtInput.identityDisproved` 随插入一起带进去,
 * 而插入失败本来就走补记梯子(见 monitor-reclaim-debts.ts)。写不进去也要出声:这一笔丢了
 * 就等于下一次尝试又可以拿弱判据重新授信。
 */
async function revokeWeakIdentity(monitorId: string, pid: number): Promise<void> {
  if (dbClient.closed) return;
  try {
    await db.update(monitorReclaimDebts)
      .set({ identityDisprovedAt: now() })
      .where(and(
        eq(monitorReclaimDebts.monitorId, monitorId),
        isNull(monitorReclaimDebts.identityDisprovedAt),
      ));
  } catch (err) {
    console.error(`[ash] 身份反证记不下来 monitor=${monitorId} pid=${pid}（弱判据这一轮仍被拒）:`, err);
  }
}
