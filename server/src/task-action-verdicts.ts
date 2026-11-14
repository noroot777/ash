// 任务「此刻能做什么」的判据本体：每个动作一个吃事实的纯函数。路由拿它挡请求，
// `GET /tasks/:id/actions` 拿它下发给前端 —— 同一个函数，不许两份
// （为什么见 shared/src/task-actions.ts 的文件头）。重跑上一回合的判据住在 task-retry-turn.ts
// （`retryTurnRejection`），形状与这里一样。
//
// 这里只收**确定性**的事实：库里的行、同队成员、审查链、有没有活进程。回合锁、验收锁、加成员锁
// 这些转瞬即逝的占位不在这里，由各路由在判据之后自己查（撞车被拒时照样回一句原因）。
import type { ActionVerdict, PrimaryAction, TaskStatus } from "@ash/shared";
import { canArchive, canSingleRun } from "@ash/shared";
import { queueBlockedText, type QueueBlocker } from "@ash/shared/scheduled-message-wait";
import { isTeamSettled, teamNeverStarted } from "@ash/shared/team";
import { handoffBlockReason } from "./handoff-guard.js";

/** 判据要的那几列（任务行的子集，回归脚本直接喂字面量）。 */
export type ActionTask = {
  mode: string;
  status: string;
  archived: boolean;
  parentId: string | null;
  reviewOf: string | null;
  workflowMode: string | null;
  handoff: string | null;
  question: string | null;
  resumePrompt: string | null;
  verifyRound: number | null;
  resumePromptGeneration: number;
  queueAdvanceRequest: { resumePromptGeneration: number } | null;
};

export type ActionFacts = {
  task: ActionTask;
  /** 在不在某条队列里。 */
  inQueue: boolean;
  /** 同队挡着它执行的成员（`queueBlockerDetails`）。 */
  blockedBy: QueueBlocker[];
  /** 这个任务名下有没有活着的 agent 进程（`isRunning`）。 */
  liveProcess: boolean;
  /** 上级是团队：执行者跟着团队一起归档、一起取回。 */
  parentIsTeam: boolean;
  /** 自由工作流有一轮审查正在进行（`hasActiveFreeReview`）。 */
  freeReviewActive: boolean;
  /** 历史独立审查任务还有一轮没结束。 */
  legacyReviewActive: boolean;
  /** 团队任务才有：名下执行者各自的状态，和它派活建的分组有没有被停下（停止全组看整个团队）。 */
  team: { workers: { status: TaskStatus }[]; groupsPaused: boolean } | null;
};

/** 路由那一侧多带两样：回给调用方的附加字段，和要不要往任务时间线留痕（`noted`）。 */
export type Verdict =
  | { ok: true }
  | { ok: false; reason: string; hidden?: true; detail?: Record<string, unknown>; note?: true };

const OK: Verdict = { ok: true };
const hide = (reason: string, detail?: Record<string, unknown>): Verdict => ({ ok: false, reason, hidden: true, detail });
const block = (reason: string, detail?: Record<string, unknown>): Verdict => ({ ok: false, reason, detail });

export function publicVerdict(verdict: Verdict): ActionVerdict {
  if (verdict.ok) return { ok: true };
  return verdict.hidden ? { ok: false, reason: verdict.reason, hidden: true } : { ok: false, reason: verdict.reason };
}

const live = (status: string) => status === "running" || status === "queued";

/**
 * 运行 / 继续（`POST /tasks/:id/run`）。普通任务允许 backlog / canceled / failed / paused；团队的
 * idle 也能运行（常驻调度台待命，点击接回同一条会话）。
 *
 * 就地验证轮没出结论、或者有待答复的提问时不给运行（团队除外：调度台的提问走它自己的答复）——
 * 轮次号还挂着时起一轮普通回合会被当成这一轮验证的续跑，提问态则是把等着的那个问题丢掉
 * （口径同 `/fire`）。
 */
