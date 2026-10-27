// 验证轮的**编排**：什么时候开一轮、这一轮谁来跑、跑完了怎么走。
//
// 现在的做法是**就地验证**：不再另起一个审查任务，而是在被验任务自己身上多跑一个
// 旁路回合（`tasks.verify_round` 记着正在跑第几轮）。结论仍走 `report_stage`，证据仍
// 落 `data/runs/<taskId>/review/round-<n>/`，打回修复仍是同一个任务续跑 —— 变的只是
// 「验证这件事住在哪个任务身上」。
//
// 老数据里还有一批独立审查任务（`tasks.review_of` 指向被审任务），它们的启动路径已经
// 拆掉，但**跑完之后的结算路径完整保留**（`finishReview`），否则重启时正在跑的那些
// 审查任务会没人收尾。两条路最后汇进同一个 `concludeRound`。
//
// 判定（该不该验、几轮、找谁验）住在 review-policy.ts；证据读写住在 review-evidence.ts；
// 提示词正文住在 review-prompts.ts。
import type {
  AgentType,
  ReviewConclusion,
  ReviewDispatchInput,
  TaskReviewInfo,
  TaskReviewRound,
  TaskStage,
  TaskStatus,
  TeamConfig,
} from "@ash/shared";
import { AGENT_TYPES, TEAM_DEFAULTS } from "@ash/shared";
import { inheritExecutorOverrides, pickExecutor } from "@ash/shared/executors";
import { anchorAt } from "@ash/shared/workflow-policy";
import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { evidenceHeaders } from "./evidence-path.js";
import { db } from "./db/index.js";
import { agents, projects, regressionEvidence, tasks } from "./db/schema.js";
import { handoffBlockReason } from "./handoff-guard.js";
import {
  nextReviewRound,
  readConclusion,
  readReport,
  readReviewFile,
  safeReviewFilePath,
  screenshots,
  reviewRoundDir,
} from "./review-evidence.js";
import { finishReview, finishVerifyRound } from "./review-settlement.js";
import { verifyProtocolFor } from "./review-prompts.js";
import { setTaskStage, clearTaskStage } from "./task-stage.js";
import { appendTaskTimeline } from "./task-timeline.js";
import {
  shouldAutoDispatchReview,
  withVerifyExecutor,
} from "./review-policy.js";
import { claimTurn, continueWhenIdle, releaseTurn } from "./runs.js";
import { taskWorkflowDef } from "./workflows.js";
import { advanceWorkflowFrom, settleFrom } from "./workflow-advance.js";
import { applyRunFailPolicy } from "./workflow-steps.js";
import { now } from "./util.js";
import { completedInlineVerificationSteps } from "./review-execution.js";
import { withReviewAuthority, ReviewSuperseded, type ReviewAuthority } from "./review-ownership.js";
import { evidenceState, restartRegressionEvidence } from "./regression-evidence-lifecycle.js";

type TaskRow = typeof tasks.$inferSelect;

function reviewerConfig(lead: TaskRow | null): TeamConfig {
  if (!lead?.team) return TEAM_DEFAULTS;
  try {
    return { ...TEAM_DEFAULTS, ...(JSON.parse(lead.team) as TeamConfig) };
  } catch {
    return TEAM_DEFAULTS;
  }
}

