import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AgentType,
  ReviewConclusion,
  ReviewDispatchInput,
  Task,
  TaskReviewInfo,
  TaskReviewRound,
  TaskStatus,
  TeamConfig,
} from "@harness/shared";
import { AGENT_TYPES, TEAM_DEFAULTS } from "@harness/shared";
import { inheritExecutorOverrides, pickExecutor } from "@harness/shared/executors";
import { VERIFY_CHECK_LABELS, STEP_LABELS } from "@harness/shared/workflow";
import { anchorAt, firstAnchor, workflowPolicy } from "@harness/shared/workflow-policy";
import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { agents, projects, sessions, tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";
import {
  detectReviewCoverage,
  repairCoverageGuard,
  type ReviewCoverageFinding,
} from "./review-coverage.js";
import { setTaskStage } from "./task-stage.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { askAboutFailure } from "./task-question.js";
import { createTasks } from "./task-store.js";
import {
  MAX_AUTO_REVIEW_ROUNDS,
  reviewOutcomeAction,
  reviewPlan,
  shouldAutoDispatchReview,
  withVerifyExecutor,
  type Settlement,
} from "./review-policy.js";
import { taskWorkflowDef } from "./workflows.js";
import { advanceWorkflowFrom, settleFrom } from "./workflow-advance.js";
import { applyRunFailPolicy } from "./workflow-steps.js";
import type { Workspace } from "./git.js";
import { id, now } from "./util.js";

const REVIEW_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".md": "text/markdown; charset=utf-8",
};

type TaskRow = typeof tasks.$inferSelect;

export const REVIEW_OVERWRITE_CHECK =
  "若声称行为在仓库里不存在或已被改掉，先查被审产物提交之后是否有后续提交触及同批文件；" +
  "若有，在报告写明“疑似被后续提交有意覆盖，建议人工确认而非自动打回”及提交 hash、说明和文件，" +
  "并先调用 ask_question 等人工确认，不要仅因此上报 verify_failed。";


export function reviewRoundDir(taskId: string, round: number): string {
  return join(RUNS_DIR, taskId, "review", `round-${round}`);
}

export function nextReviewRound(existingRounds: number): number {
  return Math.max(0, Math.floor(existingRounds)) + 1;
}

// Resolve only one file inside a single round directory. Both the route and its
// regression test use this helper so path traversal cannot drift from policy.
export function safeReviewFilePath(taskId: string, round: number, name: string): string | null {
  if (
    !Number.isInteger(round) ||
    round < 1 ||
    !taskId ||
    basename(taskId) !== taskId ||
    !name ||
    basename(name) !== name
  ) return null;
  const base = resolve(reviewRoundDir(taskId, round));
  const file = resolve(base, name);
  return file.startsWith(base + sep) ? file : null;
}

// Lexical containment is not enough: a reviewer can replace `review` or
// `round-N` with a symlink and make an otherwise harmless `report.md` resolve
// outside RUNS_DIR. Walk every directory component with lstat so both reads and
// server-owned conclusion writes reject symlink ancestors.
async function safeReviewDirectory(dir: string, create = false): Promise<boolean> {
  const root = resolve(RUNS_DIR);
  const target = resolve(dir);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  if (create) await mkdir(root, { recursive: true });
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (create) await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function reviewerConfig(lead: TaskRow | null): TeamConfig {
  if (!lead?.team) return TEAM_DEFAULTS;
  try {
    return { ...TEAM_DEFAULTS, ...(JSON.parse(lead.team) as TeamConfig) };
  } catch {
    return TEAM_DEFAULTS;
  }
}

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
    parentId: teamLead?.id ?? null,
    groupId: teamLead ? target.groupId : null,
    agentType: (picked.agentType ?? fallback.agentType ?? "claude") as AgentType,
    executorId: picked.executorId,
    ...inherited,
  };
}

