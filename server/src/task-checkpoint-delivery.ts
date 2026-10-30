import { and, eq, isNotNull } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages, sessions, tasks } from "./db/schema.js";
import { restoreMonitorCheckpoint } from "./monitor-checkpoint-handoff.js";
import { recoverPendingDelivery } from "./pending-delivery-recovery.js";
import {
  CHECKPOINT_RUN_ORIGIN, checkpointDeliveryVerdict, forgetCheckpointDelivering, noteCheckpointDelivering,
} from "./pending-checkpoint-recovery.js";
import { CROSSING_PROTOCOL, ensureCrossingDir, forgetDeliveryCrossing } from "./delivery-crossing.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { freshRunFailureTarget } from "./turn-failure.js";
import { markSent } from "./pending-messages.js";
import {
  announceResumePrompt, resumePromptHeldBy, resumePromptTakePatch,
} from "./task-resume-prompt.js";
import { describeCheckpointOwner, mintCheckpointOwner } from "./checkpoint-ownership.js";
import { id, now } from "./util.js";

type Row = typeof scheduledMessages.$inferSelect;

/**
 * 认领这段续跑交代,换一张**带在途租约**的凭证。
 *
 * 第一句先建好越线记号的目录:那是整条协议的凭据落点,而且必须赶在产生任何外部效果之前 ——
 * 恢复侧要靠「目录在、这一条不在」构成否证(delivery-crossing.ts 的文件头),目录自己不在时
 * 它什么都证明不了。建不起来就抛:凭据系统坏了,这一轮根本不该开始,交代原样留在任务上。
 */
export async function claimCheckpointForRun(taskId: string, expected: string, generation?: number): Promise<Row | null> {
  ensureCrossingDir(taskId);
  // 凭证的 id **先定下来、先登记所有权,再落库** —— 顺序反过来就是 F1 那条缝:根连接的读
  // 不等别人的事务(db/node-sqlite-client.ts 的 execute),所以这一行刚插进去、`deliveringNow`
  // 还没写上时,并发的恢复一读就看见「有租约、没人管」,按 not-started 归还给任务;而这条路
  // 照旧拿着已被回收的凭证走到 spawn,那段话于是执行两遍(第 1 轮审查 FMGMWUm5TH7E F1 实测:
  // 第一次 CLI 收到 1 次、任务上原文还在,第二次运行 CLI 收到次数变成 2)。
  // 登记在前就没有这个窗口:行一旦可见,所有权就已经在了。
  const messageId = id();
  const owner = mintCheckpointOwner();
  noteCheckpointDelivering(messageId);
  let receipt: Row | null = null;
  try {
    receipt = await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(and(
      eq(tasks.id, taskId), eq(tasks.resumePrompt, expected),
      generation === undefined ? undefined : eq(tasks.resumePromptGeneration, generation),
    ))).at(0);
    if (!task) return null;
    const taken = await transaction.update(tasks).set(resumePromptTakePatch()).where(and(
      eq(tasks.id, taskId), ...resumePromptHeldBy({
        text: expected, generation: task.resumePromptGeneration,
      }),
    )).returning({ id: tasks.id });
    if (!taken.length) return null;
    const stamp = now();
    const logged = await transaction.insert(scheduledMessages).values({
      id: messageId, taskId, text: expected, mode: "queued", status: "canceled",
      origin: CHECKPOINT_RUN_ORIGIN, sendAt: stamp, createdAt: stamp, deliveringSince: stamp,
      // 所有权**身份**,跟租约同一笔落库:接管方据此证明「原发送方已经不在送」,原发送方
      // 据此发现自己已经失权(checkpoint-ownership.ts 的文件头,第 2 轮自由审查 F1)。
      deliveringOwner: owner,
      checkpointTaken: expected, checkpointAuto: task.resumePromptAuto,
      checkpointGeneration: task.resumePromptGeneration,
      // 跟凭证同一笔落库:这张票据受哪一代协议保护,以后谁来读都看得见(F1)。
      crossingProtocol: CROSSING_PROTOCOL,
    }).returning();
      return logged[0]!;
    });
  } finally {
    // 没拿到凭证(交代已经不在任务上了)或者整笔回滚:这条路没有在途投递,所有权当场交回,
    // 否则这个 id 会永远留在登记里(那正是 F2 那类泄漏)。
    if (!receipt) forgetCheckpointDelivering(messageId);
  }
  await announceResumePrompt(taskId);
  return receipt;
}