// 这一轮找谁来验。默认是任务自己的执行器（就地验证 = 同一个 agent 回过头审自己），
// 线上的「自动验证」那一站或用户手点时可以指定另一个执行器 —— **交叉验证的价值就靠
// 这里保住**：换个执行器就是换一双眼睛，同一份工作目录、同一个任务，各走各的会话线。
async function reviewExecution(target: TaskRow, override: ReviewDispatchInput) {
  const lead = target.parentId
    ? (await db.select().from(tasks).where(eq(tasks.id, target.parentId))).at(0) ?? null
    : null;
  const teamLead = lead?.mode === "team" && lead.projectId === target.projectId ? lead : null;
  const cfg = reviewerConfig(teamLead);
  const fallback = teamLead
    ? {
        executorId: cfg.reviewerExecutorId ?? null,
        agentType: cfg.reviewerAgentType ?? cfg.worker,
      }
    : {
        executorId: target.executorId ?? null,
        agentType: ((target.agentType as AgentType | null) ?? "claude") as AgentType,
      };
  const profileTypes = new Map(
    (await db.select({ id: agents.id, type: agents.type }).from(agents))
      .map((profile) => [profile.id, profile.type as AgentType] as const),
  );
  const explicitType = override.executorId ? profileTypes.get(override.executorId) : undefined;
  if (explicitType && override.agentType && explicitType !== override.agentType) {
    throw new Error(`executorId 属于 ${explicitType},但 agentType 是 ${override.agentType}`);
  }
  const picked = pickExecutor({
    executorId: override.executorId,
    agentType: override.agentType,
    fallback,
    typeOf: (executorId) => profileTypes.get(executorId),
  });
  const inherited = inheritExecutorOverrides({
    from: fallback,
    to: picked,
    model: override.model,
    reasoningEffort: override.reasoningEffort,
    defaultModel: teamLead ? cfg.reviewerModel : target.model,
    defaultReasoningEffort: teamLead ? cfg.reviewerReasoningEffort : target.reasoningEffort,
  });
  return {
    agentType: (picked.agentType ?? fallback.agentType ?? "claude") as AgentType,
    executorId: picked.executorId,
    ...inherited,
  };
}

/** 历史那批独立审查任务（可能还没跑完）。轮次编号要接着它们往下数。 */
async function legacyReviewTasks(targetId: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.reviewOf, targetId))
    .orderBy(asc(tasks.reviewRound), asc(tasks.createdAt));
}

/** 这个任务一共验过几轮（历史独立审查任务 + 就地验证轮）。 */
export async function reviewRoundsOf(target: TaskRow): Promise<number> {
  return (await legacyReviewTasks(target.id)).length + (target.verifyRounds ?? 0);
}

/**
 * 开一轮就地验证：在被验任务自己身上多跑一个旁路回合，不另起任务。
 *
 * 三件事必须一起做对：
 * ① `verify_round` 落库 —— 它既是「此刻有一轮在跑」的锁，也是每回合提醒的依据
 *    （验证轮中途提问、被打断续跑时，只有从任务状态派生的提醒能跟到底）；
 * ② 续跑必须等**当前这一轮**退干净（`continueWhenIdle`）—— 自动验证是在结算钩子里
 *    触发的，那一刻单飞锁还锁着这个任务，直接 continueTask 会被静默挡回；
 * ③ 起不来要把 `verify_round` 清掉，否则任务永远卡在「正在验证」。
 */
