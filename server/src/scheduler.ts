import { eq, asc, inArray } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { hasCliGoalHold } from "@ash/shared/cli-commands";
import { db } from "./db/index.js";
import { tasks, groups, queueItems } from "./db/schema.js";
import { setTaskStatus } from "./status.js";
import { claimTurn, freezeStartingTurn, isTurnClaimed, releaseTurn, stopTask, turnIdentity } from "./runs.js";
import { noteMissedAdvance, serializeQueueClaims } from "./queue-seat.js";
import { resumeOrRunTask } from "./task-resume.js";
import { preparePendingCheckpointStart } from "./pending-checkpoint-recovery.js";
import { reserveQueuedTask, restoreQueuedTask, taskQueueReservation, type TaskQueueReservation } from "./task-queue-reservation.js";
import { clearQueueAdvance, deferQueueAdvance, requestQueueAdvance, type QueueAdvanceRequest } from "./queue-advance-retry.js";
import { waitForStartReceipt } from "./task-start-receipt.js";

const MAX_PARALLEL = 4;

// 暂停整组(POST /groups/:id/pause 与团队的「停止全组」共用这一份):置 paused、
// 把还没起跑的 queued 退回 backlog、把正在跑的杀掉并**结算 paused**(不是
// canceled——canceled 会被队列透明跳过,恢复分组时就错启下一个;paused 占住
// head,恢复时从原 CLI 会话续跑被打断的那个)。
//
// 第三种成员：**回合已占位、进程还没起来**（重试按钮/派审刚 claim 完，正在解析执行器、
// 准备 worktree）。它既没有 handle 可杀，status 也还停在上一轮的终态 —— 只扫这两样的话
// pause 会 200 返回、CLI 随后照样被拉起来（第 1 轮审查复现 20/20）。所以扫描时**只要
// 杀不到就补一个起跑冻结标记**，由 spawn 前的最后一道闸消费（turn-freeze.ts）。
export async function pauseGroup(groupId: string): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.update(groups).set({ paused: true }).where(eq(groups.id, groupId));
    await transaction.update(tasks).set({ queueAdvanceRequest: null }).where(eq(tasks.groupId, groupId));
  }, { behavior: "immediate" });
  const members = await db.select().from(tasks).where(eq(tasks.groupId, groupId));
  for (const t of members) {
    // status 可能在队列推进/续聊交错时短暂失真；只要有活 handle，先杀进程永远优先。
    if (stopTask(t.id, "paused")) continue;
    if (t.status === "queued") await setTaskStatus(t.id, "backlog");
    else freezeStartingTurn(t.id, "paused");
  }
}

// Re-read the live paused flag each tick (the pause endpoint flips it mid-run).
async function isPaused(groupId: string): Promise<boolean> {
  const g = (await db.select().from(groups).where(eq(groups.id, groupId))).at(0);
  return !!g?.paused;
}

// Park tasks that were queued-but-never-started back to backlog so a paused
// group shows them parked (not stuck "queued") and a restart won't reap them.
async function parkQueued(groupId: string): Promise<void> {
  const waiting = (await db.select().from(tasks).where(eq(tasks.groupId, groupId))).filter(
    (t) => t.status === "queued",
  );
  for (const t of waiting) await setTaskStatus(t.id, "backlog");
}

// 终态钩子：任务进 done / canceled / failed 时,如果它在某个 queue 里,推进
// 那个 queue。failed 不再链停——失败的留在原地等用户/协调者处理,但后面的
// 继续跑(一个环节挂了不该拖住整条流水线)。awaiting_review 不触发——审查门
// 是明确的"等人"语义(DESIGN §3)。
// status.ts 在写完终态后会动态 import 调过来;保持纯函数,不依赖 status.ts。
export async function advanceQueueFromTask(taskId: string): Promise<void> {
  const item = (
    await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))
  ).at(0);
  if (!item) return; // 不在任何 queue 里(独立任务 / parallel group)
  await advanceQueue(item.queueId);
}

