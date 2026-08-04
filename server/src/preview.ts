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
import { connect } from "node:net";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreviewLife, PreviewReady, WorkflowStep } from "@harness/shared/workflow";
import { augmentedEnv, killByPid } from "./executors/spawn.js";
import { RUNS_DIR } from "./paths.js";
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

const READY_WORDS = /ready|listening|started|compiled|running at|server running/i;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{2,5}))?[^\s'"]*/i;

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

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function http200(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function ready(mode: PreviewReady, url: string, port: number, log: string): Promise<boolean> {
  if (mode === "http200") return http200(url);
  if (!(await canConnect(port))) return false;
  return mode === "port" || READY_WORDS.test(log);
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
  await stopPreview(taskId, null);
  const dir = join(RUNS_DIR, taskId);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "preview.log");
  writeFileSync(log, `$ ${step.p.cmd}\n`);
  const fd = openSync(log, "a");
  let pid: number;
  try {
    const child = spawn("sh", ["-lc", step.p.cmd], {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: augmentedEnv(),
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
    if (!alive(pid)) {
      return { ok: false, reason: `预览进程已退出。最后几行日志：\n${text.slice(-800)}` };
    }
    const hit = URL_RE.exec(text);
    if (!hit) continue;
    const url = hit[0];
    const port = Number(hit[1] ?? (url.startsWith("https") ? 443 : 80));
    if (!(await ready(step.p.ready, url, port, text))) continue;
    const record: PreviewRecord = {
      taskId, cmd: step.p.cmd, pid, url, port, life: step.p.life, startedAt: now(), log,
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
export async function stopPreview(taskId: string, reason: string | null): Promise<boolean> {
  const record = readPreview(taskId);
  if (!record) return false;
  if (alive(record.pid)) killByPid(record.pid);
  rmSync(recordPath(taskId), { force: true });
  if (reason) await appendTaskTimeline(taskId, `预览已回收（${reason}）：${record.url ?? record.cmd}`);
  return true;
}

/** 人工关口结束时的回收：只收 life="gate" 那一档，选了「任务结束时回收」的留着继续看。 */
export async function stopPreviewAtGate(taskId: string): Promise<void> {
  const record = readPreview(taskId);
  if (record?.life === "gate") await stopPreview(taskId, "人工关口已结束");
}

/** 任务又开跑了：预览指向的是上一版代码，一律收掉，免得对着旧页面验新改动。 */
export async function stopPreviewOnRerun(taskId: string): Promise<void> {
  if (readPreview(taskId)) await stopPreview(taskId, "任务重新开跑，旧预览指向的是上一版代码");
}

// 清扫：进程早死了的记录、以及 idle30 那一档到点的。启动时先扫一遍，之后每 5 分钟一次
// —— 重启后内存 map 没了也不影响，判据全在盘上。
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
      rmSync(recordPath(taskId), { force: true });
      await appendTaskTimeline(taskId, `预览进程已自行退出：${record.url ?? record.cmd}`);
      continue;
    }
    if (record.life === "idle30" && Date.now() - Date.parse(record.startedAt) > IDLE_LIFE_MS) {
      await stopPreview(taskId, "起来满 30 分钟，按线上写的回收");
    }
  }
}

export function startPreviewSweeper(): NodeJS.Timeout {
  void sweepPreviews();
  const timer = setInterval(() => void sweepPreviews(), SWEEP_MS);
  timer.unref();
  return timer;
}
