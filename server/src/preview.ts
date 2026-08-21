// 「打开预览」那一站的真身：起一个长驻服务、等它真的能连上、把地址留在时间线上。
//
// 为什么值得单独一个模块：预览进程跟 agent 进程是两回事——它**没有终点**，是我们主动
// 起、也得主动收的。所以这里的每一件事都围绕「别留孤儿」转：
//   ① 进程 detached 自成组，pid 落盘（data/runs/<task>/preview.json），server 重启后
//      照样杀得掉——内存里的 map 随进程一起没了，文件不会。
//   ② 每个任务同一时刻只有一个预览，起新的先收旧的。
//   ③ 定时清扫既收「进程早死了但记录还在」，也收 idle30 这一档。
//
// 就绪判定不做花活：**日志里出现地址** 是唯一的线索来源（dev server 都会打印一行
// http://localhost:xxxx），拿到之后再按用户选的那档确认——端口连得上 / 日志也说了
// ready / HTTP 真返回 200。等不到就是这一站失败，绝不写一句「预览已起」骗人。
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreviewLife, WorkflowStep } from "@ash/shared/workflow";
import type { FreeWorkflowPreviewEventSource } from "@ash/shared";
import { augmentedEnv, killByPid } from "./executors/spawn.js";
import { recordFreePreviewEventIfFree } from "./free-workflow-events.js";
import { RUNS_DIR } from "./paths.js";
import { userShellLaunch } from "./platform.js";
import { portConflict, pickPreviewUrl, portHint } from "./preview-log.js";
import { ready } from "./preview-probe.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export type PreviewStep = Extract<WorkflowStep, { kind: "preview" }>;

export interface PreviewRecord {
  taskId: string;
  cmd: string;
  pid: number;
  url: string | null;
  port: number | null;
  life: PreviewLife;
  startedAt: string;
  log: string;
}

/** 等它起来最多等多久 —— 前端构建冷启动一分钟很常见，再久就该报「起不来」了。 */
const READY_TIMEOUT_MS = 120_000;
const POLL_MS = 500;
/** idle30 那一档：满这么久就回收（见 PREVIEW_LIFE_LABELS 的口径说明）。 */
const IDLE_LIFE_MS = 30 * 60_000;
const SWEEP_MS = 5 * 60_000;
const UNSAFE_SCHEDULER_LOG = "[ash] scheduler started";

// 「端口撞车怎么认、日志里哪个地址才是预览本尊、认出来说什么」都在 preview-log.ts
//（纯函数，回归 test:preview-log）；「连不连得上、算不算起来了」在 preview-probe.ts
//（回归 test:preview-probe）。两个都不进 db，才测得动。

/**
 * 借一个空闲端口，以环境变量 `PORT` 传给启动命令。
 *
 * 起因是一类**必然**发生的撞车：预览跑在任务自己的 worktree 里，命令却是从项目里抄来的
 * `npm run dev`，端口写死在脚本里。而同一个项目此刻多半已经有一份在跑（开发者自己那份、
 * 或者另一个任务的预览），于是这一站不是「有时候起不来」，是**一次都起不来**。
 *
 * 认 `PORT` 的框架（Next / CRA / Nest / Express / vite 的 `--port $PORT` 写法）就此自动
 * 错开；不认的也不会更糟——那种情况下我们至少还能在日志里当场认出撞车并说人话。
 * 端口是 listen(0) 拿的，关掉再交给子进程，中间有个理论上的竞态窗口，抢不到就还是撞车
 * 那条路，不额外补偿。
 */
function freePort(): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(null));
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close(() => resolve(port));
    });
  });
}

/** 撞车时给的下一步在 preview-log.ts。 */

function recordPath(taskId: string): string {
  return join(RUNS_DIR, taskId, "preview.json");
}