// 队列推进的唯一规则(DESIGN §3)。
// 沿 position 升序找 head:
//   - done / canceled / failed → 透明跳过,继续找(failed 留在原地等用户
//     重试/处理,但不挡后面的;重试完成 done 时钩子会再推进一次)
//   - awaiting_review → 停,审查门等用户
//   - running / queued → 等已在跑的那个跑完
//   - backlog → 拉起新 agent
//   - paused → 用 resumePrompt 续跑(resumeOrRunTask 内部按 status 分流)
// 每次推进只启动 head 一项;它跑完触发 advanceQueueFromTask 再推下一个。
export async function advanceQueue(queueId: string, request?: QueueAdvanceRequest): Promise<void> {
  // 「挑下一个」与「落 queued」收进队列认领临界区(queue-seat.ts,与手动运行/重跑/
  // 消息补投同一条链):分开的话,读完成员快照到落库之间的 await 窗口里,另一个入口
  // 刚认领的占位在这里看不见,按旧快照再拉起一个就是同队双跑(第 7 轮审查:跨入口
  // 竞争)。临界区里只做挑选与占位,真正拉起(resumeOrRunTask)在链外。
  const next = await serializeQueueClaims<(typeof tasks.$inferSelect & {
    reservation: TaskQueueReservation; advanceRequest: QueueAdvanceRequest;
  }) | "paused" | null>(async () => {
    const rows = await queueMembers(queueId);
    const candidate = selectNextInQueue(rows);
    if (request) {
      const target = rows.find((task) => task.id === request.taskId);
      if (!target || target.queueAdvanceRequest?.id !== request.id
        || target.resumePromptGeneration !== request.resumePromptGeneration || target.archived
        || ["done", "failed", "canceled"].includes(target.status) || target.question || hasCliGoalHold(target.cliState)
        || (target.groupId && await isPaused(target.groupId))) {
        await clearQueueAdvance(request);
        return "paused";
      }
      if (!candidate || candidate.id !== request.taskId) {
        deferQueueAdvance(queueId);
        return "paused";
      }
    }
    if (!candidate) {
      // 挑不出人,而冻结源里有旁路/续聊回合(followUpFrom 非终态)的活跃回合:这次
      // 让位会被它结算时的 quiet 恢复吞掉(setTaskStatus 的 quietAdvance),给它记一笔
      // 欠账,结算恢复后补办(账本与互斥性见 queue-seat.ts)。真执行的 running 不记:
      // 它自己的终态钩子会推进。
      for (const t of rows) {
        if (
          (t.followUpFrom === "paused" || t.followUpFrom === "backlog")
          && (t.status === "running" || t.status === "queued")
        ) noteMissedAdvance(t.id, queueId);
      }
      return null;
    }
    // 队列绑定到 group:组被暂停时允许编辑队列(保存排队关系),但不启动任何成员。
    // 检查放在这里而不是各调用方 —— 建队列/插入/重排/移除/终态钩子全走本函数,
    // 任何一个入口漏检都会撤销用户的暂停意图(第 1 轮审查实测:暂停组里入队,
    // 前驱当场被拉起)。成员同组是本文件的不变量,看 next 的 groupId 就够。
    if (candidate.groupId && (await isPaused(candidate.groupId))) return "paused";
    const advanceRequest = request ?? await requestQueueAdvance(queueId, candidate);
    if (!advanceRequest) return "paused";
    deferQueueAdvance(queueId);
    if (await preparePendingCheckpointStart(candidate.id)) {
      return "paused";
    }
    // 观察空闲 ≠ 取得所有权:上一版先 isTurnClaimed 再 setQueued,检查与落位之间的
    // await 窗口里 checkpoint 追问这类合法入口照样抢走回合 —— 推进把追问的 running
    // 覆盖成 queued、续跑被旧 reply 占的锁挡回、追问结算恢复 paused,交接蒸发
    // (第 5 轮审查确定性复现)。claimTurn 是同步的内存原子操作,在临界区里直接
    // **认领**所有权:抢到才落 queued,续跑带 turnHeld 进场;抢不到(占用方多半是
    // 刚进来的旁路追问)记账,等它 releaseTurn 后回调补办这次推进。
    if (!claimTurn(candidate.id)) {
      noteMissedAdvance(candidate.id, queueId);
      return null;
    }
    // 认领与接管之间的每个异常出口都要收口:setQueued 一旦写失败(典型:并发写锁把
    // busy timeout 耗尽),临界区异常外抛,下面的续跑与占位回收都装不上 —— 新认领的锁
    // 就没人释放,任务从此 /run 一律 409「回合正在进行」,人工也救不回(第 6 轮审查:
    // 真实 SQLite 写锁 7 秒注入,一次可恢复的超时变成永久停滞)。失败即释放锁、延迟
    // 一拍记账重推:数据库恢复可写后自动续上这次交接。
    const reservation = taskQueueReservation(candidate);
    try {
      await reserveQueuedTask(reservation);
    } catch (err) {
      releaseTurn(candidate.id);
      console.error(`[ash] 队列推进占位写入失败(${candidate.id}),释放预认领并稍后补偿:`, err);
      // 失败 ≠ 肯定没写入:setTaskStatus 写完 status 还要读 sessions 算用时再广播,
      // UPDATE 已提交、附带 SELECT 才超时的话任务已经是 queued —— selectNextInQueue
      // 会被这具遗留占位冻结,单纯重推救不回(第 7 轮审查:短暂锁故障后整队永久
      // 「排队中」)。按持久结果补偿:延迟交给 reclaimStrandedSeat 守卫式收拾(queued
      // 遗留就回滚,没写进去就只记账重推),它自己失败会再重试,数据库恢复后交接续上。
      scheduleSeatReclaim(candidate.id, queueId, candidate.status as TaskStatus, 1_000, { reservation });
      return null;
    }
    return { ...candidate, reservation, advanceRequest };
  });
  if (next === "paused") return;
  if (next && typeof next === "object") {
    const prevStatus = next.status as TaskStatus; // 临界区里读到的占位前状态
    void waitForStartReceipt(next.id, () => resumeOrRunTask(next.id, { reason: "queue", turnHeld: true })
      .catch((err) => {
        console.error(`[ash] 队列推进续跑(${next.id})失败:`, err);
        // 接管前就抛了(读库/取指令那串 await):turnHeld 的锁还挂在我们头上 —— 占着
        // 期间别的入口 claim 不进来,所以此刻还被占的锁必是这次认领的,由认领方收回。
        // 接管后的异常由 continueTask 自己吸收并在 finally 释放,不会走到这里。
        if (isTurnClaimed(next.id)) releaseTurn(next.id);
      })
      .finally(() => reclaimStrandedSeat(next.id, queueId, prevStatus, { reservation: next.reservation })))
      .then(async (started) => {
        if (started) await clearQueueAdvance(next.advanceRequest);
        else deferQueueAdvance(queueId);
      }).catch((error) => {
        console.error(`[ash] 队列启动回执确认失败(${next.id}):`, error);
        deferQueueAdvance(queueId);
      });
    return;
  }
  if (!next) {
    // 没有可启动的成员 ≠ 队里没事可做:失败成员的**执行型待发送回复**(排队期间暂存
    // 的修改要求,见 pending-messages 的 execution)在等「整队无人在跑」才能投递。它的
    // 任务已是终态,不会再有自己的结算钩子来救,只推自己的 flush 又只看发起任务 ——
    // 这里是「队列刚空出来」这一事实的唯一权威时点,替队内成员推一把。按 position
    // 顺序逐个入列:投递侧对每个成员走 claimQueueSeat 认领占位(queue-seat.ts),前一个
    // 成员的 queued 先落库,后一个成员的判定才执行,所以**至多一个**被启动(第 6 轮
    // 审查:并行扫描曾让两个失败成员同时恢复执行);无关成员在判定里是 no-op。
    const members = await queueMembers(queueId);
    const idle = members.filter((t) => !t.archived && t.mode === "single");
    if (idle.length) {
      void import("./pending-messages.js").then(({ deliverPendingMessages }) =>
        Promise.all(idle.map((t) => deliverPendingMessages(t.id).catch(() => undefined))),
      );
    }
    return;
  }
}

