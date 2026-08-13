// 线上那些「当场就能做完」的站：跑一条命令、打开预览。
//
// 它们夹在几个会停下来等的站中间（干活等 agent、自动验证等审查任务、等我点头等人），
// 所以是**成段**跑的——段落切分在 shared 的 segmentAfter()，这里只管把一段跑完。
//
// 两条不变量：
//   ① 每一站的成败都往时间线写一行。刷新后仍看得见「跑了什么、成没成、为什么」，
//      不然用户只会看到任务莫名其妙停住。
//   ② 这一层**不碰队列、不碰分组**，也不改 status。一段跑砸了就把结论返回给调用方，
//      由它按线上写的失败策略决定停下等人还是打回重做。
import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { segmentAfter } from "@harness/shared/workflow-policy";
import type { WorkflowDef, WorkflowStep } from "@harness/shared/workflow";
import { STEP_LABELS } from "@harness/shared/workflow";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { augmentedEnv } from "./executors/spawn.js";
import { RUNS_DIR } from "./paths.js";
import { readPreview, startPreview, type PreviewStep } from "./preview.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { askAboutFailure } from "./task-question.js";
import { taskWorkspace } from "./task-workspace.js";
import { taskWorkflowDef } from "./workflows.js";
import { continueWhenIdle } from "./runs.js";

const run = promisify(execFile);

/** 一条命令最多跑多久。跑构建、跑测试都算在内，再久基本是卡住了。 */
const COMMAND_TIMEOUT_MS = 20 * 60_000;

type TaskRow = typeof tasks.$inferSelect;
type CommandStep = Extract<WorkflowStep, { kind: "command" }>;

export interface SegmentResult {
  /** 这一段是不是全跑过了 */
  ok: boolean;
  /** 没跑过时卡在哪一站（调用方要读它的 fail 策略） */
  failed?: WorkflowStep;
  reason?: string;
}

export interface SegmentOptions {
  /**
   * 跳过「合并并清理」这一站。只有一种场合要用：**用户刚点完验收**，acceptTask 回过头来
   * 跑「点头之后那一段」——那一站正是刚刚做完的事，不能再做一遍。
   */
  skipAccept?: boolean;
  /**
   * 已经执行完成、这次直接跳过的站（验收尾段的崩溃补跑用）：没有它，补跑=整段重跑，
   * 已发生过的发布/部署副作用会重复执行。
   */
  skipStepIds?: ReadonlySet<string>;
  /** 每一站成功执行完后的落账回调（验收尾段把 step id 追加进 durable 清单）。 */
  onStepDone?: (stepId: string) => Promise<void>;
}

function shorten(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

// 「在哪儿跑」：任务工作区 = 它自己那份（worktree 或项目目录），项目根目录 = 仓库本身。
// 这两个在没开 worktree 时本来就是同一个地方，选项的意义只在开了 worktree 的任务上。
async function cwdFor(task: TaskRow, where: "workspace" | "repo"): Promise<string | null> {
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project?.repoPath) return null;
  if (where === "repo") return project.repoPath;
  try {
    return (await taskWorkspace(task, project.repoPath)).path;
  } catch {
    return project.repoPath;
  }
}

