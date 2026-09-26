// 「这条启动脚本到底起不起得来」——**真跑一遍**。
//
// 跟 preview-start.ts 的正式预览是同一套判据（同样借空闲端口、同样注同一组环境变量、
// 同样用 preview-probe 探活），区别只在于它**不属于任何任务**：不写预览记录、不进时间线、
// 不开反代，探到结果当场把进程杀干净。所以它能被用在「项目设置里还没保存的那条脚本」上。
//
// 谁要它：AI 协助（preview-assist.ts）。模型说「我验证过了」不算数 —— 让它算数的代价是
// 用户保存完、下次点开预览才发现是空的。这个文件就是那句「真的起来过」的全部依据。
//
// 一条纪律：**不替用户装依赖、不在他的仓库里留东西**。这里跑的 cwd 是用户的项目目录本身
// （不是任务 worktree），正式预览那套 `prepareNodeDeps` 会在工作区里挂 node_modules 软链，
// 放到这儿就成了「ash 往人家仓库里写东西」——那条线用户划得很清楚（见 preview-deps.ts
// 顶部）。缺依赖就如实报回去，由人决定装不装。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewMode } from "@ash/shared/preview";
import { boundListeningPort, currentListeningPort } from "./listening-port.js";
import { isPidAlive, isProcessGroupAlive, killTree } from "./platform.js";
import { afterLoginShell, previewBaseEnv, previewScriptLaunch } from "./preview-env.js";
import { missingDepsHint, missingNodeBin, pickPreviewUrl, portConflict, portHint, stripAnsi } from "./preview-log.js";
import { nodeDepsAdvice } from "./preview-deps.js";
import { canConnect, ready } from "./preview-probe.js";
import { freePorts, PORT_POOL, portEnv } from "./preview-ports.js";

export interface PreviewTrialOutcome {
  ok: boolean;
  url: string | null;
  port: number | null;
  /** 没起来的原因，一句话。起来了就是 null。 */
  reason: string | null;
  /** 试跑日志（尾巴，已去掉 ANSI）。 */
  log: string;
}

export interface PreviewTrialOptions {
  cwd: string;
  script: string;
  mode: PreviewMode;
  timeoutMs: number;
  /** 返回 true 就立刻收摊（用户点了取消）。 */
  canceled?: () => boolean;
  /** 日志有新内容时回调，给界面流进度用。 */
  onLog?: (log: string) => void;
}

/** 日志留多少。够看清报错栈，又不会把一个刷屏的 webpack 塞满内存。 */
const LOG_LIMIT = 40_000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * 此刻正在试跑的那些进程组。
 *
 * 必须有这一份：试跑的子进程是 detached 起的（要整组杀才带得走 `sh -lc` 的孙子），而
 * 正式预览那套「重启后照记录收尾」的机制（preview-store 的记录文件 + reconcile）它一概
 * 没有——试跑不属于任何任务，不写记录。ash 在试跑中途被关掉的话，那个 dev server 就成了
 * 谁也不认识的孤儿：占着端口、吃着 CPU，界面上一点痕迹都没有。所以 ash 自己退出前把它们
 * 带走，这是唯一的兜底。
 */
const liveTrials = new Set<number>();
let hooked = false;

function hookProcessExit(): void {
  if (hooked) return;
  hooked = true;
  // exit 回调里只能做同步的事，killTree 在 POSIX 上正是同步的 process.kill(-pid)。
  process.on("exit", () => { for (const pid of liveTrials) killTree(pid, "SIGKILL"); });
}