// 续跑没接管占位的兜底:turnHeld 的锁被 enterTurn 退回(验收互斥、接力拒收),或占位
// 写入半途而废(UPDATE 已提交、附带读取才失败)—— 任务停在 queued、回合又没人持有,
// 不收拾就是永久「排队中」。守卫与 queue-seat 的 seat.release 同款:正常跑完的回合在
// 这里全是 no-op(状态早被结算覆盖/锁被真实回合接管)。回滚用 quiet(回原样不是落位);
// 重推延迟一拍 —— 互斥方(典型:验收)没有结束钩子来推队列,立刻重试只会原地打转。
//
// repush = 回收之后要不要记账重推队列,三档按**是谁欠下这次启动**选:
//   "always"   队列推进自己的占位写失败:交接确实发生过、语义就是 resume-or-run,
//              即使写入没提交也要记账,数据库恢复后由 advanceQueue 原样补办;
//   "stranded" finally 的常规兜底(缺省):只有真收拾了 queued 遗留才记账 —— 正常
//              结算的回合自有终态钩子,不额外多推;
//   "never"    手动/扫描入口(/run、/fire、/retry、消息投递)的占位写失败:只回滚
//              遗留,**绝不记账重推** —— advanceQueue 的补办是 resumeOrRunTask,会把
//              /fire 的「全新一轮」偷换成续跑旧会话、消费掉检查点指令(第 ll7XKsu_ps0n
//              链第 2 轮实测);这些入口各有自己的重试面(用户重点、扫描重投、定时
//              不消费班次),失败就让原入口按原语义重来。
// 导出供回归直调(触发它的真实路径是「UPDATE 提交后附带 SELECT 超时」,无法从测试
// 外侧精确注入到两条语句之间)。
export async function reclaimStrandedSeat(
  taskId: string,
  queueId: string,
  prevStatus: TaskStatus,
  opts?: { repush?: "always" | "stranded" | "never"; reservation?: TaskQueueReservation },
): Promise<void> {
  const repush = opts?.repush ?? "stranded";
  if (isTurnClaimed(taskId)) return;
  try {
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    const reservation = opts?.reservation ?? (row ? {
      taskId, prevStatus, token: row.queueSeatToken, epoch: row.directionEpoch,
    } : undefined);
    const stranded = !!reservation && await restoreQueuedTask(reservation);
    if (repush === "never" || (repush === "stranded" && !stranded)) return;
    if (row && !stranded && (row.status !== prevStatus || row.directionEpoch !== reservation?.epoch)) return;
    const timer = setTimeout(() => noteMissedAdvance(taskId, queueId), 1_000);
    timer.unref?.();
  } catch (err) {
    // 补偿自己也可能撞上还没放开的写锁:不放弃,退避后重试 —— 这正是「数据库恢复后
    // 再补办交接」的那一等(第 7 轮审查:一次短暂锁故障不许变成永久停滞)。
    console.error(`[ash] 队列占位补偿失败(${taskId}),5s 后重试:`, err);
    scheduleSeatReclaim(taskId, queueId, prevStatus, 5_000, { repush, reservation: opts?.reservation });
  }
}

