// 删一条任务:连带收掉的那一堆关联状态,以及 `DELETE /tasks/:id` 本体。
//
// 从 task-routes.ts 拆出来,是因为那份文件已经顶到 700 行上限,而「删除」是其中自洽度
// 最高的一块:它跟建任务、改任务不共用任何局部状态,只靠 `mountTaskDeleteRoutes(api)`
// 挂回去。`deleteTaskCompletely` 跟着一起搬——项目删除那条路(project-routes.ts)也
// 调它,留在建任务那份文件里只会让人以为它跟建任务有关。
import type { TaskWorkspaceDiscardResult } from "@ash/shared";
import { eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { acceptGateRuns, freeReviewDebateTurns, freeReviewDebates, freeReviewRounds, freeReviewRuns, freeWorkflowEvents, freeWorkflowStates, groups, monitorPendingCalls, monitors, noteTasks, projects, queueItems, schedules, scheduledMessages, sessionTurns, sessions, taskMemos, tasks, teamInbound, taskBranchReceipts } from "./db/schema.js";
import { revokeTaskMonitors, settleTaskRevocation } from "./claude-monitor-backfill.js";
import { clearScanCursorsStatement } from "./claude-monitor-cursors.js";
import { stopMonitorsForTask } from "./monitor-reclaim.js";
import { stopAcceptGatesForTask } from "./accept-gate.js";
import { deleteTaskSideChats } from "./chat/lifecycle.js";
import { branchDeletionRejection, deleteTaskBranchRefs } from "./task-branch-plan.js";
import { taskBusyRejection } from "./task-busy.js";
import { forgetTaskUnconfirmed } from "./session-turns.js";
import { withRepoLock } from "./repo-lock.js";
import { detectTaskWorkspace, discardTaskWorkspace } from "./workspace-cleanup.js";

// 删一个任务:关联状态 + 任务行本身,**一个出口、一个原子批**。自由审查链(run/round)、预约槽、
// 事件、排队/定时消息、随手记回链都要一起收。没有 FK cascade,只删任务行会留下孤儿——审查实测:
// 等答复的审查在任务删除后永远停在 reviewing,答复消息永远 pending(投递时任务已不存在)。
//
// **任务行的删除从调用方搬进来了**(第 5 轮审查 F1):内置 Monitor 的删除门闸要按「删完之后
// 任务行还在不在」收口(`settleTaskRevocation`),而调用方各自删行时,这个函数的 finally 永远
// 看到「行还在」—— 要么永远关着闸(任务还在却再也打不开它的监听),要么永远开着(删干净了还
// 在写孤儿)。两种都错,所以删除的全部语句必须在同一个出口里。
//
// **而且必须在同一个原子批里**(第 6 轮审查 F1):一条一条删的话,中间任何一条失败都留下
// 「任务还在、它的行已经没了」—— 审查实测 10 个失败点里有 6 个让留下来的任务永久丢卡:
// monitors 删完之后再失败,ash 那张历史卡没有任何重建路径;sessions 也删完之后再失败,连内置
// Monitor 的重建依据(按会话找 run 文件)都没了,刷新多少次都回不来。`db.batch` 在同一个
// BEGIN…COMMIT 里同步跑完这些语句,中途抛错整批回滚:**要么任务连同它的一切都没了,要么一切
// 原样还在**,不存在第三种状态。
export async function deleteTaskCompletely(taskId: string): Promise<void> {
  try {
    await deleteTaskRows(taskId);
  } finally {
    // 删成了还是删一半失败,由它按「任务行还在不在」收口(见 claude-monitor-backfill.ts)。
    await settleTaskRevocation(taskId);
  }
}

async function deleteTaskRows(taskId: string): Promise<void> {
  // ── 批之前:**回滚不掉的那几样**,顺序由它们自己的依赖决定 ──────────────────────
  //
  // 它们都读「删除之前的状态」才找得到要收的东西(旁聊房间、git ref、哨兵的 pid),所以只能
  // 排在前面;代价是删除失败时它们已经做了。这不影响 F1 那条不变量——**卡片和它的重建依据
  // 全在批里**(monitors / sessions / pending / cursors),这里停掉的是进程、删掉的是 git ref。
  revokeTaskMonitors(taskId);
  await deleteTaskSideChats(taskId);
  await deleteTaskBranchRefs(taskId);
  // 哨兵:**先把进程停了再删行**。顺序反过来就再也没人知道那个 pid 是谁的,它会一直
  // 跑到机器重启为止 —— 这是整个功能最容易留下的垃圾(进程本来就是故意脱离 ash 的)。
  // 上面那行 `revokeTaskMonitors` 必须排在所有删除之前:它关掉内置 Monitor 那四个 writer
  // 的落库资格(门闸,覆盖整个删除期),并作废进程内缓着的扫描状态/恢复责任。
  // `destroy`：用户要求这个任务的一切就此结束，审查还在进行也不留 —— 下面那一批删除紧接着
  // 就把 pid 这个唯一线索一起带走（见 monitors.ts 的 MonitorStopIntent）。
  //
  // **这里不吞异常**(第 3 轮审查 F1)。逐条停失败由回收层自己兜(补杀 + 留下持久的回收
  // 责任),抛到这里的只剩「连枚举都没成」—— 那时我们**压根不知道有几个进程在跑**,再往下
  // 删就是把 pid 线索连同任务一起抹掉。删除失败是可重试的(闸由 `settleTaskRevocation` 按
  // 「任务行还在」收口,用户再点一次即可),留下无主进程不可逆,所以这一笔宁可整个不做。
  await stopMonitorsForTask(taskId, "任务已删除", "destroy");
  // 验收前置命令跟哨兵同一个道理:**先停进程再删行**。正常路径上 taskBusyRejection 已经
  // 把「门禁还在跑的任务」挡在删除之外了,这里兜的是绕过那道闸的入口(项目删除的批量路径)
  // —— 行一删,pid 这条唯一线索就没了,那条全量回归会一直跑到机器重启。
  //
  // **等它真的停下来**(第 1 轮审查 F2):下面紧接着就要删工作区,而那条命令的 cwd 正是
  // 那儿。两刀都下过仍确认不了退出的,如实抛出 —— 删行是可重试的,留一个还在往已删目录
  // 里写文件的无主进程不可逆。
  if (!await stopAcceptGatesForTask(taskId)) {
    throw new Error("验收前置命令的进程停不掉(TERM、KILL 都发过了仍确认不到它退出),所以没有删除这个任务 —— "
      + "再往下删会把 pid 这条唯一线索一起抹掉。等它退出后再删一次。");
  }

  // ── 批本体:全删或全不删 ─────────────────────────────────────────────────────
  const runs = db.select({ id: freeReviewRuns.id }).from(freeReviewRuns)
    .where(eq(freeReviewRuns.taskId, taskId));
  // 辩论挂在轮次上（debates → debate_turns），得先于 rounds 收掉，否则 round 行一删
  // 就再没有任何线索能找到那些发言行。子查询而不是先查 id 再删:查和删之间隔着 await,
  // 那段时间里新写进来的行会被漏掉,而批里的子查询跟删除是同一条语句。
  const debates = db.select({ id: freeReviewDebates.id }).from(freeReviewDebates)
    .where(eq(freeReviewDebates.taskId, taskId));
  await db.batch([
    db.delete(taskBranchReceipts).where(eq(taskBranchReceipts.taskId, taskId)),
    // 验收前置命令的执行记录:不删就是一堆指着已删任务的孤儿行(还带着 pid 和日志路径)。
    db.delete(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId)),
    db.delete(freeReviewDebateTurns).where(inArray(freeReviewDebateTurns.debateId, debates)),
    db.delete(freeReviewDebates).where(eq(freeReviewDebates.taskId, taskId)),
    db.delete(freeReviewRounds).where(inArray(freeReviewRounds.runId, runs)),
    db.delete(freeReviewRuns).where(eq(freeReviewRuns.taskId, taskId)),
    db.delete(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, taskId)),
    db.delete(freeWorkflowEvents).where(eq(freeWorkflowEvents.taskId, taskId)),
    db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, taskId)),
    db.delete(monitors).where(eq(monitors.taskId, taskId)),
    // **`monitor_reclaim_debts` 刻意不在这里。** 那张表记的是「这个 pid 该停、但没停掉」,
    // 它的全部意义就是活得比任务久 —— 跟着任务一起删等于把唯一线索再丢一次(第 3 轮审查
    // F1)。收档只有一个出口:能追的线索都追空了(monitor-reclaim-debts.ts 的清扫)。
    // 还没配上 `task_started` 的那几条调用（见 claude-monitor-pending.ts）：任务都删了，
    // 它们再也不会被配上，留下就是没有任何入口能清的孤儿行。
    db.delete(monitorPendingCalls).where(eq(monitorPendingCalls.taskId, taskId)),
    // 历史扫描读到哪儿了（见 claude-monitor-cursors.ts）：任务都没了，这几行再没人会用。
    clearScanCursorsStatement(taskId),
    db.delete(teamInbound).where(eq(teamInbound.taskId, taskId)), // 调度台还没送出的入站消息
    db.delete(noteTasks).where(eq(noteTasks.taskId, taskId)),
    // 任务备忘:只有这个任务一个入口能读到它,任务没了就是再也打不开的孤儿行。
    db.delete(taskMemos).where(eq(taskMemos.taskId, taskId)),
    // 会话行、定时计划、队列位也一起收：孤儿 cron 每个 tick 都会被扫到再查不到任务，
    // 队列残位会顶住后续推进（审查实测：删除后 sessionRows/scheduleRows 各剩 1）。
    db.delete(sessions).where(eq(sessions.taskId, taskId)),
    db.delete(sessionTurns).where(eq(sessionTurns.taskId, taskId)),
    db.delete(schedules).where(eq(schedules.taskId, taskId)),
    db.delete(queueItems).where(eq(queueItems.taskId, taskId)),
    // 团队派活自建的内部组（groups.owner_task_id=本任务）：GET /groups 默认过滤掉它们，
    // 留下来就是永远不可见也没入口清理的孤儿（审查实测：删 lead 后两个内部组原样保留）。
    db.delete(groups).where(eq(groups.ownerTaskId, taskId)),
    db.delete(tasks).where(eq(tasks.id, taskId)),
  ]);
  // 库里的行删完了,写端内存里那几笔「没落账的开始意图」也得跟着走：它们本来只在「这条会话
  // 又开一个回合」时才有人去补、去划掉（session-turns.ts 的 flushUnconfirmed）,任务都没了
  // 就再也不会有那一下,留着就是长命进程里只增不减的无主条目（第 1 轮审查 N3）。
  // **只在确实删除时清**:暂停、失败、停止一律不清 —— 那几笔还是有效证据。
  forgetTaskUnconfirmed(taskId);
}

