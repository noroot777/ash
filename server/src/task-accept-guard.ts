// 验收前的「在飞检查」（从 task-accept.ts 拆出，纯行数拆分）：任务或共享执行者正在
// running/queued、或回合已被 claim（DB status 尚未落 running 的窗口），都算在飞——
// 后者只看 status 会在 agent 已开跑时合并并删掉它正在用的 worktree（审查实测复现）。
import { eq, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { ConflictHandoff } from "./accept-conflict.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { isTurnClaimed } from "./runs.js";

export type AcceptWarning = {
  reason: "temporary_cleanup_failed";
  message: string;
  worktreePath: string;
};

export type InFlightTask = {
  id: string;
  title: string;
  status: string;
  role: "task" | "shared_worker";
};

export type AcceptFailure = {
  accepted: false;
  httpStatus: 404 | 409;
  taskId: string;
  reason: string;
  error: string;
  status?: string;
  sourceBranch?: string;
  targetBranch?: string | null;
  conflictFiles?: string[];
  dirtyFiles?: string[];
  targetPath?: string;
  worktreePath?: string;
  /** 冲突已交给来源任务的 agent 去解(只在 merge_conflict 时出现) */
  conflictHandoff?: ConflictHandoff;
  phase?: "initial" | "before_accept" | "before_merge" | "before_cleanup";
  inFlightTasks?: InFlightTask[];
  warnings?: AcceptWarning[];
};

export async function acceptanceState(taskId: string): Promise<{
  task: typeof tasks.$inferSelect | null;
  inFlightTasks: InFlightTask[];
}> {
  const related = await db
    .select()
    .from(tasks)
    .where(or(eq(tasks.id, taskId), eq(tasks.parentId, taskId)));
  const task = related.find((row) => row.id === taskId) ?? null;
  if (!task) return { task: null, inFlightTasks: [] };

  // DB status 之外还要看 turn 锁：续聊从 claimTurn 到写 running 之间有真实窗口，
  // 只看 status 会在 agent 已开跑时合并并删掉它正在用的 worktree（审查实测复现）。
  const inFlight = (row: typeof tasks.$inferSelect) =>
    row.status === "running" || row.status === "queued" || isTurnClaimed(row.id);
  const inFlightTasks: InFlightTask[] = [];
  if (inFlight(task)) {
    inFlightTasks.push({ id: task.id, title: task.title, status: task.status, role: "task" });
  }
  if (task.mode === "team") {
    const workers = related.filter((row) => row.parentId === task.id);
    for (const worker of workers) {
      // 共享执行者除了「正在跑」，「从未执行(backlog)/停在检查点(paused)」同样挡验收：
      // 团队验收会把全部共享执行者的 stage 联动置 accepted——盖到没跑过/待续跑的活上，
      // 「团队整体验收完成」就包含了从未发生的工作（审查实测：backlog/paused 都被盖成
      // accepted）。
      const notSettled = worker.status === "backlog" || worker.status === "paused";
      if (!worker.useWorktree && (inFlight(worker) || notSettled)) {
        inFlightTasks.push({ id: worker.id, title: worker.title, status: worker.status, role: "shared_worker" });
      }
    }
  }
  return { task, inFlightTasks };
}

export async function acceptanceGuard(
  taskId: string,
  phase: AcceptFailure["phase"],
): Promise<{ task: typeof tasks.$inferSelect | null; failure: AcceptFailure | null }> {
  const state = await acceptanceState(taskId);
  if (!state.task) {
    return {
      task: null,
      failure: { accepted: false, httpStatus: 404, taskId, reason: "not_found", error: "not found", phase },
    };
  }
  // 每个阶段都重查 archived：验收入口检查过之后、合并/清理之前，任务可能刚被归档——
  // Archived = frozen/read-only，冻结之后一个字节都不能再写（审查实测过中途归档穿透）。
  if (state.task.archived) {
    return {
      task: state.task,
      failure: {
        accepted: false,
        httpStatus: 409,
        taskId,
        reason: "task_archived",
        error: "任务已归档（只读）；先取消归档再验收",
        status: state.task.status,
        phase,
      },
    };
  }
  // 接力出去的任务(含 pending 未确认)同样每个阶段都拦:横幅定义它是「历史存档」,
  // 验收却会把接力时刻的旧提交合入本机主分支、清掉 worktree——目标机还在同一分支上
  // 继续干活,回程必然更难合(审查实测:out+pending 任务 accept 直接 200)。
  const handedOff = handoffBlockReason(state.task.handoff);
  if (handedOff) {
    return {
      task: state.task,
      failure: {
        accepted: false,
        httpStatus: 409,
        taskId,
        reason: "task_handed_off",
        error: handedOff,
        status: state.task.status,
        phase,
      },
    };
  }
  // 未收尾的就地验证轮 / 待答复的提问，同样算「这一版还没定稿」，不能验收：
  // ① 验证轮的轮次号还挂在任务身上（`verifyRound` 非空 = 这一轮还没 concludeRound），
  //    验收写下 accepted 之后那一轮回来结算，会拿验证结论把 accepted 盖成
  //    verified/verify_failed（见 review.ts `finishVerifyRound`）——验收事实被一个
  //    比它更早开始的回合覆盖掉。
  // ② 提问态（`question` 非空）意味着 agent 停在半路等答复，答复会 resume 同一会话
  //    继续往 worktree 里写。验收已经把分支合并、worktree 删掉了，于是「已验收」的
  //    产物和 agent 手里正在写的那份对不上（审查实测：验收后库里 done|accepted|
  //    verify_round=1|question 仍在，再 POST /answer 仍 200 并继续写）。
  // 两者都是 running/queued/turn 锁看不见的状态——任务确实没有进程在跑，但它这一版
  // 的生命周期没结束。先把它们收掉（答复 / 等验证轮出结论）再验收。
  if (state.task.verifyRound !== null || state.task.question) {
    const pendingQuestion = !!state.task.question;
    return {
      task: state.task,
      failure: {
        accepted: false,
        httpStatus: 409,
        taskId,
        reason: pendingQuestion ? "question_pending" : "verify_round_in_flight",
        error: pendingQuestion
          ? "任务有待答复的提问，答复并等它跑完这一轮再验收"
          : `第 ${state.task.verifyRound} 轮就地验证还没出结论，等它结束再验收`,
        status: state.task.status,
        phase,
      },
    };
  }
  if (state.inFlightTasks.length === 0) return { task: state.task, failure: null };

  const sharedWorkers = state.inFlightTasks.filter((item) => item.role === "shared_worker");
  const listed = state.inFlightTasks.map((item) => `${item.title}（${item.id}，${item.status}）`).join("、");
  return {
    task: state.task,
    failure: {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: sharedWorkers.length > 0 ? "shared_team_workers_in_flight" : "task_in_flight",
      error: sharedWorkers.length > 0
        ? `共享执行者仍在进行或尚未完成（running/queued/backlog/paused），先运行完或停掉再验收：${listed}`
        : `任务正在 running/queued，必须等当前执行结束后再验收：${listed}`,
      status: state.task.status,
      phase,
      inFlightTasks: state.inFlightTasks,
    },
  };
}