export async function trialPreviewScript(options: PreviewTrialOptions): Promise<PreviewTrialOutcome> {
  const { cwd, script, mode, timeoutMs } = options;
  const canceled = options.canceled ?? (() => false);
  const ports = await freePorts(PORT_POOL);
  const lent = ports[0] ?? null;
  const env = portEnv(ports);
  env.ASH_PREVIEW_BASE = "/";
  // 「只起前端」那一档的脚本要把 /api 打回这台 ash，正式预览给的就是这个值（不猜，绑上了
  // 才有）。试跑不给它，那一档的脚本会在启动时就连不上后端，判出来的失败跟真实预览对不上。
  const hostApiUrl = boundListeningPort() === null ? null : `http://127.0.0.1:${boundListeningPort()}`;
  if (hostApiUrl) env.ASH_HOST_API = hostApiUrl;
  const banner = `$ ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")} BROWSER=none ASH_PREVIEW=1 ASH_PREVIEW_MODE=${mode} ${script}\n`;
  // Windows 的多行脚本要落成 .cmd 才跑得起来（previewScriptLaunch），那个文件写在 ash 自己
  // 的临时目录里 —— 写进用户仓库就是往人家的 git status 里塞垃圾。
  const dir = mkdtempSync(join(tmpdir(), "ash-preview-trial-"));
  let text = banner;
  let outcome: PreviewTrialOutcome | null = null;
  let pid = 0;
  let exited = false;
  let spawnError: string | null = null;
  try {
    const launch = previewScriptLaunch(afterLoginShell(script, hostApiUrl), dir, "trial");
    const child = spawn(launch.file, launch.args, {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...previewBaseEnv(cwd), ...env, ASH_PREVIEW: "1", ASH_PREVIEW_MODE: mode, BROWSER: "none" },
    });
    const absorb = (chunk: Buffer | string) => {
      text = (text + stripAnsi(String(chunk))).slice(-LOG_LIMIT);
      options.onLog?.(text);
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    child.on("error", (error) => { spawnError = error.message; });
    child.on("exit", () => { exited = true; });
    pid = child.pid ?? 0;
    if (pid) { hookProcessExit(); liveTrials.add(pid); }
    const deadline = Date.now() + timeoutMs;
    // ash 自己绑着的端口永远不是这条脚本本尊（它就在上面跑着）。日志里出现它只可能是脚本
    // 在说「我的 /api 打到 ash 那边」——认了它，就会把 ash 自己判成「脚本起来了」。
    const self = currentListeningPort();
    const others = [...ports.slice(1), ...(self === null ? [] : [self])];
    while (Date.now() < deadline) {
      await sleep(400);
      if (canceled()) {
        outcome = { ok: false, url: null, port: null, reason: "已取消", log: text };
        break;
      }
      if (spawnError || (!pid) || exited) {
        const deps = missingDepsHint(text, nodeDepsAdvice(cwd, script, missingNodeBin(text)));
        outcome = {
          ok: false, url: null, port: null, log: text,
          reason: `进程已退出${spawnError ? `：${spawnError}` : ""}。${deps ?? ""}`.trim(),
        };
        break;
      }
      const found = pickPreviewUrl(text, lent, others)
        ?? (lent !== null && await canConnect(lent) ? { url: `http://localhost:${lent}/`, port: lent, lent: true } : null);
      const conflict = found?.lent ? null : portConflict(text);
      if (conflict) {
        outcome = { ok: false, url: null, port: null, reason: `${conflict}。${portHint(lent)}`, log: text };
        break;
      }
      // ready 档用 "port"：用户填过脚本的项目，正式预览走的也正是这一档
      // （workflow-steps.ts 把 ready 改成 "port"），两边判据得一样。
      if (!found || !(await ready("port", found.url, found.port, text))) continue;
      outcome = { ok: true, url: found.url, port: found.port, reason: null, log: text };
      break;
    }
    outcome ??= {
      ok: false, url: null, port: null, log: text,
      reason: `等了 ${Math.round(timeoutMs / 1000)} 秒，${lent === null ? "" : `借出去的端口 ${lent} 上`}没有服务响应`,
    };
  } catch (error) {
    outcome = { ok: false, url: null, port: null, reason: error instanceof Error ? error.message : String(error), log: text };
  } finally {
    await stopTrial(pid);
    liveTrials.delete(pid);
    rmSync(dir, { recursive: true, force: true });
  }
  return outcome;
}

/**
 * 把这一趟起的东西全杀掉。**不能只杀直接子进程**：脚本多半是 `sh -lc` 起的，真正在听端口的
 * 是它的孙子（npm → vite）。POSIX 上 detached 给了它们独立进程组，`killTree` 打的是整组。
 *
 * 杀不干净的代价很具体：这台机器上留着一个谁也管不到的 dev server，占着端口、吃着 CPU，
 * 而界面上连它存在过的痕迹都没有（试跑不写预览记录）。所以 TERM 之后还要确认，不退就 KILL。
 *
 * 确认要问**整组**还活着没有，不能只问组长（第 3 轮审查复现）：`npm run dev &` 这种写法里
 * 组长（那层 shell）先退、后台那个后代还赖在组里，而它要是忽略 TERM——`process.on('SIGTERM')`
 * 里什么都不做的脚本满地都是——只问组长就立刻得到「已经没了」，KILL 那一步根本不会执行，
 * 于是它一直活着。判据跟正式预览收尾那套一致（preview-process-stop.ts 的 `alive`）。
 */
async function stopTrial(pid: number): Promise<void> {
  if (!pid) return;
  const alive = () => isPidAlive(pid) || isProcessGroupAlive(pid);
  killTree(pid, "SIGTERM");
  for (let i = 0; i < 12 && alive(); i += 1) await sleep(250);
  if (alive()) killTree(pid, "SIGKILL");
}