export function runVerdict(f: ActionFacts): Verdict {
  const { task } = f;
  // 停在检查点上的任务，这颗键叫「继续」：那句原因跟着键名说。
  const verb = task.status === "paused" ? "继续" : "运行";
  if (task.archived) return hide(`任务已归档，先取消归档再${verb}`, { archived: true });
  const handedOff = handoffBlockReason(task.handoff);
  if (handedOff) return hide(handedOff, { handoff: true });
  const runnable = task.mode === "team"
    ? !["running", "queued", "awaiting_review"].includes(task.status)
    : canSingleRun(task.status as TaskStatus);
  if (!runnable) return hide("任务当前状态不可运行", { status: task.status });
  const settled = pendingSideState(task, verb);
  if (settled) return settled;
  return queueVerdict(f);
}

/** 重试（`POST /tasks/:id/retry`）：只有失败的任务。 */
export function retryVerdict(f: ActionFacts): Verdict {
  const { task } = f;
  if (task.archived) return hide("任务已归档，先取消归档再重试", { archived: true });
  const handedOff = handoffBlockReason(task.handoff);
  if (handedOff) return hide(handedOff, { handoff: true });
  if (task.status !== "failed") return hide("只有失败的任务可以重试", { status: task.status });
  const settled = pendingSideState(task, "重试");
  if (settled) return settled;
  return queueVerdict(f);
}

function pendingSideState(task: ActionTask, verb: string): Verdict | null {
  if (task.mode === "team") return null;
  if (task.verifyRound !== null) {
    return hide(`第 ${task.verifyRound} 轮就地验证还没出结论，等它结束再${verb}`, { verifyRound: task.verifyRound });
  }
  if (task.question) return hide(`任务在等你答复，先回答提问再${verb}`, { question: true });
  return null;
}

// 同队有人在跑、或前面还有没让位的：手动启动不得插队。这里是确定性的那一半，权威认领在
// queue-seat.ts 的 seatThenStart（检查与占位同一临界区）。
function queueVerdict(f: ActionFacts): Verdict {
  if (!f.blockedBy.length) return OK;
  return { ok: false, reason: queueBlockedText(f.blockedBy), detail: { blockedBy: f.blockedBy.map((b) => b.id) }, note: true };
}

/**
 * 此刻轮到你的那一步。失败了是重试，没跑过 / 取消了是运行，停在检查点上是继续（同一个 `/run`）；
 * 团队只有「还没起过」时才有运行 —— 起过以后停和续是团队外壳自己的「停止全组 / 恢复全组」。
 */
export function primaryAction(f: ActionFacts): PrimaryAction | null {
  const { status, mode } = f.task;
  if (mode === "team") return teamNeverStarted(status as TaskStatus) ? { kind: "run", ...publicVerdict(runVerdict(f)) } : null;
  if (status === "failed") return { kind: "retry", ...publicVerdict(retryVerdict(f)) };
  if (status === "canceled" || status === "backlog") return { kind: "run", ...publicVerdict(runVerdict(f)) };
  if (status === "paused") return { kind: "resume", ...publicVerdict(runVerdict(f)) };
  return null;
}

/**
 * 停止（`POST /tasks/:id/stop`）。三样有一样就有东西可停：待启动的队列运行请求（撤销它）、活着的
 * 进程（杀掉）、状态还停在 running / queued（进程已丢或还没 spawn，直接落 canceled）。
 */
export function stopVerdict(f: ActionFacts): Verdict {
  const { task } = f;
  const request = task.queueAdvanceRequest;
  const pendingAdvance = !!request && request.resumePromptGeneration === task.resumePromptGeneration
    && ["paused", "backlog", "queued", "running"].includes(task.status);
  if (pendingAdvance || f.liveProcess || live(task.status)) return OK;
  return hide("任务没有在运行的进程可停止", { status: task.status });
}

/**
 * 停止全组（`POST /tasks/:id/team/halt`；团队任务的「停止」就是它）：调度台在说话、或者还有执行者
 * 在跑 / 排队 / 停在检查点上，才有东西可停。已经停下了（分组暂停着）不再出这颗 —— 那时团队头出的
 * 是「恢复全组」，那是团队壳自己的事。
 */