async function runCommand(task: TaskRow, step: CommandStep): Promise<SegmentResult> {
  const cwd = await cwdFor(task, step.p.where);
  if (!cwd) return { ok: false, failed: step, reason: "找不到这个任务的工作目录" };
  try {
    const { stdout, stderr } = await run("sh", ["-lc", step.p.cmd], {
      cwd, env: augmentedEnv(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
    });
    const out = shorten(`${stdout}${stderr}`, 400);
    await appendTaskTimeline(task.id, `跑了一条命令：\`${step.p.cmd}\`（通过）${out ? `\n${out}` : ""}`);
    return { ok: true };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const reason = err.killed
      ? `超时（${Math.round(COMMAND_TIMEOUT_MS / 60_000)} 分钟）`
      : shorten(`${err.stderr ?? ""}${err.stdout ?? ""}` || err.message || "命令失败");
    await appendTaskTimeline(task.id, `跑了一条命令：\`${step.p.cmd}\`（没通过）\n${reason}`);
    return { ok: false, failed: step, reason };
  }
}

async function runPreview(task: TaskRow, step: PreviewStep): Promise<SegmentResult> {
  const cwd = await cwdFor(task, "workspace");
  if (!cwd) return { ok: false, failed: step, reason: "找不到这个任务的工作目录" };
  const result = await startPreview(task.id, step, cwd);
  if (result.ok) {
    await appendTaskTimeline(
      task.id,
      `预览已起：${result.record.url ?? `端口 ${result.record.port}`}（\`${step.p.cmd}\`）`,
    );
    return { ok: true };
  }
  await appendTaskTimeline(task.id, `预览没起来（\`${step.p.cmd}\`）\n${result.reason}`);
  return { ok: false, failed: step, reason: result.reason };
}

// 「合并并清理」这一站：**不在这里另写一套合并**，直接调用户点「验收通过」走的那条路
// （acceptTask 带着仓库锁、冲突处理、「绝不 -D」的规矩）。区别只在谁按下的：走到这一站
// 就是这条线自己按的——所以传 `"workflow"`，这条路只做线上真画了的事（人亲手点则相反，
// 手按覆盖线上写没写，理由见 shared 的 acceptPlan）。
// 怎么合、清到什么程度全读这一站的参数——acceptTask 里的 acceptPlan() 读的就是它。
//
// 那行时间线要照实说**这一合是怎么来的**，而它有两种来路：线上压根没画关口（没人点过
// 头），和关口画在前面、用户已经在那儿放行过了。早先只写死前一种，于是「干活 → 预览 →
// 等我点头 → 验证 → 合并」这种线合并时会写出「这条线上没写「等我点头」」——用户几分钟
// 前刚在那道关口点过放行，看到这句只会以为系统把他那一下弄丢了。
async function runAccept(task: TaskRow, def: WorkflowDef | null, step: WorkflowStep): Promise<SegmentResult> {
  const gated = !!def?.steps.some((s) => s.kind === "human");
  await appendTaskTimeline(
    task.id,
    gated
      ? "你在前面那道「等我点头」放行过了，线走到「合并并清理」，按线上写的合。"
      : "这条线上没写「等我点头」，走到「合并并清理」就自己合了。",
  );
  const { acceptTask } = await import("./task-accept.js");
  const result = await acceptTask(task.id, "workflow");
  if (result.accepted) return { ok: true };
  return { ok: false, failed: step, reason: result.error };
}

// 把紧跟**某一站**之后的那一段跑完。任何一站砸了就地停下——后面的站多半依赖前面的产物
// （典型：先跑 build 再起预览），继续往下跑只会把一个错误变成两个。
// 「卡住了怎么办」不在这儿决定：那是 applyFailPolicy 的事，调用方拿到结果自己按。
export async function runSegment(
  task: TaskRow,
  def: WorkflowDef | null,
  fromStepId: string | null | undefined,
  opts: SegmentOptions = {},
): Promise<SegmentResult> {
  for (const step of segmentAfter(def, fromStepId)) {
    if (opts.skipStepIds?.has(step.id)) continue; // 崩溃补跑：这一站上次已经真的跑完了
    const result = step.kind === "command"
      ? await runCommand(task, step)
      : step.kind === "preview"
        ? await runPreview(task, step)
        : step.kind === "accept" && !opts.skipAccept
          ? await runAccept(task, def, step)
          : { ok: true } as SegmentResult;
    if (!result.ok) return result;
    await opts.onStepDone?.(step.id);
  }
  return { ok: true };
}

// ── 失败策略与推进 ─────────────────────────────────────────────────────────
// 「打回给 AI 重做」得有个数着的地方，否则一条老是跑不过的命令会把任务打回无数次。
// 计数落盘（跟预览记录一个套路）：重启后照样数得清，一段跑通就清掉。
function attemptsPath(taskId: string): string {
  return join(RUNS_DIR, taskId, "workflow-steps.json");
}

function readAttempts(taskId: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(attemptsPath(taskId), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function bumpAttempt(taskId: string, stepId: string): number {
  const all = readAttempts(taskId);
  const next = (all[stepId] ?? 0) + 1;
  all[stepId] = next;
  mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
  writeFileSync(attemptsPath(taskId), JSON.stringify(all));
  return next;
}

function clearAttempts(taskId: string): void {
  rmSync(attemptsPath(taskId), { force: true });
}

/**
 * 一站没过之后按线上写的那一档收尾 —— **三档都在这儿真的做出来**，这是整条线上
 * 「没过怎么办」的唯一实现处（段落里的命令/预览/合并、干活那一站没干成、以后新增的
 * 站，全走这一个入口）：
 *   stop —— 只写一行时间线，任务停在原地等人。
 *   ask  —— 把「接下来怎么办」挂成提问，答复照常送进这个任务的会话。
 *   back —— 把报错交回给干活的 agent，最多 max 轮，轮数落盘数着。
 * 无论走哪一档，这条线都**卡住了**：调用方一律不要再往下推（别派审、别送进人工关口）。
 */
export async function applyFailPolicy(
  task: TaskRow,
  step: WorkflowStep,
  reason: string | null | undefined,
  repairPrompt: (round: number) => string,
): Promise<void> {
  const label = STEP_LABELS[step.kind];
  const fail = step.fail;
  if (fail?.mode === "ask") {
    await askAboutFailure(task.id, label, reason);
    await appendTaskTimeline(task.id, `这条线卡在「${label}」这一站；线上写的是「问我一句」，已经把问题挂给你了。`);
    return;
  }
  if (fail?.mode !== "back") {
    await appendTaskTimeline(task.id, `这条线卡在「${label}」这一站，停下等你处理。`);
    return;
  }
  const round = bumpAttempt(task.id, step.id);
  if (round > Math.max(1, fail.max)) {
    await appendTaskTimeline(
      task.id,
      `「${label}」已经打回重做 ${fail.max} 次仍没过，按线上写的上限停下等你处理。`,
    );
    return;
  }
  await appendTaskTimeline(task.id, `这条线卡在「${label}」这一站，按线上写的打回给 AI 重做（第 ${round} 次）。`);
  // 打回重做要等这个任务当前这一轮退干净：这些失败策略是在结算钩子里做的，那一刻
  // 任务的单飞锁还锁着，直接 continueTask 会被静默挡回、打回就此石沉大海。
  continueWhenIdle(task.id, repairPrompt(round), { system: "wake" }, (error) => appendTaskTimeline(
    task.id,
    `想把这一站打回重做，但唤醒任务时出错（${error}），请手动续跑。`,
  ));
}

function stepFailPrompt(step: WorkflowStep, reason: string | null | undefined) {
  return (round: number) =>
    `这条线在「${STEP_LABELS[step.kind]}」这一站没过（第 ${round} 次）：\n\n`
    + `${"```"}\n${reason ?? ""}\n${"```"}\n\n`
    + "请修到它能过，然后照常确认完成。";
}

// 跑完一段并按线上写的失败策略收尾。返回 false = 这条线卡住了，调用方**不要再往下推**
// （别在一条卡住的线上派审、也别把它送进人工关口）。
export async function advanceSegment(
  task: TaskRow,
  def: WorkflowDef | null,
  fromStepId: string | null | undefined,
  opts: SegmentOptions = {},
): Promise<boolean> {
  const result = await runSegment(task, def, fromStepId, opts);
  if (result.ok) {
    clearAttempts(task.id);
    return true;
  }
  const step = result.failed!;
  await applyFailPolicy(task, step, result.reason, stepFailPrompt(step, result.reason));
  return false;
}

/**
 * 「让 AI 干活」这一站**自己**没干成（这一轮以 failed 结算）时按线上写的那一档走。
 *
 * 跟上面两个的区别是它读的不是「干完之后那一段」，而是干活那一站本身的失败分支——
 * 用户在线路图上给这一站选了「问我一句」或「打回给 AI 重做 3 轮」，就得真的问、真的
 * 重做，否则那颗标签就是画着好看的。手停（canceled）不走这儿：那是用户自己按的。
 */
export async function applyRunFailPolicy(task: TaskRow, def: WorkflowDef | null): Promise<void> {
  const step = def?.steps.find((s) => s.kind === "run");
  if (!step?.fail || step.fail.mode === "stop") return; // 停下等人 = 什么都不用做
  await applyFailPolicy(
    task,
    step,
    "这一轮以失败结算：agent 没有确认完成，或者中途异常退出了。",
    (round) => `这条线在「${STEP_LABELS.run}」这一站没干成（第 ${round} 次）：上一轮没有确认完成。\n\n`
      + "请接着把它做完，然后照常确认完成。",
  );
}

// ── 手动重开预览 ───────────────────────────────────────────────────────────
/**
 * 界面上那颗「重启预览」按钮的真身。**不属于「线在往前走」**：不动游标、不碰失败策略、
 * 不写任何账，就是把这一站的命令按原样再跑一次。
 *
 * 为什么非得有一颗手动的：预览在**任务一开跑**那一下就被收掉了（`stopPreviewOnRerun`，
 * 收在 `status.ts` 那个唯一入口），因为此刻新一版代码还没出来，留着旧页面只会让人对着
 * 上一版验新改动。而重新把它起来的机会只有一条：agent 亲口确认完成、这条线往前走到
 * 这一站。于是「用户问一句、agent 没确认完成」的轮次就成了洼地——预览被收了，线也没
 * 往前走，没有任何一条自动路径会再把它起来，用户只能盯着一个再也打不开的地址。
 */
export type PreviewRestart =
  | { ok: true; url: string | null; port: number | null }
  | { ok: false; reason: string; code: "gone" | "nostep" | "busy" | "failed" };

/** 同一个任务同时点两下：第二下必须挡回去。`startPreview` 是「先停旧的再起新的」，
 *  可第一下那份此刻还没落盘，停不到——两个 dev server 一起活着，其中一个成了没人认领
 *  的孤儿，端口还占着。 */
const restartingPreview = new Set<string>();

export async function restartTaskPreview(taskId: string, stepId?: string | null): Promise<PreviewRestart> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return { ok: false, reason: "这个任务不在了", code: "gone" };
  const steps = (taskWorkflowDef(task.workflow)?.steps ?? []).filter(
    (step): step is PreviewStep => step.kind === "preview",
  );
  // 一条线上「打开预览」**不是** singleton（只有干活和合并是），所以调用方得指名道姓说
  // 重启哪一站；只有一站时才允许省略。
  const step = stepId ? steps.find((s) => s.id === stepId) : steps.length === 1 ? steps[0] : null;
  if (!step) {
    return {
      ok: false,
      code: "nostep",
      reason: stepId
        ? "这条线上没有这一站「打开预览」（线是任务创建那一刻的快照，可能已经跟库里的不一样了）"
        : steps.length ? "这条线上不止一站「打开预览」，得说清楚重启哪一站" : "这条线上没有「打开预览」这一站",
    };
  }
  if (restartingPreview.has(taskId)) {
    return { ok: false, reason: "这个任务的预览正在起，等它起来（或起不来）再说", code: "busy" };
  }
  restartingPreview.add(taskId);
  try {
    // 直接复用线自己跑这一站的那条路：成败两种时间线都由它写，刷新后仍看得见。
    const result = await runPreview(task, step);
    if (!result.ok) return { ok: false, reason: result.reason ?? "预览没起来", code: "failed" };
    const record = readPreview(taskId);
    return { ok: true, url: record?.url ?? null, port: record?.port ?? null };
  } finally {
    restartingPreview.delete(taskId);
  }
}
