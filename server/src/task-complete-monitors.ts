// 完成确认这一刻的两问，都只关于哨兵：
//
//  ① **还有会被这次完成毁掉的哨兵吗** —— 有就不许完成（`monitorsBlockingComplete`）。
//  ② **这一回合亲手撤掉过哨兵吗** —— 撤过就在时间线上留一行（`noteMonitorsDropped`）。
//
// 为什么是两问而不是一问：它们堵的是同一件事的两条路径。一条是「挂着哨兵直接收工」，闸
// 能当场拦住；另一条是「先 stop_monitor 再 complete_task」—— 那是合法动作的合法组合，拦
// 不得也不该拦（哨兵确实可能已经没用了），但用户有权一眼看见这个取舍，而不是事后去翻
// trace 才挖得出来。2026-10-20 的真实现场（任务 u7nb4wnGcX2O）走的正是第二条：挂上哨兵
// 10 秒后自撤、5 秒后把同一条等待命令换成活不过本回合的内置后台任务，最后两边都没拿到
// 结果。只做①的话，这种情形在界面上依旧一声不响。
//
// ── 闸拦的集合 = 完成那一刻**真会被收走**的集合 ───────────────────────────────────
//
// 这是本文件唯一容易写错的地方。任务落终态时 `stopMonitorsForTask` 并不收走所有哨兵：
// **属于一次仍在进行的审查的那些有豁免**（任务终态 ≠ 审查结束，见 monitor-reclaim.ts）。
// 所以闸必须用同一份判据，否则两边一漂移就会出现两种错：拦了却不收（审查者挂的哨兵白白
// 把执行者的完成堵死，而它本来就活得过这次完成），或者收了却不拦（回到今天这个缺口）。
// 判据就一句：`sourceReviewRun` 指向的那一轮审查此刻还活着 ⇒ 这条哨兵不受这次完成影响。
import { and, desc, eq, isNull } from "drizzle-orm";
import { monitorEventTally } from "@ash/shared/monitor-silence";
import { db } from "./db/index.js";
import { monitors, sessions } from "./db/schema.js";
import { appendTaskTimeline } from "./task-timeline.js";

type DoomedMonitor = {
  id: string;
  label: string;
  command: string;
  events: number;
  endedReason: string | null;
};

/** 描述是 agent 自己写的「我在盯什么」，没写就退回命令原文（跟 `liveMonitorSummary` 同一口径）。 */
const labelOf = (r: { description: string | null; command: string }): string =>
  (r.description ?? "").trim() || r.command.trim();

/**
 * 这次完成会毁掉哪几条哨兵。
 *
 * `status` 由调用方给：闸问的是 `running`（还在盯的），痕迹问的是 `stopped`（本回合被撤的）。
 * 审查豁免两边同一份 —— 一条属于活跃审查的哨兵既不该拦住完成，也不该在「撤了几个」里被
 * 算进去（它根本不是这次完成的受害者）。
 */
async function monitorsAffectedByCompletion(
  taskId: string,
  status: "running" | "stopped",
  since?: string,
): Promise<DoomedMonitor[]> {
  const { isReviewSourceActive } = await import("./monitor-session.js");
  const rows = await db
    .select({
      id: monitors.id, description: monitors.description, command: monitors.command,
      events: monitors.events, endedAt: monitors.endedAt, endedReason: monitors.endedReason,
      sourceReviewRun: monitors.sourceReviewRun, sourceReviewRound: monitors.sourceReviewRound,
    })
    .from(monitors)
    .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "ash"), eq(monitors.status, status)));
  const affected: DoomedMonitor[] = [];
  for (const r of rows) {
    // 时间窗只用于「本回合撤的」那一问。字符串比较成立是因为两列都是 `new Date().toISOString()`
    // （util.ts 的 `now`），同一种定长 UTC 格式，字典序就是时间序。
    if (since && !(r.endedAt && r.endedAt >= since)) continue;
    const spared = r.sourceReviewRun !== null
      && await isReviewSourceActive(r.sourceReviewRun, r.sourceReviewRound);
    if (spared) continue;
    affected.push({
      id: r.id, label: labelOf(r), command: r.command,
      events: r.events, endedReason: r.endedReason,
    });
  }
  return affected;
}

