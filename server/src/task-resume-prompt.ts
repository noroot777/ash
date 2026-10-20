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
// ## 来源列的口径：**只有写入新文本的地方写它，清空与回填一律不碰**
//
// 上一版的口径是「凡是写 `resume_prompt` 的地方都同时写它」,靠自觉在十来个点上带对一个
// 布尔 —— 第 1 轮审查（PUfD6pQBJUri）F2 从三个点走穿了它:持久重投账本只存了文字、普通
// 运行冲突的退回漏了来源、跨机接力的载荷里压根没有这一列,于是一段系统等待往返一趟就被洗成
// 「agent 自己写的」,此后永不自动清理,任务停在 paused 等一个再也不会来的唤醒。
//
// 现在换成一条**守得住**的：这一列只在 `resume_prompt` 非空时有意义,所以
//
//  · **取走 / 清空**：一个字都不碰它。那一格就此休眠 —— 休眠值不是脏数据,它正是那段文字
//    的来源,等着文字回来。
//  · **原样退回**（CAS 只填回自己腾空的那个位置）：同样不碰。于是来源**自动**跟着文字回来,
//    调用方连这件事都不必知道（`restoreResumePrompt` 压根没有这个参数,想传也传不进去）。
//  · **写入一段新文本**：必须自己声明来源（`writeResumePrompt` 的第三个参数没有缺省值,
//    漏了就编译不过）。
//
// 库里直接 `db.update` 写这一列的只剩两处新文本写入点（`pause` 端点、断线补录的 pause),
// 各自在就近注释里点名了它;清空与回滚（结算消费、引导清场与回滚、哨兵唤醒的交代转手）按上面
// 第一、二条,一律不出现这一列。
import { and, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
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
 * CAS 取走这段续跑指令：只清掉调用方读到的那一段。
 * 返回是否**由本次调用**清掉（false = 被另一路取走了，或 agent 刚换了新的一段）。
 */
export async function takeResumePrompt(taskId: string, expected: string): Promise<boolean> {
  const cleared = await db
    .update(tasks)
    // **来源列一个字都不碰**(见文件头的口径):它就此休眠,等这段文字被退回来时原样生效。
    // 归零反而是错的 —— 退回那一笔不知道来源,只能按缺省当成「agent 自己写的」,于是一段
    // 系统等待往返一趟就再也不会被自动清理（第 1 轮审查 F2 的三个实例都是这样来的）。
    // agent 随后自己 `pause_task` 写下新的一段时会**显式**把来源写成 false,盖不到一起。
    .set({ resumePrompt: null, updatedAt: now() })
    .where(and(eq(tasks.id, taskId), eq(tasks.resumePrompt, expected)))
    .returning({ id: tasks.id });
  if (!cleared.length) return false;
  await announceResumePrompt(taskId);
  return true;
}

/**
 * CAS 回填**自己刚取走的那一段**：只填回自己腾出的那个空。这中间 agent 可能已经 pause_task
 * 写下**新的**一段，无条件回填就是拿旧指令盖掉新指令。
 *
 * **没有来源参数,这是故意的**（见文件头）：取走时没碰那一列,所以它还原样记着这段文字是谁
 * 写的,填回来就自动对上。想传一个来源进来 = 想声明「这是一段新文本」,那该调
 * `writeResumePrompt`。
 */
export async function restoreResumePrompt(taskId: string, value: string): Promise<boolean> {
  return writeInto(taskId, { resumePrompt: value, updatedAt: now() });
}

/**
 * 写下一段**新的**续跑指令，同时声明它是谁写的。CAS 同上：只填空位。
 *
 * `auto` 没有缺省值 —— 漏了就编译不过。少了它这段文字的有效期就无从判断,而两种来源的有效期
 * 完全相反（`clearAutoCheckpoint`）。
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
  return writeInto(taskId, { resumePrompt: value, resumePromptAuto: auto, updatedAt: now() }, where);
}

async function writeInto(
  taskId: string,
  patch: Partial<typeof tasks.$inferInsert>,
  where: (SQL | undefined)[] = [],
): Promise<boolean> {
  const restored = await db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, taskId), isNull(tasks.resumePrompt), ...where))
    .returning({ id: tasks.id });
  if (!restored.length) return false;
  await announceResumePrompt(taskId);
  return true;
}

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
    // 这里**要**把来源归零:它不是「腾个空等文字回来」,而是「这段等待作废了」。留着 true
    // 的话,下一次有人往空位里退回一段**别的**文字,会凭休眠值继承到一个不属于它的来源。
    .set({ resumePrompt: null, resumePromptAuto: false, updatedAt: now() })
    // `isNotNull`:文字已经被取走时这一列是休眠值,碰它就等于把那段正在路上的文字的来源
    // 改掉（它还可能被退回来）。没有文字可清 = 没有等待可作废,照实返回 false。
    .where(and(eq(tasks.id, taskId), eq(tasks.resumePromptAuto, true), isNotNull(tasks.resumePrompt)))
    .returning({ id: tasks.id });
  if (!cleared.length) return false;
  await announceResumePrompt(taskId);
  return true;
}
