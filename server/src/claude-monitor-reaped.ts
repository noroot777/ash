// 回合结束那一刻的收尾：这一代 agent 进程名下的内置 Monitor 全部作废，并在任务时间线上
// **如实留一笔**。
//
// ── 为什么要留这一笔 ─────────────────────────────────────────────────────────
//
// 内置 Monitor 的进程在智能体自己的进程树里，回合一结束 CLI 就把它们成批收走。实测的
// 行序（Bp2LkwfRO37A 第 2 轮审查的 run 文件，原样）：
//
// ```
// system task_started                        ← 智能体挂上监听
// assistant "监听已挂上，套件结束会叫我。"
// result   success                           ← 回合结束
// system task_notification status=stopped    ← 紧接着就被收走，套件还在跑
// ```
//
// 那句「套件结束会叫我」在说出口的那一刻就不成立了：没有人会被叫醒——内置 Monitor 的通知
// 只注回智能体自己的会话，而那个会话连同进程已经没了；ash 这边只是一份只读投影，手里没有
// 任何唤醒通道（能跨回合唤醒任务的只有 ash 自己起的哨兵，见 shared/src/monitor.ts 文件头）。
//
// 而用户那一侧看到的全部线索是：卡片变成「已停止」。那读起来像「等到了，然后停了」，**意思
// 正好相反**。于是「为什么全都停止了也没唤醒」只能靠翻 run 文件才查得出来——这正是
// 「停止/暂停必须留下持久可见的状态」那条规矩要拦的情形（AGENTS.md）。
//
// 2026-10-16 起，一次性回合里这一幕基本不会再发生：agent 调内置 Monitor 的那一下会被
// PreToolUse hook 改道成 ash 哨兵（claude-monitor-hook.ts）。这里仍然留着，因为改道只覆盖
// 「ash 拉起的一次性回合」——常驻调度台不挂那个 hook（它那边内置 Monitor 真能唤醒自己），
// 而老 CLI、用户自带的 `--settings`（它排在后面，会顶掉 ash 这份）都可能让改道落空。这条
// 路是最后那道「至少如实说出来」。
//
// 所以每轮至多记一条合并说明：这一轮起了几个、它们现在全没了、以及唤醒该走哪条路。时间线
// 这条是 `aside`（agent 看不见，见 task-timeline.ts 文件头），所以它只是说给用户听的记账，
// 不构成对下一个 agent 的指令。
import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { CLAUDE_MONITOR_ENDED_REASON } from "@ash/shared/monitor-claude";
import { bus } from "./bus.js";
import type { MonitorRunOrigin } from "./claude-monitor-origin.js";
import { isTaskRevoked } from "./claude-monitor-revoked.js";
import { db, dbClient } from "./db/index.js";
import { monitors, sessions } from "./db/schema.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

/**
 * **收尾**圈多大：只收自己这一代的尾。
 *
 * 同一条 CLI 会话会跨好几代进程（resume 后号不变），把别的代次一起收掉就是拿这一代的死亡
 * 给上一代下结论 —— 方向上虽然同样是「判死」，凭据却是错的，而错凭据两个方向都会用（这一代
 * 还活着时同样会把旧卡续命）。判据和落库那一侧同一份：**证明不了是别人的就算我的** ——
 * `source_run` 为空的是存量行和没有落盘文件的会话（Windows、常驻），它们只可能归我；明确
 * 记着另一个 run 的才排除。
 *
 * 自己都没有 run 凭据时（`runPath` 为空）回到老语义：**整条会话一起收**。这一支不能换成
 * 「这条流开始之后起的」——接管回来的流（真实接管不重放 init，可能一条事件都收不到）要收的
 * 恰恰是上一轮留下的、比本流更早的那些行，按时刻卡就一条都收不到（test-claude-monitor-parse
 * 的「一条事件都没收到的接管流」钉的就是这个）。
 */
const reapScope = (origin: MonitorRunOrigin) =>
  origin.runPath
    ? or(isNull(monitors.sourceRun), eq(monitors.sourceRun, origin.runPath))
    : undefined;

/**
 * **记账**圈多大：严格只数「这一轮起的」。
 *
 * 跟上面那个口径**故意不同**，因为两件事的代价不对称：收尾宁可宽（漏收 = 面板上留一张假的
 * 「正在盯着」），记账宁可窄（多数 = 时间线上那句话里的数字跟用户看到的卡片对不上，而那句
 * 话的全部价值就在于可核对）。所以存量行（`source_run` 为空）不计入，没有 run 凭据时按
 * **流开始时刻**卡——那个时刻是实例构造那一刻记的，不是收尾时现查 `sessions`（那几列每回合
 * 被下一轮覆盖）。
 */
