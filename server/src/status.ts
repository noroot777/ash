import { and, eq, inArray } from "drizzle-orm";
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
     * **条件写**:只有库里当前状态仍是这里列的值之一,这一笔才提交。
     *
     * 为什么需要它:本函数自己内部就隔着 await(先整行 SELECT 再 UPDATE),所以调用方
     * 「先查一次归属、紧接着调我」是挡不住交错的 —— 真正的权威后来者(用户点停止写
     * canceled)能在那段窗口里落库,随后这一笔照样把它盖掉,还连带发布终态、停哨兵、
     * 推进队列(本轮审查 F1 实测:停止回 200 且库里是 canceled,旧回滚结束后变成 failed)。
     *
     * 给了它之后,「核验」和「写」争的是同一条 UPDATE 语句(WHERE 里带状态),没有窗口。
     * 不命中 = 这一笔过期了:**一个副作用都不触发**,返回 false 让调用方自己收场。
     */
    expectStatus?: TaskStatus | TaskStatus[];
    /**
     * 紧贴 UPDATE 之前再同步问一句「这次写还归我吗」。
     *
     * 补的是 `expectStatus` 看不见的那一种过期:状态**恰好还是**期望值,但那已经是
     * 后来者重新占下的同一个状态(队列占位换了代次 —— `claimQueueSeat` 走自己那条认领链,
     * 不需要回合锁,所以回合锁拦不住它)。谓词必须同步:中间一旦有 await,求值结果到
     * 写入之间就又有了窗口。
     */
    owns?: () => boolean;
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
): Promise<boolean> {
  const cur = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  // 又开跑了:这一段里不许有新的自由工作流动作(起预览、验收、派审…)。**同步竖起来、
  // 状态落库之后才放下**——收预览和写 running 是两步,中间那条缝里库里那行还是 `done`,
  // 按状态放行的动作会一路放行(见 rerun-gate.ts)。
  const rerun = status === "running" && !!cur && cur.status !== "running";
  if (rerun) beginRerunGate(taskId);
  try {
    return await writeTaskStatus(taskId, status, cur, rerun, opts);
  } finally {
    if (rerun) endRerunGate(taskId);
  }
}

async function writeTaskStatus(
  taskId: string,
  status: TaskStatus,
  cur: typeof tasks.$inferSelect | undefined,
  rerun: boolean,
  opts: Parameters<typeof setTaskStatus>[2],
): Promise<boolean> {
  const quietAdvance = opts?.quietAdvance;
  const expect = opts?.expectStatus === undefined
    ? null
    : (Array.isArray(opts.expectStatus) ? opts.expectStatus : [opts.expectStatus]);
  const owns = opts?.owns;
  const updatedAt = now();
  let startedAt = cur?.startedAt ?? null;
  let endedAt = cur?.endedAt ?? null;
  const patch: Record<string, unknown> = { status, updatedAt };

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
  }
  if (status !== "running") {
    // 回合内的身份随回合结束作废。**`direction_epoch` 不在此列,那不是漏写**:它正是为了
    // 补上这三列归零之后留下的那条分不清的边 —— 「现在空着」原本同时意味着「我清掉的那一轮
    // 已结束」和「后来又跑完了另一轮」,于是改派失败后迟到的回滚把旧提问、旧完成确认写回一个
    // 已经跑完新回合的任务(第 4 轮审查 F1-B)。世代一路只增,这里碰它就等于把那条边又抹掉。
    Object.assign(patch, directionIdentityCleared());
  }

  // ── 条件写的那一条语句 ───────────────────────────────────────────────────────
  // `owns()` 到这条 UPDATE 之间**不许出现 await**:谓词答的是「此刻还归我吗」,隔一个
  // await 它就又变成了一次过期的快照(理由见 setTaskStatus 的 `owns`)。
  if (owns && !owns()) return false;
  const written = await db
    .update(tasks)
    .set(patch)
    .where(expect ? and(eq(tasks.id, taskId), inArray(tasks.status, expect)) : eq(tasks.id, taskId))
    .returning({ id: tasks.id });
  // 一行都没改到 = 状态在我读到它之后被别人改了,这一笔过期。**就此收手**:下面每一件事
  // (撤落地闩、记状态、停哨兵、广播、推进队列、flush 待发送)都是「状态真的变了」的后果,
  // 过期的写发布它们就等于用一次没发生的变更去驱动整条链(本轮审查 F1)。
  //
  // 只在调用方给了条件时才短路:无条件的调用方(绝大多数)从来不检查返回值,也不该因为
  // 任务行恰好不存在就少走一遍既有的广播与钩子。
  if (expect && !written.length) return false;
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
