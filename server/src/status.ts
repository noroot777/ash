import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
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
import { clearStallFailure } from "./turn-stall-verdict.js";

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
export type SetTaskStatusOptions = {
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
   * 这一笔 done 是**一次完成**,不是「把续聊/启动失败/重启对账打断之前的原状态放回去」。
   * 只有它会给 `done_seq` 加一(「等它完成后发送」比的就是这个,pending-after.ts),而且跟
   * status 同一条 UPDATE。默认不算:恢复原状态的入口(停止、出错、提问、启动失败、重启对账、
   * 引导回退)一律不传,传它的只有真正收尾的那几处(结算交卷、续聊正常结束、duet 收官、
   * 用户手动标完成)。非 done 时忽略。
   */
  completion?: boolean;
  /**
   * 由所有权层包住实际数据库提交,失去所有权时返回 false。
   * 数据库驱动可能等待写门,同步谓词不能覆盖这个窗口。队列占位通过共用认领链,
   * 把核验、等待写门、提交及广播串在一起;队列推进异步排到链尾,不在这里等待重入。
   */
  commitGuard?: (commit: () => Promise<boolean>) => Promise<boolean>;
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
  /**
   * 这一笔落位**同时消费掉**的那几项回合输入事实(续聊前的原状态、原生回合标记、完成确认)。
   *
   * 为什么非得挤进同一条 UPDATE(main 那一轮第 2 轮审查 F2,已实测):结算侧原先是「先清
   * `followUpFrom`、下一句再写 status」两条语句。两句之间任务是 `running + followUpFrom=null`
   * —— 此刻进程没了,**恢复原终态所需的那个事实已经永久消失**,重启后的对账只能把一个本该
   * 回到 `done` 的任务落成 failed。用户那边唯一的区别只是 ash 有没有在那条缝里重启。
   *
   * 起跑侧一直是对的(`guarded-turn-start.ts` / `review-start-retry.ts`:status 与这三列在同一笔
   * 事务里写),结算侧照它对齐。类型只允许「清掉」那几个值:这个口子不是通用的字段补写入口。
   */
  consume?: { followUpFrom?: null; nativeTurn?: false; completeConfirmedAt?: null };
  /**
   * 这一笔落位**兑现掉**的熔断失败义务(会话 + 回合起点)。
   *
   * 为什么销账只能从这个口子走(main 那一轮第 2 轮审查 F1,已实测):判决的回收条件是「这个执行
   * 身份的任务落位已经持久确认」,而全仓唯一知道这件事的就是**真把那一行写进库的那一次**。启动
   * 对账原先在算出落位之前就销了账(`interruptedTurnVerdict` 里),后面还隔着持续目标善后、时间线、
   * 基线恢复和最终状态写入 —— 这中间重启一次、或者任何一个 await 抛一次,盘上就留下「任务仍
   * running、失败义务已销账」:下一次启动只看到一个已经闭合的回合,一个提示过「已自动终止」的
   * 持续目标回来显示「暂停中 + 继续」。
   *
   * 做成这个函数的参数,而不是「记得在 setStatus 之后再调一句」:后者的正确性靠调用顺序,而
   * 这条链上每一轮审查都在证明调用顺序护不住这件事。写在这儿,销账与落位同生共死 ——
   * UPDATE 没改到行(被 guard/expectStatus 挡下、任务已被删)就一个字都不销。
   *
   * 回合区间自己就是权威结局的那几条链(duet 的一轮发言、团队那台的一个回合)不走这里:
   * 它们的失败由各自的区间与返回值承载,跟任务那一行什么时候落位无关(见
   * turn-stall-verdict.ts 的 `clearStallFailure`)。
   */
  settleStallTurns?: { sessionId: string; turnStartedAt: string }[];
};

/** 只有 `writeGuardedTaskStatus` 这一条内部入口用得到的两档:调用方自带谓词 + 占位凭证。 */
type WriteStatusOptions = SetTaskStatusOptions & {
  guard?: SQL;
  queueSeatToken?: string | null;
};

export async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
  opts?: SetTaskStatusOptions,
): Promise<boolean> {
  const cur = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  // 又开跑了:这一段里不许有新的自由工作流动作(起预览、验收、派审…)。**同步竖起来、
  // 状态落库之后才放下**——收预览和写 running 是两步,中间那条缝里库里那行还是 `done`,
  // 按状态放行的动作会一路放行(见 rerun-gate.ts)。
  const rerun = status === "running" && !!cur && cur.status !== "running";
  if (rerun) beginRerunGate(taskId);
  try {
    const commit = () => writeTaskStatus(taskId, status, cur, rerun, opts);
    return await (opts?.commitGuard ? opts.commitGuard(commit) : commit());
  } finally {
    if (rerun) endRerunGate(taskId);
  }
}

