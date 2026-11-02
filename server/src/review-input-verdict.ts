// 「这一轮审查的任务书**到底进没进审查者手里**」—— 落在持久交付凭据上,结算与恢复都按它读。
//
// 为什么不能只活在投递层的内存里(第 1 轮自由审查 R1,已实测):交付凭据
// (`waitOwnership.deliveredReview`)在 spawn 之后就落下,那一刻只证明「越过了线」;协议回执
// 要几百毫秒到几十秒后才落定。而**审查结算跑在这一轮结束之前**(回合锁里面),从前它只问「有没有
// 结论」,于是输入还说不清的那一轮被当场结成「未能正常给出结论」,在途意图晾在终态轮次上。
//
// 一份事实,三个读者 —— 写:回执一落定就记(初次与迟到都记,turn-input-settlement.ts),排在任何
// 调用方记账之前;读:审查结算(`reviewInputHold`)、补投恢复(free-review-redeliver.ts)。
//
// **按住多久**(第 2 轮自由审查 R1):只要协议事实**还可能到**,就谁都不许替它下结论 —— 结算不结,
// 恢复也不许拿「越过了线」当「送到了」去清意图。「还可能到」是一个**本进程**的事实:回执本体是
// 一个只活在本进程里的承诺,它还没落定就登记在 `waiting` 里;它落定成 unknown(连接断了、协议再也
// 答不上来)或者进程没了(重启之后谁都等不到它),这条通道就关了 —— 那时再按着只会让这一轮永远
// 停在 reviewing,而用户没有任何按钮能把它放下来(没有活进程可停,也不是 failed 可重跑)。通道
// 关了之后照常结算,时间线照实写「送没送进去说不清」,不自动重投(那可能是重复执行)。
//
// **身份**(第 2 轮自由审查 R2):同一轮审查的多次续跑(答复提问、检查点续跑)共用目录与代次,
// 每一次输入却各有自己的 turnToken/directionToken/directionEpoch。回执只属于产生它的那一次输入:
// 写入在同一条 UPDATE 的 WHERE 里核完整输入身份,前一次输入迟到的定论写不进后一次的凭据;读取先核
// 权威代次,上一代次的凭据不当这一代的事实读。
//
// **写不下来**(同上 R1):协议事实先进内存(`unwritten`),再落库;库写失败就留在内存里供本进程
// 读,不会被读成「缺席 = 没这回事」。进程没了它才随之消失 —— 那时通道本来也关了,按说不清结算。
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { regressionEvidence, tasks } from "./db/schema.js";
import type { InputAcceptance } from "./executors/types.js";
import type { ReviewStartReceipt } from "./review-start-withdrawal.js";

type Verdict = Exclude<InputAcceptance, "unknown">;
type Delivered = NonNullable<NonNullable<typeof tasks.$inferSelect["waitOwnership"]>["deliveredReview"]>;

const keyOf = (taskId: string, receipt: Pick<Delivered, "directory" | "generation" | "identity">) =>
  JSON.stringify([taskId, receipt.directory, receipt.generation,
    receipt.identity.turnToken, receipt.identity.directionToken, receipt.identity.directionEpoch]);

/** 回执本体还没落定的那几次输入:定论**还可能到**。 */
const waiting = new Set<string>();
/** 已经落定、却还没落进库的定论(写库失败或正在写)。读的时候它优先于库里那一份。 */
const unwritten = new Map<string, Verdict>();

const at = (path: string) => sql`json_extract(${tasks.waitOwnership}, ${`$.deliveredReview.${path}`})`;

async function persist(taskId: string, receipt: ReviewStartReceipt, acceptance: InputAcceptance): Promise<void> {
  await db.update(tasks)
    .set({ waitOwnership: sql`json_set(${tasks.waitOwnership}, '$.deliveredReview.acceptance', ${acceptance})` })
    .where(and(
      eq(tasks.id, taskId),
      sql`${at("directory")} = ${receipt.directory}`,
      sql`${at("generation")} = ${receipt.generation}`,
      // 输入身份三位都要对上(`IS` = 认 null 的相等:turnToken / directionToken 可以是 null)。
      sql`${at("identity.turnToken")} IS ${receipt.identity.turnToken}`,
      sql`${at("identity.directionToken")} IS ${receipt.identity.directionToken}`,
      sql`${at("identity.directionEpoch")} IS ${receipt.identity.directionEpoch}`,
      // 单调:定论落下之后不再改;unknown 只占「还没定论」那一格。
      sql`coalesce(${at("acceptance")}, 'unknown') = 'unknown'`,
    ));
}

