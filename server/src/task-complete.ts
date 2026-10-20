// 完成确认这件事的**唯一业务入口**，外加那条不变量的另外两处落点。
//
// 不变量一句话：**名下还有会被这次完成毁掉的哨兵或哨兵结果时，这个任务不会落 done。**
//
// 第一版只在 HTTP 那一个入口上问了一次，于是第 1 轮审查 F1 从两头走穿了它：
//
//  · **确认之后再挂**：先 `complete_task`（放行、确认落库），再 `start_monitor`。第二次
//    complete 确实被 409 拦住了，可第一份确认还在，结算照旧落 done，新哨兵被当场停掉。
//    实测输出：`{"firstComplete":200,"startMonitor":true,"secondComplete":409,
//    "confirmationStillSet":true,"settlement":"done","monitorAfter":"stopped"}`。
//  · **断线补录**：MCP 通道中断时，agent 这一轮的 `complete_task` 会从调用记录里补录
//    （`mcp-handoff.ts`）。那条路直接写 `complete_confirmed_at`，一个字都没问过闸。
//    实测输出：`{"replayed":1,"confirmed":true,"settlement":"done","monitorAfter":"stopped"}`。
//
// 所以「确认那一刻没有哨兵」证明不了「落 done 那一刻没有哨兵」，而请求从哪条通道来也不该
// 改变业务约束。四处落点，各管一段：
//
//  ① **确认**（本文件 `confirmTaskComplete`）—— HTTP 与补录共用这一个函数。整段排在
//     `task:<id>` 那条队列上，跟哨兵的创建/停止同一条队：不排队的话「数一数有几个哨兵」和
//     「插进去一条」可以互相穿过去（审查指出的那个并发窗口）。
//  ② **创建**（`holdCompletionForNewMonitor`，由 `startMonitor` 在交接完成后调）—— 挂上
//     哨兵的那一刻，手里那份确认就不成立了：当场撤掉它、把本回合改成检查点暂停，并在创建
//     的返回里当场告诉 agent（它读结果的那一眼就看到，不必等结算才发现落位变了）。
//  ③ **结算**（`holdCompletionAtSettlement`，由 `settleTaskStatus` 在落 done 之前调）——
//     最后一关。①②都是在「有人调了某个接口」时才跑，这一关不依赖任何人调用，兜住所有
//     没想到的路径（含并发窗口）。
//  ④ 这三处**共用同一份判据** `monitorsBlockingComplete`（见 task-complete-monitors.ts）。
//
// 拦下来的落位是**检查点暂停**，不是失败：哨兵醒来会把这条会话重新叫起来（`paused` 不在
// `MONITOR_BLOCKING_STATUSES` 里），已预约的审查也会跟着等（自由工作流的等待判据就是
// `question || resumePrompt` 非空）—— 这正是用户 2026-10-16 要的那句「等拿到结果再继续」。
import { and, eq, type SQL } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { serialize } from "./monitors.js";
import { confirmDone, revokeConfirmed } from "./runs.js";
import { monitorsBlockingComplete, noteMonitorsDropped } from "./task-complete-monitors.js";
import { restoreResumePrompt } from "./task-resume-prompt.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export type ConfirmCompleteResult = { ok: true } | { ok: false; error: string };

/**
 * ① 落一次完成确认。**HTTP 和断线补录都必须走这里**。
 *
 * `where` 是调用方自己那套身份 CAS 条件（HTTP 核回合+方向令牌、补录核方向令牌），`staleError`
 * 是条件没落上时那句话 —— 两条通道的身份口径本来就不同，共用的是**闸和落库这一段**，不是
 * 身份校验。`confirmDone` 的内存快路和时间线留痕都在这里一起办，漏哪一样都会变成第二份
 * 实现（审查原话：不能只给补录多复制一次 if）。
 */
export async function confirmTaskComplete(a: {
  taskId: string;
  where: (SQL | undefined)[];
  staleError: string;
}): Promise<ConfirmCompleteResult> {
  const result = await serialize(`task:${a.taskId}`, async (): Promise<ConfirmCompleteResult> => {
    const blocked = await monitorsBlockingComplete(a.taskId);
    if (blocked) return { ok: false, error: blocked };
    const at = now();
    const updated = await db
      .update(tasks)
      .set({ completeConfirmedAt: at, updatedAt: at })
      .where(and(eq(tasks.id, a.taskId), ...a.where))
      .returning({ id: tasks.id });
    if (!updated.length) return { ok: false, error: a.staleError };
    confirmDone(a.taskId);
    return { ok: true };
  });
  // 闸只拦得住「还挂着」的那些；「先撤再完成」是合法动作的合法组合，拦不得，但要留下痕迹。
  // 排在队列外面：它只读不写，而且写时间线失败不该把已经落库的确认翻掉。
  if (result.ok) await noteMonitorsDropped(a.taskId);
  return result;
}

