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
function augmentedEnv() {
  const cur = process.env.PATH ?? "";
  const have = new Set(cur.split(":"));
  const extra = EXTRA_PATHS.filter((p) => !have.has(p));
  return { ...process.env, PATH: extra.length ? `${cur}:${extra.join(":")}` : cur };
}

// Resolve a bare command name to an absolute executable path by scanning PATH +
// EXTRA_PATHS. Returns null if it can't be found anywhere. Spawning the absolute
// path removes all dependence on the child's inherited PATH — so a remaining
// ENOENT can only mean a bad cwd, never a missing binary.
function resolveBin(bin: string): string | null {
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
function failedChild(message: string): ChildProcess {
  const child: any = new EventEmitter();
  child.stdout = Readable.from([]);
  child.stderr = Readable.from([]);
  child.stdin = { write() {}, end() {} };
  queueMicrotask(() => {
    const err: any = new Error(message);
    err.precise = true; // tells spawnErrorMessage to use this message verbatim
    child.emit("error", err);
  });
  return child as ChildProcess;
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
// targets — DESIGN.md §0/§2: local spawn vs `ssh host "cd repo && <cli> …"`).
// detached: true 让 agent 自成进程组，killChild 才能对整棵进程树发 kill(-pid)。
// 不这样的话 stop 只杀 CLI 本身，它拉起的孙进程(ffmpeg、打包器…)继承着我们的
// stdout/stderr 管道不死，流永远不 EOF，run loop 收不到 close → 任务永远停不掉
// (真实案例：codex CLI 重装期间 resume，任务卡 running 且 stop 无效)。
// 代价：dev 前台 Ctrl-C 不再连带杀掉 agent(生产是 nohup 跑法，不受影响)。
export function spawnAgent(target: ExecTarget, cwd: string, bin: string, args: string[], prompt: string): ChildProcess {
  if (target.kind === "ssh") {
    const remote = `cd ${shq(cwd)} && ${bin} ${args.map(shq).join(" ")}`;
    const child = spawn("ssh", [target.host, remote], { stdio: ["pipe", "pipe", "pipe"], env: augmentedEnv(), detached: true });
    child.stdin?.write(prompt);
    child.stdin?.end();
    return child;
  }
  // Local pre-flight: distinguish "cwd missing" from "binary missing" so the
  // error never lies (both raise ENOENT from spawn, indistinguishable by code).
  if (!isDir(cwd)) return failedChild(`工作目录不存在：${cwd}`);
  const abs = resolveBin(bin);
  if (!abs) return failedChild(`找不到 ${bin} 命令(不在 PATH，也不在常见目录)`);
  // 追踪 fd(见 killEscapees):打开一个本次运行专属文件,把 fd 作为 stdio[3]
  // 传给子进程 —— 后代无论怎么换组/被收养都带着它,stop 时可按文件反查。
  // best-effort:开不出来就照旧 spawn,只是丢掉逃逸追踪能力。
  let trackFd: number | null = null;
  let trackPath: string | null = null;
  try {
    trackPath = join(tmpdir(), `harness-track-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    trackFd = openSync(trackPath, "w");
  } catch {
    trackPath = null;
  }
  const stdio: Array<"pipe" | number> = trackFd === null ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", trackFd];
  const child = spawn(abs, args, { cwd, stdio, env: augmentedEnv(), detached: true });
  if (trackFd !== null && trackPath) {
    closeSync(trackFd); // 子进程已持有副本,父进程这份立即关掉
    trackFiles.set(child, trackPath);
    const cleanupPath = trackPath;
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
  child.stdin?.write(prompt);
  child.stdin?.end();
  return child;
}

// Wrap a resume command for the target so it is copy-paste runnable (§13).
export function resumeFor(target: ExecTarget, cwd: string, inner: string): string {
  if (target.kind === "ssh") return `ssh ${target.host} "cd ${shq(cwd)} && ${inner}"`;
  return `cd ${shq(cwd)} && ${inner}`;
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
// session and continue) — single source of truth, used both when storing a
// session and when recomputing the display command on read. (The harness's own
// headless resume is built separately inside each executor's run().)
export const resumeInner: Record<string, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  antigravity: (id) => `antigravity --resume ${id}`,
};

// Build the display resume command from persisted session fields, so it always
// reflects the current format (no stale stored strings when the format changes).
export function resumeCommandFor(
  agentType: string,
  targetStr: string | null | undefined,
  cwd: string,
  cliSessionId: string,
): string {
  const inner = (resumeInner[agentType] ?? resumeInner.claude)(cliSessionId);
  const target: ExecTarget = targetStr?.startsWith("ssh:")
    ? { kind: "ssh", host: targetStr.slice(4) }
    : { kind: "local" };
  return resumeFor(target, cwd, inner);
}
