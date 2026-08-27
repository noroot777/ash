import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { statSync, openSync, closeSync, unlinkSync, createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { IS_WINDOWS, isPidAlive, killOne, killTree, listProcesses } from "../platform.js";
import { isMultiUserSync } from "../auth/multi-flag.js";
import { augmentedEnv, resolveBin, resolveLaunch } from "./bin-resolve.js";

// PATH 补全与命令名解析住在 bin-resolve.ts(Windows 的 PATHEXT / `.cmd` 垫片够写
// 一整个文件)。这里转出去,是因为已有近二十处从 spawn.ts import 它们。
export { augmentedEnv, resolveBin, resolveLaunch };
export type { LaunchPlan } from "./bin-resolve.js";

// ── 多人模式:server 进程自己的出站凭证不透传给 agent(docs/multi-user-plan.md §八)──
// 宿主机上跑着的 ash 很可能自带 ANTHROPIC_API_KEY 之类;不删的话,一个「没挂供应商」
// 的执行器照样能花到宿主的钱,「抹去宿主订阅」整节就是空的。
//
// 顺序很关键:这一层是**基座**,供应商注入(executor.env() 的 relay)与回合身份
// (opts.env)都拼在它后面,所以挂了供应商的执行器仍然拿得到自己的 key —— 清掉的
// 只有「server 环境里带进来的那份」。
//
// 名单只含「能直接花到宿主模型额度」的变量。仓库访问凭证(GH_TOKEN 等)刻意不清:
// agent 用 `gh` 查 issue 是正常工作流,砍掉是平白弄坏功能,而项目 git 凭证本来就走
// project_git_credentials 单独注入。
const SCRUBBED_OUTBOUND_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_BASE_URL_PATH",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY", "DASHSCOPE_API_KEY", "XAI_API_KEY",
] as const;

/**
 * 起 agent CLI 用的基座环境。自用模式下与 `augmentedEnv()` 逐字节相同 ——
 * 那条路的行为必须与本功能上线前一致(§二)。
 */
export function agentBaseEnv(): NodeJS.ProcessEnv {
  const env = augmentedEnv();
  if (!isMultiUserSync()) return env;
  for (const key of SCRUBBED_OUTBOUND_ENV) delete env[key];
  return env;
}

// shell-quote a single argument for a copy-pasteable command line
export const shq = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);


const isDir = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

// A stand-in child that fails immediately with a precise, human-readable reason.
// Used when a pre-flight check already rules out a successful spawn, so the
// stream parsers surface the real cause instead of a generic `spawn ENOENT`.
//
// The 'error' MUST wait for a listener. The parsers (parseClaudeStream /
// parseCodexStream) are lazy async generators — their `child.on("error")` only
// runs once the run loop starts iterating, several awaits later. Emitting before
// that means an 'error' with no listener, which EventEmitter escalates to an
// uncaughtException; the server's runtime handler swallows it and the run loop
// then waits forever for a `done` that never comes — the task is stuck 'running',
// unstoppable, until a restart (2026-07-28: reproduced by replying to a task whose
// worktree had been deleted). So we hold the error until someone subscribes.
export function failedChild(message: string): ChildProcess {
  const child: any = new EventEmitter();
  child.stdout = Readable.from([]);
  child.stderr = Readable.from([]);
  child.stdin = { write() {}, end() {} };
  const err: any = new Error(message);
  err.precise = true; // tells spawnErrorMessage to use this message verbatim
  let sent = false;
  child.on("newListener", (event: string) => {
    if (event !== "error" || sent) return;
    sent = true;
    // newListener fires BEFORE the listener is registered — defer one microtask
    // so the emit lands on a subscriber that actually exists.
    queueMicrotask(() => child.emit("error", err));
  });
  return child as ChildProcess;
}

/**
 * 真库流程测试会把 RUNS_DIR 指到临时目录。这种进程默认绝不起真 CLI：测试只想
 * 验证游标/状态却误走生产副作用，就是 2026-08-07 一次泄漏 19 个 Claude 回合的根因。
 * 少数确实要验证进程管理的测试必须显式给 ASH_ALLOW_REAL_AGENT=1；不再依赖每个调用点
 * 记得注入 no-op。
 */
export function guardAgentSpawn(bin: string): ChildProcess | null {
  if (!process.env.ASH_RUNS_DIR || process.env.ASH_ALLOW_REAL_AGENT === "1") return null;
  return failedChild(
    `测试隔离环境禁止启动真执行器 ${bin}；`
    + "这个测试若就是要验证进程管理，显式设 ASH_ALLOW_REAL_AGENT=1",
  );
}