/**
 * 这张凭证**还是我的吗** —— 起跑资格的最后一问,而且必须是一次**条件写**,不是一次读。
 *
 * 为什么不能是读(第 2 轮自由审查 F1 实测):读回来的是「刚才那一瞬的样子」,拿它当起跑
 * 许可就等于用过期观察授权一次不可逆的投递。现在问法改成「把租约续到此刻,条件是所有权
 * 身份还是我那一个」——0 行 = 我已经失权,这一趟不许起跑。
 *
 * 它自己**不负责**排他:排他来自接管那一侧的证据闸(checkpoint-ownership.ts:活着的发送方
 * 证不出已不在,就不许被接管)。这一问只负责两件事:发现自己已经失权,以及
 * **问不出来时按失权处理** —— 「读不到被回收的证据」不是「仍有起跑权」的证明,而这一步
 * 之后紧接着就是 spawn,宁可这一趟不起跑(凭证原样留着,下一趟对账照旧接得走)。
 */
export async function holdCheckpointOwnership(receipt: Row): Promise<boolean> {
  try {
    const held = await db.update(scheduledMessages).set({ deliveringSince: now() }).where(and(
      eq(scheduledMessages.id, receipt.id),
      // 老库开出来的凭证没有身份,只能退回比租约戳(它那一代就是这个口径)。
      receipt.deliveringOwner === null
        ? eq(scheduledMessages.deliveringSince, receipt.deliveringSince!)
        : eq(scheduledMessages.deliveringOwner, receipt.deliveringOwner),
      isNotNull(scheduledMessages.checkpointTaken),
    )).returning({ id: scheduledMessages.id });
    return held.length > 0;
  } catch (error) {
    console.error(`[ash] 续跑凭证所有权复查失败 task=${receipt.taskId} message=${receipt.id}`
      + `（按已失权处理，这一趟不起跑）:`, error);
    return false;
  }
}

/**
 * 这张票现在还挂在我名下吗 —— 账本副作用之前的那一问(归还、补记、交付不明都经它)。
 *
 * 三态:`mine` / `lost`(已经被别人接管走) / `unknown`(读不出来)。`unknown` 不许当成
 * `mine`:失权方继续写账就是「原文既被归还、又被标成已送达」那一类后果(审查点名的
 * fence 缺口)。
 */
async function checkpointOwnershipState(receipt: Row): Promise<"mine" | "lost" | "unknown"> {
  if (receipt.deliveringOwner === null) return "mine"; // 老库凭证没有身份可比,按原口径继续
  try {
    const current = (await db.select({ owner: scheduledMessages.deliveringOwner })
      .from(scheduledMessages).where(eq(scheduledMessages.id, receipt.id))).at(0);
    if (!current) return "lost";
    return current.owner === receipt.deliveringOwner ? "mine" : "lost";
  } catch {
    return "unknown";
  }
}

/**
 * 送达之后的那一笔确认。
 *
 * **绝不抛、也绝不归还**:走到这里 = 那段话已经喂给 agent 了(orchestrator 在 spawn、落会话
 * 行、原文落盘之后才回调)。这一笔只是记账,写不成就**原地补办** —— 归还等于把已经在执行的
 * 输入重新变成待执行输入,下一次启动再送一遍(第 1 轮审查必须修 3 明确点了这条约束)。
 *
 * 补办期间租约**留着**:它是「有一次投递在途」的唯一凭据,清掉就会被 recoverPendingCheckpoints
 * 当成「没送出去」回填给任务。这段时间启动被拒,拒绝理由由 pendingCheckpointBlockReason 按
 * 「已送达、正在补记」那一档说;进程要是在补办中被换掉,开机那一拍的 reconcileCheckpointDeliveries
 * 会按同一个判据接管下去。
 */