export async function dispatchReviewTask(
  targetId: string,
  override: ReviewDispatchInput = {},
): Promise<Task> {
  const target = (await db.select().from(tasks).where(eq(tasks.id, targetId))).at(0);
  if (!target) throw new Error("被审任务不存在");
  if (target.reviewOf) throw new Error("审查任务自身不能再派审");

  const existing = await db.select().from(tasks).where(eq(tasks.reviewOf, targetId));
  if (existing.some((review) => ["backlog", "queued", "running", "paused"].includes(review.status))) {
    throw new Error("该任务已有一轮审查尚未结束");
  }
  const round = nextReviewRound(existing.length);
  // 这一轮验的是线上**哪一站**。轮数（round）仍然全局递增——它是证据目录名
  // `review/round-<n>`，一条线上有好几站验证时按站数会撞车。判定用的「这一站验到第几轮」
  // 另外按 review_step 数（`stationRound`）。
  const reviewStep = anchorAt(
    taskWorkflowDef(target.workflow), target.workflowAt, "verify",
  )?.id ?? null;
  const execution = await reviewExecution(target, withVerifyExecutor(target, override));
  const at = now();
  const reviewId = id();
  const [created] = await createTasks([{
    id: reviewId,
    projectId: target.projectId,
    groupId: execution.groupId,
    parentId: execution.parentId,
    title: `审查:${target.title}`,
    body: `审查任务 ${target.id} 的第 ${round} 轮。按注入的审查协议真实运行验证并留证。`,
    mode: "single",
    status: "backlog",
    stage: null,
    reviewOf: target.id,
    reviewRound: round,
    reviewStep,
    reviewRequested: false,
    priority: target.priority,
    labels: "[]",
    dependsOn: "[]",
    resumeDependsOn: "[]",
    agentType: execution.agentType,
    executorId: execution.executorId,
    model: execution.model,
    reasoningEffort: execution.reasoningEffort,
    autoTitle: false,
    debate: null,
    team: null,
    reportBack: false,
    scheduleId: null,
    createdAt: at,
    updatedAt: at,
    useWorktree: false,
    worktreeBase: null,
    originTaskId: target.id,
  }]);
  if (!created) throw new Error("创建审查任务失败");

  await setTaskStage(target.id, "verifying");
  bus.publish({ type: "task.review", taskId: target.id });
  void import("./orchestrator.js")
    .then(({ runTask }) => runTask(reviewId))
    .catch((error) => appendTaskTimeline(
      target.id,
      `第 ${round} 轮审查启动失败：${error instanceof Error ? error.message : String(error)}`,
    ));
  return created;
}

export async function reviewProtocolFor(
  review: TaskRow,
  workspace: Workspace,
  repoPath: string,
): Promise<string> {
  if (!review.reviewOf || !review.reviewRound) return "";
  const target = (await db.select().from(tasks).where(eq(tasks.id, review.reviewOf))).at(0);
  if (!target) return `【审查任务】被审任务 ${review.reviewOf} 已不存在，记录问题后结束本轮。\n\n`;
  const evidenceDir = reviewRoundDir(target.id, review.reviewRound);
  const baseline = target.useWorktree ? target.worktreeBase || "项目当前基线" : "当前工作树的基准提交";
  // 「验什么」是用户在线上勾的，不能只画在界面里：不传给审查者，那几个勾就是装饰。
  // 一条线上可以有好几站验证，各勾各的——所以读**这一轮验的那一站**（review_step）。
  const checks = workflowPolicy(
    taskWorkflowDef(target.workflow), review.reviewStep ?? target.workflowAt,
  )?.verify?.p.checks ?? [];
  const required = checks.length
    ? `这条线上勾的验证项必须逐项过：${checks.map((c) => VERIFY_CHECK_LABELS[c]).join("、")}。` +
      `发现别的风险照样报，但这几项不能跳。\n\n`
    : "";
  return `【审查任务 · 第 ${review.reviewRound} 轮】\n` +
    `审查对象：${target.id} / ${target.title}\n` +
    `目标正文：\n${target.body || "(无正文)"}\n\n` +
    required +
    `先检查真实改动：项目仓库 ${repoPath}；被审工作目录 ${workspace.path}；` +
    `被审分支 ${workspace.branch ?? "(无 Git 分支)"}；比较基线 ${baseline}。` +
    `先看 git status / git diff / 相关提交，再决定验证范围。\n\n` +
    `${REVIEW_OVERWRITE_CHECK}\n\n` +
    `必须真实运行验证：只读代码或只过编译不算。web 改动必须启动服务，用浏览器确认行为并截图；` +
    `其它改动也必须运行与风险相称的测试或产物。\n\n` +
    `浏览器验证优先走 CDP（Chrome DevTools Protocol）直连/复用浏览器；确实走不通才允许退回 playwright 一类工具。` +
    `一旦用了 playwright，审查结束前必须把它落在仓库工作区里的产物删干净（.playwright-cli/、playwright-report/、test-results/ 等），` +
    `并用 git status 确认没有留下未跟踪文件——残留会把工作区弄脏，直接导致后续验收合并被拒。\n\n` +
    `验证收尾必须清场：审查结束前把你为验证启动的所有服务/进程全部停掉（dev server、mock server、throwaway 实例等），` +
    `确认监听端口已释放，不许留孤儿进程在后台。\n\n` +
    `证据强制落盘：\n` +
    `- 必写报告：${join(evidenceDir, "report.md")}（包含结论、依据、发现的问题）\n` +
    `- 截图：放在 ${evidenceDir} 目录内\n` +
    `- 证据**只落盘，绝不 git add / commit 进仓库**（data/ 本就在 .gitignore 里，不要 -f 强加）：` +
    `验收界面直接从磁盘读证据，塞进 git 只会拿二进制文件污染被审分支的验收 diff\n\n` +
    `审查结束时，调用 report_stage(taskId="${target.id}", stage="verified"|"verify_failed") 给被审任务下结论；` +
    `最后调用 complete_task(taskId="${review.id}") 确认你自己的审查任务完成。` +
    `不要给审查任务自身上报 stage。\n\n`;
}