export async function startVerifyRound(
  targetId: string,
  override: ReviewDispatchInput = {},
  opts: { holdTurn?: boolean; reviewAuthority?: ReviewAuthority } = {},
): Promise<{ round: number }> {
  // HTTP 手动派验证与自由派审同级的原子互斥：普通回合已 claim、status 尚未落 running
  // 时，只看 DB status 会先永久写下 verifyRound/stage=verifying/时间线，再把验证消息排
  // 到那个回合之后——UI 与验收门禁提前宣称「正在验证」（审查实测）。占位身份 dispatch
  // 覆盖校验到排队注册，finally 释放后验证投递自然开跑。结算内部的自动触发不走这里
  //（那时收尾回合正占着 turn，天然互斥；gate 放行路径由验收锁互斥）。
  const holdingTurn = opts.holdTurn === true;
  if (holdingTurn && !claimTurn(targetId, "dispatch")) {
    throw new Error("任务回合正在进行，结束后再派验证");
  }
  try {
  // 占位后重读+**权威校验**：路由的预检查在 await c.req.json() 等间隙之后可能已过期
  // （审查实测：streaming body 停住解析，任务先被归档，继续 body 后验证照样 201）。
  // 归档与这里互为镜像：归档检查 isTurnClaimed（占位期间归档 409），这里占位后重查
  // archived（归档先完成则拒）。
  const target = (await db.select().from(tasks).where(eq(tasks.id, targetId))).at(0);
  if (!target) throw new Error("被验任务不存在");
  if (target.reviewOf) throw new Error("审查任务自身不能再验");
  if (target.archived) throw new Error("任务已归档（只读），先取消归档再派验证");
  if (target.mode !== "single") throw new Error("当前只支持验证 single 任务");
  if (target.status === "running" || target.status === "queued") {
    throw new Error("目标仍在运行或排队，结束后再验");
  }
  // 等待答复/续跑的任务不能派验证：验证结算把 question/resumePrompt 当「验证者本轮
  // 中途提问」的正常等待态，派验证之前就存在的字段会让这一轮永远收不了尾——
  // verifyRound 挂着、第二次派验证 400（审查实测）。与自由派审同一门禁。
  if (target.question || target.resumePrompt) {
    throw new Error("任务正等待答复或续跑，处理后再派验证");
  }
  if (target.verifyRound) throw new Error("该任务已有一轮验证正在进行");
  const legacy = await legacyReviewTasks(targetId);
  if (legacy.some((review) => ["backlog", "queued", "running", "paused"].includes(review.status))) {
    throw new Error("该任务已有一轮审查尚未结束");
  }
  const round = nextReviewRound(legacy.length + (target.verifyRounds ?? 0));
  // 这一轮验的是线上**哪一站**。轮次号（round）仍然全局递增——它是证据目录名
  // `review/round-<n>`，一条线上有好几站验证时按站数会撞车。判定用的「这一站验到第几
  // 轮」另记在 `verify_station_rounds` 上：换一站就归零，否则第一站用掉的轮次会算到
  // 第二站头上，用户在第二站写的「没过就重做 2 轮」一进门就用完了。
  const station = anchorAt(taskWorkflowDef(target.workflow), target.workflowAt, "verify")?.id ?? null;
  const execution = await reviewExecution(target, withVerifyExecutor(target, override));
  const project = (await db.select().from(projects).where(eq(projects.id, target.projectId))).at(0);

  // 协议/证据目录准备（可失败：目录被 symlink 换掉等）必须在**任何状态提交之前**——
  // 先写 verifyRound/stage=verifying 再抛错会留下「已有一轮验证正在进行」的半轮状态，
  // 任务永久无法再派验证（审查实测复现）。
  const directory = reviewRoundDir(targetId, round);
  await evidenceState(targetId, directory);
  await withReviewAuthority(opts.reviewAuthority, (transaction) => restartRegressionEvidence(targetId, directory, transaction));
  const protocol = await verifyProtocolFor(target, round, project?.repoPath ?? "(项目已不存在)", station);

  await withReviewAuthority(opts.reviewAuthority, async (transaction) => {
    await transaction.update(tasks)
      .set({
        verifyRound: round,
        verifyCompletedSteps: JSON.stringify([...completedInlineVerificationSteps(target)]),
        reviewStep: station,
        verifyStationRounds: target.reviewStep === station ? (target.verifyStationRounds ?? 0) : 0,
        updatedAt: now(),
      })
      .where(eq(tasks.id, targetId));
    if (opts.reviewAuthority) await transaction.update(tasks).set({ stage: "verifying", updatedAt: now() }).where(eq(tasks.id, targetId));
  });
  if (!opts.reviewAuthority) await setTaskStage(targetId, "verifying");
  await appendTaskTimeline(targetId, `第 ${round} 轮验证开始：就在这个任务的工作目录里跑，不另起审查任务。`);
  bus.publish({ type: "task.review", taskId: targetId });

  continueWhenIdle(
    targetId,
    protocol,
    {
      system: "run",
      sideTurn: true,
      ...(opts.reviewAuthority ? { wakeGuard: async () => {
        try { await withReviewAuthority(opts.reviewAuthority, async () => {}); return null; }
        catch (error) { return String(error); }
      } } : {}),
      agent: execution.agentType,
      executorId: execution.executorId,
      model: execution.model,
      reasoningEffort: execution.reasoningEffort,
    },
    async (error) => {
      if (opts.reviewAuthority) {
        try {
          await withReviewAuthority(opts.reviewAuthority, async (transaction) => {
            const current = (await transaction.select().from(tasks).where(eq(tasks.id, targetId)))[0]!;
            if (current.verifyRound !== round) return;
            await transaction.update(tasks).set({ verifyRound: null, reviewStep: target.reviewStep,
              verifyCompletedSteps: target.verifyCompletedSteps, verifyStationRounds: target.verifyStationRounds,
              stage: current.stage === "verifying" ? target.stage : current.stage, updatedAt: now(),
            }).where(eq(tasks.id, targetId));
          });
        } catch (failure) { if (failure instanceof ReviewSuperseded) return; throw failure; }
        await appendTaskTimeline(targetId, `第 ${round} 轮验证启动失败：${error}`);
        bus.publish({ type: "task.review", taskId: targetId });
        return;
      }
      // 对称回滚：验证没起来，这一轮写下的**全部**状态恢复原值——只清 verifyRound 会
      // 留下 stage=verifying（taskDisplayStatus 里 stage 优先），UI 永久显示「验证中」
      // 而轮数为空（审查实测：释放点被竞争 waiter 抢先后永久卡住）。
      await db.update(tasks).set({
        verifyRound: null,
        reviewStep: target.reviewStep ?? null,
        verifyCompletedSteps: target.verifyCompletedSteps,
        verifyStationRounds: target.verifyStationRounds ?? 0,
        updatedAt: now(),
      }).where(eq(tasks.id, targetId));
      const current = (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, targetId))).at(0);
      if (current?.stage === "verifying") {
        // 只在还是本轮写下的 verifying 时回滚（期间有更新的结论就不碰）。
        if (target.stage && target.stage !== "verifying") await setTaskStage(targetId, target.stage as TaskStage);
        else await clearTaskStage(targetId, `第 ${round} 轮验证启动失败，验证状态已回滚。`);
      }
      await appendTaskTimeline(targetId, `第 ${round} 轮验证启动失败：${error}`);
      bus.publish({ type: "task.review", taskId: targetId });
    },
  );
  return { round };
  } finally {
    if (holdingTurn) releaseTurn(targetId);
  }
}