export async function acknowledgeCheckpointRun(receipt: Row, attempts = 0): Promise<void> {
  try {
    await markSent(receipt);
    forgetCheckpointDelivering(receipt.id);
    forgetDeliveryCrossing(receipt.taskId, [receipt.id]);
    if (attempts) console.log(`[ash] 续跑交代确认已补记 task=${receipt.taskId} message=${receipt.id}（第 ${attempts + 1} 次尝试）`);
  } catch (error) {
    if (dbClient.closed) return;
    const delay = Math.min(200 * 2 ** Math.min(attempts, 8), 30_000);
    console.warn(`[ash] 续跑交代确认写入失败 task=${receipt.taskId} message=${receipt.id}`
      + `（原文已送达，${delay}ms 后补记第 ${attempts + 2} 次）:`, error);
    const timer = setTimeout(() => void acknowledgeCheckpointRun(receipt, attempts + 1), delay);
    timer.unref?.();
  }
}

/**
 * 归还。**只走「证明了还没越线」那一档** —— 判定在 `settleStrandedCheckpointRun`,别从别处直接
 * 调它:交付不明的那一档归还一次就是重放一次(第 1 轮审查 F1)。
 */
export async function returnCheckpointRun(receipt: Row): Promise<void> {
  forgetCheckpointDelivering(receipt.id);
  forgetDeliveryCrossing(receipt.taskId, [receipt.id]);
  await recoverPendingDelivery(
    [receipt], new Map([[receipt.id, "检查点续跑尚未送达，续跑交代归还任务"]]),
    [{ restore: () => restoreMonitorCheckpoint(receipt) }], "检查点续跑尚未送达",
  );
}

/**
 * **交付不明**的那一档:原文已经交给 agent 进程了,但这一轮的记账没做完,系统分不清它到底
 * 执行了没有。
 *
 * 两件事都不能做:
 *  · **不归还、不重投** —— 可能已经执行过,再送一遍就是同一段交代执行两遍(F1 实测的那个后果);
 *  · **不永久挂着** —— 租约留着就等于这个任务此后一律起不来,而补记的退避重试活在已经死掉的
 *    那个进程里,新进程没有任何人在推它(D5 的「不永久阻塞」)。
 *
 * 所以就地了结:标 sent(凭证从此不再参与投递与准入),同时留下一条**带原文**的可见交代 ——
 * 「保留可见的交付不明状态等待裁定」。要不要再送一遍是用户的判断,不是系统的猜测;原文在
 * 时间线上,他复制一遍就能再送。
 *
 * `eventKey` 按消息 id 定死:对账在开机那一拍和每次启动前都会跑,这条交代只该出现一次。
 */
export async function settleUncertainCheckpointRun(receipt: Row, attempts = 0): Promise<void> {
  try {
    // **发布成功是消费凭证的前提。** `appendTaskTimeline` 是尽力而为的:它把异常 catch 掉、
    // 返回 false(task-timeline.ts)。早先这里只看第一次的返回值、补办那一次的返回值压根没
    // 接,于是对话文件写不下去(目录不可写、配额满)时,那条带原文的裁定记录一个字都没发布
    // 出去,而 markSent + 删记号已经把恢复责任永久消费掉 —— 用户再也看不到原文,对账也不会
    // 再扫到它(第 2 轮自由审查 F4)。`eventKey` 只保证去重,不保证发布成功。
    if (!await publishUncertainRecord(receipt)) throw new Error("带原文的交付不明记录没有发布成功");
    await markSent(receipt);
    forgetCheckpointDelivering(receipt.id);
    forgetDeliveryCrossing(receipt.taskId, [receipt.id]);
    console.warn(`[ash] 续跑交代交付不明 task=${receipt.taskId} message=${receipt.id}：`
      + `越过 spawn 但没落下会话行，已就地结成可见记录，不自动重投${attempts ? `（第 ${attempts + 1} 次尝试）` : ""}`);
  } catch (error) {
    if (dbClient.closed) return;
    // 一个字都不消费:租约留着(它是「这张凭证还没了结」的唯一凭据)、记号留着(它是
    // 「越过线了」的唯一凭据)。退避重试;进程要是在重试中被换掉,开机那一拍与每次启动前的
    // 对账会按同一判据接着办(verdict 仍是 uncertain)。
    const delay = Math.min(200 * 2 ** Math.min(attempts, 8), 30_000);
    console.warn(`[ash] 续跑交代交付不明的可见记录没发布成功 task=${receipt.taskId} message=${receipt.id}`
      + `（凭证原样留着，${delay}ms 后重试第 ${attempts + 2} 次）:`, error);
    const timer = setTimeout(() => void settleUncertainCheckpointRun(receipt, attempts + 1), delay);
    timer.unref?.();
  }
}