// Turn a spawn error into a truthful message. `precise` errors (from pre-flight)
// pass through; a raw ENOENT here is the rare in-flight case (binary vanished).
export function spawnErrorMessage(bin: string, err: NodeJS.ErrnoException): string {
  if ((err as any).precise) return err.message;
  if (err.code === "ENOENT") return `找不到 ${bin} 命令(PATH 未包含其所在目录)`;
  return `启动 ${bin} 失败：${err.message}`;
}

// ── 逃逸进程追踪(继承 fd,systemd 同款思路)──────────────────────────────
// 进程组击杀(kill -pid)只覆盖「还留在 agent 进程组里」的后代。但 codex/claude
// 的 exec 层会给命令另开进程组,命令再 nohup/& 一放、父进程一退,整条流水线就
// 变成 ppid=1、自成一组的孤儿 —— 组杀和树遍历都追不到(真实案例:暂停分组后
// TTS 流水线 run_youtube_pipeline.sh 一家五口继续后台跑)。
// 解法:spawn 时塞一个指向「本次运行专属追踪文件」的继承 fd(stdio[3])。所有
// 后代都会带着这个 fd(bash/nohup 不关高位 fd),无论怎么改组、被谁收养;停止
// 时 `lsof -t <file>` 反查持有者,再从每个持有者向下走 ppid 树补上被 python
// close_fds 掐断继承的孙进程。局限:双 fork 且中间
// 层已死、又恰好隔着一层 close_fds 的深孤儿仍可能漏(实践中极少)。
//
// **Windows 上这一层仍然比 POSIX 弱,但正常收尾那条路可以补。** 两个差异:
//  · 继承 fd 反查没有零依赖等价物(handle.exe 要单独装、要管理员),所以
//    Windows 上根本不开追踪文件,只剩 ppid 树遍历这一半。
//  · Windows 不做 reparent,孤儿的 ParentProcessId 保留着已死父进程的号 ——
//    CLI 活着时从它往下走得到;CLI 已死以后如果把它的 pid 一起忘了,就再也找不到入口。
//    RunHandle 因此在事件流收尾时调用 cleanupAfterRun:ChildProcess 还握在手里,哪怕根
//    进程刚退出,仍能拿它的旧 pid 走这棵保留下来的 ppid 树。server 重启后句柄丢了、
//    或 pid 已经被复用的深孤儿仍然无解,所以 Windows 依旧是尽力而为,不是等价保证。
const trackFiles = new WeakMap<ChildProcess, string>();

async function killEscapees(child: ChildProcess, sig: NodeJS.Signals): Promise<number[]> {
  const targets = new Set<number>();
  const trackPath = trackFiles.get(child);
  if (trackPath) {
    const out = await new Promise<string>((res) =>
      execFile("lsof", ["-t", trackPath], (_e, stdout) => res(stdout || "")),
    );
    for (const line of out.split("\n")) {
      const p = Number(line.trim());
      if (p) targets.add(p);
    }
  }
  // 每个 fd 持有者 + CLI 本体的存活后代(ppid 树)一并纳入
  const roots = [...targets];
  if (child.pid) roots.push(child.pid);
  if (roots.length) {
    const kids = new Map<number, number[]>();
    for (const row of await listProcesses()) {
      if (!row.ppid) continue;
      if (!kids.has(row.ppid)) kids.set(row.ppid, []);
      kids.get(row.ppid)!.push(row.pid);
    }
    const stack = [...roots];
    while (stack.length) {
      const p = stack.pop()!;
      for (const k of kids.get(p) ?? []) {
        if (!targets.has(k)) {
          targets.add(k);
          stack.push(k);
        }
      }
    }
  }
  targets.delete(process.pid);
  if (child.pid) targets.delete(child.pid); // CLI 本体走进程组信号,不重复补刀
  for (const pid of targets) {
    if (pid <= 1) continue;
    killOne(pid, sig);
  }
  return [...targets].filter((pid) => pid > 1);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPidsGone(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isPidAlive);
  while (alive.length && Date.now() < deadline) {
    await wait(50);
    alive = pids.filter(isPidAlive);
  }
  return alive;
}

/**
 * 一次性 agent 的事件流已经收完:CLI 本体按理已经退出,但它用 `&` / `start /b`
 * 甩出去的后台后代可能还活着。此刻 ChildProcess 还在手里,是 Windows 上利用已死
 * ParentProcessId 找回它们的最后窗口;再往后只剩一个 worktree 路径,已经无法可靠
 * 区分「agent 遗留」和「用户自己开的终端」。
 *
 * 先给 SIGTERM/Windows taskkill,最多等 2 秒;残存者再补 SIGKILL。正常没有逃逸者时
 * 只做一次进程表快照,不会给每个回合平白加等待。
 */
