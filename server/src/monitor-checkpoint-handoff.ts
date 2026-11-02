// 「哨兵叫醒的那一轮，要把 agent 当初留给自己的那段续跑交代一起喂回去」这一摊 —— 那段文字在
// **任务行 ↔ 待发送消息**之间的转手。
//
// 从 `monitor-session.ts` 分出来的理由是行数（那边连这一摊是 704 行，超过单文件 700 行的约定）
// 和职责：那边回答「这条事件该不该唤醒任务、唤醒谁」，这一份只回答「那段交代此刻归谁、怎么交、
// 没送出去怎么退回」。两边的交界只有一个函数（`monitorWakeCheckpoint`，投递链路的唯一入口）。
//
// 这一摊的不变量全都写在各自函数的注释里，只有一条是跨函数的，写在这儿：
//
//   **转手的凭证是 `{文字, 来源, 占用代次}` 三样，一起落账、一起退回。**
//
// 来源（`tasks.resume_prompt_auto`）只在文字还在那一格里时有意义，所以它不能留在任务行上等文
// 字回来 —— 那一格可能被另一段文字占用过又腾空（见 task-resume-prompt.ts 文件头的两版历史与
// 第 2 轮审查 F2 的双向实测）。代次（`resume_prompt_generation`）是归属本体：代次变了，这张凭
// 证就此过期，那段文字不许再填回去。
import { and, eq, exists, isNull, ne, sql } from "drizzle-orm";
import { monitorIdFromOrigin } from "@ash/shared/monitor";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import {
  announceResumePrompt, resumePromptHeldBy, resumePromptRestorePatch, resumePromptSlotFor,
  resumePromptTakePatch, type StoredResumePromptReceipt,
} from "./task-resume-prompt.js";
import { appendTaskTimeline } from "./task-timeline.js";

/**
 * 哨兵把任务叫醒的那一轮，要把 agent 当初**留给自己**的那段续跑交代一起喂回去。
 *
 * `start_monitor` 的说明就是这么许诺 agent 的：「起了哨兵的那一轮用 pause_task 收尾，
 * resumePrompt 写清被哨兵叫醒后该干什么」。但哨兵事件走的是投递链路（`byBackend`），而
 * 消费检查点那一条只认真人消息（见 orchestrator 里 `takeResumePrompt` 那一处的条件），
 * 于是两件事都落空了：
 * - agent 收到的只有一行事件，自己写的交代一个字都看不到；
 * - 那段交代**永远留在库里**，任务从此显示「在等续跑」，派审 / 预约 / 修复 / 预览整排
 *   按钮被那条门禁灰掉，`startFreeReview` 也一直 409（见 task-resume-prompt.ts 顶部）。
 *   审查者按说明 pause 一轮等套件，结论给完了任务还是卡着。
 *
 * ── 为什么是「先取走，没送出去再回填」而不是「送达后再取走」────────────────────
 *
 * 跟既有的检查点续跑同一套（`task-resume.ts`：`takeResumePrompt` → 起跑失败
 * `restoreResumePrompt`）。送达后才取走的写法有一个修不掉的窗口：`markSent` 已经落库、
 * 取走那一步却失败（库忙、进程正好被换掉），于是消息是 sent、交代还在 —— 没有任何人会
 * 再来清它，任务做完了仍被结算判成 paused，工具条整排按钮继续灰着（第 1 轮审查 F4 第 3
 * 种）。而那一步的失败又被 `onDelivered` 的 catch 当作记账错误吞掉，连日志都没有。
 *
 * 反过来「先取走」留下的窗口是「取走了但一个字没送出去」，那一种**有补偿**：`restore` 的
 * CAS 只填回自己腾出的那个空，agent 中途写了新的一段就不动它。所以这里只提供 `take` 和
 * `restore`，没有 `consume` —— 调用方必须在未送达的每条出路上回填（见两处投递点）。
 */
/**
 * 账本上那张凭证就是 `StoredResumePromptReceipt`（存量行的来源与代次可能是 NULL）。**归属条件
 * 和要写的列一律由 task-resume-prompt.ts 给**，这里不再自己拼一份：那两份口径只要有一处漂移，
 * 漂的就是「这段话是谁的」—— 第 3 轮审查前，这边把「代次未知」解释成了「对任意新代次都有效」。
 */
const ledgerReceipt = (m: {
  checkpointTaken: string | null; checkpointAuto?: boolean | null; checkpointGeneration?: number | null;
}): StoredResumePromptReceipt => ({
  text: m.checkpointTaken ?? "",
  auto: m.checkpointAuto ?? null,
  generation: m.checkpointGeneration ?? null,
});

