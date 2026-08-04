// 线上那些「当场就能做完」的站：跑一条命令、打开预览。
//
// 它们夹在几个会停下来等的站中间（干活等 agent、自动验证等审查任务、等我点头等人），
// 所以是**成段**跑的——段落切分在 shared 的 stepsAfterAnchor()，这里只管把一段跑完。
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
import { stepsAfterAnchor, type AnchorKind } from "@harness/shared/workflow-policy";
import type { WorkflowDef, WorkflowStep } from "@harness/shared/workflow";
import { STEP_LABELS } from "@harness/shared/workflow";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { augmentedEnv } from "./executors/spawn.js";
import { RUNS_DIR } from "./paths.js";
import { startPreview, type PreviewStep } from "./preview.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { taskWorkspace } from "./task-workspace.js";

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
// （acceptTask 带着仓库锁、冲突处理、「绝不 -D」的规矩）。区别只在谁按下的：线上没写
// 「等我点头」时，走到这一站就是这条线自己按的。
// 怎么合、清到什么程度全读这一站的参数——acceptTask 里的 acceptPlan() 读的就是它。
async function runAccept(task: TaskRow, step: WorkflowStep): Promise<SegmentResult> {
  await appendTaskTimeline(task.id, "这条线上没写「等我点头」，走到「合并并清理」就自己合了。");
  const { acceptTask } = await import("./task-accept.js");
  const result = await acceptTask(task.id);
  if (result.accepted) return { ok: true };
  return { ok: false, failed: step, reason: result.error };
}

// 把紧跟某个锚点之后的那一段跑完。任何一站砸了就地停下——后面的站多半依赖前面的产物
// （典型：先跑 build 再起预览），继续往下跑只会把一个错误变成两个。
export async function runSegment(
  task: TaskRow,
  def: WorkflowDef | null,
  anchor: AnchorKind,
  opts: SegmentOptions = {},
): Promise<SegmentResult> {
  for (const step of stepsAfterAnchor(def, anchor)) {
    const result = step.kind === "command"
      ? await runCommand(task, step)
      : step.kind === "preview"
        ? await runPreview(task, step)
        : step.kind === "accept" && !opts.skipAccept
          ? await runAccept(task, step)
          : { ok: true } as SegmentResult;
    if (!result.ok) {
      await appendTaskTimeline(
        task.id,
        `这条线卡在「${STEP_LABELS[step.kind]}」这一站${step.fail?.mode === "back" ? "，交回去重做" : "，停下等你处理"}。`,
      );
      return result;
    }
  }
  return { ok: true };
}

// ── 失败策略与推进 ─────────────────────────────────────────────────────────
// 「回到某一步重做」得有个数着的地方，否则一条老是跑不过的命令会把任务打回无数次。
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

// 跑完一段并按线上写的失败策略收尾。返回 false = 这条线卡住了，调用方**不要再往下推**
// （别在一条卡住的线上派审、也别把它送进人工关口）。
async function advance(task: TaskRow, def: WorkflowDef | null, anchor: AnchorKind): Promise<boolean> {
  const result = await runSegment(task, def, anchor);
  if (result.ok) {
    clearAttempts(task.id);
    return true;
  }
  const step = result.failed!;
  const fail = step.fail;
  if (fail?.mode !== "back") return false;
  const round = bumpAttempt(task.id, step.id);
  if (round > Math.max(1, fail.max)) {
    await appendTaskTimeline(
      task.id,
      `「${STEP_LABELS[step.kind]}」已经交回去重做 ${fail.max} 次仍没过，按线上写的上限停下等你处理。`,
    );
    return false;
  }
  const { continueTask } = await import("./orchestrator.js");
  await continueTask(
    task.id,
    `这条线在「${STEP_LABELS[step.kind]}」这一站没过（第 ${round} 次）：\n\n`
    + `${"```"}\n${result.reason ?? ""}\n${"```"}\n\n`
    + "请修到它能过，然后照常确认完成。",
    { system: "wake" },
  ).catch((error) => appendTaskTimeline(
    task.id,
    `想把这一站交回去重做，但唤醒任务时出错（${error instanceof Error ? error.message : String(error)}），请手动续跑。`,
  ));
  return false;
}

/** 干完之后那一段（「让 AI 干活」到下一个会停下来等的站之间）。 */
export function advanceAfterRun(task: TaskRow, def: WorkflowDef | null): Promise<boolean> {
  return advance(task, def, "run");
}

/** 验完之后那一段（「自动验证」到「等我点头」之间）—— 典型用途就是在这儿把预览打开。 */
export function advanceAfterVerify(task: TaskRow, def: WorkflowDef | null): Promise<boolean> {
  return advance(task, def, "verify");
}