export async function cleanupAfterRun(child: ChildProcess): Promise<void> {
  const targets = new Set(await killEscapees(child, "SIGTERM"));
  if (child.pid && isPidAlive(child.pid)) {
    targets.add(child.pid);
    killTree(child.pid, "SIGTERM");
  }
  if (!targets.size) return;

  const survivors = await waitForPidsGone([...targets], 2000);
  if (!survivors.length) return;
  if (child.pid && survivors.includes(child.pid)) killTree(child.pid, "SIGKILL");
  for (const pid of survivors) {
    if (pid !== child.pid) killOne(pid, "SIGKILL");
  }
  await waitForPidsGone(survivors, 2000);
}

// Windows 上一律不 detached。三点理由:
//  · 白拿不到好处 —— 那边的组杀是 `taskkill /T`,按进程表的父子关系走,不需要进程
//    组;POSIX 上 detached 的唯一用途(让 kill(-pid) 打得到整棵树)在这里不存在。
//  · 有实打实的坏处 —— libuv 把 detached 翻译成
//    `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`:前者让子进程**完全没有控制台**
//    (个别 CLI 会据此改变输出形态),后者让它脱离本控制台的 Ctrl-C 组。
//  · 方向也不对 —— Windows 上「活得过 server 重启」这一档本来就砍掉了(见
//    detached.ts 的 spawnForRun),再让 agent 脱离父进程只会攒出没人管的孤儿。
// 额外收益:dev 终端 Ctrl-C 会连带把 agent 带走,正好补上下面那条「代价」的缺口。
const DETACH = !IS_WINDOWS;