function scheduleSeatReclaim(
  taskId: string,
  queueId: string,
  prevStatus: TaskStatus,
  delayMs: number,
  opts?: { repush?: "always" | "stranded" | "never"; reservation?: TaskQueueReservation },
): void {
  const timer = setTimeout(() => void reclaimStrandedSeat(taskId, queueId, prevStatus, { repush: "always", ...opts }), delayMs);
  timer.unref?.();
}

// selectNextInQueue 只需要这几列,写成结构类型,单测就能直接喂字面量。
export type QueueMember = {
  id: string;
  status: string;
  archived: boolean;
  mode: string | null;
  question: string | null;
  // 非空 = 这一轮是「续聊」(终态任务的追加对话),队列按这个终态看待它。
  followUpFrom?: string | null;
  cliState?: string | null;
};

// 队列眼里的成员状态:终态任务的续聊回合虽然 status=running,但那一轮不是任务的
// 执行 —— 位置早就被透明跳过了，所以按续聊前的终态看它。paused/backlog 等非终态
// 只用于旁路完成后的落位，不能遮住真实 running，否则队列会把活回合再拉一次。
// (实测事故:队列 head 是个 done 任务,用户 11:30 给它发了条消息续聊,后面刚跑完
// 的那位就再也推进不了,整条流水线白等了六分钟。)
// 导出:queues.ts 的 queueBlockers(手点「运行」的前置检查)必须用同一把尺子。
export function queueStatus(t: { status: string; followUpFrom?: string | null }): string {
  const before = t.followUpFrom;
  return before === "done" || before === "canceled" || before === "failed" ? before : t.status;
}

