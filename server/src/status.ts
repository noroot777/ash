import { and, eq, type SQL } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { db } from "./db/index.js";
import { tasks, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { stopPreviewOnRerun } from "./preview.js";
import { beginRerunGate, endRerunGate } from "./rerun-gate.js";
import { reviewTurnInFlight } from "./review-turn.js";
import { now, runsTiming } from "./util.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { previewStopFailure } from "./preview-process-stop.js";
import { recordTaskStatus } from "./task-start-status.js";
import { releaseTerminalLanding } from "./task-complete.js";
import { directionIdentityCleared } from "./task-direction-epoch.js";

const TERMINAL: TaskStatus[] = ["done", "failed", "canceled"];

// Single source of truth for changing a task's status. Besides persisting the
// status it maintains the run-timing columns and broadcasts them, so every
// surface (single run, duet, scheduler, manual patch) keeps `startedAt` /
// `endedAt` consistent and the web can show start/end/duration live:
//   • → running  : stamp startedAt once (first run), clear endedAt.
//   • → terminal : stamp endedAt (run finished).
//   • → paused   : 跑到检查点（非终止），startedAt/endedAt 都不动；下次 resume
//                  会走 → running 路径自动清掉 endedAt。
//   • otherwise  : leave the timestamps untouched.
export async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
  opts?: {
    /**
     * 这次写 paused 是续聊/旁路回合**恢复原状态**,不是「刚跑到检查点落位」——别触发
     * 队列推进钩子。推进会把一个本就静静等着的 paused 成员(典型:队列 head 上带
     * resumePrompt 的检查点)当作新到位的立即续跑:检查点被一句「怎么样了」间接消费、
     * 无确认结算成 failed、后项被放行(第 ln9Q6IJEgmWf 链第 2 轮)。
     * 已知代价:追问回合期间前项恰好结束的话,那次推进被 running 的旁路回合冻结,
     * 恢复时又不补推 —— 任务静止等下一个队列事件或用户手点。保守方向:少做不会丢
     * 检查点,误做会。恢复终态不走这个口子:让位与待发送消息的 flush 都靠那次推进。
     */
    quietAdvance?: boolean;
  },
): Promise<void> {
  const cur = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  // 又开跑了:这一段里不许有新的自由工作流动作(起预览、验收、派审…)。**同步竖起来、
  // 状态落库之后才放下**——收预览和写 running 是两步,中间那条缝里库里那行还是 `done`,
  // 按状态放行的动作会一路放行(见 rerun-gate.ts)。
  const rerun = status === "running" && !!cur && cur.status !== "running";
  if (rerun) beginRerunGate(taskId);
  try {
    await writeTaskStatus(taskId, status, cur, rerun, opts?.quietAdvance);
  } finally {
    if (rerun) endRerunGate(taskId);
  }
}

