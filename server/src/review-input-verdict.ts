// 「这一轮审查的任务书**到底进没进审查者手里**」—— 落在持久交付凭据上,结算与恢复都按它读。
//
// 为什么不能只活在投递层的内存里(第 1 轮自由审查 R1,已实测):交付凭据
// (`waitOwnership.deliveredReview`)在 spawn 之后就落下,那一刻只证明「越过了线」;协议回执
// 要几百毫秒到几十秒后才落定。投递层(`continueWhenIdle` 的三档裁决)要等这一轮结束才能交代
// 拒收/说不清,而**审查结算跑在这一轮结束之前**(回合锁里面):它只问「有没有结论」,于是输入
// 还说不清的那一轮被当场结成「未能正常给出结论」、落了终态 —— 在途意图被晾在一个终态轮次上,
// 对账只扫 reviewing,迟到的凭据回来也救不回它。
//
// 所以这里是一份事实、两个读者:
//   · 写:回执一落定就记(初次与迟到都记,turn-input-settlement.ts),排在任何调用方记账之前;
//   · 读:审查结算问 `reviewInputHold` —— 说不清、而且派发还在负责,就别结这一轮。
//
// 按住之后怎么收口(进程内,不靠重启):迟到的收下 → 派发了结意图;迟到的拒收 → 派发带着真实原因
// 落终态;到头仍说不清 → 派发只还认领证,周期对账(30 秒一拍)按交付凭据只结清意图、不重投,下一拍
// 意图已空,按孤儿结算 —— 那时这里答 `unknown`,时间线照实说「送没送到说不清」。
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { InputAcceptance } from "./executors/types.js";
import type { ReviewStartReceipt } from "./review-start-withdrawal.js";

const at = (path: string) => sql`json_extract(${tasks.waitOwnership}, ${`$.deliveredReview.${path}`})`;

/**
 * 把协议回执记到**这一轮这一代次**的交付凭据上。单调:accepted / refused 是定论,落下之后不再改;
 * unknown 只占「还没定论」那一格,等后话覆盖。凭据不是这一轮的(被顶替、或者 spawn 之后的交付
 * 落账失败了)就什么都不写 —— 条件全在同一条 UPDATE 的 WHERE 里。
 */
export async function noteReviewInputAcceptance(
  taskId: string, receipt: ReviewStartReceipt | undefined, acceptance: InputAcceptance,
): Promise<void> {
  if (!receipt) return;
  await db.update(tasks)
    .set({ waitOwnership: sql`json_set(${tasks.waitOwnership}, '$.deliveredReview.acceptance', ${acceptance})` })
    .where(and(
      eq(tasks.id, taskId),
      sql`${at("directory")} = ${receipt.directory}`,
      sql`${at("generation")} = ${receipt.generation}`,
      sql`coalesce(${at("acceptance")}, 'unknown') = 'unknown'`,
    ));
}

export type ReviewInputHold = "hold" | "refused" | "unknown";

/**
 * 一轮**还没交卷**的审查回合结束时,输入裁决对结算意味着什么:
 *  · `hold`    —— 说不清,而且派发还在负责(round 上的在途意图还挂着、是这一代次的):**别结**。
 *    这一轮不是「审查者没给结论」,而是「不知道审查者收没收到」。收口交给派发那一侧:迟到的
 *    定论(收下 → 了结意图;拒收 → 带着真实原因落终态),或者对账按交付凭据裁决(凭据说越过了
 *    线,就只结清意图、不重投 —— 之后按孤儿收尸,那时意图已空,这一问答 null,照常结算)。
 *  · `refused` —— 确证一个字都没进去:照常结算,但时间线得说真话(不是「没给出结论」)。
 *  · `unknown` —— 说不清、而且已经没人负责了:照常结算,时间线同样照实说。
 *  · `null`    —— 收下了、没有凭据、或者凭据不是这一轮的:照原路结算。
 */
export function reviewInputHold(
  task: Pick<typeof tasks.$inferSelect, "waitOwnership">,
  directory: string,
  dispatch: { generation?: string | null } | null | undefined,
): ReviewInputHold | null {
  const delivered = task.waitOwnership?.deliveredReview;
  if (!delivered || delivered.directory !== directory) return null;
  if (delivered.acceptance === "refused") return "refused";
  if (delivered.acceptance !== "unknown") return null;
  return dispatch && (!dispatch.generation || dispatch.generation === delivered.generation) ? "hold" : "unknown";
}

/** 照常结算之前写进时间线的那一句真话(`label` 是「自由工作流第 N 轮」这类前缀)。 */
export function reviewInputNote(input: Exclude<ReviewInputHold, "hold">, label: string): string {
  return input === "refused"
    ? `${label}审查的任务书被协议层明确拒收，审查者一个字都没收到，这一轮按未完成收尾；重跑这一轮即可重新投递。`
    : `${label}审查的任务书送没送进审查者手里说不清（协议层到最后也没给回执），这一轮按未完成收尾；`
      + "为免重复执行没有自动重投，需要的话重跑这一轮。";
}