// 「等我点头」这一站落地：把验收阶段停在 awaiting_acceptance。
// **只动 stage 不动 status** —— status 是调度用的（改成 awaiting_review 会顺带停住这个
// 任务所在的队列），而这条线只描述这一个任务干完之后怎么走，不该外溢到队列/分组。
// 显示上也不需要动 status：taskDisplayStatus 里 stage 优先，列表那一格就是「待验收」。
export async function enterHumanGate(taskId: string, authority?: ReviewAuthority): Promise<void> {
  if (authority) {
    const updatedAt = now();
    await withReviewAuthority(authority, async (transaction) => {
      await transaction.update(tasks).set({ stage: "awaiting_acceptance", updatedAt }).where(eq(tasks.id, taskId));
    });
    bus.publish({ type: "task.stage", taskId, stage: "awaiting_acceptance", updatedAt });
    await appendTaskTimeline(taskId, "这条线走到「等我点头」，停在待验收等你决定。");
    return;
  }
  const row = (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row || row.stage === "merged" || row.stage === "accepted") return;
  // stage 早就是 awaiting_acceptance 也照样往下走。那个 stage 可能是**别处写的**——agent
  // 自报、上一道关口放行前留下的——跟「这条线此刻真的走到了关口」不是一回事。早先在这里
  // 一并 return，后果是关口**静默**停下：时间线上一个字都没有，用户看见任务停着不动，
  // 无从判断它是在等自己点头还是卡住了。只跳过重复的 setTaskStage（免得多一行没信息量
  // 的「验收阶段更新：待验收」），那句「走到等我点头」照写。
  if (row.stage !== "awaiting_acceptance") await setTaskStage(taskId, "awaiting_acceptance");
  await appendTaskTimeline(taskId, "这条线走到「等我点头」，停在待验收等你决定。");
}

async function parentIsTeam(task: TaskRow): Promise<boolean> {
  if (!task.parentId) return false;
  const parent = (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, task.parentId))).at(0);
  return parent?.mode === "team";
}