/**
 * 完成确认前的闸：名下还有活哨兵就不许完成，返回那句拒绝的话（`null` = 放行）。
 *
 * 文案里**必须带着两条出路**。只说「不许」的话，agent 碰上一个永远等不到的哨兵就被锁死在
 * 这个任务上 —— 而那恰恰是最常见的一种：2026-10-20 那条哨兵等的 `^OK` 根本不会出现（被等
 * 的测试进程早没了）。所以这里既要拦住「挂着哨兵就收工」，也要把 `stop_monitor` 这条明路
 * 指出来，让它做一个**有意识的**取舍，而不是撞上一堵没有门的墙。
 */
export async function monitorsBlockingComplete(taskId: string): Promise<string | null> {
  const live = await monitorsAffectedByCompletion(taskId, "running");
  if (live.length === 0) return null;
  const what = live.map((m) => m.label).slice(0, 3).join("、");
  const more = live.length > 3 ? `等 ${live.length} 个` : "";
  return (
    `完成确认被拦下：你名下还有 ${live.length} 个哨兵在盯着（${what}${more}）。`
    + "任务一落 done，它们会被系统一并停掉，它们在等的结果你就再也拿不到了。按你的判断选一条出路："
    + "① 还要那个结果 → 改用 pause_task 收尾，resumePrompt 写清「被哨兵叫醒后该干什么」；"
    + "哨兵醒来会把这条会话重新叫起来，已预约的审查也会等它。"
    + "② 不要了 → 对每个哨兵调 stop_monitor（reason 写清为什么不要了），再调 complete_task。"
  );
}

/** 这个任务当前这一轮是什么时候开跑的。会话行跨回合复用，所以 `turnStartedAt` 才是回合锚。 */
async function currentTurnStartedAt(taskId: string): Promise<string | null> {
  const row = (await db
    .select({ turnStartedAt: sessions.turnStartedAt, startedAt: sessions.startedAt })
    .from(sessions)
    .where(and(eq(sessions.taskId, taskId), isNull(sessions.endedAt)))
    .orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt))).at(0);
  return row?.turnStartedAt ?? row?.startedAt ?? null;
}

/**
 * 完成确认落定之后：这一回合撤掉过哨兵吗。撤过就写一条时间线。
 *
 * **跑在确认之后、任务还 running 的时候**，所以这时查到的 `stopped` 行必然是人或 agent 主动
 * 停的 —— 系统的那次收回（`stopMonitorsForTask`）要等任务真落 done 才发生，还没轮到。
 *
 * 失败不往上抛：完成确认已经落库了，一条说明文字写不进去不该把它翻掉。
 */
export async function noteMonitorsDropped(taskId: string): Promise<void> {
  try {
    const since = await currentTurnStartedAt(taskId);
    if (!since) return;
    const dropped = await monitorsAffectedByCompletion(taskId, "stopped", since);
    if (dropped.length === 0) return;
    const detail = dropped.slice(0, 3).map((m) => {
      const why = (m.endedReason ?? "").trim();
      return `${m.label}（${why ? `撤的理由「${why}」，` : ""}${monitorEventTally(m.events, m.command)}）`;
    }).join("；");
    const more = dropped.length > 3 ? `，另有 ${dropped.length - 3} 个` : "";
    await appendTaskTimeline(
      taskId,
      `本回合撤掉 ${dropped.length} 个哨兵后确认完成：${detail}${more}。`
      + "它们在等的结果不会再回来了——还需要的话得重新挂一个哨兵。",
    );
  } catch (e) {
    console.error(`[ash] 记录「撤哨兵后完成」失败 task=${taskId}:`, e);
  }
}
