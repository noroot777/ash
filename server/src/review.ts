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
import { extname } from "node:path";
import type {
  AgentType,
  ReviewConclusion,
  ReviewDispatchInput,
  TaskReviewInfo,
  TaskReviewRound,
  TaskStatus,
  TeamConfig,
} from "@harness/shared";
import { AGENT_TYPES, TEAM_DEFAULTS } from "@harness/shared";
import { inheritExecutorOverrides, pickExecutor } from "@harness/shared/executors";
import { STEP_LABELS } from "@harness/shared/workflow";
import { anchorAt, firstAnchor, workflowPolicy } from "@harness/shared/workflow-policy";
import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { agents, projects, sessions, tasks } from "./db/schema.js";
import {
  detectReviewCoverage,
  type ReviewCoverageFinding,
} from "./review-coverage.js";
import {
  REVIEW_MIME,
  nextReviewRound,
  readConclusion,
  readReport,
  readReviewFile,
  safeReviewFilePath,
  screenshots,
  writeConclusion,
} from "./review-evidence.js";
import { repairPrompt, verifyProtocolFor } from "./review-prompts.js";
import { setTaskStage } from "./task-stage.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { askAboutFailure } from "./task-question.js";
import {
  MAX_AUTO_REVIEW_ROUNDS,
  reviewOutcomeAction,
  reviewPlan,
  shouldAutoDispatchReview,
  withVerifyExecutor,
  type Settlement,
} from "./review-policy.js";
import { continueWhenIdle } from "./runs.js";
import { taskWorkflowDef } from "./workflows.js";
import { advanceWorkflowFrom, settleFrom } from "./workflow-advance.js";
import { applyRunFailPolicy } from "./workflow-steps.js";
import { now } from "./util.js";

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
): Promise<{ round: number }> {
  const target = (await db.select().from(tasks).where(eq(tasks.id, targetId))).at(0);
  if (!target) throw new Error("被验任务不存在");
  if (target.reviewOf) throw new Error("审查任务自身不能再验");
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

  await db
    .update(tasks)
    .set({
      verifyRound: round,
      reviewStep: station,
      verifyStationRounds: target.reviewStep === station ? (target.verifyStationRounds ?? 0) : 0,
      updatedAt: now(),
    })
    .where(eq(tasks.id, targetId));
  await setTaskStage(targetId, "verifying");
  await appendTaskTimeline(targetId, `第 ${round} 轮验证开始：就在这个任务的工作目录里跑，不另起审查任务。`);
  bus.publish({ type: "task.review", taskId: targetId });

  continueWhenIdle(
    targetId,
    verifyProtocolFor(target, round, project?.repoPath ?? "(项目已不存在)", station),
    {
      system: "run",
      sideTurn: true,
      agent: execution.agentType,
      executorId: execution.executorId,
      model: execution.model,
      reasoningEffort: execution.reasoningEffort,
    },
    async (error) => {
      await db.update(tasks).set({ verifyRound: null, updatedAt: now() }).where(eq(tasks.id, targetId));
      await appendTaskTimeline(targetId, `第 ${round} 轮验证启动失败：${error}`);
      bus.publish({ type: "task.review", taskId: targetId });
    },
  );
  return { round };
}

async function reviewCoverageFor(target: TaskRow): Promise<ReviewCoverageFinding | null> {
  const [project, taskSessions] = await Promise.all([
    db.select().from(projects).where(eq(projects.id, target.projectId)).then((rows) => rows.at(0)),
    db.select().from(sessions).where(eq(sessions.taskId, target.id)),
  ]);
  if (!project) return null;
  const completed = taskSessions
    .filter((session) => session.endedAt)
    .sort((a, b) => b.endedAt!.localeCompare(a.endedAt!))[0];
  return detectReviewCoverage({
    repoPath: project.repoPath,
    ref: completed?.branch,
    turnStartedAt: completed?.turnStartedAt ?? completed?.startedAt ?? target.startedAt,
    endedAt: completed?.endedAt ?? target.endedAt,
  });
}

/**
 * 这一轮是**这一站**验证的第几轮（历史那批独立审查任务的口径：数它们的行）。
 *
 * 跟证据轮次号的区别：那个是这个任务验过的总次数（同时也是证据目录名，必须全局唯一）；
 * 一条线上有好几站验证时，第二站的第一轮不该继承第一站用掉的轮数——否则用户在第二站
 * 写的「没过就重做 2 轮」会当场用完。就地验证轮没有独立任务行可数，按站的轮数记在被验
 * 任务的 `verify_station_rounds` 上。
 */
async function roundAtStation(targetId: string, review: TaskRow): Promise<number> {
  if (!review.reviewStep) return review.reviewRound ?? 1;
  const rows = await db
    .select({ reviewRound: tasks.reviewRound, reviewStep: tasks.reviewStep })
    .from(tasks)
    .where(eq(tasks.reviewOf, targetId));
  return rows.filter((row) =>
    row.reviewStep === review.reviewStep && (row.reviewRound ?? 0) <= (review.reviewRound ?? 0),
  ).length || 1;
}