const noticeScope = (origin: MonitorRunOrigin, openedAt: string) =>
  origin.runPath ? eq(monitors.sourceRun, origin.runPath) : gte(monitors.startedAt, openedAt);

/**
 * 收这一代的尾。调用点是**流结束**那一刻（`executors/claude-stream.ts` 的 finally →
 * `ClaudeMonitorTrace.finishAll`）。
 *
 * 两件事按顺序做，不能颠倒：先把还挂着 `running` 的落 `lost`（不收的话面板上会永远留着
 * 几张「正在盯着」的卡，而那些进程早就随 agent 一起没了），再按**收完之后**的状态去记时间线
 * ——那样那句话里的数字才跟用户刷新后看到的卡片对得上。
 */
export async function reapClaudeMonitors(
  cliSessionId: string, origin: MonitorRunOrigin, openedAt: string,
): Promise<void> {
  if (dbClient.closed || !cliSessionId) return;
  const ours = and(eq(monitors.kind, "claude"), eq(monitors.cliSessionId, cliSessionId));

  const live = await db
    .select({ id: monitors.id, taskId: monitors.taskId })
    .from(monitors)
    .where(and(ours, eq(monitors.status, "running"), reapScope(origin)));
  if (live.length) {
    await db.update(monitors).set({
      status: "lost",
      endedAt: now(),
      endedReason: CLAUDE_MONITOR_ENDED_REASON.lost ?? null,
    }).where(and(inArray(monitors.id, live.map((r) => r.id)), eq(monitors.status, "running")));
    for (const taskId of new Set(live.map((r) => r.taskId))) bus.publish({ type: "task.monitors", taskId });
  }

  // 状态一起查:这一轮里**自己跑完的**和**被收走的**不能说成同一件事(第 4 轮审查 N1)。
  const all = await db
    .select({ taskId: monitors.taskId, status: monitors.status })
    .from(monitors)
    .where(and(ours, noticeScope(origin, openedAt)));
  if (!all.length) return;
  const byTask = new Map<string, { total: number; finished: number }>();
  for (const row of all) {
    const entry = byTask.get(row.taskId) ?? { total: 0, finished: 0 };
    entry.total += 1;
    // `exited` 是唯一能说「它等到了/跑完了」的一档。`stopped` 说不清(CLI 那边 TaskStop 和
    // 回合收尾共用同一个词,见 CLAUDE_MONITOR_ENDED_REASON 那段实测),所以不算进来。
    if (row.status === "exited") entry.finished += 1;
    byTask.set(row.taskId, entry);
  }
  for (const [taskId, tally] of byTask) {
    if (isTaskRevoked(taskId)) continue;
    await appendTaskTimeline(taskId, reapedNotice(tally), { sessionId: await sessionOf(cliSessionId, taskId) });
  }
}

/**
 * 时间线上那句话。**要回答的是「它们停了，为什么没人被唤醒」**，所以三件事缺一不可：
 * 这一轮起了几个、它们各自是怎么结束的、以及想跨回合等事情该走哪条路。
 *
 * 中间那件事不能一刀切成「全部失效」:`exited` 那一档是命令真的跑完了，说成失效就是把事实
 * 说错(第 4 轮审查 N1)。但**结论对两档都一样**——通知只注回智能体自己的会话，任务不会被
 * 唤醒；跑完了也只是「它自己可能看见了」，回合已经结束的话连它也没看见。
 */
const reapedNotice = (tally: { total: number; finished: number }): string => {
  const { total, finished } = tally;
  const how = finished === 0
    ? "回合结束时已全部失效"
    : finished === total
      ? "都在这一轮里自己跑完了"
      : `其中 ${finished} 个自己跑完了、剩下 ${total - finished} 个在回合结束时已经失效`;
  return `本轮智能体自己起了 ${total} 个内置 Monitor，${how}——`
    + `它们的通知只注回智能体自己的会话（回合一结束，连它自己也看不到了），从来不会唤醒任务。`
    + `要跨回合等一件事，得用 ash 的哨兵（start_monitor）并用 pause_task 收尾这一轮。`;
};

/**
 * 这条说明该落在哪条会话的时间线上。
 *
 * 一个任务可以有好几条会话（用户 @ 过谁就多一条），按「最新」投递会把这段话贴到别人名下。
 * 认人用 `cli_session_id` —— 起这些监听的就是它。认不出来就交给 `appendTaskTimeline` 自己
 * 按最新会话兜底，那总比不记强。
 */
async function sessionOf(cliSessionId: string, taskId: string): Promise<string | undefined> {
  const row = (await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.taskId, taskId), eq(sessions.cliSessionId, cliSessionId)))
    .orderBy(desc(sessions.startedAt))).at(0);
  return row?.id;
}
