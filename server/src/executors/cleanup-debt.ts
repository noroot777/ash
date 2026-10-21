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
import { IS_WINDOWS, isPidAlive } from "../platform.js";
import { processUnitEvidence, type UnitEvidence } from "../proc.js";
import { describeEvidence, signalMembers } from "./escapees.js";
import { probeTrackHolders } from "./track-evidence.js";

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
 * 排在清理路径的每一条「没问清楚 / 还有残留」分支上。返回 `false` = 连责任都没落下来,
 * 那就只剩日志 —— 调用方不必因此改变自己的结算,但**不许**把它当成清理成功。
 *
 * 同一次运行反复欠账只占一行(记号是主键):覆盖的是「最近一次停在哪一档」,`attempts`
 * 由清扫侧累加。**收档不是终局** —— 又有新证据落到同一个记号上,说明「追不下去」这个
 * 判断过期了,把戳撤掉重新开追(判据同哨兵债表)。
 */
export async function noteCleanupDebt(input: CleanupDebtInput): Promise<boolean> {
  const key = debtKey(input);
  if (!key || dbClient.closed) return false;
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
    return true;
  } catch (error) {
    console.error(`[ash] agent 清理责任落库失败 unit=${key}:`, error);
    return false;
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

/** 确证清空:销账删行。**只有 `none` + 没有持有者那一档配调用它。** */
export async function settleCleanupDebt(unitToken: string | null | undefined): Promise<void> {
  if (!unitToken || dbClient.closed) return;
  try {
    await db.delete(agentCleanupDebts).where(eq(agentCleanupDebts.unitToken, unitToken));
  } catch { /* 下一轮清扫再说 */ }
}

/** 追到这里为止(线索本身没了):盖戳、不再重试,**但不删行** —— 它是最后的可定位身份。 */
async function closeCleanupDebt(unitToken: string, note: string): Promise<void> {
  if (dbClient.closed) return;
  try {
    await db.update(agentCleanupDebts)
      .set({ closedAt: now(), closedNote: note.slice(0, 500) })
      .where(and(eq(agentCleanupDebts.unitToken, unitToken), isNull(agentCleanupDebts.closedAt)));
  } catch { /* 下一轮清扫再说 */ }
}

/** 还在追的那几笔(披露与重试入口都读它)。 */
export async function listOpenCleanupDebts(): Promise<(typeof agentCleanupDebts.$inferSelect)[]> {
  if (dbClient.closed) return [];
  try {
    return await db.select().from(agentCleanupDebts).where(isNull(agentCleanupDebts.closedAt));
  } catch {
    return [];
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
export async function sweepAgentCleanupDebts(): Promise<{ settled: number; left: number; closed: number }> {
  const open = await listOpenCleanupDebts();
  let settled = 0, left = 0, closed = 0;
  for (const debt of open) {
    const verdict = await pushCleanupDebt(debt);
    if (verdict === "settled") settled += 1;
    else if (verdict === "closed") closed += 1;
    else left += 1;
  }
  return { settled, left, closed };
}

async function pushCleanupDebt(
  debt: typeof agentCleanupDebts.$inferSelect,
): Promise<"settled" | "closed" | "left"> {
  const evidence = processUnitEvidence(debt.unitToken, { fresh: true });
  // 两条跨得过重启的路径线索都问:追踪文件(后代带着继承 fd)和这次运行独有的输出文件
  // (根的 stdout)。**它们只用于残留检测,不用于下刀** —— 「谁还握着这个文件」证明得了
  // 「还有东西在」,证明不了「这个号就是那个东西」,而重启之后这边连句柄都没有。要下刀只
  // 走记号 exact 档那一条(自带归属证明 + 同源代次)。
  const holders = debt.trackPath ? await probeTrackHolders(debt.trackPath) : null;
  const outHolders = debt.outPath ? await probeTrackHolders(debt.outPath) : null;
  const touch = async (state: "remaining" | "unknown", detail: string) => {
    if (dbClient.closed) return;
    try {
      await db.update(agentCleanupDebts).set({
        state, detail: detail.slice(0, 2000), unitVerdict: evidence.verdict,
        lastAttemptAt: now(), attempts: sql`${agentCleanupDebts.attempts} + 1`,
      }).where(eq(agentCleanupDebts.unitToken, debt.unitToken));
    } catch { /* 下一轮再说 */ }
  };

  if (evidence.verdict === "ours") {
    // 自带归属证明 + 同源代次 ⇒ 这一档敢下刀。逐个打,`signalMembers` 每一刀之前重核代次。
    signalMembers(evidence.members, "SIGTERM");
    await new Promise((r) => { const t = setTimeout(r, 2000); (t as { unref?: () => void }).unref?.(); });
    const again = processUnitEvidence(debt.unitToken, { fresh: true });
    if (again.verdict === "ours") signalMembers(again.members, "SIGKILL");
    const after = processUnitEvidence(debt.unitToken, { fresh: true });
    if (after.verdict === "none") {
      await settleCleanupDebt(debt.unitToken);
      return "settled";
    }
    await touch("remaining", `下过刀仍有成员:${describeEvidence(after)}`);
    return "left";
  }

  if (evidence.verdict === "none") {
    // 记号说空了,但输出文件还被人握着 ⇒ 根(或者某个继承了它 stdout 的后代)还在。
    // 这一档**不许销账**:记号可以被 `env -i` 洗掉,文件 fd 洗不掉。
    if (outHolders?.kind === "held" && outHolders.pids.some(isPidAlive)) {
      await touch("remaining", `记号已空,但输出文件仍被 ${outHolders.pids.join(",")} 握着`);
      return "left";
    }
    if (!holders || holders.kind === "empty") {
      // 记号确证空 + 文件没有持有者 ⇒ 这项资源确证清空。
      await settleCleanupDebt(debt.unitToken);
      return "settled";
    }
    if (holders.kind === "held" && holders.pids.some(isPidAlive)) {
      await touch("remaining", `记号已空,但追踪文件仍被 ${holders.pids.join(",")} 握着`);
      return "left";
    }
    if (holders.kind === "unknown" && holders.lost) {
      // 记号空了、路径名这条线索也没了:能追的都答出来了、都空了 ⇒ 追到这里为止。
      await closeCleanupDebt(debt.unitToken, `记号已空,追踪文件已不在(${holders.reason})`);
      return "closed";
    }
    await touch("unknown", `记号已空,但追踪文件这一问没答出来:${describeProbe(holders)}`);
    return "left";
  }

  // 没有记号的那些行(`no-unit:` 开头):记号这一问对它们永远是 `unprovable`,所以不能
  // 拿这一档当「还有残留」。判据只剩路径线索 —— 两条都确证没人握着就销账,都追不下去
  // 就收档,否则留着。少了这一段,老会话行会在披露面上永久积压。
  if (debt.unitToken.startsWith(NO_UNIT_PREFIX)) {
    const live = [holders, outHolders].some((p) => p?.kind === "held" && p.pids.some(isPidAlive));
    if (live) {
      await touch("remaining", `没有记号,但文件仍被握着:${describeProbe(holders)} / ${describeProbe(outHolders)}`);
      return "left";
    }
    const answered = [holders, outHolders].filter(Boolean);
    if (answered.length && answered.every((p) => p!.kind === "empty")) {
      await settleCleanupDebt(debt.unitToken);
      return "settled";
    }
    if (answered.every((p) => p!.kind === "unknown" && p!.lost)) {
      await closeCleanupDebt(debt.unitToken, "没有记号,路径线索也已经不在了");
      return "closed";
    }
    await touch("unknown", `没有记号,路径这一问没答出来:${describeProbe(holders)} / ${describeProbe(outHolders)}`);
    return "left";
  }

  // suspected / unprovable:两档都**不许**当成清空。如实记下这一刻停在哪。
  await touch(
    evidence.verdict === "suspected" ? "remaining" : "unknown",
    `${describeEvidence(evidence)};追踪文件:${describeProbe(holders)}`
    + (debt.outPath ? `;输出文件:${describeProbe(outHolders)}` : ""),
  );
  return "left";
}

const describeProbe = (probe: Awaited<ReturnType<typeof probeTrackHolders>> | null): string => {
  if (!probe) return IS_WINDOWS ? "这个平台不开追踪文件" : "没有记下路径";
  if (probe.kind === "held") return `仍被 ${probe.pids.join(",")} 握着`;
  if (probe.kind === "empty") return "没有持有者";
  return `问不出来(${probe.reason})`;
};