/** 被拦下来之后喂回给 agent 的那段续跑指令。它会作为一条 user 消息唤醒同一条会话。 */
const checkpointResume = (why: string): string =>
  `继续：你这一轮确认过完成，但${why}，所以这一轮落成了检查点暂停而不是已完成`
  + "（任务一落 done，还在盯的哨兵会被一并停掉、排着没送到的结果会被作废，你再也拿不到它们）。"
  + "现在把哨兵那边的结果收下来：用 list_monitors 看它们各自什么状态、读完送到你手上的事件，"
  + "然后按结果把活干完 —— 确实不要某个哨兵了就 stop_monitor（reason 写清为什么），"
  + "名下没有还在盯的哨兵、也没有排着没收的结果之后，再调 complete_task。";

/**
 * 撤掉一份还没结算的确认，**两条道一起撤**（DB 列 + `confirmDone` 的内存快路）—— settle 是
 * 任一命中即算确认，只清一边等于没撤（审查原话）。返回它本来在不在。
 */
async function revokeConfirmation(taskId: string): Promise<boolean> {
  const row = (await db
    .select({ confirmedAt: tasks.completeConfirmedAt })
    .from(tasks).where(eq(tasks.id, taskId))).at(0);
  const inMemory = revokeConfirmed(taskId);
  if (!row?.confirmedAt) return inMemory;
  await db.update(tasks).set({ completeConfirmedAt: null, updatedAt: now() }).where(eq(tasks.id, taskId));
  return true;
}

/**
 * 落检查点：一段续跑指令 + 一条时间线。
 *
 * 续跑指令**必须有**，否则这一轮会按「没交卷」记成 failed，而它明明交了卷。用 CAS 回填
 * （`restoreResumePrompt` 只填空位）：agent 可能已经自己 `pause_task` 写过一段，那段比我们
 * 这段更知道它想干什么。
 */
async function landCheckpoint(taskId: string, why: string, note: string): Promise<void> {
  await restoreResumePrompt(taskId, checkpointResume(why));
  await appendTaskTimeline(taskId, note);
}

/**
 * ② 刚挂上一条哨兵：手里那份确认就此不成立。
 *
 * 返回要带回创建结果里的那句话（`null` = 没有确认要撤，绝大多数情况）。不必再问一遍闸 ——
 * 刚插进去的这一行本身就是闸要拦的东西。**绝不抛**：调用点在「进程已交接」之后，往上抛会
 * 让一次成功的创建看起来像失败。
 */
export async function holdCompletionForNewMonitor(taskId: string, label: string): Promise<string | null> {
  try {
    if (!await revokeConfirmation(taskId)) return null;
    const note = `已撤掉本回合的完成确认：挂上哨兵「${label}」之后，这一轮改为检查点暂停 —— `
      + "任务一落 done 这个哨兵就会被一并停掉，它在等的结果也就没了。它醒来会把这条会话重新叫起来。";
    await landCheckpoint(taskId, `随后挂上了哨兵「${label}」`, note);
    return note;
  } catch (e) {
    console.error(`[ash] 挂哨兵后撤销完成确认失败 task=${taskId}:`, e);
    return null;
  }
}

/**
 * ③ 结算落 done 之前的最后一关。返回那句说明（`null` = 放行，照原落位走）。
 *
 * 只在「这一轮确实拿到了确认」时调（见 `settleTaskStatus`）：没确认的轮次本来就不会落 done，
 * 多问一遍只是白查一次库。走到这里时 settle 已经把两条道上的确认都消费掉了，`revokeConfirmation`
 * 多半返回 false —— 照旧调它一遍，为的是另一条路（补录在 settle 之后才写进来）也收得干净。
 */
export async function holdCompletionAtSettlement(taskId: string): Promise<string | null> {
  return serialize(`task:${taskId}`, async () => {
    const blocked = await monitorsBlockingComplete(taskId);
    if (!blocked) return null;
    const note = `本回合确认了完成，但落「已完成」被拦下，改为检查点暂停：${blocked}`;
    await revokeConfirmation(taskId);
    await landCheckpoint(taskId, "名下还有没了结的哨兵", note);
    return note;
  });
}

// 残余窗口,如实记在这儿:这一关读完之后、`setStatus("done")` 落下去之前,还有不到一毫秒的
// 空隙 —— 那一瞬插进来的创建会被紧接着的终态连坐停掉(`stopMonitorsForTask` 跟创建排同一条
// 队,所以它一定收得到,不会漏成后台孤儿)。要把这最后一丝也焊死,得让整段结算都持着这把锁,
// 代价是结算与哨兵创建互等 —— 现阶段不值当。审查报告对这一档的判断同此(「按代码推断」)。