// Single settlement hook. It is invoked only by the real run loop after a turn
// settles, never by setTaskStatus/manual PATCH, so a casual follow-up that falls
// back to done cannot accidentally create another review.
//
// `turnOk` = 这一回合本身干净收尾了（没被停、退出码 0、也没有执行器 error 事件）。
// 它跟 `status` 不是一回事：
// 旁路回合（就地验证）的 status 是任务原来的终态，只有 turnOk 说得清这一轮跑成没跑成。
export async function handleTaskSettlement(
  taskId: string,
  status: TaskStatus,
  confirmedDone: boolean,
  turnOk: boolean | null = true,
): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return;
  // 就地验证轮：这一回合是搭在任务上的验证，不是任务的执行 —— 不派新验证、不推线，
  // 只把这一轮的结论收掉。
  if (task.verifyRound) {
    await finishVerifyRound(task, turnOk);
    return;
  }
  if (task.reviewOf) {
    if (status === "done" || status === "failed" || status === "canceled") {
      await finishReview(task, status, turnOk === null);
    }
    return;
  }

  const workflow = taskWorkflowDef(task.workflow);
  // 「让 AI 干活」这一站自己没干成：线上给它写了「问我一句」或「打回重做」就得真的做，
  // 不能只有验证站的失败才算数。手停（canceled）不走这条 —— 那是用户自己按的，
  // 再打回去或者再问一句都属于跟用户对着干。
  if (status === "failed") {
    await applyRunFailPolicy(task, workflow);
    return;
  }
  const isTeamWorker = await parentIsTeam(task);
  // 身上有线：整条线怎么走全交给推进器 —— 跑完这一段、决定下一个锚点是再验一站、
  // 停在人工关口还是走到头。**从哪一站接着走**由 settleFrom 定（游标停在某一站验证上
  // 时要退回它前面那个锚点，好让那一段重跑一遍再重新验，而不是当它验过了）。
  if (confirmedDone && status === "done" && workflow && task.mode !== "team") {
    await advanceWorkflowFrom(task, workflow, settleFrom(workflow, task.workflowAt));
    return;
  }
  // 身上没线的老任务照旧：团队那边要求审查就开一轮就地验证。
  if (shouldAutoDispatchReview({
    confirmedDone,
    status,
    parentIsTeam: isTeamWorker,
    mode: task.mode,
    reviewOf: task.reviewOf,
    reviewRequested: task.reviewRequested,
    stage: task.stage,
    existingRounds: await reviewRoundsOf(task),
    workflow,
  })) {
    await startVerifyRound(task.id);
  }
}

// 一个任务验过的所有轮次，按轮次号排好：历史的独立审查任务（where:"task"）和现在的
// 就地验证轮（where:"inline"）混在一条时间线上，前端只认轮次号和结论。
async function reviewInfo(target: TaskRow): Promise<TaskReviewInfo> {
  const legacy = await legacyReviewTasks(target.id);
  const evidence = await db.select().from(regressionEvidence).where(eq(regressionEvidence.taskId, target.id));
  const settlements = new Map(evidence.map((state) => [state.directory, state.settlement]));
  const legacyRounds = new Set(legacy.map((review) => review.reviewRound ?? 1));
  const latestLegacyId = legacy.at(-1)?.id;
  // 就地轮次没有自己的行，只有一个计数 —— 轮次号是连续的，把历史占掉的号跳过去。
  const inline: number[] = [];
  for (let round = 1; inline.length < (target.verifyRounds ?? 0) + (target.verifyRound ? 1 : 0); round++) {
    if (!legacyRounds.has(round)) inline.push(round);
  }
  const latestRound = Math.max(0, ...legacyRounds, ...inline);

  const rounds: TaskReviewRound[] = await Promise.all([
    ...legacy.map(async (review): Promise<TaskReviewRound> => {
      const round = review.reviewRound ?? 1;
      const settlement = settlements.get(reviewRoundDir(target.id, round));
      let conclusion = await readConclusion(target.id, round);
      if (!conclusion && review.id === latestLegacyId && (settlement ? !settlement.pending && settlement.outcome === "done" : review.status === "done")) {
        conclusion = target.stage === "verified" || target.stage === "verify_failed"
          ? target.stage as ReviewConclusion
          : null;
      }
      return {
        round,
        where: "task",
        reviewTaskId: review.id,
        reviewTaskStatus: settlement?.pending ? "running" : settlement?.outcome ?? (review.status as TaskStatus),
        conclusion: settlement && (settlement.pending || settlement.outcome !== "done") ? null : conclusion,
        reportMarkdown: await readReport(target.id, round),
        screenshots: await screenshots(target.id, round),
      };
    }),
    ...inline.map(async (round): Promise<TaskReviewRound> => {
      const settlement = settlements.get(reviewRoundDir(target.id, round));
      const running = target.verifyRound === round || settlement?.pending === true;
      let conclusion = running ? null : await readConclusion(target.id, round);
      // 最后一轮的结论文件可能还没落（结论写在结算那一步），此时看任务身上的 stage。
      if (!conclusion && !running && round === latestRound && (!settlement || settlement.outcome === "done")) {
        conclusion = target.stage === "verified" || target.stage === "verify_failed"
          ? target.stage as ReviewConclusion
          : null;
      }
      return {
        round,
        where: "inline",
        reviewTaskId: null,
        reviewTaskStatus: running ? "running" : settlement?.outcome ?? "done",
        conclusion: settlement && settlement.outcome !== "done" ? null : conclusion,
        reportMarkdown: await readReport(target.id, round),
        screenshots: await screenshots(target.id, round),
      };
    }),
  ]);
  rounds.sort((a, b) => a.round - b.round);
  return { reviewRequested: target.reviewRequested, rounds };
}