// Spawn an agent CLI locally, feeding the prompt via stdin (avoids escaping
// large prompts in argv).
// detached: true 让 agent 自成进程组，killChild 才能对整棵进程树发 kill(-pid)。
// 不这样的话 stop 只杀 CLI 本身，它拉起的孙进程(ffmpeg、打包器…)继承着我们的
// stdout/stderr 管道不死，流永远不 EOF，run loop 收不到 close → 任务永远停不掉
// (真实案例：codex CLI 重装期间 resume，任务卡 running 且 stop 无效)。
// 代价：dev 前台 Ctrl-C 不再连带杀掉 agent(生产是 nohup 跑法，不受影响)。
// Windows 上反过来 —— 一律不 detached，理由见 DETACH。
// extraEnv: per-executor 的环境变量(供应商的 base_url / key、覆盖 CLI 自己的配置)。
// **值为 `undefined` = 把这个变量从子进程里删掉**:ash 自己环境里带着的同名变量,
// 不删就会盖掉「这里留空 = 跟随 CLI」(Node 会跳过值为 undefined 的项)。
// keepStdin: 常驻会话(§Team 的调度台)用 —— 写完首条消息不关 stdin,管道留给
// 调用方继续注入后续回合(见 executors/claude.ts 的 openResident)。
export function spawnAgent(
  cwd: string,
  bin: string,
  args: string[],
  prompt: string,
  extraEnv?: Record<string, string | undefined>,
  opts?: { keepStdin?: boolean; teeOut?: string },
): ChildProcess {
  const blocked = guardAgentSpawn(bin);
  if (blocked) return blocked;
  // Local pre-flight: distinguish "cwd missing" from "binary missing" so the
  // error never lies (both raise ENOENT from spawn, indistinguishable by code).
  if (!isDir(cwd)) return failedChild(`工作目录不存在：${cwd}`);
  let plan;
  try {
    plan = resolveLaunch(bin, args);
  } catch (e) {
    // Windows 上必须过 cmd.exe、而某个参数带换行 —— 转义不了,如实报出来。
    return failedChild(e instanceof Error ? e.message : String(e));
  }
  if (!plan) return failedChild(`找不到 ${bin} 命令(不在 PATH，也不在常见目录)`);
  const track = openTrackFd();
  const stdio: Array<"pipe" | number> = track.fd === null ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", track.fd];
  const child = spawn(plan.file, plan.args, {
    cwd,
    stdio,
    env: { ...agentBaseEnv(), ...extraEnv },
    detached: DETACH,
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
  registerTrackFd(child, track);
  teeStdout(child, opts?.teeOut);
  child.stdin?.write(prompt);
  if (!opts?.keepStdin) child.stdin?.end();
  return child;
}

// 管道路径上的「输出同时落盘」。
//
// detached.ts 那条路(输出直接写文件)顺带满足了一个**跟活得过重启无关**的需求:
// 回合结算前 `replayUndeliveredMcpCalls`(mcp-handoff.ts)要回头扫一遍 agent 的
// 输出,把没送达的 `complete_task` 补录进库。走匿名管道时那个文件根本不存在,补捞
// 静默变成空操作 —— 一个干完活的任务会被记成 failed,且失败得无声无息。
//
// Windows 上「活得过重启」这一档整个砍掉了(spawnForRun),所以那个 out 文件得由
// 这里补上。
//
// 实现上不用 `stdout.pipe(ws)`:pipe 会立刻把原流切进 flowing 模式,而各 executor
// 的解析器是**之后**才挂 'data' 的,中间这几个 tick 冒出来的字节就永久丢了。改成
// 接管原流、转发给一个 PassThrough 顶替 child.stdout,顺便把背压一起转发。
// 开不出文件就当没这回事(best-effort):补捞退回原来的空操作,不该把这轮跑挂掉。
function teeStdout(child: ChildProcess, file: string | undefined): void {
  const src = child.stdout;
  if (!file || !src) return;
  let sink;
  try {
    mkdirSync(dirname(file), { recursive: true });
    sink = createWriteStream(file, { flags: "a" });
  } catch {
    return;
  }
  sink.on("error", () => {}); // 盘满/被删:同上,降级不报错
  const relay = new PassThrough();
  src.on("data", (chunk: Buffer) => {
    sink.write(chunk);
    if (!relay.write(chunk)) src.pause();
  });
  relay.on("drain", () => src.resume());
  src.on("end", () => {
    relay.end();
    sink.end();
  });
  src.on("error", (e) => {
    relay.destroy(e);
    sink.end();
  });
  Object.defineProperty(child, "stdout", { value: relay, configurable: true, writable: true });
}

// 追踪 fd(见 killEscapees):打开一个本次运行专属文件,把 fd 作为 stdio[3] 传给
// 子进程 —— 后代无论怎么换组/被收养都带着它,stop 时可按文件名 lsof 反查。
// best-effort:开不出来就照旧 spawn,只是丢掉逃逸追踪能力。
// 抽成一对函数是为了让 detached.ts 那条路(输出走文件)复用同一套逃逸追踪,
// 而不是各写一份 —— 少一份就意味着那条路上的孤儿没人管。
// Windows 上直接返回空:反查手段不存在(见 killEscapees 顶部),开了也没人用,
// 还会平白留下一堆临时文件。
export function openTrackFd(): { fd: number | null; path: string | null } {
  if (IS_WINDOWS) return { fd: null, path: null };
  try {
    const path = join(tmpdir(), `ash-track-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    return { fd: openSync(path, "w"), path };
  } catch {
    return { fd: null, path: null };
  }
}

export function registerTrackFd(child: ChildProcess, track: { fd: number | null; path: string | null }): void {
  if (track.fd === null || !track.path) return;
  closeSync(track.fd); // 子进程已持有副本,父进程这份立即关掉
  trackFiles.set(child, track.path);
  const cleanupPath = track.path;
  child.on("close", () => {
    // 延迟删除:killChild 的补刀清扫(SIGTERM 后 2s)要靠文件名 lsof;
    // unlink 早了就查不到了。60s 后基本尘埃落定。
    const t = setTimeout(() => {
      try {
        unlinkSync(cleanupPath);
      } catch {
        /* already gone */
      }
    }, 60_000);
    (t as { unref?: () => void }).unref?.();
  });
}

// detached.ts 对外返回的是合成 ChildProcess；把真进程上的追踪文件映射复制过去，
// cleanupAfterRun 才能在根进程退出后继续按继承 fd 找回已经 reparent 的后代。
export function shareTrackFdRegistration(source: ChildProcess, target: ChildProcess): void {
  const path = trackFiles.get(source);
  if (path) trackFiles.set(target, path);
}

// Wrap a resume command so it is copy-paste runnable (§13).
// envPrefix(供应商的 `KEY=值 `,token 已换成占位符)拼在 CLI 前面 —— 不带它,
// 粘到终端的命令会走 CLI 自己的官方账号,跟这次运行不是同一个来源。
export function resumeFor(cwd: string, inner: string, envPrefix = ""): string {
  return `cd ${shq(cwd)} && ${envPrefix}${inner}`;
}

// 命令行里出现的密钥兜底打码。executor 走 env / env_key 注入,正常不该有 key 落到
// commandLine(它会存进 sessions.command_line 并在 UI 展示);这层是防以后有人手写
// extraArgs 时把 key 带进来。
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(sk|sk-ant|sk-proj|ghp|gho)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._-]{8,}/gi, "$1 ***")
    .replace(/((?:token|api[_-]?key|auth[_-]?token|secret)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi, "$1***");
}

// Terminate a running agent subprocess (manual stop). SIGTERM first so the CLI
// can wind down; a short fallback SIGKILL guarantees the process — and thus our
// output stream — actually ends even if the CLI ignores SIGTERM. Safe to call on
// the pre-flight failedChild stub (it has no real pid) and after exit.
// 三层击杀:①信号发给整个进程组(-pid,spawn 时 detached 使 child 为组长);
// ②killEscapees 按继承 fd 反查逃出进程组的后代(nohup 孤儿等)一并处理;
// ③2s 后对残存者(含期间新逃逸的)统一补 SIGKILL。
//
// **Windows 上第①层换成 `taskkill /T /F`,而且没有「优雅」这一档。** Windows 只有
// GUI 窗口收得到 WM_CLOSE,控制台程序不吃;Ctrl+C 只能发给同一个控制台组,而 agent
// 是 DETACHED_PROCESS 起的(没有控制台)。所以第一发就是强杀,CLI 没有落盘/收尾的
// 机会 —— 这是平台限制,如实记在这里。第②层退化成纯 ppid 树遍历(见 killEscapees),
// 第③层仍在(确认死透)。
export function killChild(child: ChildProcess): void {
  if (typeof child.kill !== "function") return;
  const signal = (sig: NodeJS.Signals) => {
    if (child.pid) {
      killTree(child.pid, sig);
      return;
    }
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  signal("SIGTERM");
  void killEscapees(child, "SIGTERM").catch(() => {});
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal("SIGKILL");
    // 无论 CLI 死没死透,逃逸者一律补 SIGKILL —— stop 的语义就是全家结束。
    void killEscapees(child, "SIGKILL").catch(() => {});
  }, 2000);
  // Don't keep the event loop alive just for the fallback timer.
  (t as { unref?: () => void }).unref?.();
}

// 只有 pid 时的击杀(重启后接管的 agent 走这条 —— ChildProcess 句柄随上一个
// server 进程一起没了,追踪 fd 的 WeakMap 也没了)。
// 只剩三层里的第①③层:进程组信号 + 2s 后补 SIGKILL。第②层(继承 fd 反查逃逸者)
// 做不到,因为那份映射是内存态的。代价:重启前就已经逃出进程组的孤儿杀不到 ——
// 如实记在这里,别让以后的人以为这条路和 killChild 等价。
export function killByPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  killTree(pid, "SIGTERM");
  const t = setTimeout(() => {
    if (isPidAlive(pid)) killTree(pid, "SIGKILL");
  }, 2000);
  (t as { unref?: () => void }).unref?.();
}

// exit(进程亡)之后 close(所有 stdio 关闭)通常毫秒级跟到;但当管道写端被
// 残留的孙进程握着、或 CLI 死得不干净时,close 永远不来 —— 事件流不结束,
// run loop 挂死,任务卡 running 且 stop 无效。这里在 exit 后限时等待 flush,
// 超时仍没等到 close 就调用 finish 强制终结事件流(双保险的第二层;第一层是
// killChild 的进程组击杀)。
export function forceFinishOnExit(
  child: ChildProcess,
  isFinished: () => boolean,
  finish: (exitStatus: number) => void,
  graceMs = 5000,
): void {
  child.on("exit", (code, sig) => {
    const t = setTimeout(() => {
      if (!isFinished()) finish(code ?? (sig ? 1 : 0));
    }, graceMs);
    (t as { unref?: () => void }).unref?.();
  });
}

// The per-agent *interactive* resume command (what a human pastes to see the
// session and continue) — 模板本体现在登记在目录里各 spec 的
// `exec.session.interactive`,这里只留 claude/codex 两个自带专用执行器的引用,
// 供 claude.ts / codex.ts / catalog 复用同一份字符串。展示用的那条命令由
// `executors/resume.ts` 的 resumeCommandFor 按目录重算(还要过一道「sessionId
// 是不是 CLI 真认得的 id」的判定,见 generic.ts 的 hasTrustedSessionId)。
// (The ash's own headless resume is built separately inside each executor's run().)
export const resumeInner: Record<string, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
};
