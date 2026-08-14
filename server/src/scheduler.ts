import { eq, asc, inArray } from "drizzle-orm";
import type { TaskStatus } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, groups, queueItems } from "./db/schema.js";
import { setTaskStatus } from "./status.js";
import { freezeStartingTurn, stopTask } from "./runs.js";
import { resumeOrRunTask } from "./task-resume.js";

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
  await db.update(groups).set({ paused: true }).where(eq(groups.id, groupId));
  const members = await db.select().from(tasks).where(eq(tasks.groupId, groupId));
  for (const t of members) {
    if (t.status === "queued") await setTaskStatus(t.id, "backlog");
    else if (t.status === "running" && stopTask(t.id, "paused")) continue;
    else freezeStartingTurn(t.id, "paused");
  }
}

async function setQueued(taskId: string) {
  await setTaskStatus(taskId, "queued");
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
  // 队列绑定到 group:如果 group 被 paused 就不推进
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (t?.groupId) {
    const g = (await db.select().from(groups).where(eq(groups.id, t.groupId))).at(0);
    if (g?.paused) return;
  }
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
export async function advanceQueue(queueId: string): Promise<void> {
  const next = await pickNextLaunchable(queueId);
  if (!next) return;
  await setQueued(next.id);
  void resumeOrRunTask(next.id, { reason: "queue" });
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
};

// 队列眼里的成员状态:续聊回合(followUpFrom 非空)虽然 status=running,但那一轮
// 不是任务的执行 —— 任务早就到终态、位置早就被透明跳过了。所以队列一律按续聊前
// 的终态看它:既不算「有人在跑」把整条线冻住,也不会被当成可启动项拉起来。
// (实测事故:队列 head 是个 done 任务,用户 11:30 给它发了条消息续聊,后面刚跑完
// 的那位就再也推进不了,整条流水线白等了六分钟。)
// 导出:queues.ts 的 queueBlockers(手点「运行」的前置检查)必须用同一把尺子。
export function queueStatus(t: { status: string; followUpFrom?: string | null }): string {
  return t.followUpFrom || t.status;
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
        (t.status === "paused" && !t.resumePrompt && !t.question)),
  );

  if (launchable.length) {
    const pending = [...launchable];
    const inflight = new Map<string, Promise<void>>();

    const launch = async (taskId: string): Promise<void> => {
      await setQueued(taskId);
      await resumeOrRunTask(taskId, { reason: "group" });
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
