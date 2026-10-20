// tasks.resume_prompt（检查点续跑指令）的两个 CAS 写入助手，外加它们共用的整行广播。
//
// 单独成文件是因为这一列有个别处没有的性质：**前端拿它当门禁读**。resumePrompt 非空 =
// 「任务在等续跑」，自由工作流工具条（web/src/free-workflow/FreeWorkflowToolbar.tsx 的
// waiting）据此把派审 / 预约 / 修复 / 打开预览整排按钮禁掉，后端 startFreeReview 与手动
// 修复也卡同一条判据（409）。而 SSE 只有 task.status / task.question / task.stage /
// task.title 这几种**局部**事件，没有一条带 resume_prompt；任务列表也只在首次加载和断线
// 重连时整表拉一次（web/src/lib/useTasks.ts，没有轮询）。于是直接 db.update 改这一列，
// 长开着的页面就永久停在旧值：
//   - 清空不广播 → 该亮的按钮一直灰。接力移回实测：导入把「接力前言」写进 resume_prompt
//     并广播了整行，0.13 秒后自动续跑把它取走却没广播，页面一直灰到用户手动刷新。
//   - 写入不广播 → 该灰的按钮一直亮，点下去吃后端 409。
// 复合更新里顺手改到这一列（结算、原生引导的清场与回滚）用不上下面的 CAS 助手，那些地方
// 直接调 announceResumePrompt 补一条广播。
//
// **它还有个同伴列 `resume_prompt_auto`：这一段话是谁写的。**
// `false`/缺省 = agent 自己 `pause_task` 写的（或真人塞的）；`true` = 系统替它写下的等待
// （目前只有一种来源：哨兵拦下了这一轮的完成，见 task-complete.ts）。分开记是因为两者的
// **有效期不同**：系统写的那段在「它等的东西没了」之后必须清掉（否则任务永远停在 paused
// 等一个再也不会来的唤醒，第 2 轮审查 R2-2 实测），而 agent 自己写的那段谁也不许抹。
//
// ## 口径：**凭证随身**（取走的那一位拿着 `{text, auto, generation}`，退回时三样一起带回来）
//
// 这一列的来源只在 `resume_prompt` 非空时有意义，所以前两版都在想办法「让来源跟着文字走」：
//
//  · 第一版「凡是写 resume_prompt 的地方都同时写来源」—— 靠自觉在十来个点上带对一个布尔，
//    第 1 轮审查从三个点走穿（账本只存文字、运行冲突的退回漏了来源、跨机载荷里压根没这一列）。
//  · 第二版「取走/退回一个字都不碰它，那一格休眠着等文字回来」—— 看着守得住，但它只在**中间
//    没有别的写入**时成立：槽可以被另一段文字占用、再被取走，于是又空了。这时一个在途的旧退回
//    填回来，就继承到不属于它的来源。第 2 轮审查两个方向都实测到
//    （`F2_DORMANT_SCALAR_IS_NOT_PROVENANCE`：系统等待被洗成主动暂停 ⇒ 任务卡在 paused；
//    主动暂停被洗成系统等待 ⇒ 被自动清掉）。
//
// 现在换成**不靠猜**的那一种：那一格有个占用代次（`resume_prompt_generation`），
//
//  · **写入一段新文字**：代次 +1，并声明来源（`writeResumePrompt`，`auto` 没有缺省值）。
//  · **作废一段等待**：代次也 +1（`clearAutoCheckpoint`）—— 它不是「腾个空等文字回来」，所以
//    任何在途的旧凭证都该就此失效。
//  · **取走**：代次不动，返回一张凭证 `{text, auto, generation}`（`takeResumePrompt`）。
//  · **退回**：凭证三样一起写回去，而且**只在代次没变时**才写得进去（`restoreResumePrompt`）。
//    代次变了 = 这一格已经被别人占用过，那段文字就此过期，不许复活。
//
// 于是「这段文字是谁写的」永远由**拿着它的那一位**说，不再由任务行上一个可能已经改过的布尔说。
//
// ## 这一层是**唯一**的写入口（第 3 轮审查 F1）
//
// 代次只有在**所有** writer 都维护它时才是归属凭证。第 2 轮只改了这个文件里的两个助手，而
// 真人暂停（`POST /tasks/:id/pause`）和断线补录的 `pause_task` 各自 `db.update(tasks)` 直写
// 那两列、不动代次 —— 于是「数值相等」压根证明不了「还是同一次占用」：实测走生产路由写下一段
// 新的主动暂停后代次仍是 1，一个在途的旧凭证于是合法地填回去、占住位置，真正新的那一段再也
// 退不回来（`F2_HTTP_PAUSE_GENERATION_BYPASS`）。
//
// 所以这个文件导出**每一种写法**，任何地方都不许自己拼 `.set({ resumePrompt… })`：
//
//  · 占位：`writeResumePrompt`（只填空位）/ `occupyResumePrompt`（允许盖掉已经挂着的那一段）
//  · 取走：`resumePromptTakePatch` + `resumePromptHeldBy`（谁还握着这一次占用）
//  · 退回：`restoreResumePrompt` / `resumePromptSlotFor` + `resumePromptRestorePatch`
//  · 作废：`resumePromptVoidPatch`（这段话已经消费掉/不该再回来）
//  · 清场：`resumePromptClearPatch`（有就作废、没有就一个字不动）
//
// 这条不靠自觉：回归里有一道结构锁遍历 `server/src` 的每一条 `db.update(tasks)`，谁再在
// 自己那边直写这三列就红（`monitor-complete-checkpoint-groups.ts` ㉗c）。
//
// 需要在别的语句里一起落库的调用方（消息账本、改派回滚、结算）用上面那几个 patch/条件助手
// 拼进自己的那一笔 —— 口径只有这一份。
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";

