// 完成确认这件事的**唯一业务入口**，外加那条不变量的另外三处落点。
//
// 不变量一句话：**名下还有会被这次完成毁掉的哨兵或哨兵结果时，这个任务不会落终态。**
//
// 第一版只在 HTTP 那一个入口上问了一次，第 1 轮审查从两头走穿了它（确认之后再挂 / 断线补录）；
// 第二版补上了创建与结算两关，第 2 轮审查又从**那两关之间的缝**走穿了一次：
//
//  · **最后一关与终态落库之间**：结算先问闸（放行），松手之后才写 `done` 那一行 —— 探针把那次
//    写入按住，在缝里用真实 `startMonitor` 起了一条 `sleep 45`，放开之后任务落 done、新哨兵被
//    终态清理停掉。`OLD_F1_FINAL_SETTLEMENT_RACE {"statusAtInjection":"running",
//    "startMonitor":true,"settlement":"done","monitorAfter":"stopped"}`。
//    「不到一毫秒」不是互斥保证 —— 这一版用**闩**把那条缝焊上（见 `beginTerminalLanding`）。
//  · **补录被拦下之后**：拒绝写确认 ≠ 哨兵被保留。那一轮接着按「没交卷」落 failed，而 failed
//    也是终态，哨兵照样被收走。`OLD_F1_REPLAY_REJECTED_THEN_FAILED {"replayed":0,
//    "settlement":"failed","monitorAfter":"stopped"}`。拦下来必须同时落一段**可恢复的等待**。
//
// 四处落点，各管一段，**共用同一份判据** `monitorsBlockingComplete`（见 task-complete-monitors.ts）：
//
//  ① **确认**（`confirmTaskComplete`）—— HTTP 与断线补录共用这一个函数。
//  ② **创建**（`holdCompletionForNewMonitor`，`startMonitor` 交接完成后调）—— 挂上哨兵的那一刻，
//     手里那份确认就不成立了：当场撤掉、改成检查点暂停，并在创建的返回里告诉 agent。
//  ③ **终态落位**（`beginTerminalLanding`，`settleTaskStatus` 在每个会收走哨兵的落位之前调）——
//     核一遍阻塞物**并置闩**，闩期间 `startMonitor` 一律拒（monitor-create.ts 的 ⑤-b）。
//  ④ 以上三处都在 `task:<id>` 那条队列上排队 —— 跟哨兵的创建、停止、终态清理同一条队。
//
// 拦下来的落位是**检查点暂停**，不是失败：哨兵醒来会把这条会话重新叫起来（`paused` 不在
// `MONITOR_BLOCKING_STATUSES` 里），已预约的审查也会跟着等（自由工作流的等待判据就是
// `question || resumePrompt` 非空）—— 这正是用户 2026-10-16 要的那句「等拿到结果再继续」。
//
// 而**自动写下的那段等待是有有效期的**（第 2 轮审查 R2-2）：阻塞物消失、agent 重新交卷时要
// 把它清掉，否则任务永远停在 paused 等一个再也不会来的唤醒。靠 `tasks.resume_prompt_auto`
// 分来源：只清系统自己写的那种，绝不碰 agent 用 `pause_task` 写下的那段。
import { and, eq, type SQL } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { serialize } from "./monitors.js";
import { confirmDone, hasConfirmed, revokeConfirmed } from "./runs.js";
import { monitorsBlockingComplete, noteMonitorsDropped } from "./task-complete-monitors.js";
import { clearAutoCheckpoint, restoreResumePrompt } from "./task-resume-prompt.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export type ConfirmCompleteResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /**
       * 拦下它的是**哨兵闸**（业务等待），不是身份过期。
       *
       * 两种拒绝的后果完全不同：身份过期 = 这笔确认不该生效（换方向了 / 不是这一回合的），
       * 什么都不该补；被闸拦下 = 它确实交了卷，只是现在还不能落终态，**必须落一段可恢复的
       * 等待**，否则这一轮按「没交卷」记 failed —— 而 failed 也是终态，哨兵照样被收走
       * （第 2 轮审查 R2-1 实测 `OLD_F1_REPLAY_REJECTED_THEN_FAILED`）。
       */
      blockedByMonitors?: true;
    };

// ── ③ 的那把闩 ───────────────────────────────────────────────────────────────
//
// 为什么非要一把闩，而不是「把终态行的写入也搬进同一把锁」：终态钩子 `stopMonitorsForTask`
// 自己就要抢 `task:<id>`（它必须排在终态落库**之后**，见 status.ts），在锁里调 `setTaskStatus`
// 等于自锁死。所以改成两段：锁里**核阻塞物 + 置闩**，锁外写状态与跑钩子，写完撤闩。
// 创建那一侧在同一把锁里看这个闩（它本来就在那把锁里数「现在有几个哨兵」），于是
// 「核完了还能插进来一条」这件事从此不可能发生。
//
// **带时限**：闩的唯一用途是护住「置闩 → 写终态」这几毫秒。万一调用方没走到写状态就抛了，
// 时限让它自己失效 —— 代价是那段时间里创建会被拒，比永久挡死一个任务安全得多。
const LATCH_TTL_MS = 60_000;
const landing = new Map<string, number>();