async function writeTaskStatus(
  taskId: string,
  status: TaskStatus,
  cur: typeof tasks.$inferSelect | undefined,
  rerun: boolean,
  quietAdvance?: boolean,
  guard?: SQL,
  queueSeatToken?: string | null,
): Promise<boolean> {
  const updatedAt = now();
  let startedAt = cur?.startedAt ?? null;
  let endedAt = cur?.endedAt ?? null;
  const patch: Record<string, unknown> = { status, updatedAt, queueSeatToken: queueSeatToken ?? null };

  if (status === "running") {
    if (!startedAt) patch.startedAt = startedAt = updatedAt;
    patch.endedAt = endedAt = null;
    // 又开跑了：上一轮起的预览指向的是上一版代码，留着只会让人对着旧页面验新改动。
    // 收在这儿是因为**所有**开跑路径都经过这一个函数（手点运行、队列推进、修复续跑）。
    //
    // **旁路回合例外**：审查轮/验证轮只读工作区、不产出新一版代码，页面不会在用户眼皮
    // 底下变成别的东西。收掉它等于每派一次审查就把用户正看着的预览关掉——而那十几分钟
    // 恰恰是最该自己点开看一眼的时候（见 review-turn.ts）。身份在这一刻已经落下：
    // claimTurn/reclaimTurn 都排在 setStatus(running) 之前。
    if (rerun && !reviewTurnInFlight(taskId)) {
      try { await stopPreviewOnRerun(taskId); }
      catch (error) { await appendTaskTimeline(taskId, `旧预览回收暂缓，任务继续运行。${previewStopFailure(error).message}`); }
    }
  } else if (TERMINAL.includes(status)) {
    patch.endedAt = endedAt = updatedAt;
    patch.queueAdvanceRequest = null;
  }
  if (status !== "running") {
    // 回合内的身份随回合结束作废。**`direction_epoch` 不在此列,那不是漏写**:它正是为了
    // 补上这三列归零之后留下的那条分不清的边 —— 「现在空着」原本同时意味着「我清掉的那一轮
    // 已结束」和「后来又跑完了另一轮」,于是改派失败后迟到的回滚把旧提问、旧完成确认写回一个
    // 已经跑完新回合的任务(第 4 轮审查 F1-B)。世代一路只增,这里碰它就等于把那条边又抹掉。
    Object.assign(patch, directionIdentityCleared());
  }

  const changed = await db.update(tasks).set(patch).where(and(eq(tasks.id, taskId), guard)).returning({ id: tasks.id });
  if (!changed.length) return false;
  // 这一行落库了 ⇒ 结算那一关置的闩可以撤了(见 task-complete.ts 的 `beginTerminalLanding`):
  // 它护的就是「核完阻塞物」到「这一笔写进库」之间那条缝。从这一刻起,库里这一行自己就答得了
  // 「还能不能挂哨兵」—— 终态由 `monitorSourceGate` 挡住,非终态本来就该放行。
  //
  // **撤在终态清理之前、而且不只在终态撤**:续聊回合核过闩之后恢复的可能是 paused/backlog
  // 一类非终态,只在终态分支撤的话,那一轮会把这个任务的创建挡到闩过期为止。撤销幂等。
  releaseTerminalLanding(taskId);
  recordTaskStatus(cur, status);
  if (TERMINAL.includes(status)) {
    // 任务自己结束了,它名下的哨兵一并停掉。哨兵唯一的出口就是「唤醒这个任务」,任务都
    // 结束了还留着它,只会在某个深夜把一个已经 done 的任务重新叫起来跑一轮。要让哨兵
    // 继续盯,这一轮该用 pause_task 收尾而不是 complete_task —— 这句判据同时写在 MCP
    // 工具说明里,那是 agent 做这个选择时唯一看得到的地方。
    //
    // **必须排在终态落库之后**:清理那一侧要判「这个任务还能不能被哨兵叫醒」,而它读的
    // 就是这一行。写在前面的话,清理和紧跟其后排队的创建请求读到的都还是 running —— 于是
    // 任务都 done 了还能起得来一个新哨兵,它一直盯到超时,推的每一条又都被终态挡回
    // (第 3 轮审查实测:natural-terminal-start-queue 里第二次创建 ok:true、任务 done)。
    //
    // **必须 await**:下面那句 flushPendingForTask 会把排着队的消息立刻送进会话,清理要是
    // 还在路上,刚攒下的哨兵事件就会抢在它前面把这个已经 done 的任务重新拉起来跑一轮。
    await import("./monitor-reclaim.js")
      .then(({ stopMonitorsForTask }) => stopMonitorsForTask(taskId, `任务已${status}，哨兵一并收回`))
      .catch((err) => console.error(`[ash] stopMonitorsForTask(${taskId}) failed:`, err));
  }
  // Carry execution-time fields so every surface updates live with the status —
  // notably the terminal transition, where every turn now has ended_at so
  // activeMs is final and liveSince clears. When no session rows exist yet (status
  // flips to running just before the row is recorded) omit them, so the client
  // keeps its last fetched value rather than seeing a transient null.
  const runs = await db
    .select({ activeMs: sessions.activeMs, turnStartedAt: sessions.turnStartedAt, endedAt: sessions.endedAt })
    .from(sessions)
    .where(eq(sessions.taskId, taskId));
  const timing = runs.length ? runsTiming(runs) : {};
  bus.publish({ type: "task.status", taskId, status, updatedAt, startedAt, endedAt, ...timing });

  // 队列推进钩子(DESIGN §3):任务进 done / canceled / failed / paused 时,
  // 如果它在某个 queue 里,触发那个 queue 的下一位推进。
  // - done / canceled / failed = 透明,head 让位(failed 留在原地等用户处理,
  //   但不挡后面的——一个环节挂了不拖整条流水线)
  // - paused = 让上游(若也 paused)知道"我已经到位等续跑了",但只有当我
  //   恰好是 head 的时候 advance 才会启动我;否则我继续静静等
  // awaiting_review 不触发——审查门是明确的"等人"语义。
  // 动态 import scheduler 以避免和 scheduler → status 的循环。
  if (status === "done" || status === "canceled" || status === "failed" || (status === "paused" && !quietAdvance)) {
    void import("./scheduler.js").then(({ advanceQueueFromTask }) =>
      advanceQueueFromTask(taskId).catch((err) =>
        console.error(`[ash] advanceQueueFromTask(${taskId}) failed:`, err),
      ),
    );
  }

  // 待发送消息钩子:任务一不在跑了,就把排着队的那条送进去(排队追问的正常触发源)。
  // 只靠 scheduler 的 30s tick 的话,用户会对着一条本该立刻发出的消息干等最多半分钟,
  // 界面上看起来就像「排队坏了」。paused 也算空闲——提问中的任务照样接得住回复。
  // awaiting_review 是明确的"等人"语义,不在此列;判定与投递单点仍在 pending-messages.ts。
  if (status !== "running" && status !== "queued" && status !== "awaiting_review") {
    void import("./pending-messages.js").then(({ flushPendingForTask }) => flushPendingForTask(taskId));
  }
  return true;
}

export async function writeGuardedTaskStatus(taskId: string, status: TaskStatus, guard: SQL,
  queueSeatToken: string | null = null): Promise<boolean> {
  const current = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  return writeTaskStatus(taskId, status, current, false, true, guard, queueSeatToken);
}