/** 把整行推给客户端。广播失败只记日志：实时通知挂了不该反过来把已经落库的写入判成失败。 */
export async function announceResumePrompt(taskId: string): Promise<void> {
  try {
    await publishTaskUpdated(taskId);
  } catch (error) {
    console.warn(`[ash] 续跑指令已更新，但实时通知失败 ${taskId}:`, error);
  }
}

/**
 * 取走那一段续跑指令时拿到的**凭证**：文字、它是谁写的、取走时这一格的占用代次。
 *
 * 退回必须原样带着它（见文件头）。`generation` 是归属本体：代次变了说明这一格已经被别人
 * 占用过，这张凭证就此过期。
 */
export type ResumePromptReceipt = { text: string; auto: boolean; generation: number };

/**
 * **落在别处、过一阵子才回来**的那张凭证（消息账本、改派快照）。跟上面差一处：两列可能是
 * `null` —— 存量账本行是这两列存在之前写下的。
 *
 * `null` 的含义是「未知」，而未知**不等于对任意新代次都有效**：那种行写下时任务行的代次只
 * 能是迁移缺省 `0`，所以它的归属就是第 0 次占用（见 `resumePromptSlotFor`）。来源未知时不碰
 * 来源列 —— 拿 `false` 冒充事实正是第 1 轮 F2 把系统等待洗成主动暂停的那个写法。
 */
export type StoredResumePromptReceipt = { text: string; auto: boolean | null; generation: number | null };

/**
 * CAS 取走这段续跑指令：只清掉调用方读到的那一段。
 *
 * 返回凭证（`null` = 没取到：被另一路取走了，或 agent 刚换了新的一段）。**来源列一个字都不碰**
 * —— 归零会让这段文字的来源凭空丢掉，而改写它会动到下一段文字的来源；它的真正去处是凭证。
 */
export async function takeResumePrompt(taskId: string, expected: string): Promise<ResumePromptReceipt | null> {
  const cleared = await db
    .update(tasks)
    .set({ resumePrompt: null, updatedAt: now() })
    .where(and(eq(tasks.id, taskId), eq(tasks.resumePrompt, expected)))
    // RETURNING 给的是写后的行,而这一笔不碰这两列 —— 所以它们就是取走那一刻的事实。
    .returning({ auto: tasks.resumePromptAuto, generation: tasks.resumePromptGeneration });
  const row = cleared.at(0);
  if (!row) return null;
  await announceResumePrompt(taskId);
  return { text: expected, auto: row.auto, generation: row.generation };
}

/**
 * **要填回自己取走的那一段，条件是什么**：这一格空着，而且还是同一次占用。
 *
 * 导出是为了让需要把「填回」跟别的语句放进同一个批的调用方（消息账本的转手、改派回滚）复用
 * 同一份口径 —— 自己拼一遍就会漏掉代次那一条，而那正是第 2 轮审查 F2 走穿的地方。
 */
export const resumePromptSlotFor = (receipt: StoredResumePromptReceipt): SQL[] => [
  isNull(tasks.resumePrompt),
  // **存量账本行（代次 NULL）按第 0 次占用算**，不是「对任意代次都有效」：它写下时这一列还
  // 不存在，任务行的代次只能是迁移缺省 0。于是升级后只要有过一次新占用（代次 ≥ 1），这张旧
  // 凭证就此过期 —— 否则它能凭一个空槽填回去，还顺手继承新占用留下的来源（第 3 轮审查 F1）。
  eq(tasks.resumePromptGeneration, receipt.generation ?? 0),
];