/** 这个任务此刻正在落一个会收走哨兵的终态吗（同步，给创建那一侧在锁里问）。 */
export function terminalLandingInFlight(taskId: string): boolean {
  const at = landing.get(taskId);
  if (at === undefined) return false;
  if (Date.now() - at < LATCH_TTL_MS) return true;
  landing.delete(taskId);   // 过期 = 当初那次落位早就结束（或者抛在了半路）
  return false;
}

/** 终态行已经落库（或这次落位放弃了）—— 撤闩。重复调用无副作用。 */
export function releaseTerminalLanding(taskId: string): void {
  landing.delete(taskId);
}

/**
 * ③ **要落一个会收走哨兵的终态了**：核一遍阻塞物，顺便把闩置上。
 *
 * - 返回 `null` = 可以落。**闩已经置上**，调用方必须在那一行落库之后撤闩 —— 这一步由
 *   `setTaskStatus` 写完状态**无条件**撤（status.ts），不指望每个落位分支自己记得。无条件是
 *   因为核过闩之后真正落位的未必是终态（续聊回合可能恢复成 paused/backlog），只在终态撤的话
 *   那一轮会把这个任务的创建挡到闩过期为止。
 * - 返回字符串 = 拦下来了（闩没置）。确认已经撤掉、检查点已经落下，调用方改落 `paused`，
 *   那句话就是返回值。
 */
export async function beginTerminalLanding(taskId: string): Promise<string | null> {
  return serialize(`task:${taskId}`, async () => {
    const blocked = await monitorsBlockingComplete(taskId);
    if (!blocked) {
      landing.set(taskId, Date.now());
      return null;
    }
    const note = `本回合要落的终态被拦下，改为检查点暂停：${blocked}`;
    await landCheckpoint(taskId, "名下还有没了结的哨兵", note);
    await revokeConfirmation(taskId);
    return note;
  });
}

/**
 * ① 落一次完成确认。**HTTP 和断线补录都必须走这里**。
 *
 * `where` 是调用方自己那套身份 CAS 条件（HTTP 核回合+方向令牌、补录核方向令牌），`staleError`
 * 是条件没落上时那句话 —— 两条通道的身份口径本来就不同，共用的是**闸和落库这一段**，不是
 * 身份校验。`confirmDone` 的内存快路、失效的自动等待、时间线留痕都在这里一起办，漏哪一样都
 * 会变成第二份实现（审查原话：不能只给补录多复制一次 if）。
 */
export async function confirmTaskComplete(a: {
  taskId: string;
  where: (SQL | undefined)[];
  staleError: string;
}): Promise<ConfirmCompleteResult> {
  const result = await serialize(`task:${a.taskId}`, async (): Promise<ConfirmCompleteResult> => {
    const blocked = await monitorsBlockingComplete(a.taskId);
    if (blocked) return { ok: false, error: blocked, blockedByMonitors: true };
    const at = now();
    const updated = await db
      .update(tasks)
      .set({ completeConfirmedAt: at, updatedAt: at })
      .where(and(eq(tasks.id, a.taskId), ...a.where))
      .returning({ id: tasks.id });
    if (!updated.length) return { ok: false, error: a.staleError };
    confirmDone(a.taskId);
    // 闸放行了 ⇒ 之前为哨兵自动写下的那段等待已经失效（它等的东西没了）。不清的话这一轮
    // 照旧落 paused，而再没有任何哨兵会来叫醒它（第 2 轮审查 R2-2 实测）。
    await clearAutoCheckpoint(a.taskId);
    return { ok: true };
  });
  // 闸只拦得住「还挂着」的那些；「先撤再完成」是合法动作的合法组合，拦不得，但要留下痕迹。
  // 排在队列外面：它只读不写，而且写时间线失败不该把已经落库的确认翻掉。
  if (result.ok) await noteMonitorsDropped(a.taskId);
  return result;
}