export async function restoreMonitorCheckpoint(message: {
  id: string; taskId: string; checkpointTaken: string | null;
  checkpointAuto?: boolean | null; checkpointGeneration?: number | null;
}): Promise<void> {
  if (message.checkpointTaken !== null) await restoreCheckpoint(message, ledgerReceipt(message));
}

export async function monitorWakeCheckpoint(
  message: {
    id: string; taskId: string; origin: string | null; text: string;
    checkpointTaken: string | null;
    // 随身凭证（见 schema.ts 的 checkpoint_auto）。**存量行是 NULL** —— 那种只能退化成旧口径
    // （只填空槽、不碰来源列），所以两列都按 `| null` 处理，不许在这里拿缺省值冒充事实。
    checkpointAuto?: boolean | null; checkpointGeneration?: number | null;
  },
): Promise<{ text: string; checkpoint: string; restore: () => Promise<void> } | null> {
  if (dbClient.closed || monitorIdFromOrigin(message.origin) === null) return null;
  // **重投**(上一次取走了交代、却一个字没送出去:进程正好没了、送达报错):账本列记着是
  // 哪一段,不再取第二次。拼接在内存里当场做,所以这一次带上的是**此刻**的事件正文——
  // 期间合并进来的新事件一并带走,而不是上一次那一份快照。
  if (message.checkpointTaken) {
    // 重投(进程换过一次,首次调用的内存闭包早没了):**凭证从账本上来**。
    //
    // 第一版在这里硬写 `auto: false`,于是持久重投一趟就把系统等待洗成「agent 自己写的」,
    // 此后永不自动清理（第 1 轮审查 F2）。第二版改成「不碰来源列,靠任务行上那一格的休眠值
    // 自动对上」—— 而那一格可能已经被另一段文字占用过又腾空,于是继承到别人的来源
    // （第 2 轮审查 F2,两个方向都实测到）。所以来源和代次跟文字一起落在账本上,这里原样取回。
    const receipt = ledgerReceipt(message);
    return { text: withCheckpoint(message.text, receipt.text), checkpoint: receipt.text, restore: () => restoreCheckpoint(message, receipt) };
  }
  const slot = (await db
    .select({
      resumePrompt: tasks.resumePrompt,
      auto: tasks.resumePromptAuto,
      generation: tasks.resumePromptGeneration,
    })
    .from(tasks)
    .where(eq(tasks.id, message.taskId))).at(0);
  const checkpoint = slot?.resumePrompt;
  if (!checkpoint || !slot) return null;
  // 这一刻读到的三样就是凭证本体:文字、来源、占用代次。下面的转手把它们一起落到账本上,
  // **而且转手的两条语句都按这三样认人**(见下面的 heldByUs)。
  const receipt = { text: checkpoint, auto: slot.auto, generation: slot.generation };
  // ── 取走:**两条语句互为对方的生效条件** ──────────────────────────────────────
  //
  // 一笔交代的转手是「任务行上腾空」+「这条消息认下这笔账」两半,少任何一半都是错的:
  // - 只腾空不落账:那段话只活在返回值这个内存字符串里,进程一没就两边都查不到它(第 2 轮 F4);
  // - 只落账不腾空:同一段交代会被喂两遍(任务行上它还在,下一条消息、真人续跑都会再取一次)。
  //
  // `db.batch` 是一个 BEGIN…COMMIT、中间没有 await,但**同批提交并不等于两条都命中**——
  // 各自的 CAS 是各自判的,一条命中一条落空照样整批提交(第 3 轮审查 F3)。所以条件不能各写
  // 各的,要互相引用:① 认账的前提是「任务行上那一段还在」,② 腾空的前提是「账已经认在这条
  // 消息上」。①先跑,于是只有两种结局——都中(真的转手成功),或者都不中(库里一个字没动)。
  // 不对称的回滚因此不在提交之后发生,而是**压根提交不出来**,下面那条只是个会出声的兜底。
  // **判据是「文字 + 代次」而不是只有文字**（第 3 轮审查 F1-B）：同一段话被另一路取走、又被
  // 原样写成一段新的主动暂停时，只比文字照样命中 —— 于是清掉的是**新**的那一段，账本上记的
  // 却是**旧**的来源和代次（实测 `F2_SAME_TEXT_ABA_WRONG_RECEIPT`，随后回填被代次挡住、账本
  // 也清了，新暂停两边都没了）。条件由存储层给，两条语句共用同一份。
  const heldByUs = resumePromptHeldBy(receipt);
  const checkpointStillHere = exists(db.select({ one: sql`1` }).from(tasks)
    .where(and(eq(tasks.id, message.taskId), ...heldByUs)));
  const ledgerOurs = exists(db.select({ one: sql`1` }).from(scheduledMessages)
    .where(and(eq(scheduledMessages.id, message.id), eq(scheduledMessages.checkpointTaken, checkpoint))));
  const [logged, taken] = await db.batch([
    // **文字、来源、代次同一笔落账**:少任何一样,重投那一趟就只能靠猜(第 2 轮审查 F2)。
    db.update(scheduledMessages)
      .set({ checkpointTaken: checkpoint, checkpointAuto: receipt.auto, checkpointGeneration: receipt.generation })
      .where(and(
        eq(scheduledMessages.id, message.id),
        isNull(scheduledMessages.checkpointTaken),
        checkpointStillHere,
      ))
      .returning({ id: scheduledMessages.id }),
    // 来源列不碰、代次也不动:取走不是一次新的占用,这段文字的来源在凭证里跟着走。
    db.update(tasks).set(resumePromptTakePatch())
      .where(and(eq(tasks.id, message.taskId), ...heldByUs, ledgerOurs))
      .returning({ id: tasks.id }),
  ]);
  if (!logged.length || !taken.length) {
    // 都不中 = 读到之后、批跑到之前另一路(真人续跑、手点运行)先取走了同一段,或者这条消息
    // 已经不是那个样子了。什么都没变,直接不带交代走。
    // 单侧命中按上面的条件推不出来,真出现就是条件被改坏了:出声,并把那一侧退回去。
    if (logged.length !== taken.length) await unwindHalfTake(message, receipt, logged.length > 0);
    return null;
  }
  await announceResumePrompt(message.taskId);
  return {
    text: withCheckpoint(message.text, checkpoint),
    checkpoint,
    restore: () => restoreCheckpoint(message, receipt),
  };
}