/**
 * 填回时要写的那几列（同上，口径只有一份）。**代次不动**：原样退回不是一次新的占用。
 *
 * 来源未知（存量账本行）时**不碰来源列**：那一格此刻的值是上一次占用留下的，拿它当这段文字
 * 的来源是冒领；而写一个猜的值更糟（第 1 轮 F2）。
 */
export const resumePromptRestorePatch = (receipt: StoredResumePromptReceipt) => ({
  resumePrompt: receipt.text,
  ...(receipt.auto === null ? {} : { resumePromptAuto: receipt.auto }),
  updatedAt: now(),
});

/**
 * **取走**那一段时要写的列，和「谁还握着这一次占用」这个条件。
 *
 * 导出是因为消息账本的转手必须把「任务行上腾空」和「这条消息认下这笔账」放进同一批
 * （`monitor-checkpoint-handoff.ts`），没法走上面的 `takeResumePrompt`。
 *
 * 条件里**文字和代次都要**：只比文字时，同一段话被另一路取走、又被原样写成一段新的主动暂停
 * （代次变了）之后，转手照样命中，于是把**新**的那一段清掉、却在账本上记下**旧**的来源和代次；
 * 随后投递失败回填时代次不符被拒，账本也清了 —— 新暂停两边都没了（第 3 轮审查 F1，实测
 * `F2_SAME_TEXT_ABA_WRONG_RECEIPT`）。
 */
export const resumePromptTakePatch = () => ({ resumePrompt: null, updatedAt: now() });

export const resumePromptHeldBy = (receipt: { text: string; generation: number }): SQL[] => [
  eq(tasks.resumePrompt, receipt.text),
  eq(tasks.resumePromptGeneration, receipt.generation),
];

/**
 * CAS 回填**自己刚取走的那一段**：只填回自己腾出的那个空，而且只在这一格还是同一次占用时。
 *
 * 这中间 agent 可能已经 pause_task 写下**新的**一段（代次变了、槽也占着），无条件回填就是拿旧
 * 指令盖掉新指令；更隐蔽的是「新的一段又被取走了」—— 槽空着，但代次已经不是它那一次，这时填
 * 回去就会连来源一起错位（第 2 轮审查 F2）。
 */
export async function restoreResumePrompt(taskId: string, receipt: ResumePromptReceipt): Promise<boolean> {
  return writeInto(taskId, resumePromptRestorePatch(receipt), resumePromptSlotFor(receipt));
}

/**
 * 写下一段**新的**续跑指令，同时声明它是谁写的。CAS 同上：只填空位。
 *
 * `auto` 没有缺省值 —— 漏了就编译不过。少了它这段文字的有效期就无从判断,而两种来源的有效期
 * 完全相反（`clearAutoCheckpoint`）。
 *
 * **代次 +1**：这是一次新的占用，所以之前取走的那些凭证就此过期（它们退回来会被挡住）。
 */
export async function writeResumePrompt(
  taskId: string,
  value: string,
  auto: boolean,
  /**
   * 调用方的身份 CAS 条件（回合 / 方向令牌），跟这一笔写入**合在同一条语句里**。
   *
   * 为什么不是「先查一遍身份,再写」:查完到写之间隔着 await,方向完全可以在这中间换走
   * （第 1 轮审查 F3 实测:补录读到旧方向后排在任务锁后面,新方向在它拿锁前就位,于是旧
   * 方向的暂停指令被补到了新方向头上）。条件写进语句里,换走了就是 0 行。
   */
  where: (SQL | undefined)[] = [],
): Promise<boolean> {
  return writeInto(taskId, occupyPatch(value, auto), [isNull(tasks.resumePrompt), ...where]);
}

/**
 * 同上，但**允许盖掉已经挂着的那一段**：真人/agent 自己挂检查点（HTTP `/pause`、补录的
 * `pause_task`）就是这种语义 —— 那一格此刻可能挂着系统替它写下的等待，agent 自己的话优先。
 *
 * 跟直接 `db.update` 的区别只有一处，而那一处是全部要害：**代次照样 +1**。这是一次新的占用，
 * 所有在途的旧凭证必须就此过期（第 3 轮审查 F1-A：绕过这里就等于把代次这道闸整条废掉）。
 */
export async function occupyResumePrompt(
  taskId: string,
  value: string,
  auto: boolean,
  where: (SQL | undefined)[] = [],
): Promise<boolean> {
  return writeInto(taskId, occupyPatch(value, auto), where);
}

/** 一次新占用要写的那几列。两个 writer 共用，所以「代次 +1」漏不掉。 */
const occupyPatch = (value: string, auto: boolean) => ({
  resumePrompt: value,
  resumePromptAuto: auto,
  updatedAt: now(),
  resumePromptGeneration: sql`${tasks.resumePromptGeneration} + 1`,
});

