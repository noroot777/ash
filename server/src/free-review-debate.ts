// 「让双方辩论一轮」：用户看过执行者的驳回之后，把审查者和执行者各叫起来说几段。
//
// 形状是**交替的旁路回合**，不是一个新会话：
//   第 1 段 审查者（接着它自己那条审查会话说，上文里就是它写的那份报告）
//   第 2 段 执行者（接着任务自己的会话说，上文里就是它改的那版代码）
//   …按用户选的来回数重复…
//   最后一段 审查者收尾，给一个**自述立场**（verdict）
//
// 三条硬规矩，改这块时别绕过去：
// ① **辩论回合只说话，不改代码**。它是 sideTurn（任务终态原样不动），提示词里也明说
//    禁止改工作区——一边辩一边改，下一段的对手看到的就是另一版代码了。
// ② **发言靠 `debate_reply` 交卷，不靠 agent 的输出文本**。输出文本里混着思考、工具
//    调用和寒暄，从中猜「哪几段是它的正式意见」永远会猜错；交卷调用还顺便回答了
//    「这一段到底说没说话」——回合崩在半路时，二者天差地别。
// ③ **推进只在结算里做**。发言交卷的那一刻回合还占着单飞锁，此时去起下一段只会被
//    静默挡回（runs.ts continueWhenIdle 的由来）。所以 `debate_reply` 只落库，
//    `settleDebateTurn` 才决定「换人说 / 收尾 / 中止」。
//
// 辩论结束**不改写任何结论**：它只是把两边的说法摆到用户面前。裁定仍由用户点
// （free-review-dispute.ts）。
import type {
  AgentType,
  FreeReviewDebateSide,
  FreeReviewDebateVerdict,
} from "@ash/shared";
import { MAX_FREE_REVIEW_DEBATE_EXCHANGES } from "@ash/shared/free-workflow";
import { and, asc, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import {
  freeReviewDebateTurns,
  freeReviewDebates,
  freeReviewRuns,
  projects,
  tasks,
} from "./db/schema.js";
import { debatePrompt } from "./free-review-prompts.js";
import { openDisputeOf, type ReviewRunRow } from "./free-review-dispute.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { claimTurn, continueWhenIdle, isTurnClaimed, releaseTurn, turnRole } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { id, now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
export type DebateRow = typeof freeReviewDebates.$inferSelect;
export type DebateTurnRow = typeof freeReviewDebateTurns.$inferSelect;

/** 一段发言的长度上限；够写满一页逐条对质。 */
export const MAX_DEBATE_STATEMENT_LEN = 20_000;

export const DEBATE_SIDE_LABELS: Record<FreeReviewDebateSide, string> = {
  reviewer: "审查者",
  executor: "执行者",
};

export const DEBATE_VERDICT_LABELS: Record<FreeReviewDebateVerdict, string> = {
  upheld: "维持原意见",
  withdrawn: "撤回原意见",
  partial: "部分成立",
};

export function exchangesOf(raw: unknown): number {
  const value = Math.trunc(Number(raw ?? 1));
  if (!Number.isFinite(value) || value < 1 || value > MAX_FREE_REVIEW_DEBATE_EXCHANGES) {
    throw new Error(`来回数只能是 1 到 ${MAX_FREE_REVIEW_DEBATE_EXCHANGES}`);
  }
  return value;
}

/** 总发言段数：每个来回两段，末尾多一段审查者收尾。 */
export function totalSegments(exchanges: number): number {
  return exchanges * 2 + 1;
}

/** 奇数段是审查者（含收尾那段），偶数段是执行者。 */
export function sideOfSeq(seq: number): FreeReviewDebateSide {
  return seq % 2 === 1 ? "reviewer" : "executor";
}

/** 这一轮意见上的全部辩论，按开始时间排（通常只有一条）。 */
export async function debatesOfRound(roundId: string): Promise<DebateRow[]> {
  return db.select().from(freeReviewDebates)
    .where(eq(freeReviewDebates.roundId, roundId))
    .orderBy(asc(freeReviewDebates.startedAt));
}

/** 这一轮意见上最近的那条辩论（没有则 null）。 */
export async function debateOfRound(roundId: string): Promise<DebateRow | null> {
  return (await debatesOfRound(roundId)).at(-1) ?? null;
}

export async function debateTurnsOf(debateId: string): Promise<DebateTurnRow[]> {
  return db.select().from(freeReviewDebateTurns)
    .where(eq(freeReviewDebateTurns.debateId, debateId))
    .orderBy(asc(freeReviewDebateTurns.seq));
}

/** 这个任务身上正在跑的辩论（没有则 null）。验收、派审、裁定都要等它结束。 */
export async function activeDebateOf(taskId: string): Promise<DebateRow | null> {
  return (await db.select().from(freeReviewDebates)
    .where(and(eq(freeReviewDebates.taskId, taskId), eq(freeReviewDebates.status, "running")))).at(0) ?? null;
}

async function speakingTurnOf(debate: DebateRow): Promise<DebateTurnRow | null> {
  return (await db.select().from(freeReviewDebateTurns).where(and(
    eq(freeReviewDebateTurns.debateId, debate.id),
    eq(freeReviewDebateTurns.seq, debate.currentSeq),
  ))).at(0) ?? null;
}

async function failDebate(debate: DebateRow, turn: DebateTurnRow | null, note: string): Promise<void> {
  const at = now();
  if (turn && turn.status === "speaking") {
    await db.update(freeReviewDebateTurns).set({ status: "error", endedAt: at })
      .where(eq(freeReviewDebateTurns.id, turn.id));
  }
  await db.update(freeReviewDebates).set({ status: "failed", updatedAt: at, finishedAt: at })
    .where(eq(freeReviewDebates.id, debate.id));
  await appendTaskTimeline(debate.taskId, `${note}辩论已中止；驳回仍在等你裁定，也可以再开一轮辩论。`);
  bus.publish({ type: "task.review", taskId: debate.taskId });
}

/** 起一段发言：按发言方挑执行器与会话。审查者续它自己那条审查会话，执行者续任务本身的会话。 */
async function launchSegment(
  task: TaskRow,
  run: ReviewRunRow,
  debate: DebateRow,
  turn: DebateTurnRow,
  reason: string,
  previous: DebateTurnRow[],
): Promise<void> {
  const project = (await db.select({ repoPath: projects.repoPath }).from(projects)
    .where(eq(projects.id, task.projectId))).at(0);
  const prompt = debatePrompt({
    task, run, debate, turn, disputeReason: reason, previous,
    repoPath: project?.repoPath ?? "(项目已不存在)",
  });
  const side = turn.side as FreeReviewDebateSide;
  await appendTaskTimeline(task.id,
    `辩论第 ${turn.seq}/${totalSegments(debate.exchanges)} 段：轮到${DEBATE_SIDE_LABELS[side]}发言` +
    `${side === "reviewer" ? `（${run.reviewerName}）` : ""}。`);
  bus.publish({ type: "task.review", taskId: task.id });
  continueWhenIdle(task.id, prompt, side === "reviewer"
    ? {
        system: "run",
        sideTurn: true,
        agent: run.agentType as AgentType,
        executorId: run.executorId,
        model: run.model,
        reasoningEffort: run.reasoningEffort,
        sessionRole: "reviewer",
      }
    // 执行者那一段回到任务自己的会话（它的上文里就是这版代码怎么来的）。仍是旁路
    // 回合：任务的终态、验收阶段一律不动。
    : { system: "run", sideTurn: true },
    (error) => failDebate(debate, turn, `辩论第 ${turn.seq} 段没能起跑（${error}）；`),
  );
}

/**
 * 用户点「让双方辩论」。与派审同级的原子互斥（占位身份 dispatch）：只查 DB status
 * 挡不住「普通回合已 claim、status 还没落 running」那段窗口。
 */
export async function startFreeReviewDebate(
  taskId: string,
  input: { exchanges?: unknown } = {},
  opts: { holdTurn?: boolean } = {},
): Promise<{ debateId: string; exchanges: number }> {
  const exchanges = exchangesOf(input.exchanges ?? 1);
  const holdingTurn = opts.holdTurn === true;
  if (holdingTurn && !claimTurn(taskId, "dispatch")) {
    throw new Error("任务回合正在进行，结束后再开辩论");
  }
  try {
    if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
    try {
      const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
      if (!task) throw new Error("任务不存在");
      if (task.mode !== "single" || task.parentId || task.reviewOf || task.workflowMode !== "free") {
        throw new Error("当前任务不是自由工作流普通任务");
      }
      if (task.archived) throw new Error("归档任务不能开辩论");
      const handedOff = handoffBlockReason(task.handoff);
      if (handedOff) throw new Error(handedOff);
      if (task.status === "running" || task.status === "queued") throw new Error("任务正在运行或排队，结束后再开辩论");
      // 遗留的提问/续跑指令必须先处理：辩论回合的结算会把它们当成「这一段还没说完」，
      // 带着旧字段开辩论会让这条辩论永远收不了尾（同派审的门禁，理由见 free-workflow.ts）。
      if (task.question || task.resumePrompt) throw new Error("任务正等待答复或续跑，处理后再开辩论");
      const open = await openDisputeOf(taskId);
      if (!open) throw new Error("现在没有等待裁定的驳回，没有可辩的对象");
      if (await activeDebateOf(taskId)) throw new Error("已经有一轮辩论正在进行");
      // 好好辩完的那条挡住再辩：同一份报告挂两条辩完的记录，只会让「到底以哪条为准」
      // 变成新问题——该裁定了，或者再派一轮审查。**中断的不挡**：那是系统没让人说完
      // （回合崩了 / 没交卷），把用户的出路一起关掉是拿自己的失败惩罚他。
      const previousDebate = await debateOfRound(open.round.id);
      if (previousDebate?.status === "finished") {
        throw new Error("这一轮意见已经辩完了；先裁定它，或者再派一轮审查");
      }

      const at = now();
      const debate: typeof freeReviewDebates.$inferInsert = {
        id: id(), roundId: open.round.id, taskId, runId: open.run.id, round: open.run.currentRound,
        status: "running", exchanges, currentSeq: 1, verdict: null,
        startedAt: at, updatedAt: at, finishedAt: null,
      };
      await db.insert(freeReviewDebates).values(debate);
      const turn: typeof freeReviewDebateTurns.$inferInsert = {
        id: id(), debateId: debate.id, seq: 1, side: "reviewer", statement: null,
        status: "speaking", startedAt: at, endedAt: null,
      };
      await db.insert(freeReviewDebateTurns).values(turn);
      await appendTaskTimeline(taskId,
        `开始辩论第 ${open.run.currentRound} 轮审查意见：${exchanges} 个来回，` +
        `审查者（${open.run.reviewerName}）先答辩，最后由它收尾给出立场；结论仍由你裁定。`);
      await launchSegment(
        task, open.run,
        debate as DebateRow, turn as DebateTurnRow,
        open.round.disputeReason!, [],
      );
      return { debateId: debate.id, exchanges };
    } finally {
      releaseFreeWorkflowAction(taskId);
    }
  } finally {
    if (holdingTurn) releaseTurn(taskId);
  }
}

/**
 * 发言交卷（MCP `debate_reply`）。只落库，不推进（推进在结算里，理由见文件头 ③）。
 *
 * 身份按**这一段轮到谁**核对回合的运行时身份：审查者那段必须出自 reviewer 回合，
 * 执行者那段必须出自任务自己的旁路回合（sideTurn 会把身份接管成 "side"）。
 */
export async function submitDebateStatement(
  taskId: string,
  input: { statement?: unknown; verdict?: unknown },
): Promise<{ seq: number; side: FreeReviewDebateSide; final: boolean; verdictIgnored: boolean }> {
  const statement = typeof input.statement === "string" ? input.statement.trim() : "";
  if (!statement) throw new Error("发言不能为空：把你这一段的意见写进 statement");
  const debate = await activeDebateOf(taskId);
  if (!debate) throw new Error("当前没有正在进行的辩论");
  const turn = await speakingTurnOf(debate);
  if (!turn || turn.status !== "speaking") throw new Error("这一段发言已经交过卷了");
  const side = turn.side as FreeReviewDebateSide;
  const role = turnRole(taskId);
  if (side === "reviewer" && role !== "reviewer") {
    throw new Error("这一段轮到审查者发言，只有审查回合能交卷");
  }
  if (side === "executor" && role !== "side" && role !== "single") {
    throw new Error("这一段轮到执行者发言，只有任务自己的回合能交卷");
  }
  const final = turn.seq === totalSegments(debate.exchanges);
  let verdict: FreeReviewDebateVerdict | null = null;
  if (final) {
    if (input.verdict !== "upheld" && input.verdict !== "withdrawn" && input.verdict !== "partial") {
      throw new Error("这是收尾发言，必须给出 verdict：upheld（维持原意见）/ withdrawn（撤回原意见）/ partial（部分成立）");
    }
    verdict = input.verdict;
  }
  const at = now();
  const written = await db.update(freeReviewDebateTurns)
    .set({ statement: statement.slice(0, MAX_DEBATE_STATEMENT_LEN), status: "done", endedAt: at })
    .where(and(eq(freeReviewDebateTurns.id, turn.id), eq(freeReviewDebateTurns.status, "speaking")))
    .returning({ id: freeReviewDebateTurns.id });
  if (!written.length) throw new Error("这一段发言已经交过卷了");
  if (verdict) {
    await db.update(freeReviewDebates).set({ verdict, updatedAt: at })
      .where(eq(freeReviewDebates.id, debate.id));
  }
  bus.publish({ type: "task.review", taskId });
  // 非收尾段给了 verdict 就明确告诉它被忽略了：静默吞掉会让它以为立场已经表过。
  return { seq: turn.seq, side, final, verdictIgnored: !final && input.verdict !== undefined };
}

/**
 * 辩论段的结算：换人说 / 收尾 / 中止。由 `handleFreeWorkflowSettlement` 在分流角色
 * **之前**调用——辩论段既可能是 reviewer 回合也可能是任务自己的旁路回合，按角色分流
 * 会把它误当成普通审查/执行回合去结算。
 *
 * 返回 true = 这一回合是辩论段，已经收掉，调用方不要再走别的结算。
 */
export async function settleDebateTurn(taskId: string, turnOk: boolean): Promise<boolean> {
  const debate = await activeDebateOf(taskId);
  if (!debate) return false;
  const turn = await speakingTurnOf(debate);
  if (!turn) {
    await failDebate(debate, null, "辩论找不到正在发言的那一段；");
    return true;
  }
  const side = turn.side as FreeReviewDebateSide;
  // 回合没干净收尾（崩了 / 被用户按停）一律中止：即便发言已经落库，「用户按了停止」
  // 的意思也不是「接着让下一位说」。
  if (!turnOk) {
    await failDebate(debate, turn, `${DEBATE_SIDE_LABELS[side]}这一段被停止或异常结束；`);
    return true;
  }
  if (turn.status !== "done" || !turn.statement) {
    await failDebate(debate, turn, `${DEBATE_SIDE_LABELS[side]}这一回合结束时没有调用 debate_reply 交卷；`);
    return true;
  }

  const total = totalSegments(debate.exchanges);
  const at = now();
  if (turn.seq >= total) {
    await db.update(freeReviewDebates).set({ status: "finished", updatedAt: at, finishedAt: at })
      .where(eq(freeReviewDebates.id, debate.id));
    const verdict = (await db.select({ verdict: freeReviewDebates.verdict }).from(freeReviewDebates)
      .where(eq(freeReviewDebates.id, debate.id))).at(0)?.verdict as FreeReviewDebateVerdict | null;
    await appendTaskTimeline(taskId,
      `辩论结束，审查者收尾立场：${verdict ? DEBATE_VERDICT_LABELS[verdict] : "未给出"}。` +
      "这只是它自己的立场，结论仍由你裁定：采纳执行者，或维持审查意见让它照改。");
    bus.publish({ type: "task.review", taskId });
    return true;
  }

  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const run = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, debate.runId))).at(0);
  const open = await openDisputeOf(taskId);
  if (!task || !run || !open) {
    await failDebate(debate, null, "辩论的被辩对象已经不在了（任务、审查链或驳回被改动）；");
    return true;
  }
  const next: typeof freeReviewDebateTurns.$inferInsert = {
    id: id(), debateId: debate.id, seq: turn.seq + 1, side: sideOfSeq(turn.seq + 1),
    statement: null, status: "speaking", startedAt: at, endedAt: null,
  };
  await db.insert(freeReviewDebateTurns).values(next);
  await db.update(freeReviewDebates).set({ currentSeq: next.seq, updatedAt: at })
    .where(eq(freeReviewDebates.id, debate.id));
  await launchSegment(
    task, run, { ...debate, currentSeq: next.seq }, next as DebateTurnRow,
    open.round.disputeReason!, await debateTurnsOf(debate.id),
  );
  return true;
}