// 队列推进的纯计算核心:给定按 position 排好的成员,挑出"现在该被拉起来的那个"。
// **不变量:一个 queue 同一时刻至多一个成员在跑。** 所以先整体扫一遍,只要有人
// running/queued 就一个都不启动 —— 不能只靠"顺序扫到才发现",因为被透明跳过的
// 终态任务(典型:failed)一旦回到 backlog,它的位置就排在正在跑的那个**前面**,
// 顺序扫描会先命中它,于是同一条串行队列上两个任务并跑(实测:05 失败 → 06 起跑
// → 在 05 点重新排队 → 05 和 06 一起跑)。守卫放这里,所有推进入口
// (advanceQueue / runGroup / queues 的 reorder·remove·insert / requeue)一起受益。
export function selectNextInQueue<T extends QueueMember>(rows: T[]): T | null {
  const live = rows.filter((t) => !t.archived && t.mode !== "team");
  if (live.some((t) => queueStatus(t) === "running" || queueStatus(t) === "queued")) return null;

  for (const t of live) {
    const s = queueStatus(t) as TaskStatus;
    if (s === "done" || s === "canceled" || s === "failed") continue;
    if (s === "awaiting_review") return null; // 审查门:链停等用户
    // 提问暂停(question 非空)≠ 检查点暂停:它在等 answer_question 带答复唤醒,
    // 队列跟着等,绝不能在这里用「继续」把它空手叫醒(问题会白问)。
    if (s === "paused" && t.question) return null;
    if (s === "paused" && hasCliGoalHold(t.cliState)) return null;
    return t; // backlog / paused
  }
  return null;
}

// 给定 queue,挑出"现在应该被拉起来的下一个 task"(或 null = 没有)。
// 只读 DB、不变状态,便于给 UI 用来高亮"下一个会跑的";规则本身在
// selectNextInQueue(纯函数,单测覆盖)。
export async function pickNextLaunchable(queueId: string): Promise<typeof tasks.$inferSelect | null> {
  const rows = await queueMembers(queueId);
  return selectNextInQueue(rows);
}

// queue 成员按 position 升序取出(一次批查,避免逐条查库)。归档成员仍占位置,
// 所以照样取回来 —— 由 selectNextInQueue 决定怎么对待。
export async function queueMembers(queueId: string): Promise<(typeof tasks.$inferSelect)[]> {
  const items = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.queueId, queueId))
    .orderBy(asc(queueItems.position));
  if (items.length === 0) return [];
  const rows = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.id, items.map((i) => i.taskId)));
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return items.map((i) => byId.get(i.taskId)).filter((t): t is typeof tasks.$inferSelect => !!t);
}