export function teamHaltVerdict(f: ActionFacts): Verdict {
  const { task, team } = f;
  if (task.mode !== "team" || !team) return hide("只有团队任务能停止全组", { mode: task.mode });
  if (task.archived) return hide("团队已归档");
  if (teamNeverStarted(task.status as TaskStatus)) return hide("团队还没开工，没有东西可停", { status: task.status });
  if (team.groupsPaused) return hide("全组已经停下了，要接着干就恢复全组");
  if (isTeamSettled(task.status === "running" || f.liveProcess, team.workers)) {
    return hide("调度台和执行者都没有在跑，没有东西可停", { status: task.status });
  }
  return OK;
}

/**
 * 归档（`POST /tasks/:id/archive`）。归档 = 冻结：还有回合、审查、验证轮在进行时不给冻结。
 * 已经归档了不算拒绝 —— 路由那边是幂等的，这里只是不出「归档」这颗键（出的是取消归档）。
 */
export function archiveVerdict(f: ActionFacts): Verdict {
  const { task } = f;
  if (task.archived) return hide("任务已归档");
  if (f.parentIsTeam) return hide("执行者跟着所属团队一起归档", { parentId: task.parentId });
  if (!canArchive(task.status as TaskStatus)) {
    return block("只有已完成/失败/已取消的任务可以归档", { status: task.status });
  }
  // 就地验证轮中途提问后，旁路结算会把 status 放回原终态，而 verifyRound 和 question 都还挂着
  // —— 只看 status 会放行，于是「已冻结」的任务被答复后继续结算，留下 archived + verifying 的死局。
  if (task.verifyRound !== null) {
    return block("就地验证轮还没结束（可能正等你答复），处理完再归档", { status: task.status });
  }
  if (task.workflowMode === "free" && f.freeReviewActive) return block("自由审查正在进行，结束后再归档");
  return OK;
}

/** 重新排队（`POST /tasks/:id/requeue`）：队列里失败 / 取消的任务回到等待。 */
export function requeueVerdict(f: ActionFacts): Verdict {
  const { task } = f;
  if (task.archived) return hide("任务已归档，先取消归档再重新排队", { archived: true });
  const handedOff = handoffBlockReason(task.handoff);
  if (handedOff) return hide(handedOff, { handoff: true });
  if (live(task.status)) return hide("任务正在进行，不需要重新排队", { status: task.status });
  if (task.status !== "failed" && task.status !== "canceled") {
    return hide("只有失败/已取消的任务需要重新排队", { status: task.status });
  }
  if (!f.inQueue) return hide("任务不在任何队列里，直接点运行即可");
  return OK;
}

/**
 * 派一轮就地验证（`POST /tasks/:id/review/dispatch` 与 `startVerifyRound`）。
 *
 * 等待答复 / 续跑的任务不能派：验证结算把 question / resumePrompt 当成「验证者本轮中途提问」的
 * 正常等待态，派之前就挂着的话这一轮永远收不了尾。
 */
export function verifyVerdict(f: ActionFacts): Verdict {
  const { task } = f;
  if (task.reviewOf) return hide("审查任务自身不能再验");
  if (task.mode !== "single") return hide("当前只支持验证 single 任务", { mode: task.mode });
  if (task.archived) return hide("任务已归档（只读），先取消归档再派验证", { archived: true });
  const handedOff = handoffBlockReason(task.handoff);
  if (handedOff) return hide(handedOff, { handoff: true });
  if (live(task.status)) return block("目标仍在运行或排队，结束后再验", { status: task.status });
  if (task.question || task.resumePrompt) return block("任务正等待答复或续跑，处理后再派验证");
  if (task.verifyRound) return block("该任务已有一轮验证正在进行");
  if (f.legacyReviewActive) return block("该任务已有一轮审查尚未结束");
  return OK;
}