/**
 * 那条**带原文**的可见记录。返回值 = 它到底有没有发布出去。
 *
 * 写不进去有两种成因,得分开:**这个任务一条会话都没有**(交代是在它从没跑过时写上去的)
 * 要先开一行诊断会话再写;**对话文件这会儿写不下去**(目录不可写、配额满)则只能如实回
 * false 等重试 —— 不能每重试一次就新开一行诊断会话,那会在任务里堆出一串空会话。
 *
 * 任务行本身都没了是唯一的例外:那时既没有「用户看得见的地方」,这张凭证也不再挡着谁 ——
 * 原文打进日志后就地了结,不做无意义的无限重试。
 */
async function publishUncertainRecord(receipt: Row): Promise<boolean> {
  const text = receipt.checkpointTaken ?? receipt.text;
  const note = "〔系统〕这一轮的续跑交代**可能已经**交给 agent 进程了（越线记号还在，或者那张"
    + "记号这会儿读不出来），而「已送达」那一笔没来得及记下（进程在交出输入和落账之间被换掉了）。"
    + "系统分不清它到底执行了没有，所以**不会自动再送一遍** —— 同一段交代执行两遍的代价比晚一点"
    + "更大。原文留在下面，要不要再送由你决定：\n\n"
    + `> ${text.split("\n").join("\n> ")}`;
  const target = { eventKey: `checkpoint-uncertain:${receipt.id}` };
  if (await appendTaskTimeline(receipt.taskId, note, target)) return true;
  const opened = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.taskId, receipt.taskId));
  if (opened.length) return false;
  const task = (await db.select().from(tasks).where(eq(tasks.id, receipt.taskId))).at(0);
  if (!task) {
    console.error(`[ash] 续跑交代交付不明、又无处落账 task=${receipt.taskId}，原文:`, text);
    return true;
  }
  return appendTaskTimeline(receipt.taskId, note, { ...await freshRunFailureTarget(task, null), ...target });
}

/**
 * 「证据读不出来」那条路的**退避代次**,按凭证记。
 *
 * 为什么不能只靠参数(第 2 轮自由审查 N6):计时器回调要先绕一趟 `reconcileCheckpointDeliveries`
 * 才回到这里,`attempts` 在那一跳上丢掉 —— 于是持续故障时每一轮又从 0 起,恒为 200ms,
 * 既没有真正的退避,还会把日志和读取压力按故障时长线性放大。记在这里,代次就跨得过那一跳;
 * 判定一旦读得动(或者这张票了结)就删掉。
 */
const settleRetries = new Map<string, number>();

/**
 * 交回所有权 + 退避重排一趟对账,**一个字都不消费**(租约与越线记号原样留着)。
 *
 * 交回是前提:不交回的话,下一趟对账会把它当成「还有发送方」跳过,任务从此起不来,只有
 * 重启能解(第 1 轮审查 F2 定点实测)。接管方经证据闸 + 条件更新接手,不会跟谁撞。
 */
function rescheduleCheckpointSettle(receipt: Row, why: string, attempts: number, error: unknown): void {
  forgetCheckpointDelivering(receipt.id);
  if (dbClient.closed) return;
  const attempt = Math.max(attempts, settleRetries.get(receipt.id) ?? 0);
  settleRetries.set(receipt.id, attempt + 1);
  const delay = Math.min(200 * 2 ** Math.min(attempt, 8), 30_000);
  const head = `[ash] ${why} task=${receipt.taskId} message=${receipt.id}：`;
  console.warn(`${head}这一问读不出来（所有权已交回，${delay}ms 后第 ${attempt + 2} 次对账）:`, error);
  const timer = setTimeout(() => void (async () => {
    const { reconcileCheckpointDeliveries } = await import("./pending-checkpoint-recovery.js");
    await reconcileCheckpointDeliveries(receipt.taskId);
  })().catch((retryError) => console.error(`${head}重排对账失败:`, retryError)), delay);
  timer.unref?.();
}