/**
 * 一轮验证结束后怎么走 —— 就地验证轮和历史独立审查任务**共用这一段**。
 *
 * `outcome` 是这一轮本身的落位（跑完了 / 挂了 / 被停），不是被验任务的状态：就地验证
 * 是旁路回合，任务状态本来就该原样不动，拿它当验证结果会把「任务是 done」误读成
 * 「验证通过」。`reviewTaskId` 非空 = 历史那种独立审查任务。
 *
 * `at` 是「这一轮验的是线上哪一站、按站数是第几轮」：轮数上限、失败策略、验完往哪走
 * 全读这一站的（`station` 为 null = 身上没线的老任务，退化成老行为）。
 */
async function concludeRound(
  target: TaskRow,
  round: number,
  outcome: Settlement,
  reviewTaskId: string | null,
  at: { station: string | null; stationRound: number },
): Promise<void> {
  const { station, stationRound } = at;
  const conclusion = target.stage === "verified" || target.stage === "verify_failed"
    ? target.stage as ReviewConclusion
    : null;
  const workflow = taskWorkflowDef(target.workflow);
  const policy = workflowPolicy(workflow, station);
  const action = reviewOutcomeAction({
    reviewStatus: outcome,
    conclusion,
    reviewRequested: target.reviewRequested,
    round: stationRound,
    parentIsTeam: await parentIsTeam(target),
    workflow,
    at: station,
  });
  const by = reviewTaskId ? `审查任务 ${reviewTaskId} ` : "";

  if (outcome === "done") await writeConclusion(target.id, round, reviewTaskId, conclusion);
  bus.publish({ type: "task.review", taskId: target.id });
  if (action === "verified") {
    // 验完之后线上还写着的那几站在这儿跑，然后走到下一个锚点：可能是又一站「自动验证」，
    // 也可能是「等我点头」。人工关口之前就得把预览起好，不然用户点进来只有一句
    // 「待验收」，没东西可看。中间任何一段跑砸了就停在那儿，不再往下推。
    await advanceWorkflowFrom(target, workflow, station);
    return;
  }
  if (action === "failed") {
    await appendTaskTimeline(target.id, `第 ${round} 轮验证${by ? `（${by.trim()}）` : ""}以 ${outcome} 结束；不自动循环，等待人工处理。`);
    return;
  }
  if (action === "invalid") {
    await appendTaskTimeline(
      target.id,
      `第 ${round} 轮验证${by ? `（${by.trim()}）` : ""}已结束，但没有给出 verified/verify_failed 结论；等待人工处理。`,
    );
    return;
  }
  if (action === "stop") {
    // 停在这儿的两种理由用不同的话说清楚：拐回重做跑满了轮数，跟这条线本来就写着
    // 「没过就停下等人」，对用户是两件事。
    const byPolicy = policy?.verify && policy.onVerifyFail !== "back";
    if (byPolicy && policy.onVerifyFail === "ask") {
      // 「问我一句」得真的问出来：把验证报告的开头附上，用户不用点进证据就能判断。
      await askAboutFailure(target.id, STEP_LABELS.verify, await readReport(target.id, round));
      await appendTaskTimeline(
        target.id,
        `第 ${round} 轮验证未通过；这条线写的是「没过就问我一句」，已经把问题挂给你了。`,
      );
      return;
    }
    await appendTaskTimeline(target.id, byPolicy
      ? `第 ${round} 轮验证未通过；这条线写的是「没过就停下等人」，现停在 verify_failed 等人处理。`
      : `第 ${round} 轮验证仍未通过；自动复验上限为 ${policy?.verify ? policy.verifyRounds : MAX_AUTO_REVIEW_ROUNDS} 轮，现停在 verify_failed 等人处理。`);
    return;
  }

  const [report, images, coverage] = await Promise.all([
    readReport(target.id, round),
    screenshots(target.id, round),
    reviewCoverageFor(target),
  ]);
  const plan = reviewPlan({
    parentIsTeam: await parentIsTeam(target),
    reviewRequested: target.reviewRequested,
    workflow,
    at: station,
  });
  await appendTaskTimeline(target.id, `第 ${round} 轮验证未通过，已把报告和证据路径交回原任务续跑修复。`);
  // 打回修复也要等这一轮退干净：就地验证的结论正是在这个任务自己的结算钩子里下的，
  // 那一刻它的单飞锁还锁着。
  continueWhenIdle(
    target.id,
    repairPrompt({
      target,
      round,
      reviewTaskId,
      report,
      images,
      coverage,
      autoNext: plan.auto && stationRound < plan.maxRounds,
    }),
    {},
    (error) => appendTaskTimeline(
      target.id,
      `验证打回失败：唤醒原任务时出错（${error}），请手动续跑。`,
    ),
  );
}

