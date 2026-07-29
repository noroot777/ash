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
import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { agents, tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";
import { setTaskStage } from "./task-stage.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { createTasks } from "./task-store.js";
import type { Workspace } from "./git.js";
import { id, now } from "./util.js";

export const MAX_AUTO_REVIEW_ROUNDS = 2;
const REVIEW_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".md": "text/markdown; charset=utf-8",
};

type TaskRow = typeof tasks.$inferSelect;
type Settlement = "canceled" | "paused" | "done" | "failed";

export function shouldAutoDispatchReview(input: {
  confirmedDone: boolean;
  status: Settlement;
  parentIsTeam: boolean;
  mode: string;
  reviewOf: string | null;
  reviewRequested: boolean;
  stage: string | null;
  existingRounds: number;
}): boolean {
  if (!input.confirmedDone || input.status !== "done") return false;
  if (!input.parentIsTeam || input.mode === "team" || input.reviewOf) return false;
  if (!input.reviewRequested) return false;
  if (input.existingRounds === 0) return true;
  return input.stage === "verify_failed" && input.existingRounds < MAX_AUTO_REVIEW_ROUNDS;
}

export type ReviewOutcomeAction = "verified" | "repair" | "stop" | "failed" | "invalid";

export function reviewOutcomeAction(input: {
  reviewStatus: Settlement;
  conclusion: string | null;
  reviewRequested: boolean;
  round: number;
}): ReviewOutcomeAction {
  if (input.reviewStatus === "failed" || input.reviewStatus === "canceled") return "failed";
  if (input.reviewStatus !== "done") return "invalid";
  if (input.conclusion === "verified") return "verified";
  if (input.conclusion !== "verify_failed") return "invalid";
  // Round 2 is the only automatic-chain stop. A later round can only have been
  // manually dispatched, so it may hand back another repair without silently
  // scheduling yet another review.
  return input.reviewRequested && input.round === MAX_AUTO_REVIEW_ROUNDS ? "stop" : "repair";
}

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
  const execution = await reviewExecution(target, override);
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
  return `【审查任务 · 第 ${review.reviewRound} 轮】\n` +
    `审查对象：${target.id} / ${target.title}\n` +
    `目标正文：\n${target.body || "(无正文)"}\n\n` +
    `先检查真实改动：项目仓库 ${repoPath}；被审工作目录 ${workspace.path}；` +
    `被审分支 ${workspace.branch ?? "(无 Git 分支)"}；比较基线 ${baseline}。` +
    `先看 git status / git diff / 相关提交，再决定验证范围。\n\n` +
    `必须真实运行验证：只读代码或只过编译不算。web 改动必须启动服务，用浏览器确认行为并截图；` +
    `其它改动也必须运行与风险相称的测试或产物。\n\n` +
    `证据强制落盘：\n` +
    `- 必写报告：${join(evidenceDir, "report.md")}（包含结论、依据、发现的问题）\n` +
    `- 截图：放在 ${evidenceDir} 目录内\n\n` +
    `审查结束时，调用 report_stage(taskId="${target.id}", stage="verified"|"verify_failed") 给被审任务下结论；` +
    `最后调用 complete_task(taskId="${review.id}") 确认你自己的审查任务完成。` +
    `不要给审查任务自身上报 stage。\n\n`;
}

export function reviewReminderFor(review: Pick<TaskRow, "id" | "reviewOf" | "reviewRound">): string {
  if (!review.reviewOf || !review.reviewRound) return "";
  const dir = reviewRoundDir(review.reviewOf, review.reviewRound);
  return `审查提醒:这是第 ${review.reviewRound} 轮审查；必须真实运行验证并把报告写到 ${join(dir, "report.md")}，` +
    `截图放同目录；结束前对被审任务 ${review.reviewOf} 调 report_stage(verified|verify_failed)，` +
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

function repairPrompt(target: TaskRow, review: TaskRow, report: string, images: string[]): string {
  const dir = reviewRoundDir(target.id, review.reviewRound ?? 1);
  const autoNext = target.reviewRequested && (review.reviewRound ?? 1) < MAX_AUTO_REVIEW_ROUNDS;
  const evidence = images.length
    ? images.map((name) => `- ${join(dir, name)}`).join("\n")
    : "- (本轮没有截图文件)";
  return `【自动审查未通过 · 第 ${review.reviewRound} 轮】\n` +
    `审查任务 ${review.id} 已给出 verify_failed。请按报告修复，不要扩大原任务边界。\n\n` +
    `审查报告：\n${report || "(审查者未写 report.md；请结合会话与现有产物排查)"}\n\n` +
    `证据目录：${dir}\n${evidence}\n\n` +
    `修完必须调用 complete_task(taskId="${target.id}") 确认完成；` +
    (autoNext ? "确认后 harness 会自动派发下一轮复审。" : "本轮不自动续派，确认后可由用户手动再次派审。");
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
  const action = reviewOutcomeAction({
    reviewStatus: status,
    conclusion,
    reviewRequested: target.reviewRequested,
    round,
  });

  if (status === "done") await writeConclusion(target.id, round, review.id, conclusion);
  bus.publish({ type: "task.review", taskId: target.id });
  if (action === "verified") return;
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
    await appendTaskTimeline(target.id, `第 ${round} 轮审查仍未通过；自动复审上限为 ${MAX_AUTO_REVIEW_ROUNDS} 轮，现停在 verify_failed 等人处理。`);
    return;
  }

  const [report, images] = await Promise.all([readReport(target.id, round), screenshots(target.id, round)]);
  await appendTaskTimeline(target.id, `第 ${round} 轮审查未通过，已把审查报告和证据路径交回原任务续跑修复。`);
  void import("./orchestrator.js")
    .then(({ continueTask }) => continueTask(target.id, repairPrompt(target, review, report, images)))
    .catch((error) => appendTaskTimeline(
      target.id,
      `审查打回失败：唤醒原任务时出错（${error instanceof Error ? error.message : String(error)}），请手动续跑。`,
    ));
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

  const parent = task.parentId
    ? (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, task.parentId))).at(0)
    : null;
  const rounds = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.reviewOf, task.id));
  if (!shouldAutoDispatchReview({
    confirmedDone,
    status,
    parentIsTeam: parent?.mode === "team",
    mode: task.mode,
    reviewOf: task.reviewOf,
    reviewRequested: task.reviewRequested,
    stage: task.stage,
    existingRounds: rounds.length,
  })) return;
  await dispatchReviewTask(task.id);
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