export function reviewReminderFor(review: Pick<TaskRow, "id" | "reviewOf" | "reviewRound">): string {
  if (!review.reviewOf || !review.reviewRound) return "";
  const dir = reviewRoundDir(review.reviewOf, review.reviewRound);
  return `审查提醒:这是第 ${review.reviewRound} 轮审查；必须真实运行验证并把报告写到 ${join(dir, "report.md")}，` +
    `截图放同目录（只落盘，绝不 commit 进仓库）；浏览器验证优先 CDP，退回 playwright 的话结束前必须删掉它在工作区的产物（.playwright-cli/ 等）；` +
    `验证完停掉自己启动的所有服务/进程；` +
    `结束前对被审任务 ${review.reviewOf} 调 report_stage(verified|verify_failed)，` +
    `再对审查任务自身 ${review.id} 调 complete_task。`;
}

async function readReport(taskId: string, round: number): Promise<string> {
  return (await readReviewFile(taskId, round, "report.md"))?.toString("utf8") ?? "";
}

async function screenshots(taskId: string, round: number): Promise<string[]> {
  try {
    const dir = reviewRoundDir(taskId, round);
    if (!(await safeReviewDirectory(dir))) return [];
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && [".png", ".jpg", ".jpeg"].includes(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function readReviewFile(taskId: string, round: number, name: string): Promise<Buffer | null> {
  const file = safeReviewFilePath(taskId, round, name);
  if (!file) return null;
  try {
    if (!(await safeReviewDirectory(reviewRoundDir(taskId, round)))) return null;
    // lstat (not stat) rejects symlinks, including a reviewer-created link to a
    // file outside the evidence directory with an otherwise harmless .md name.
    if (!(await lstat(file)).isFile()) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}

async function writeConclusion(targetId: string, round: number, reviewTaskId: string, conclusion: ReviewConclusion) {
  if (!conclusion) return;
  const dir = reviewRoundDir(targetId, round);
  if (!(await safeReviewDirectory(dir, true))) return;
  const file = join(dir, "conclusion.json");
  try {
    const handle = await open(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(
        JSON.stringify({ conclusion, reviewTaskId, recordedAt: now() }, null, 2) + "\n",
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    // A conclusion is immutable once recorded. EEXIST also covers a malicious
    // final symlink without following or overwriting its target.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function readConclusion(targetId: string, round: number): Promise<ReviewConclusion> {
  try {
    const raw = await readReviewFile(targetId, round, "conclusion.json");
    if (!raw) return null;
    const parsed = JSON.parse(raw.toString("utf8")) as {
      conclusion?: unknown;
    };
    return parsed.conclusion === "verified" || parsed.conclusion === "verify_failed"
      ? parsed.conclusion
      : null;
  } catch {
    return null;
  }
}

function repairPrompt(
  target: TaskRow,
  review: TaskRow,
  report: string,
  images: string[],
  coverage: ReviewCoverageFinding | null,
  autoNext: boolean,
): string {
  const dir = reviewRoundDir(target.id, review.reviewRound ?? 1);
  const evidence = images.length
    ? images.map((name) => `- ${join(dir, name)}`).join("\n")
    : "- (本轮没有截图文件)";
  const coverageGuard = repairCoverageGuard(coverage);
  return `【自动审查未通过 · 第 ${review.reviewRound} 轮】\n` +
    `审查任务 ${review.id} 已给出 verify_failed。请按报告修复，不要扩大原任务边界。\n\n` +
    (coverageGuard ? `${coverageGuard}\n\n` : "") +
    `审查报告：\n${report || "(审查者未写 report.md；请结合会话与现有产物排查)"}\n\n` +
    `证据目录：${dir}\n${evidence}\n\n` +
    `修完必须调用 complete_task(taskId="${target.id}") 确认完成；` +
    (autoNext ? "确认后 harness 会自动派发下一轮复审。" : "本轮不自动续派，确认后可由用户手动再次派审。");
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
 * 这一轮是**这一站**验证的第几轮。
 *
 * 跟 `reviewRound` 的区别：那个是这个任务被审过的总次数（同时也是证据目录名，必须全局
 * 唯一）；一条线上有好几站验证时，第二站的第一轮不该继承第一站用掉的轮数——否则用户
 * 在第二站写的「没过就重做 2 轮」会当场用完。
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

async function finishReview(review: TaskRow, status: Settlement): Promise<void> {
  const target = review.reviewOf
    ? (await db.select().from(tasks).where(eq(tasks.id, review.reviewOf))).at(0)
    : null;
  if (!target) return;
  const round = review.reviewRound ?? 1;
  const conclusion = target.stage === "verified" || target.stage === "verify_failed"
    ? target.stage as ReviewConclusion
    : null;
  const workflow = taskWorkflowDef(target.workflow);
  // 这一轮验的是哪一站：审查任务身上记着（老审查任务没记，回落到线上第一站验证）。
  // 轮数也按站数——第二站验证的第一轮就是它的第 1 轮，不该继承第一站用掉的次数。
  const station = review.reviewStep ?? firstAnchor(workflow, "verify")?.id ?? null;
  const stationRound = await roundAtStation(target.id, review);
  const policy = workflowPolicy(workflow, station);
  const action = reviewOutcomeAction({
    reviewStatus: status,
    conclusion,
    reviewRequested: target.reviewRequested,
    round: stationRound,
    parentIsTeam: await parentIsTeam(target),
    workflow,
    at: station,
  });

  if (status === "done") await writeConclusion(target.id, round, review.id, conclusion);
  bus.publish({ type: "task.review", taskId: target.id });
  if (action === "verified") {
    // 验完之后线上还写着的那几站在这儿跑，然后走到下一个锚点：可能是又一站「自动验证」，
    // 也可能是「等我点头」。人工关口之前就得把预览起好，不然用户点进来只有一句
    // 「待验收」，没东西可看。中间任何一段跑砸了就停在那儿，不再往下推。
    await advanceWorkflowFrom(target, workflow, station);
    return;
  }
  if (action === "failed") {
    await appendTaskTimeline(target.id, `第 ${round} 轮审查任务 ${review.id} 以 ${status} 结束；不自动循环，等待人工处理。`);
    return;
  }
  if (action === "invalid") {
    await appendTaskTimeline(
      target.id,
      `第 ${round} 轮审查任务 ${review.id} 已结束，但未给被审任务上报 verified/verify_failed；等待人工处理。`,
    );
    return;
  }
  if (action === "stop") {
    // 停在这儿的两种理由用不同的话说清楚：拐回重做跑满了轮数，跟这条线本来就写着
    // 「没过就停下等人」，对用户是两件事。
    const byPolicy = policy?.verify && policy.onVerifyFail !== "back";
    if (byPolicy && policy.onVerifyFail === "ask") {
      // 「问我一句」得真的问出来：把审查报告的开头附上，用户不用点进审查任务就能判断。
      await askAboutFailure(target.id, STEP_LABELS.verify, await readReport(target.id, round));
      await appendTaskTimeline(
        target.id,
        `第 ${round} 轮审查未通过；这条线写的是「没过就问我一句」，已经把问题挂给你了。`,
      );
      return;
    }
    await appendTaskTimeline(target.id, byPolicy
      ? `第 ${round} 轮审查未通过；这条线写的是「没过就停下等人」，现停在 verify_failed 等人处理。`
      : `第 ${round} 轮审查仍未通过；自动复审上限为 ${policy?.verify ? policy.verifyRounds : MAX_AUTO_REVIEW_ROUNDS} 轮，现停在 verify_failed 等人处理。`);
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
  await appendTaskTimeline(target.id, `第 ${round} 轮审查未通过，已把审查报告和证据路径交回原任务续跑修复。`);
  void import("./orchestrator.js")
    .then(({ continueTask }) => continueTask(
      target.id,
      repairPrompt(target, review, report, images, coverage, plan.auto && stationRound < plan.maxRounds),
    ))
    .catch((error) => appendTaskTimeline(
      target.id,
      `审查打回失败：唤醒原任务时出错（${error instanceof Error ? error.message : String(error)}），请手动续跑。`,
    ));
}

// 「等我点头」这一站落地：把验收阶段停在 awaiting_acceptance。
// **只动 stage 不动 status** —— status 是调度用的（改成 awaiting_review 会顺带停住这个
// 任务所在的队列），而这条线只描述这一个任务干完之后怎么走，不该外溢到队列/分组。
// 显示上也不需要动 status：taskDisplayStatus 里 stage 优先，列表那一格就是「待验收」。
export async function enterHumanGate(taskId: string): Promise<void> {
  const row = (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row || row.stage === "awaiting_acceptance" || row.stage === "merged" || row.stage === "accepted") return;
  await setTaskStage(taskId, "awaiting_acceptance");
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
export async function handleTaskSettlement(
  taskId: string,
  status: Settlement,
  confirmedDone: boolean,
): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return;
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
  // 身上没线的老任务照旧：团队那边要求审查就派一轮。
  const rounds = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.reviewOf, task.id));
  if (shouldAutoDispatchReview({
    confirmedDone,
    status,
    parentIsTeam: isTeamWorker,
    mode: task.mode,
    reviewOf: task.reviewOf,
    reviewRequested: task.reviewRequested,
    stage: task.stage,
    existingRounds: rounds.length,
    workflow,
  })) {
    await dispatchReviewTask(task.id);
  }
}

async function reviewInfo(target: TaskRow): Promise<TaskReviewInfo> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.reviewOf, target.id))
    .orderBy(asc(tasks.reviewRound), asc(tasks.createdAt));
  const latestId = rows.at(-1)?.id;
  const rounds: TaskReviewRound[] = await Promise.all(rows.map(async (review) => {
    const round = review.reviewRound ?? 1;
    let conclusion = await readConclusion(target.id, round);
    if (!conclusion && review.id === latestId && review.status === "done") {
      conclusion = target.stage === "verified" || target.stage === "verify_failed"
        ? target.stage as ReviewConclusion
        : null;
    }
    return {
      round,
      reviewTaskId: review.id,
      reviewTaskStatus: review.status as TaskStatus,
      conclusion,
      reportMarkdown: await readReport(target.id, round),
      screenshots: await screenshots(target.id, round),
    };
  }));
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

  api.post("/tasks/:id/review/dispatch", async (c) => {
    const taskId = c.req.param("id");
    const target = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!target) return c.json({ error: "not found" }, 404);
    if (target.reviewOf) return c.json({ error: "审查任务自身不能再派审" }, 409);
    if (target.mode !== "single") return c.json({ error: "当前只支持审查 single 任务", mode: target.mode }, 409);
    if (target.archived) return c.json({ error: "归档任务不能派审" }, 409);
    if (target.status === "running" || target.status === "queued") {
      return c.json({ error: "目标仍在运行或排队，结束后再派审", status: target.status }, 409);
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
      return c.json({ reviewTask: await dispatchReviewTask(taskId, body) }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
}