/**
 * 交代**只持久在 `scheduled_messages.checkpoint_taken` 这一列**,喂出去的样子是送达前在内存
 * 里拼的(第 3 轮审查 F2)。
 *
 * 曾经是反过来的——取走时把它拼进 `text` 落库,回填时按后缀把它剥掉。两个毛病:
 * ① 剥的依据是「正文以这个后缀结尾」,而投递那一程里新事件会被合并追加到正文末尾,后缀就
 *    不在末尾了,于是剥不掉(交代留在正文里)或者连带新事件一起被切掉;
 * ② 回填整条 `text` 覆写,期间合并进来的事件直接没了。
 * 现在正文归事件、交代归账本列,两者互不覆盖,拼接是纯函数。
 */
const withCheckpoint = (text: string, checkpoint: string) =>
  `${text}\n\n【你当初留下的续跑交代】${checkpoint}`;

/** 不该发生的单侧命中(见上)。退回那一侧,并且一定要出声。 */
async function unwindHalfTake(
  message: { id: string; taskId: string },
  receipt: StoredResumePromptReceipt,
  loggedOnly: boolean,
): Promise<void> {
  const checkpoint = receipt.text;
  console.error(
    `[ash] 续跑交代转手出现单侧命中 ${message.taskId}/${message.id}(${loggedOnly ? "只落账" : "只腾空"}),`
    + "这说明两条语句的互相引用被改坏了",
  );
  try {
    if (loggedOnly) {
      await db.update(scheduledMessages)
        .set({ checkpointTaken: null, checkpointAuto: null, checkpointGeneration: null })
        .where(and(eq(scheduledMessages.id, message.id), eq(scheduledMessages.checkpointTaken, checkpoint)));
    } else {
      // 凭证原样退回（来源 + 代次条件一起带上，见文件里 `slotFor`）：这一格可能已经被另一段
      // 文字占用过又腾空，只认「空着」会把这段文字填到别人的来源上（第 2 轮审查 F2）。
      await db.update(tasks).set(resumePromptRestorePatch(receipt))
        .where(and(eq(tasks.id, message.taskId), ...resumePromptSlotFor(receipt)));
    }
  } catch (error) {
    console.error(`[ash] 单侧命中退回也失败 ${message.taskId}:`, error);
  }
}