/**
 * 把这一次输入的协议回执记下来。`stillWaiting` = 回执本体还没落定(有界等待超时了),定论还可能到。
 *
 * 顺序就是要点:定论先进内存、再撤「还在等」、最后落库 —— 任何时刻读的人看见的都是「还在等」
 * 或者「已有定论」,不会落进两者之间那个「通道关了、事实缺席」的空档,被结成说不清。
 */
export async function noteReviewInputAcceptance(
  taskId: string, receipt: ReviewStartReceipt | undefined, acceptance: InputAcceptance, stillWaiting = false,
): Promise<void> {
  if (!receipt) return;
  const key = keyOf(taskId, receipt);
  if (acceptance !== "unknown") unwritten.set(key, acceptance);
  if (stillWaiting) waiting.add(key);
  else waiting.delete(key);
  for (let attempt = 1; ; attempt++) {
    try {
      await persist(taskId, receipt, acceptance);
      unwritten.delete(key);
      return;
    } catch (error) {
      if (attempt >= 3) {
        console.error(`[ash] 任务 ${taskId} 的审查输入回执(${acceptance})没能记到交付凭据上，`
          + "本进程内照它结算；进程没了就按「送没送进去说不清」收尾:", error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/** 回执本体落定成 unknown 或者抛了:这一次输入的定论再也不会到,通道关上。 */
export function closeReviewInputWait(taskId: string, receipt: ReviewStartReceipt | undefined): void {
  if (receipt) waiting.delete(keyOf(taskId, receipt));
}

export type ReviewInputHold = "hold" | "refused" | "unknown";

/**
 * 这一轮**这一代次**最近那一次输入,进没进审查者手里:
 *  · `hold`    —— 还说不清,而且定论还可能到:**别结、别清意图**。收口交给迟到的定论(收下 →
 *    派发了结意图、对账照常结算;拒收 → 派发带着真实原因落终态),或者通道关上。
 *  · `refused` —— 确证一个字都没进去:照常结算,时间线得说真话(不是「没给出结论」)。
 *  · `unknown` —— 说不清,而且再也不会知道了:照常结算,时间线同样照实说;不重投。
 *  · `null`    —— 收下了,或者没有这一代次的凭据(压根没走到 spawn):照原路走。
 */
export function reviewInputHold(
  taskId: string,
  task: Pick<typeof tasks.$inferSelect, "waitOwnership">,
  directory: string,
  generation: string | null | undefined,
): ReviewInputHold | null {
  const delivered = task.waitOwnership?.deliveredReview;
  if (!delivered || delivered.directory !== directory || !generation || delivered.generation !== generation) return null;
  const key = keyOf(taskId, delivered);
  const fact = unwritten.get(key) ?? (delivered.acceptance === "unknown" ? undefined : delivered.acceptance);
  if (fact === "accepted") return null;
  if (fact === "refused") return "refused";
  // 缺席与 unknown 同读:缺席只可能是「写不下来、进程又没了」或者加这一位之前的老凭据 —— 都说不清。
  return waiting.has(key) ? "hold" : "unknown";
}

/** 同上,代次由这里按证据行现读(结算那一侧手上没有权威代次)。 */
export async function reviewInputHoldNow(
  taskId: string, task: Pick<typeof tasks.$inferSelect, "waitOwnership">, directory: string,
): Promise<ReviewInputHold | null> {
  const generation = (await db.select({ generation: regressionEvidence.generation })
    .from(regressionEvidence).where(eq(regressionEvidence.directory, directory))).at(0)?.generation;
  return reviewInputHold(taskId, task, directory, generation);
}

/** 结算/按住时写进时间线的那一句真话(`label` 是「自由工作流第 N 轮」这类前缀)。 */
export function reviewInputNote(input: ReviewInputHold, label: string): string {
  if (input === "hold") {
    return `${label}审查回合已结束，但任务书有没有送进审查者手里，协议层还没给回执；`
      + "这一轮先保持进行中，不判失败也不重投，回执一到自动接着收尾。";
  }
  return input === "refused"
    ? `${label}审查的任务书被协议层明确拒收，审查者一个字都没收到，这一轮按未完成收尾；重跑这一轮即可重新投递。`
    : `${label}审查的任务书送没送进审查者手里说不清（协议层到最后也没给回执），这一轮按未完成收尾；`
      + "为免重复执行没有自动重投，需要的话重跑这一轮。";
}
