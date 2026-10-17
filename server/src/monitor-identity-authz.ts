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
// ── 四种资格,弱判据只服务其中两种 ──────────────────────────────────────────────
//
// | 档 | 事实 | 弱判据(时间锚 + 命令原文) |
// |---|---|---|
// | `legacy` | 这条记录**根本没有记号**(记号那一列是后加的) | 允许 —— 否则存量行永远证不出身份 |
// | `unanswered` | 记号这一问自己没答出来(展示文本档、`ps`/`/proc` 失败) | 允许 —— 第 10 轮 F2-B:查询恢复之后还得补得上 |
// | `proven` | 记号在**真实环境项**里指着这个号,代次换算夹核通过 | 不需要 |
// | `disproved` | `none` / `ours` 名单里没有这个号 / 代次 `changed` | **永久禁止** |
//
// 「反证」与「问不出来」的区别是本层的全部内容:前者是**已经知道这个号不是它**,后者只是
// 这一刻不知道。所以反证一旦出现就要**落盘**(`identity_disproved_at`),下一次尝试、另一个
// 消费者、重启之后都不许把它退化成「未知」再走弱判据。
//
// 反证**只收走弱判据,不封死强凭证**:真实带着这次记号的后代落到同一个号上时,记号那一问
// 仍然会把它判成 `proven` —— 那是它自己的独立证据,不是给旧根重新授信。
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

/** 这一刻的授权结论。`disproved` 要跟着责任一起落盘(见 `DebtInput.identityDisproved`)。 */
export type RecoveredIdentity = {
  strong: StrongIdentity;
  /** 时间锚 + 命令原文这条弱判据,此刻有没有资格签身份。 */
  weakAllowed: boolean;
  /** 这个号被反证过 —— 这一次新问出来的,或者盘上早就记着。 */
  disproved: boolean;
};

/**
 * **问一遍 + 把反证记住**:两个消费者都从这里拿授权,不自己判。
 *
 * 盘上的反证戳(`identity_disproved_at`)只有一个作用:即使记号这一问**退化**成「答不出来」,
 * 弱判据也不再有资格。它不参与强凭证 —— `proven` 照旧放行。
 */
export async function authorizeRecoveredIdentity(m: {
  monitorId: string; pid: number; unitToken: string | null;
}): Promise<RecoveredIdentity> {
  const strong = askStrongIdentity(m.pid, m.unitToken);
  const remembered = strong.grade === "disproved" ? false : await weakIdentityRevoked(m.monitorId);
  if (strong.grade === "disproved") await revokeWeakIdentity(m.monitorId, m.pid);
  const disproved = strong.grade === "disproved" || remembered;
  const answerable = strong.grade === "legacy" || strong.grade === "unanswered";
  return { strong, weakAllowed: answerable && !disproved, disproved };
}

/** 盘上记着这个号已经被反证过吗。读不到(库关了/行还没落盘)一律按「没记着」。 */
async function weakIdentityRevoked(monitorId: string): Promise<boolean> {
  if (dbClient.closed) return false;
  try {
    const row = (await db.select({ at: monitorReclaimDebts.identityDisprovedAt })
      .from(monitorReclaimDebts).where(eq(monitorReclaimDebts.monitorId, monitorId))).at(0);
    return !!row?.at;
  } catch (err) {
    console.error(`[ash] 身份反证记录读不出来 monitor=${monitorId}:`, err);
    return false;
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