export function readPreview(taskId: string): PreviewRecord | null {
  try {
    const raw = readFileSync(recordPath(taskId), "utf8");
    const value = JSON.parse(raw) as PreviewRecord;
    return typeof value?.pid === "number" ? value : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tail(path: string, max = 4000): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > max ? text.slice(-max) : text;
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type PreviewResult =
  | { ok: true; record: PreviewRecord }
  | { ok: false; reason: string };

// 起一个预览。cwd 由调用方给（任务自己的工作区），因为「在哪儿跑」是工作区的事，
// 不该在这里第二次推导。
export async function startPreview(
  taskId: string,
  step: PreviewStep,
  cwd: string,
): Promise<PreviewResult> {
  await stopPreview(taskId, null, "system");
  const dir = join(RUNS_DIR, taskId);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "preview.log");
  const lent = await freePort();
  // 日志头把注入的环境变量照实写出来，不只写命令：用户翻 preview.log 时得能一眼看出
  // 「ash 到底把什么交给了这条命令」，而不是去猜端口是谁定的。
  const banner = lent
    ? `$ PORT=${lent} BROWSER=none ASH_PREVIEW=1 ASH_PREVIEW_MODE=${step.p.mode} ${step.p.cmd}\n`
    : `$ ASH_PREVIEW=1 ASH_PREVIEW_MODE=${step.p.mode} ${step.p.cmd}\n`;
  writeFileSync(log, banner);
  const fd = openSync(log, "a");
  let pid: number;
  try {
    // 用户那条命令行交给谁跑,由 platform 收口(POSIX 是 `sh -lc`,Windows 是
    // `cmd /d /s /c`)。**detached 两边都留着**:预览是有意要活过 server 重启的
    // (pid 落盘就是为这个),而 Windows 上 detached 只意味着「不挂控制台、自成
    // 进程组」——这里 stdio 早就重定向到文件了,没控制台反而正好;杀它走
    // killByPid → taskkill /T,不依赖进程组。
    const launch = userShellLaunch(step.p.cmd);
    const child = spawn(launch.file, launch.args, {
      cwd,
      detached: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      stdio: ["ignore", fd, fd],
      // BROWSER=none：dev server 的 `--open` 会去拉一个真浏览器窗口，预览是后台起的，
      // 那扇窗户没人要。PORT 的来由见 freePort 的注释。
      env: {
        ...augmentedEnv(),
        ASH_PREVIEW: "1",
        ASH_PREVIEW_MODE: step.p.mode,
        ...(lent ? { PORT: String(lent) } : {}),
        BROWSER: "none",
      },
    });
    child.unref();
    if (!child.pid) return { ok: false, reason: "预览进程没起来" };
    pid = child.pid;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    closeSync(fd);
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const text = tail(log);
    if (text.includes(UNSAFE_SCHEDULER_LOG)) {
      killByPid(pid);
      return {
        ok: false,
        reason: "这个分支的预览后端启动了真调度器，安全协议过旧，已立即回收。请先把当前分支同步到新版预览隔离逻辑。",
      };
    }
    const found = pickPreviewUrl(text, lent);
    // 顺序要紧：撞车先判，再判进程死没死、再判起没起来。见 PORT_TAKEN_RE 那儿的 ②。
    //
    // 只有一个例外：日志里已经出现了**借给这条命令的那个端口**上的地址。那个端口是我们
    // 刚探出来的空闲端口，此刻占着它的只可能是这条命令自己起的进程，所以 ② 担心的
    // 「连到别人的服务上去」在这一支不成立。而它救的是一类常态 —— 一条 `npm run dev`
    // 并排起好几个服务（典型：concurrently 起前端 + 后端），后端撞上本机已在跑的那份，
    // 前端明明认了 $PORT 好好地起来了，却被后端那一行日志连坐判死。
    const conflict = found?.lent ? null : portConflict(text);
    if (conflict) {
      killByPid(pid);
      return { ok: false, reason: `${conflict}。\n\n${portHint(lent)}\n\n最后几行日志：\n${text.slice(-600)}` };
    }
    if (!alive(pid)) {
      // 组长（外层 shell / scripts/dev.mjs）先退出，不代表同组的 vite/tsx 也退出了。
      // pid 本身虽已不在，POSIX 的进程组 -pid 仍可存在；照样发组信号，别留下孤儿。
      killByPid(pid);
      return { ok: false, reason: `预览进程已退出。最后几行日志：\n${text.slice(-800)}` };
    }
    if (!found) continue;
    if (!(await ready(step.p.ready, found.url, found.port, text))) continue;
    const record: PreviewRecord = {
      taskId, cmd: step.p.cmd, pid, url: found.url, port: found.port, life: step.p.life, startedAt: now(), log,
    };
    writeFileSync(recordPath(taskId), JSON.stringify(record, null, 2));
    return { ok: true, record };
  }
  killByPid(pid);
  return {
    ok: false,
    reason: `等了 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒还没起来。最后几行日志：\n${tail(log).slice(-800)}`,
  };
}

// 收掉一个任务的预览。reason 非空才往时间线写一行——刷新后仍能看出「预览被收了、
// 为什么收的」，这是停止/暂停那条规矩的同一条判据。
export async function stopPreview(
  taskId: string,
  reason: string | null,
  source: FreeWorkflowPreviewEventSource = "system",
): Promise<boolean> {
  const record = readPreview(taskId);
  if (!record) return false;
  // 不先看组长是否还活着：组长死、vite 仍留在同一进程组，正是必须回收的现场。
  killByPid(record.pid);
  rmSync(recordPath(taskId), { force: true });
  if (reason) await appendTaskTimeline(taskId, `预览已回收（${reason}）：${record.url ?? record.cmd}`);
  await recordFreePreviewEventIfFree(taskId, {
    kind: "preview_closed",
    source,
    detail: record.url ?? record.cmd,
  });
  return true;
}

/**
 * 验收通过时的回收：`gate`（下一个人工关口结束时回收）和 `task`（任务结束时回收）两档
 * 一起收。
 *
 * 「任务结束时回收」得真有个结束点，否则那一档就是永不回收——一个 dev server 一直占着
 * 端口，用户还以为选了「任务结束时回收」它自己会走。这条线的终点就是验收：走到这儿
 * 这个任务不会再动了。（打回重做那条路上关口也结束了，但那时预览由「任务重新开跑」
 * 那一下收掉，见 stopPreviewOnRerun。）
 *
 * 调用点在**「点头之后」那一段开跑之前**，所以那一段又起的预览（用户特意编排的「验收完
 * 把线上环境开起来」）不受影响 —— 它是验收之后才有的东西。
 */
export async function stopPreviewAtAccept(taskId: string): Promise<void> {
  const record = readPreview(taskId);
  if (!record) return;
  if (record.life === "gate") await stopPreview(taskId, "人工关口已结束");
  else if (record.life === "task") await stopPreview(taskId, "任务已验收完成，按线上写的「任务结束时回收」收掉");
}

/** 任务又开跑了：预览指向的是上一版代码，一律收掉，免得对着旧页面验新改动。 */
export async function stopPreviewOnRerun(taskId: string): Promise<void> {
  if (readPreview(taskId)) await stopPreview(taskId, "任务重新开跑，旧预览指向的是上一版代码", "rerun");
}

// 清扫：进程早死了的记录、以及 idle30 那一档到点的。启动时先扫一遍，之后每 5 分钟一次
// —— 重启后内存 map 没了也不影响，判据全在盘上。
//
// 还兜一类：**任务本身已经没了或者被归档**。验收那条路径收得掉正常走完的，收不掉「任务
// 直接被删/归档，预览还在那儿开着」的——那种情况下没有任何一个界面还会提到它，端口却
// 一直占着。db 走动态 import：这个模块本来只碰进程和文件，不想为一条兜底把它绑到表上。
export async function sweepPreviews(): Promise<void> {
  let dirs: string[];
  try {
    dirs = readdirSync(RUNS_DIR);
  } catch {
    return;
  }
  for (const taskId of dirs) {
    if (!existsSync(recordPath(taskId))) continue;
    const record = readPreview(taskId);
    if (!record) {
      rmSync(recordPath(taskId), { force: true });
      continue;
    }
    if (!alive(record.pid)) {
      // 记录的组长死了也要向原进程组补发信号；直接删记录会永久失去唯一的 pgid 线索。
      killByPid(record.pid);
      rmSync(recordPath(taskId), { force: true });
      await appendTaskTimeline(taskId, `预览进程已自行退出：${record.url ?? record.cmd}`);
      continue;
    }
    if (record.life === "idle30" && Date.now() - Date.parse(record.startedAt) > IDLE_LIFE_MS) {
      await stopPreview(taskId, "起来满 30 分钟，按线上写的回收");
      continue;
    }
    const gone = await taskGone(taskId);
    if (gone) await stopPreview(taskId, gone);
  }
}

/** 任务已经不在了（删了/归档了）就给个理由，否则 null。查不动库时一律当「还在」。 */
async function taskGone(taskId: string): Promise<string | null> {
  try {
    const [{ db }, { tasks }, { eq }] = await Promise.all([
      import("./db/index.js"),
      import("./db/schema.js"),
      import("drizzle-orm"),
    ]);
    const row = (await db
      .select({ archived: tasks.archived })
      .from(tasks)
      .where(eq(tasks.id, taskId))).at(0);
    if (!row) return "任务已被删除";
    return row.archived ? "任务已归档" : null;
  } catch {
    return null;
  }
}

export function startPreviewSweeper(): NodeJS.Timeout {
  void sweepPreviews();
  const timer = setInterval(() => void sweepPreviews(), SWEEP_MS);
  timer.unref();
  return timer;
}