export function mountReviewRoutes(api: Hono): void {
  api.get("/tasks/:id/review", async (c) => {
    const target = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
    if (!target) return c.json({ error: "not found" }, 404);
    return c.json(await reviewInfo(target));
  });

  api.get("/tasks/:id/review/file", async (c) => {
    const taskId = c.req.param("id");
    const target = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!target) return c.json({ error: "not found" }, 404);
    const round = Number(c.req.query("round"));
    const name = c.req.query("name") ?? "";
    // 认不认这个类型由 evidence-path.ts 那一张表说 —— 自由工作流取文件那条共用同一道。
    const headers = evidenceHeaders(name);
    const file = safeReviewFilePath(taskId, round, name);
    if (!file || !headers) return c.json({ error: "非法的审查文件路径或类型" }, 400);
    const content = await readReviewFile(taskId, round, name);
    return content
      ? c.body(Uint8Array.from(content), 200, headers)
      : c.json({ error: "not found" }, 404);
  });

  // 路径保持 /review/dispatch（老客户端还在用），但它现在开的是就地验证轮，不再建任务。
  api.post("/tasks/:id/review/dispatch", async (c) => {
    const taskId = c.req.param("id");
    const target = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!target) return c.json({ error: "not found" }, 404);
    if (target.reviewOf) return c.json({ error: "审查任务自身不能再验" }, 409);
    if (target.mode !== "single") return c.json({ error: "当前只支持验证 single 任务", mode: target.mode }, 409);
    if (target.archived) return c.json({ error: "归档任务不能验证" }, 409);
    // 接力出去的任务是历史存档:验证轮会真跑代码、往 worktree 里写证据,不给开。
    const handedOff = handoffBlockReason(target.handoff);
    if (handedOff) return c.json({ error: handedOff, handoff: true }, 409);
    if (target.status === "running" || target.status === "queued") {
      return c.json({ error: "目标仍在运行或排队，结束后再验", status: target.status }, 409);
    }
    const body = await c.req.json<ReviewDispatchInput>().catch(() => ({} as ReviewDispatchInput));
    if (body.agentType !== undefined && !AGENT_TYPES.includes(body.agentType)) {
      return c.json({ error: "未知的 reviewer agentType", agentType: body.agentType }, 400);
    }
    for (const key of ["executorId", "model", "reasoningEffort"] as const) {
      const value = body[key];
      if (value !== undefined && value !== null && typeof value !== "string") {
        return c.json({ error: `${key} 必须是字符串或 null` }, 400);
      }
    }
    try {
      return c.json(await startVerifyRound(taskId, body, { holdTurn: true }), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
}