/**
 * 一张**带着在途租约、却没人在送**的凭证该怎么收场 —— 三态判定与三条出路收在这一个函数里。
 *
 * 所有入口都必须经过它:进程内的 `finally`(task-resume.ts)、开机那一拍与每次启动前的对账
 * (pending-checkpoint-recovery.ts)。早先各处自己写「送到了吗」的布尔判断,于是同一条缝在
 * 四个地方各错一遍(第 1 轮审查 F1 点名的同类入口)。
 */
export async function settleStrandedCheckpointRun(receipt: Row, why: string,
  /** 调用方**确知**这一轮一个字都没送出去(continueTask 返回 false:起跑前被冻结闸撤回、
   *  或者越线凭据根本写不下来)。那是比任何事后读取都强的否证,直接归还。 */
  notLaunched = false, attempts = 0): Promise<void> {
  // **失权方不许再写账**(第 2 轮自由审查 F1 的第 5 条):这个出口会归还、会补记、会就地
  // 了结 —— 三种都在改那张票和任务上的交代。票已经不在我名下时一个字都不许动:那边可能
  // 已经按别的结论处置过了,再写一遍就是「原文既被归还、又被标成已送达」。
  const held = await checkpointOwnershipState(receipt);
  if (held === "lost") {
    console.warn(`[ash] ${why} task=${receipt.taskId} message=${receipt.id}：`
      + `这张续跑凭证已经由 ${describeCheckpointOwner(receipt.deliveringOwner)} 之外的人接管，这一趟不再处置它`);
    forgetCheckpointDelivering(receipt.id);
    return;
  }
  if (held === "unknown") {
    // 读不出来跟下面「判定读不出来」是同一档:交回所有权 + 退避重排,一个字都不消费。
    rescheduleCheckpointSettle(receipt, why, attempts, new Error("所有权归属读不出来"));
    return;
  }
  if (notLaunched) {
    console.warn(`[ash] ${why} task=${receipt.taskId} message=${receipt.id}：这一轮在 spawn 之前就撤回了，归还给任务`);
    await returnCheckpointRun(receipt);
    return;
  }
  const head = `[ash] ${why} task=${receipt.taskId} message=${receipt.id}：`;
  let verdict: Awaited<ReturnType<typeof checkpointDeliveryVerdict>>;
  try {
    verdict = await checkpointDeliveryVerdict(receipt);
  } catch (error) {
    // 判定自己读不出来(库锁、I/O 故障):**这一档也必须有人接着办**。早先这个异常直接穿出去,
    // 而登记里那条「正在送」的所有权留在原地 —— 此后每一趟对账都把它当成「还有发送方」跳过,
    // 任务从此起不来,只有重启能解(第 1 轮审查 FMGMWUm5TH7E F2 定点实测)。
    // 所以:所有权当场交回(下一趟对账接得走,它经 CAS 接管,不会跟谁撞),再自己退避重排
    // 一趟对账 —— 不必非等用户再点一次运行。一个字都不消费:租约和记号都原样留着。
    rescheduleCheckpointSettle(receipt, why, attempts, error);
    return;
  }
  // 判定读得动了:这张票的退避代次清零(下一次故障重新从头退避)。
  settleRetries.delete(receipt.id);
  if (verdict === "delivered") {
    console.warn(`${head}原文已送达（租约之后有回合开起来过），补记这一笔确认`);
    await acknowledgeCheckpointRun(receipt);
    return;
  }
  if (verdict === "uncertain") {
    console.warn(`${head}越线记号没能给出否证、这一轮又没落下会话行 —— 交付不明，就地结成可见记录`);
    await settleUncertainCheckpointRun(receipt);
    return;
  }
  console.warn(`${head}越线记号给出否证、回合行也没有（证明没送出去），归还给任务`);
  await returnCheckpointRun(receipt);
}