async function writeTaskStatus(
  taskId: string,
  status: TaskStatus,
  cur: typeof tasks.$inferSelect | undefined,
  rerun: boolean,
  opts?: WriteStatusOptions,
): Promise<boolean> {
  const quietAdvance = opts?.quietAdvance;
  const expect = opts?.expectStatus === undefined
    ? null
    : (Array.isArray(opts.expectStatus) ? opts.expectStatus : [opts.expectStatus]);
  const updatedAt = now();
  let startedAt = cur?.startedAt ?? null;
  let endedAt = cur?.endedAt ?? null;
  const patch: Record<string, unknown> = { status, updatedAt, queueSeatToken: opts?.queueSeatToken ?? null };

  if (status === "running") {
    if (!startedAt) patch.startedAt = startedAt = updatedAt;
    patch.endedAt = endedAt = null;
    // 又开跑了：上一轮起的预览指向的是上一版代码，留着只会让人对着旧页面验新改动。
    // 收在这儿是因为**所有**开跑路径都经过这一个函数（手点运行、队列推进、修复续跑）。
    //
    // **旁路回合例外**：审查轮/验证轮只读工作区、不产出新一版代码，页面不会在用户眼皮
    // 底下变成别的东西。收掉它等于每派一次审查就把用户正看着的预览关掉——而那十几分钟
    // 恰恰是最该自己点开看一眼的时候（见 review-turn.ts）。身份在这一刻已经落下：
    // claimOwnTurn/reclaimTurn 都排在 setStatus(running) 之前。
    if (rerun && !reviewTurnInFlight(taskId)) {
      try { await stopPreviewOnRerun(taskId); }
      catch (error) { await appendTaskTimeline(taskId, `旧预览回收暂缓，任务继续运行。${previewStopFailure(error).message}`); }
    }
  } else if (TERMINAL.includes(status)) {
    patch.endedAt = endedAt = updatedAt;
    patch.queueAdvanceRequest = null;
    // 「完成」这个事件跟 status=done 同一条 UPDATE 落下:等它完成后发送的消息比的就是它
    // (pending-after.ts)。拆成两笔的话,两笔之间崩掉或迟到的处理都分不清是哪一次完成。
    // 只认调用方声明的完成(`completion`):放回原 done 不是新的一次完成。
    if (status === "done" && opts?.completion) patch.doneSeq = sql`${tasks.doneSeq} + 1`;
  }
  if (status !== "running") {
    // 回合内的身份随回合结束作废。**`direction_epoch` 不在此列,那不是漏写**:它正是为了
    // 补上这三列归零之后留下的那条分不清的边 —— 「现在空着」原本同时意味着「我清掉的那一轮
    // 已结束」和「后来又跑完了另一轮」,于是改派失败后迟到的回滚把旧提问、旧完成确认写回一个
    // 已经跑完新回合的任务(第 4 轮审查 F1-B)。世代一路只增,这里碰它就等于把那条边又抹掉。
    Object.assign(patch, directionIdentityCleared());
  }

  // 回合输入事实跟着这一笔一起消费(见 `SetTaskStatusOptions.consume`):同一条 UPDATE,所以
  // 「落位写下了」和「输入被消费了」永远同时成立或同时不成立,中间没有可以崩进去的缝。
  if (opts?.consume) Object.assign(patch, opts.consume);
  // ── 条件写的那一条语句 ───────────────────────────────────────────────────────
  // 两档条件是两条独立链路各自带进来的,互不替代,这里取并集:
  //   · `expectStatus` —— 库里当前状态必须还是它列的那几个之一(执行占位认领)
  //   · `guard`      —— 调用方自带的归属谓词(队列预留、推进重放)
  const written = await db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, taskId), opts?.guard, expect ? inArray(tasks.status, expect) : undefined))
    .returning({ id: tasks.id });
  // 一行都没改到 = 要么状态在我读到它之后被别人改了、要么这一行已经不在了,这一笔过期。
  // **就此收手**:下面每一件事(撤落地闩、记状态、停哨兵、广播、推进队列、flush 待发送)
  // 都是「状态真的变了」的后果,过期的写发布它们就等于用一次没发生的变更去驱动整条链。
  //
  // 这条对无条件调用方也生效(跟 main 一致):那种情形下 WHERE 里只剩 id,写不中就只有
  // 一种解释——任务行已经被删了。对一个不存在的任务广播状态、推进它的队列没有一点好处。
  if (!written.length) return false;
  // **落位这一行确实写进去了** —— 这是熔断判决唯一的合法回收条件(见
  // `SetTaskStatusOptions.settleStallTurns`)。紧跟在这个判断之后,中间不插任何 await:再往后
  // 挪一步就又给出一条「落位已写、义务还欠着」的缝,而那条缝正是 main 那一轮拦下的东西。
  for (const turn of opts?.settleStallTurns ?? []) clearStallFailure(turn.sessionId, turn.turnStartedAt);
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
  // 别的任务上「等它完成后发送」的消息:完成了就锁存并发;失败/取消了托盘要改口说在等什么。
  if (status === "done" || status === "canceled" || status === "failed") {
    void import("./pending-after.js").then(({ flushPendingAfterTask }) => flushPendingAfterTask(taskId))
      .catch((err) => console.error(`[ash] flushPendingAfterTask(${taskId}) failed:`, err));
  }
  return true;
}

export async function writeGuardedTaskStatus(taskId: string, status: TaskStatus, guard: SQL,
  queueSeatToken: string | null = null): Promise<boolean> {
  const current = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  return writeTaskStatus(taskId, status, current, false, { quietAdvance: true, guard, queueSeatToken });
}