/**
 * ② 刚挂上一条哨兵：手里那份确认就此不成立。
 *
 * 返回要带回创建结果里的那句话（`null` = 没有要撤的，绝大多数情况）。**判据跟闸同一份**
 * （第 2 轮审查 R2-2）：刚插进去的这一行若属于一次仍在进行的审查，它活得过这次完成，就不该
 * 把 agent 的确认撤掉 —— 所以这里问的是 `monitorsBlockingComplete`，不是「我刚起了个哨兵」。
 *
 * **两步的顺序是半写安全的**：先落检查点、再撤确认。反过来的话，撤成功 + 检查点写失败会留下
 * 「既没确认也没等待」，那一轮按没交卷落 failed，哨兵跟着被收走（第 2 轮审查 R2-1 点出的
 * 半状态）。这个顺序下即使检查点写失败，确认也还在手里 —— 结算那一关会照样把它拦成暂停。
 *
 * **绝不抛**：调用点在「进程已交接」之后，往上抛会让一次成功的创建看起来像失败。
 */
export async function holdCompletionForNewMonitor(taskId: string, label: string): Promise<string | null> {
  try {
    const standing = (await db
      .select({ confirmedAt: tasks.completeConfirmedAt })
      .from(tasks).where(eq(tasks.id, taskId))).at(0)?.confirmedAt;
    // 没有确认可撤 ⇒ 什么都不做。**这是绝大多数创建**（agent 起哨兵、随后 pause_task 收尾），
    // 不该因此多写一段系统等待去压住它自己那一段。
    if (!standing && !hasConfirmed(taskId)) return null;
    if (!await monitorsBlockingComplete(taskId)) return null;
    const note = `已撤掉本回合的完成确认：挂上哨兵「${label}」之后，这一轮改为检查点暂停 —— `
      + "任务一落 done 这个哨兵就会被一并停掉，它在等的结果也就没了。它醒来会把这条会话重新叫起来。";
    await landCheckpoint(taskId, `随后挂上了哨兵「${label}」`, note);
    await revokeConfirmation(taskId);
    return note;
  } catch (e) {
    console.error(`[ash] 挂哨兵后撤销完成确认失败 task=${taskId}:`, e);
    return null;
  }
}

/**
 * 补录被闸拦下时：**落一段可恢复的等待**，并把那句话交给调用方写进时间线。
 *
 * 不落的话那一轮按「没交卷」记 failed —— 而 failed 同样是终态，哨兵照样被收走（第 2 轮审查
 * 实测 `settlement:"failed"`、`monitorAfter:"stopped"`）。agent 确实交过卷，只是那一笔丢在了
 * 断掉的通道里；拦下它的是业务等待，不是它做错了什么。
 */
export async function holdCompletionForBlockedReplay(taskId: string, blocked: string): Promise<string> {
  const note = "完成确认当时因 MCP 通道中断没能送达，补录时被哨兵闸拦下，这一轮改为检查点暂停："
    + blocked;
  await landCheckpoint(taskId, "名下还有没了结的哨兵", note);
  return note;
}

/** 被拦下来之后喂回给 agent 的那段续跑指令。它会作为一条 user 消息唤醒同一条会话。 */
const checkpointResume = (why: string): string =>
  `继续：你这一轮确认过完成，但${why}，所以这一轮落成了检查点暂停而不是已完成`
  + "（任务一落 done，还在盯的哨兵会被一并停掉、排着没送到的结果会被作废，你再也拿不到它们）。"
  + "现在把哨兵那边的结果收下来：用 list_monitors 看它们各自什么状态、读完送到你手上的事件，"
  + "然后按结果把活干完 —— 确实不要某个哨兵的结果了就对它调 stop_monitor（reason 写清为什么），"
  + "名下没有还在盯的哨兵、也没有排着没收的结果之后，再调 complete_task。";

/**
 * 撤掉一份还没结算的确认，**两条道一起撤**（DB 列 + `confirmDone` 的内存快路）—— settle 是
 * 任一命中即算确认，只清一边等于没撤（审查原话）。
 */
async function revokeConfirmation(taskId: string): Promise<void> {
  revokeConfirmed(taskId);
  await db
    .update(tasks)
    .set({ completeConfirmedAt: null, updatedAt: now() })
    .where(eq(tasks.id, taskId));
}

/**
 * 落检查点：一段**系统自动写的**续跑指令 + 一条时间线。
 *
 * 续跑指令必须有，否则这一轮会按「没交卷」记成 failed，而它明明交了卷。只填空位：agent 可能
 * 已经自己 `pause_task` 写过一段，那段比我们这段更知道它想干什么。
 *
 * 第三个参数 = 「这段是系统写的」（`tasks.resume_prompt_auto`）。只有把来源记下来，「阻塞物
 * 没了就把这段话清掉」才能既做到（第 2 轮审查 R2-2），又不会顺手抹掉 agent 自己写的那段。
 * CAS 回填与整行广播都在助手里（`task-resume-prompt.ts` 文件头：这一列前端当门禁读）。
 */
async function landCheckpoint(taskId: string, why: string, note: string): Promise<void> {
  await restoreResumePrompt(taskId, checkpointResume(why), true);
  await appendTaskTimeline(taskId, note);
}