/**
 * 一个字都没送出去 ⇒ 那段交代白取了,**账本清空、任务行上填回**,于是下一次投递重新取一次。
 *
 * 回退**不碰正文**(交代从来没写进去),所以这一程里合并进来的新事件不可能被它覆盖。
 *
 * 另一半的资格是「这笔账此刻还归我们管」:账本列还指着这一段、而且**没有别人正在送它**
 * (租约空着、还没 sent)。投递失败时租约已经由 `abortDelivery` 让出去了,期间被别人抢走就
 * 轮不到我们退——那一位走的是上面的重投分支,它自己没送出去时会再退一次(第 3 轮审查 F2:
 * 别在失去写入所有权之后回退)。
 *
 * 退不动也不丢:账本列还指着它,下一次投递照旧走重投分支带着它走。所以这里失败的唯一后果是
 * 「任务行上那一格暂时空着」—— 静默吞掉就等于谁也不知道(第 2 轮审查 F4),所以留一条时间线。
 */
async function restoreCheckpoint(
  message: { id: string; taskId: string },
  receipt: StoredResumePromptReceipt,
): Promise<void> {
  const checkpoint = receipt.text;
  // **归属判据只有一条,两条语句共用它**:这笔账此刻还记在这条消息上、而且没有别人正在送它。
  //
  // 原来填回任务行问的是「账本现在空着」。那句话在「另一份更新的 restore 已经归还、那一段又
  // 已经被真人续跑消费掉」之后同样成立 —— 于是一个过期的 restore 能把它凭空复活
  // (第 4 轮审查 N3 函数层实测 `N3_FUNCTION_STALE_RESTORE_RESURRECTS`)。「账本空着」证明
  // 不了「是我清的」,只有「账本还写着我这一段」才是归属本体。
  const ledgerOurs = and(
    eq(scheduledMessages.id, message.id),
    eq(scheduledMessages.checkpointTaken, checkpoint),
    receipt.auto === null ? isNull(scheduledMessages.checkpointAuto) : eq(scheduledMessages.checkpointAuto, receipt.auto),
    receipt.generation === null ? isNull(scheduledMessages.checkpointGeneration) : eq(scheduledMessages.checkpointGeneration, receipt.generation),
    isNull(scheduledMessages.deliveringSince),
    ne(scheduledMessages.status, "sent"),
  );
  try {
    const [restored, cleared] = await db.batch([
      // 先填回(此刻账本还写着我们这一段),再清账 —— 顺序反过来,下面那个 EXISTS 就只能看到
      // 被自己清空的账本,又退回「空着 = 是我清的」那个推不出来的结论。
      // CAS:只填回自己腾出的那个空。agent 中途写了新的一段就不动它——那一段才是最新交代,
      // 下一次投递会取它。
      // **归属有两半**:账本还记在这条消息上(下面那个 EXISTS),而且这一格还是同一次占用
      // (`slotFor` 里的代次)。只认前一半的话,期间被另一段文字占用过又腾空时,这段文字会连
      // 来源一起错位(第 2 轮审查 F2)。
      db.update(tasks).set(resumePromptRestorePatch(receipt))
        .where(and(
          eq(tasks.id, message.taskId),
          ...resumePromptSlotFor(receipt),
          exists(db.select({ one: sql`1` }).from(scheduledMessages).where(ledgerOurs)),
        ))
        .returning({ id: tasks.id }),
      // 账本清空时把凭证两列一起收掉:留着就是一份指向不存在的转手的残影。
      db.update(scheduledMessages)
        .set({ checkpointTaken: null, checkpointAuto: null, checkpointGeneration: null })
        .where(ledgerOurs)
        .returning({ id: scheduledMessages.id }),
    ]);
    if (!cleared.length) return; // 这笔账已经不归我们了(别人接手/已送出),什么都不做
    if (restored.length) {
      await announceResumePrompt(message.taskId);
      return;
    }
    // 账本归我们、却**填不回去**:这期间那一格被另一段续跑指令占用过(代次变了),或者此刻正
    // 占着。那一段才是最新意图,所以这段话就此作废 —— 但不许静默作废:agent 自己留给自己的
    // 交代就这么没了,用户刷新页面后应该看得出发生过这件事(第 2 轮审查 F2 的后果面)。
    await appendTaskTimeline(
      message.taskId,
      `那条哨兵事件带走的续跑交代没有放回任务行：这期间已经有另一段续跑指令占用过那一格，`
      + `后写的那一段才是最新意图，所以这一段就此作废（原文：${checkpoint.slice(0, 120)}`
      + `${checkpoint.length > 120 ? "…" : ""}）。`,
    ).catch(() => {});
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[ash] 续跑交代回填失败 ${message.taskId}:`, error);
    await appendTaskTimeline(
      message.taskId,
      `续跑交代没能放回任务行（${detail}）。它仍记在那条待发送的哨兵事件的账本列上，下一次投递会带着它走。`,
    ).catch(() => {});
    throw error;
  }
}