// 删除任务。`worktree=1` / `branch=1` 表示用户在确认框里勾了「连 worktree 和分支
// 一起删」,`force=1` 是看过第一次失败之后的再来一次(--force / -D)。
//
// 顺序刻意是「先删任务行,再清 git」:删任务是用户的主要意图,git 那边失败(worktree
// 脏、分支未合并)不该把它一起挡回去 —— 结果原样回给 UI,由用户决定强制删还是留着。
export function mountTaskDeleteRoutes(api: Hono): void {
api.delete("/tasks/:id", async (c) => {
  const tid = c.req.param("id");
  const existing = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  const deletionProject = existing ? (await db.select().from(projects).where(eq(projects.id, existing.projectId))).at(0) : undefined;
  return withRepoLock(deletionProject?.repoPath, async () => {
  // 正在跑 / 占着 turn / 在验收 / 有 child 在飞的任务都不能整行删掉,判据与理由见
  // task-busy.ts —— 项目级的两个入口用的是同一份,别在这里再拼一遍。
  const busy = await taskBusyRejection(tid, "删除");
  if (busy) return c.json(busy, 409);
  // 都停了则连 children 行一并删,不留悬空 parentId。
  const children = existing ? await db.select().from(tasks).where(eq(tasks.parentId, tid)) : [];
  const project = existing
    ? (await db.select().from(projects).where(eq(projects.id, existing.projectId))).at(0)
    : undefined;
  for (const row of [existing, ...children]) {
    if (!row || !project) continue;
    const rejection = await branchDeletionRejection(project.repoPath, row.id);
    if (rejection) return c.json(rejection, 409);
  }
  const wantWorktree = c.req.query("worktree") === "1";
  const wantBranch = c.req.query("branch") === "1";
  // children 的 Git 工作区必须与它们的行一起处理：只删行的话，独立 worktree/分支会变成
  // 数据库里查无此任务的孤儿资源，leftover 检测（按父任务 id）也看不到（审查实测）。
  const childCleanups: (TaskWorkspaceDiscardResult & { taskId: string })[] = [];
  for (const child of children) {
    await deleteTaskCompletely(child.id);
    if (project && child.useWorktree && (wantWorktree || wantBranch)) {
      childCleanups.push({
        taskId: child.id,
        ...await discardTaskWorkspace(project.repoPath, child.id, {
          worktree: wantWorktree,
          branch: wantBranch,
          force: c.req.query("force") === "1",
        }),
      });
    }
  }
  await deleteTaskCompletely(tid);
  let cleanup: TaskWorkspaceDiscardResult | null = null;
  if (project && (wantWorktree || wantBranch)) {
    cleanup = await discardTaskWorkspace(project.repoPath, tid, {
      worktree: wantWorktree,
      branch: wantBranch,
      force: c.req.query("force") === "1",
    });
  }
  // 清理之后仍然剩下的东西:没勾选、或勾了但 git 拒绝。UI 据此决定要不要继续追问。
  // children 的残留一并报（它们的行已删，之后没有别的入口能发现这些资源）。
  const leftover = project ? await detectTaskWorkspace(project.repoPath, tid) : null;
  const childLeftovers = project
    ? (await Promise.all(children.map(async (child) => ({
        taskId: child.id,
        leftover: await detectTaskWorkspace(project.repoPath, child.id),
      })))).filter((entry) => entry.leftover && (entry.leftover.path || entry.leftover.branch))
    : [];
  return c.json({
    deleted: true, leftover, cleanup,
    // 连删的全部行（父 + children）：前端按它同步本地任务集合——只摘父 id 会把
    // children 留成刷新前的幽灵任务（审查实测）。
    deletedTaskIds: [tid, ...children.map((child) => child.id)],
    ...(childCleanups.length ? { childCleanups } : {}),
    ...(childLeftovers.length ? { childLeftovers } : {}),
  });
  });
});
}