// Run an entire group. parallel mode:扫所有 backlog/paused,限流并行启动。
// serial mode:找该 group 关联的 queue,调用 advanceQueue 推进一次
// (后续推进靠 advanceQueueFromTask 终态钩子自动链式触发,不再 while-loop)。
// A paused group starts nothing;pausing mid-run 不会取消已在跑的,但不会启动新的。
export async function runGroup(groupId: string): Promise<void> {
  const group = (await db.select().from(groups).where(eq(groups.id, groupId))).at(0);
  if (!group) throw new Error("group not found");
  if (group.paused) return;

  if (group.mode === "serial") {
    // 找该 group 关联的 queue(通过任一 task 反查 queue_items)
    const groupTasks = await db.select().from(tasks).where(eq(tasks.groupId, groupId));
    if (!groupTasks.length) return;
    const items = await db
      .select()
      .from(queueItems)
      .where(inArray(queueItems.taskId, groupTasks.map((t) => t.id)));
    const queueIds = [...new Set(items.map((i) => i.queueId))];
    if (queueIds.length === 0) {
      // 异常:serial group 却没 queue。可能是 group 后来才被设成 serial、
      // 或者迁移漏了。退化按 parallel 跑(用户至少能看见任务在动)。
      console.warn(`[scheduler] serial group ${groupId} 没有 queue,退化按 parallel 启动`);
      return runParallel(groupId);
    }
    if (queueIds.length > 1) {
      // 违反不变量:同 group 多 queue。打 warn,仍尝试推进每个 queue。
      console.error(`[scheduler] group ${groupId} 关联到多个 queue: ${queueIds.join(",")}`);
    }
    for (const qid of queueIds) await advanceQueue(qid);
    return;
  }

  // parallel
  await runParallel(groupId);
}

// parallel mode 的执行:扫所有 backlog 任务并行启动,限流 MAX_PARALLEL。
// **不**主动唤起检查点 paused(带 resumePrompt)/提问 paused(带 question)任务
// ——那些得靠队列推进按顺序 resume / 等答复(否则同链上所有 paused task 一起跑
// 就破坏了 resume 顺序)。canceled / failed 也不在这里被
// 批量唤起 —— 那是 P0d-fY_Zi4RC 那个事故的根因(DESIGN §0 #3)。
// 例外:「组暂停打断」的 paused(无 resumePrompt 无 question——唯一来源就是
// group pause 杀掉 running 任务),恢复分组时在这里续跑。
// 在 queue 里的任务(含 backlog)一律不在这里启动——parallel group 也可能
// 挂着 queue(混合形态:queue 表达完成顺序,mode 表达初始启动方式,两者正交,
// 见 migrateQueues),并行拉起会破坏队列顺序;统一交给末尾的 advanceQueue
// 按位置逐个拉起。
async function runParallel(groupId: string): Promise<void> {
  const groupRows = await db.select().from(tasks).where(eq(tasks.groupId, groupId));
  const items = await db
    .select()
    .from(queueItems)
    .where(inArray(queueItems.taskId, groupRows.map((t) => t.id)));
  const inQueue = new Set(items.map((i) => i.taskId));
  const launchable = groupRows.filter(
    (t) =>
      !t.archived &&
      t.mode !== "team" && // 防御:团队任务不进组,也不该被分组批量拉起
      !inQueue.has(t.id) &&
      (t.status === "backlog" ||
        (t.status === "paused" && !t.resumePrompt && !t.question && !hasCliGoalHold(t.cliState))),
  );

  if (launchable.length) {
    const pending = [...launchable];
    const inflight = new Map<string, Promise<void>>();

    const launch = async (taskId: string): Promise<void> => {
      if (await preparePendingCheckpointStart(taskId)) return;
      const before = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
      if (!before || (before.status === "paused" && before.resumePrompt)) return;
      if (!claimTurn(taskId)) return;
      const owner = turnIdentity(taskId);
      const reservation = taskQueueReservation(before);
      try {
        await reserveQueuedTask(reservation);
        await resumeOrRunTask(taskId, { reason: "group", turnHeld: true });
      } finally {
        if (owner && turnIdentity(taskId) === owner) releaseTurn(taskId);
        await restoreQueuedTask(reservation);
      }
    };

    while (pending.length || inflight.size) {
      if (!(await isPaused(groupId))) {
        while (pending.length && inflight.size < MAX_PARALLEL) {
          const t = pending.shift()!;
          const p = launch(t.id).finally(() => inflight.delete(t.id));
          inflight.set(t.id, p);
        }
      }
      if (inflight.size) await Promise.race(inflight.values());
      else break;
    }
    await parkQueued(groupId);
  }

  // 让本 group 关联的所有 queue 也推一下(关键:如果有 paused task 在 queue
  // 头部、它的前驱都已 done,就应该自动 resume)
  const queueIds = [...new Set(items.map((i) => i.queueId))];
  for (const qid of queueIds) await advanceQueue(qid);
}
