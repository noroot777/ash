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
// **按住多久**:一直按住。unknown 既不是送到了、也不是没送到,本地的任何观察都换不来这个协议
// 事实 —— 回执落定成 unknown、回执本体抛了、进程重启之后谁都等不到它,都只说明「再也不会知道」,
// 不说明结果(自由审查第 2 轮 R1,以及再下一次审查的 R1:上一版在「通道关了」之后照常结成失败,
// 仍是拿本地可观测性顶替协议事实)。所以结算永不把它结掉,补办也不清它的意图(那份意图就是「这件事还没了」的持久
// 记号),更不自动重投(可能重复执行)。分两档只为说清楚**接下来靠谁**:
//   · 定论还可能到(回执本体还悬着,登记在本进程的 `waiting` 里):靠迟到的定论自动收口;
//   · 再也不会到:**交给用户**。这一轮停在「等你拿主意」(free-review-round.ts 的
//     `reviewAwaitsInputDecision`),会话底部
//     那颗「继续本轮审查」照常可点 —— 重投是用户知情之后的显式决定,不是系统替他猜的。
//
// **身份**(第 2 轮自由审查 R2):同一轮审查的多次续跑(答复提问、检查点续跑)共用目录与代次,
// 每一次输入却各有自己的 turnToken/directionToken/directionEpoch。回执只属于产生它的那一次输入:
// 写入在同一条 UPDATE 的 WHERE 里核完整输入身份,前一次输入迟到的定论写不进后一次的凭据;读取先核
// 权威代次,上一代次的凭据不当这一代的事实读。
//
// **写不下来**(同上 R1):凭据在 spawn 那一笔就带着显式的 unknown;协议事实先进内存(`unwritten`),
// 再落库;库写失败就留在内存里供本进程读。进程没了它才随之消失 —— 库里剩下的是 unknown,读成说
// 不清,同样按住、交给用户。
//
// **缺席 = unknown**(下一次审查第 2 轮 R2):加这一位之前落下的老凭据没有 acceptance。缺席不是
// 「收下了」,只是「当时没记」—— 照老口径放行,补办会清掉意图、下一拍对账把这一轮结成失败,正是
// 上面那条不变量要防的事。所以只有真实的 accepted/refused 定论能离开说不清,老数据也一样。
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { regressionEvidence, tasks } from "./db/schema.js";
import type { InputAcceptance } from "./executors/types.js";
import type { ReviewStartReceipt } from "./review-start-withdrawal.js";
import { appendTaskTimeline } from "./task-timeline.js";

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

/**
 * 这一次输入此刻还是不是这一轮(`directory` 的 `generation` 那一次)**当前**的输入 —— 一句迟到的
 * 定论能不能越过它自己那次输入去动整轮状态的判据(free-review-round.ts 的 `failReviewStart` 在
 * 写终态的同一个事务里问)。两问缺一不可:
 *  · 交付凭据记的仍是这一次:目录、代次、输入身份三位全对上。同一轮的答复/检查点续跑共用目录与
 *    代次,只有输入身份分得清;
 *  · 也没有下一次输入正在起跑:起跑到落凭据之间,凭据还停在上一次,那段窗口里唯一的持久痕迹是
 *    `start`(guarded-turn-start.ts)—— 它在就必须也是这一次。
 * `input` 为 null(拒收那一侧说不清是哪一次)不放行。
 */
export function reviewInputStillCurrent(
  task: Pick<typeof tasks.$inferSelect, "waitOwnership"> | undefined,
  input: ReviewStartReceipt | null, directory: string, generation: string,
): boolean {
  const { deliveredReview: delivered, start } = task?.waitOwnership ?? {};
  if (!input || !delivered || input.directory !== directory || input.generation !== generation) return false;
  const same = (other: Pick<Delivered, "directory" | "generation" | "identity">) =>
    keyOf("", other) === keyOf("", input);
  return same(delivered) && (!start || same(start));
}

/** 回执本体落定成 unknown 或者抛了:这一次输入的定论再也不会到,通道关上。 */
export function closeReviewInputWait(taskId: string, receipt: ReviewStartReceipt | undefined): void {
  if (receipt) waiting.delete(keyOf(taskId, receipt));
}

export type ReviewInputHold = "hold" | "unconfirmed" | "refused";

/**
 * 这一轮**这一代次**最近那一次输入,进没进审查者手里:
 *  · `hold`        —— 还说不清,定论还可能到:**别结、别清意图**。收口交给迟到的定论(收下 →
 *    派发了结意图、对账照常结算;拒收 → 派发带着真实原因落终态)。
 *  · `unconfirmed` —— 说不清,而且再也不会知道了:同样别结、别清意图、别重投,等用户拿主意。
 *  · `refused`     —— 确证一个字都没进去:照常结算,时间线得说真话(不是「没给出结论」)。
 *  · `null`        —— 收下了,或者没有这一代次的凭据(压根没走到 spawn):照原路走。
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
  // 缺席(老凭据)与 unknown 同读:都不是定论(见文件头「缺席 = unknown」)。
  const fact = unwritten.get(key) ?? (delivered.acceptance === "accepted" || delivered.acceptance === "refused"
    ? delivered.acceptance : undefined);
  if (fact === "accepted") return null;
  if (fact === "refused") return "refused";
  return waiting.has(key) ? "hold" : "unconfirmed";
}

/** 同上,代次由这里按证据行现读(结算那一侧手上没有权威代次)。 */
export async function reviewInputHoldNow(
  taskId: string, task: Pick<typeof tasks.$inferSelect, "waitOwnership">, directory: string,
): Promise<ReviewInputHold | null> {
  const generation = (await db.select({ generation: regressionEvidence.generation })
    .from(regressionEvidence).where(eq(regressionEvidence.directory, directory))).at(0)?.generation;
  return reviewInputHold(taskId, task, directory, generation);
}

/**
 * 把这一档写进时间线(刷新后还看得见「为什么还挂着 / 为什么没结论」)。同一次输入的同一档只写
 * 一次:结算与补办两头都会走到这里,周期对账也会反复走到。
 */
export async function noteReviewInput(
  task: Pick<typeof tasks.$inferSelect, "id" | "waitOwnership">,
  run: { targetKind: string | null; currentRound: number }, directory: string, input: ReviewInputHold,
): Promise<void> {
  const delivered = task.waitOwnership?.deliveredReview;
  await appendTaskTimeline(task.id, reviewInputNote(input,
    run.targetKind === "accepted_merge" ? "合并结果" : `自由工作流第 ${run.currentRound} 轮`),
  { eventKey: `review-input-${input}:${directory}:${delivered?.generation}:${JSON.stringify(delivered?.identity)}` });
}

/** 结算/按住时写进时间线的那一句真话(`label` 是「自由工作流第 N 轮」这类前缀)。 */
export function reviewInputNote(input: ReviewInputHold, label: string): string {
  if (input === "hold") {
    return `${label}审查回合已结束，但任务书有没有送进审查者手里，协议层还没给回执；`
      + "这一轮先保持进行中，不判失败也不重投，回执一到自动接着收尾。";
  }
  return input === "refused"
    ? `${label}审查的任务书被协议层明确拒收，审查者一个字都没收到，这一轮按未完成收尾；重跑这一轮即可重新投递。`
    : `${label}审查的任务书有没有送进审查者手里，已经确认不了（协议层到最后也没给回执）。这一轮保持进行中，`
      + "不判失败，也不自动重投（可能重复执行）；要重新投递，请点审查会话底部的「继续本轮审查」。";
}