async function writeInto(
  taskId: string,
  // 不用 `Partial<$inferInsert>`:代次那一笔是 `generation + 1` 这样的 SQL 表达式,不是字面量。
  patch: Parameters<ReturnType<typeof db.update<typeof tasks>>["set"]>[0],
  where: (SQL | undefined)[] = [],
): Promise<boolean> {
  const restored = await db
    .update(tasks)
    .set(patch)
    // **空位条件由调用方给**：填空位的那两种自己带 `isNull`，而真人暂停就是要盖掉已经挂着
    // 的那一段（见 `occupyResumePrompt`）。
    .where(and(eq(tasks.id, taskId), ...where))
    .returning({ id: tasks.id });
  if (!restored.length) return false;
  await announceResumePrompt(taskId);
  return true;
}

/**
 * **「这段等待作废了」要写的那几列**：来源归零 + 代次 +1。
 *
 * 跟「取走」差一个代次：取走是「腾个空，文字可能退回来」，作废是「这段话不该再回来了」。代次
 * 一动，所有还在途的旧凭证（账本重投、改派回滚、迟到的旧方向）就此过期 —— 否则它们能凭一个空
 * 槽把一段已经作废的等待复活回来（第 2 轮审查 F2）。
 *
 * 导出给需要在复合更新里一起落库的那几处用（结算消费检查点、丢弃迟到的旧方向状态）：口径只有
 * 这一份，各写一遍就会漏掉代次。**它们记得自己补一条 `announceResumePrompt`**（见文件头）。
 */
export const resumePromptVoidPatch = () => ({
  resumePrompt: null,
  resumePromptAuto: false,
  resumePromptGeneration: sql`${tasks.resumePromptGeneration} + 1`,
});

/**
 * **清场**：这一刻挂着什么就作废什么，**空着就一个字都不动**（代次也不动）。
 *
 * 跟上面差的就是这一条，而它是一次回归的根因：原生引导清完旧方向之后，ACK 回来还要再清一遍
 * 迟到的那几样（`discardLateDirectionState`）。那一笔原来无条件 `+1`，于是**没有任何竞争写入
 * 也会把代次推走**，紧接着新正文发送失败要回滚时，回滚自己的 CAS（代次 = 快照）被自己刚推走
 * 的那一格挡死：检查点、提问、完成票一起没了，而新工作压根没送出去（第 3 轮审查 F1-C 实测
 * `F2_NATIVE_STEER_SELF_INVALIDATES_ROLLBACK`）。
 *
 * 「真的清掉了一段话」才算一次作废 —— 那时在途的旧凭证本来就该过期；什么都没清就不是事件，
 * 不许动代次。
 */
export const resumePromptClearPatch = () => ({
  resumePrompt: null,
  resumePromptAuto: false,
  resumePromptGeneration: sql`CASE WHEN ${tasks.resumePrompt} IS NULL THEN ${tasks.resumePromptGeneration}`
    .append(sql` ELSE ${tasks.resumePromptGeneration} + 1 END`),
});

/**
 * 清掉**系统自己写的**那段等待（`resume_prompt_auto`），agent 用 `pause_task` 写的原样留着。
 *
 * 调用点只有一个：完成请求重新获准的那一刻（`confirmTaskComplete`）—— 闸放行 ⇒ 它等的那些
 * 哨兵/结果已经没了 ⇒ 这段话已经失效。不清的话这一轮照旧落 paused，而再没有任何哨兵会来
 * 叫醒它（第 2 轮审查 R2-2 实测 `NEW_STALE_AUTOMATIC_CHECKPOINT`）。
 */
export async function clearAutoCheckpoint(taskId: string): Promise<boolean> {
  const cleared = await db
    .update(tasks)
    // 来源归零、**代次 +1**:这不是「腾个空等文字回来」,而是「这段等待作废了」。代次一动,
    // 所有还在途的旧凭证(账本重投、改派回滚)就此过期 —— 否则它们能把一段已经作废的等待凭
    // 一个空槽复活回来(第 2 轮审查 F2)。
    .set({ ...resumePromptVoidPatch(), updatedAt: now() })
    // `isNotNull`:文字已经被取走时这一列是休眠值,碰它就等于把那段正在路上的文字的来源
    // 改掉（它还可能被退回来）。没有文字可清 = 没有等待可作废,照实返回 false。
    .where(and(eq(tasks.id, taskId), eq(tasks.resumePromptAuto, true), isNotNull(tasks.resumePrompt)))
    .returning({ id: tasks.id });
  if (!cleared.length) return false;
  await announceResumePrompt(taskId);
  return true;
}
