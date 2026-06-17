import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { statSync, accessSync, constants } from "node:fs";
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

// Spawn an agent CLI either locally or over ssh, feeding the prompt via stdin
// (avoids escaping large prompts in argv, and works identically for both
// targets — DESIGN.md §0/§2: local spawn vs `ssh host "cd repo && <cli> …"`).
export function spawnAgent(target: ExecTarget, cwd: string, bin: string, args: string[], prompt: string): ChildProcess {
  if (target.kind === "ssh") {
    const remote = `cd ${shq(cwd)} && ${bin} ${args.map(shq).join(" ")}`;
    const child = spawn("ssh", [target.host, remote], { stdio: ["pipe", "pipe", "pipe"], env: augmentedEnv() });
    child.stdin?.write(prompt);
    child.stdin?.end();
    return child;
  }
  // Local pre-flight: distinguish "cwd missing" from "binary missing" so the
  // error never lies (both raise ENOENT from spawn, indistinguishable by code).
  if (!isDir(cwd)) return failedChild(`工作目录不存在：${cwd}`);
  const abs = resolveBin(bin);
  if (!abs) return failedChild(`找不到 ${bin} 命令(不在 PATH，也不在常见目录)`);
  const child = spawn(abs, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: augmentedEnv() });
  child.stdin?.write(prompt);
  child.stdin?.end();
  return child;
}

// Wrap a resume command for the target so it is copy-paste runnable (§13).
export function resumeFor(target: ExecTarget, cwd: string, inner: string): string {
  if (target.kind === "ssh") return `ssh ${target.host} "cd ${shq(cwd)} && ${inner}"`;
  return `cd ${shq(cwd)} && ${inner}`;
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
