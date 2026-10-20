import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { statSync, createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { IS_WINDOWS } from "../platform.js";
import { isHostCliIsolatedSync } from "../auth/multi-flag.js";
import { augmentedEnv, resolveBin, resolveLaunch, withoutForeignNodeBins } from "./bin-resolve.js";
import { openTrackFd, registerTrackFd } from "./kill.js";

// PATH 补全与命令名解析住在 bin-resolve.ts(Windows 的 PATHEXT / `.cmd` 垫片够写
// 一整个文件)。这里转出去,是因为已有近二十处从 spawn.ts import 它们。
export { augmentedEnv, resolveBin, resolveLaunch, withoutForeignNodeBins };
export type { LaunchPlan } from "./bin-resolve.js";

// 三层击杀、逃逸后代追踪、进程身份与追踪证据的租约住在 kill.ts(同样是因为两摊各自都在
// 往 700 行上限靠)。二十来个使用方照旧从 `spawn.js` import,所以这里原样转出去。
export {
  childStillOurs, cleanupAfterRun, killByPid, killChild, markAdoptedChild, openTrackFd,
  pidRunStillAlive, registerTrackFd, releaseTrackEvidence, shareChildIdentity,
  shareTrackFdRegistration, sweepOrphanTrackFiles,
} from "./kill.js";

// ── 多人模式:server 进程自己的出站凭证不透传给 agent(docs/multi-user-plan.md §八)──
// 宿主机上跑着的 ash 很可能自带 ANTHROPIC_API_KEY 之类;不删的话,一个「没挂供应商」
// 的执行器照样能花到宿主的钱,「抹去宿主订阅」整节就是空的。
//
// 判据是**隔离**而不是「多人」:开了「共用宿主机 CLI」的实例(§八之二)本来就是几个人
// 合烧一份宿主额度,那时宿主环境里的 key 正是他们要用的那把,清掉等于把功能关了。
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
 * 起 agent CLI 用的基座环境。自用模式、以及多人但共用宿主 CLI 时,与 `augmentedEnv()`
 * 逐字节相同 —— 那两条路的行为必须与隔离功能上线前一致(§二 / §八之二)。
 */
export function agentBaseEnv(): NodeJS.ProcessEnv {
  const env = augmentedEnv();
  if (!isHostCliIsolatedSync()) return env;
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