/** 就地验证轮结束：清掉轮次标记、记账，再走公共的收尾。 */
async function finishVerifyRound(target: TaskRow, turnOk: boolean): Promise<void> {
  const round = target.verifyRound ?? 1;
  // 这一轮还没跑完：agent 中途提问（等答复）或写下了检查点（等续跑）。轮次标记留着，
  // 答复/续跑回来的那一回合仍然是这一轮验证 —— 此时下结论会把「还没验完」记成
  // 「验完了但没给结论」。
  if (target.question || target.resumePrompt) return;
  // verify_rounds 数的是**就地轮次的个数**，不是轮次号：轮次号还要算上历史那批独立
  // 审查任务占掉的号（`nextReviewRound(legacy.length + verifyRounds)`），拿号当计数会
  // 让下一轮跳号。verify_station_rounds 则是「这一站」验过几轮，判定轮数上限用它。
  const stationRound = (target.verifyStationRounds ?? 0) + 1;
  await db
    .update(tasks)
    .set({
      verifyRound: null,
      verifyRounds: (target.verifyRounds ?? 0) + 1,
      verifyStationRounds: stationRound,
      updatedAt: now(),
    })
    .where(eq(tasks.id, target.id));
  // 旁路回合的落位永远是任务原来的终态，说明不了验证跑成没跑成，所以这里用回合本身
  // 是否干净收尾来判：崩了/被手停 → 这一轮没结论，按 failed 收尾。
  await concludeRound(target, round, turnOk ? "done" : "failed", null, {
    // 开这一轮时把站号记在了被验任务身上；老数据没有就回落到线上第一站验证。
    station: target.reviewStep ?? firstAnchor(taskWorkflowDef(target.workflow), "verify")?.id ?? null,
    stationRound,
  });
}

/** 历史做法：独立审查任务跑完之后的收尾。启动路径已经拆掉，这条只服务存量数据。 */
async function finishReview(review: TaskRow, status: Settlement): Promise<void> {
  const target = review.reviewOf
    ? (await db.select().from(tasks).where(eq(tasks.id, review.reviewOf))).at(0)
    : null;
  if (!target) return;
  await concludeRound(target, review.reviewRound ?? 1, status, review.id, {
    // 这一轮验的是哪一站：审查任务身上记着（老审查任务没记，回落到线上第一站验证）。
    station: review.reviewStep ?? firstAnchor(taskWorkflowDef(target.workflow), "verify")?.id ?? null,
    stationRound: await roundAtStation(target.id, review),
  });
}

// 「等我点头」这一站落地：把验收阶段停在 awaiting_acceptance。
// **只动 stage 不动 status** —— status 是调度用的（改成 awaiting_review 会顺带停住这个
// 任务所在的队列），而这条线只描述这一个任务干完之后怎么走，不该外溢到队列/分组。
// 显示上也不需要动 status：taskDisplayStatus 里 stage 优先，列表那一格就是「待验收」。
export async function enterHumanGate(taskId: string): Promise<void> {
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
// `turnOk` = 这一回合本身干净收尾了（没被停、退出码 0）。它跟 `status` 不是一回事：
// 旁路回合（就地验证）的 status 是任务原来的终态，只有 turnOk 说得清这一轮跑成没跑成。
export async function handleTaskSettlement(
  taskId: string,
  status: TaskStatus,
  confirmedDone: boolean,
  turnOk = true,
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
      await finishReview(task, status);
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
      let conclusion = await readConclusion(target.id, round);
      if (!conclusion && review.id === latestLegacyId && review.status === "done") {
        conclusion = target.stage === "verified" || target.stage === "verify_failed"
          ? target.stage as ReviewConclusion
          : null;
      }
      return {
        round,
        where: "task",
        reviewTaskId: review.id,
        reviewTaskStatus: review.status as TaskStatus,
        conclusion,
        reportMarkdown: await readReport(target.id, round),
        screenshots: await screenshots(target.id, round),
      };
    }),
    ...inline.map(async (round): Promise<TaskReviewRound> => {
      const running = target.verifyRound === round;
      let conclusion = running ? null : await readConclusion(target.id, round);
      // 最后一轮的结论文件可能还没落（结论写在结算那一步），此时看任务身上的 stage。
      if (!conclusion && !running && round === latestRound) {
        conclusion = target.stage === "verified" || target.stage === "verify_failed"
          ? target.stage as ReviewConclusion
          : null;
      }
      return {
        round,
        where: "inline",
        reviewTaskId: null,
        // 就地验证没有独立任务，这一格说的是「这一轮跑完没有」：正在跑 → running，
        // 跑完 → done。前端只拿它显示轮次状态。
        reviewTaskStatus: running ? "running" : "done",
        conclusion,
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
    const mime = REVIEW_MIME[extname(name).toLowerCase()];
    const file = safeReviewFilePath(taskId, round, name);
    if (!file || !mime) return c.json({ error: "非法的审查文件路径或类型" }, 400);
    const content = await readReviewFile(taskId, round, name);
    return content
      ? c.body(Uint8Array.from(content), 200, { "content-type": mime })
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
      return c.json(await startVerifyRound(taskId, body), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
}
