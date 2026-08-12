import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { statSync, accessSync, constants, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ExecTarget } from "@harness/shared";

// shell-quote a single argument for a remote (ssh) command line
export const shq = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

// When the server is launched from a GUI / preview (not a login shell), PATH may
// miss the dirs where CLIs live (Homebrew etc.), causing `spawn claude ENOENT`.
// Augment PATH with the common locations so local executors resolve.
const EXTRA_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  `${homedir()}/.local/bin`,
  `${homedir()}/.bun/bin`,
  `${homedir()}/.deno/bin`,
];
export function augmentedEnv() {
  const cur = process.env.PATH ?? "";
  const have = new Set(cur.split(":"));
  const extra = EXTRA_PATHS.filter((p) => !have.has(p));
  return { ...process.env, PATH: extra.length ? `${cur}:${extra.join(":")}` : cur };
}

// Resolve a bare command name to an absolute executable path by scanning PATH +
// EXTRA_PATHS. Returns null if it can't be found anywhere. Spawning the absolute
// path removes all dependence on the child's inherited PATH — so a remaining
// ENOENT can only mean a bad cwd, never a missing binary.
// 导出是为了让「候选 bin 探测」(bin-probe.ts,检测与执行共用的单点)跟真正
// spawn 时的查找口径**完全一致** —— 检测说可用、执行却 ENOENT,根因就是两套查找。
export function resolveBin(bin: string): string | null {
  if (bin.includes("/")) {
    try { accessSync(bin, constants.X_OK); return bin; } catch { return null; }
  }
  const dirs = [...(process.env.PATH ?? "").split(":"), ...EXTRA_PATHS].filter(Boolean);
  for (const d of dirs) {
    const p = join(d, bin);
    try { accessSync(p, constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

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
 * 少数确实要验证进程管理的测试必须显式给 HARNESS_ALLOW_REAL_AGENT=1；不再依赖每个调用点
 * 记得注入 no-op。
 */
export function guardAgentSpawn(bin: string): ChildProcess | null {
  if (!process.env.HARNESS_RUNS_DIR || process.env.HARNESS_ALLOW_REAL_AGENT === "1") return null;
  return failedChild(
    `测试隔离环境禁止启动真执行器 ${bin}；`
    + "这个测试若就是要验证进程管理，显式设 HARNESS_ALLOW_REAL_AGENT=1",
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
// close_fds 掐断继承的孙进程。局限:ssh 目标不适用(远端进程);双 fork 且中间
// 层已死、又恰好隔着一层 close_fds 的深孤儿仍可能漏(实践中极少)。
const trackFiles = new WeakMap<ChildProcess, string>();

async function killEscapees(child: ChildProcess, sig: NodeJS.Signals): Promise<void> {
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
    const psOut = await new Promise<string>((res) =>
      execFile("ps", ["-eo", "pid=,ppid="], (_e, so) => res(so || "")),
    );
    const kids = new Map<number, number[]>();
    for (const line of psOut.split("\n")) {
      const [pidS, ppidS] = line.trim().split(/\s+/);
      const pid = Number(pidS), ppid = Number(ppidS);
      if (!pid || !ppid) continue;
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid)!.push(pid);
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
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

// Spawn an agent CLI either locally or over ssh, feeding the prompt via stdin
// (avoids escaping large prompts in argv, and works identically for both
// targets: local spawn vs `ssh host "cd repo && <cli> …"`).
// detached: true 让 agent 自成进程组，killChild 才能对整棵进程树发 kill(-pid)。
// 不这样的话 stop 只杀 CLI 本身，它拉起的孙进程(ffmpeg、打包器…)继承着我们的
// stdout/stderr 管道不死，流永远不 EOF，run loop 收不到 close → 任务永远停不掉
// (真实案例：codex CLI 重装期间 resume，任务卡 running 且 stop 无效)。
// 代价：dev 前台 Ctrl-C 不再连带杀掉 agent(生产是 nohup 跑法，不受影响)。
// extraEnv: per-executor 的环境变量(供应商的 base_url / key、覆盖 CLI 自己的配置)。
// 本地合进 env,ssh 拼成远程命令的 `KEY=值 ` 前缀 —— 二者对 CLI 是等价的。
// **值为 `undefined` = 把这个变量从子进程里删掉**(本地靠 Node 跳过 undefined,ssh 靠
// `env -u`):harness 自己环境里带着的同名变量,不删就会盖掉「这里留空 = 跟随 CLI」。
// keepStdin: 常驻会话(§Team 的调度台)用 —— 写完首条消息不关 stdin,管道留给
// 调用方继续注入后续回合(见 executors/claude.ts 的 openResident)。
export function spawnAgent(
  target: ExecTarget,
  cwd: string,
  bin: string,
  args: string[],
  prompt: string,
  extraEnv?: Record<string, string | undefined>,
  opts?: { keepStdin?: boolean },
): ChildProcess {
  const blocked = guardAgentSpawn(bin);
  if (blocked) return blocked;
  const entries = Object.entries(extraEnv ?? {});
  const unsets = entries.filter(([, v]) => v === undefined).map(([k]) => `-u ${shq(k)}`);
  const assigns = entries.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${shq(v!)}`);
  // 有要删的就得借 `env -u`(shell 的 `K=v cmd` 只能赋值不能删);没有就维持原来的
  // `K=v cmd` 形状,免得所有远端命令凭空多一层 env。
  const envPrefix = unsets.length
    ? `env ${[...unsets, ...assigns].join(" ")} `
    : assigns.map((pair) => `${pair} `).join("");
  if (target.kind === "ssh") {
    const remote = `cd ${shq(cwd)} && ${envPrefix}${bin} ${args.map(shq).join(" ")}`;
    const child = spawn("ssh", [target.host, remote], { stdio: ["pipe", "pipe", "pipe"], env: augmentedEnv(), detached: true });
    child.stdin?.write(prompt);
    if (!opts?.keepStdin) child.stdin?.end();
    return child;
  }
  // Local pre-flight: distinguish "cwd missing" from "binary missing" so the
  // error never lies (both raise ENOENT from spawn, indistinguishable by code).
  if (!isDir(cwd)) return failedChild(`工作目录不存在：${cwd}`);
  const abs = resolveBin(bin);
  if (!abs) return failedChild(`找不到 ${bin} 命令(不在 PATH，也不在常见目录)`);
  const track = openTrackFd();
  const stdio: Array<"pipe" | number> = track.fd === null ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", track.fd];
  const child = spawn(abs, args, { cwd, stdio, env: { ...augmentedEnv(), ...extraEnv }, detached: true });
  registerTrackFd(child, track);
  child.stdin?.write(prompt);
  if (!opts?.keepStdin) child.stdin?.end();
  return child;
}

// 追踪 fd(见 killEscapees):打开一个本次运行专属文件,把 fd 作为 stdio[3] 传给
// 子进程 —— 后代无论怎么换组/被收养都带着它,stop 时可按文件名 lsof 反查。
// best-effort:开不出来就照旧 spawn,只是丢掉逃逸追踪能力。
// 抽成一对函数是为了让 detached.ts 那条路(输出走文件)复用同一套逃逸追踪,
// 而不是各写一份 —— 少一份就意味着那条路上的孤儿没人管。
export function openTrackFd(): { fd: number | null; path: string | null } {
  try {
    const path = join(tmpdir(), `harness-track-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

// Wrap a resume command for the target so it is copy-paste runnable (§13).
// envPrefix(供应商的 `KEY=值 `,token 已换成占位符)拼在 CLI 前面 —— 不带它,
// 粘到终端的命令会走 CLI 自己的官方账号,跟这次运行不是同一个来源。
//
// ssh 那支要把整条远端命令再包一层双引号,所以里面出现的 `"`(claude 的
// `--settings '{"env":…}'` 就带着一串)必须转义,否则用户粘过去的命令在本机 shell
// 就断在半截 —— `$` 和反引号一并转,免得本机 shell 抢先展开本该发给远端的字。
const dq = (s: string) => s.replace(/([\\"$`])/g, "\\$1");

export function resumeFor(target: ExecTarget, cwd: string, inner: string, envPrefix = ""): string {
  if (target.kind === "ssh") return `ssh ${target.host} "${dq(`cd ${shq(cwd)} && ${envPrefix}${inner}`)}"`;
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
export function killChild(child: ChildProcess): void {
  if (typeof child.kill !== "function") return;
  const signal = (sig: NodeJS.Signals) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, sig);
        return;
      } catch {
        /* 进程组已不在 → 退回单进程 */
      }
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
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig); // 组杀:spawn 时 detached,agent 就是组长
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal("SIGTERM");
  const t = setTimeout(() => {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) signal("SIGKILL");
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
// (The harness's own headless resume is built separately inside each executor's run().)
export const resumeInner: Record<string, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
};