/**
 * 启动对账（与 `reconcileFreeReviews` 同一处调用，排在 reattach 之后）：`running` 是
 * 持久状态，而推进这条辩论的投递链只活在内存里。进程死在两段之间的话，辩论会永远
 * 挂着 running，裁定与再开辩论被一路 409 挡住。
 *
 * 判据同审查对账：回合还活着（任务在跑 / turn 被占 / 在等答复）就不碰，让它自己收尾。
 */
export async function reconcileFreeReviewDebates(): Promise<void> {
  const stuck = await db.select().from(freeReviewDebates).where(eq(freeReviewDebates.status, "running"));
  for (const debate of stuck) {
    const task = (await db.select().from(tasks).where(eq(tasks.id, debate.taskId))).at(0);
    if (!task) {
      await db.delete(freeReviewDebateTurns).where(eq(freeReviewDebateTurns.debateId, debate.id));
      await db.delete(freeReviewDebates).where(eq(freeReviewDebates.id, debate.id));
      continue;
    }
    if (task.status === "running" || task.status === "queued" || isTurnClaimed(task.id)) continue;
    if (task.question || task.resumePrompt) continue;
    await failDebate(debate, await speakingTurnOf(debate), "服务重启时这一段辩论已经没有回合在跑；");
  }
}

/** 把这一轮上的辩论读成对外的形状（状态快照用），按开始时间排。 */
export async function debateViews(roundId: string) {
  const debates = await debatesOfRound(roundId);
  return Promise.all(debates.map(async (debate) => ({
    id: debate.id,
    status: debate.status as "running" | "finished" | "failed",
    exchanges: debate.exchanges,
    currentSide: debate.status === "running" ? sideOfSeq(debate.currentSeq) : null,
    verdict: (debate.verdict as FreeReviewDebateVerdict | null) ?? null,
    turns: (await debateTurnsOf(debate.id)).map((turn) => ({
      seq: turn.seq,
      side: turn.side as FreeReviewDebateSide,
      statement: turn.statement ?? "",
      status: turn.status as "speaking" | "done" | "error",
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    })),
    startedAt: debate.startedAt,
    finishedAt: debate.finishedAt,
  })));
}
