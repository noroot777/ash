import { spawn } from "node:child_process";
import { homedir } from "node:os";
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

// Spawn an agent CLI either locally or over ssh, feeding the prompt via stdin
// (avoids escaping large prompts in argv, and works identically for both
// targets — DESIGN.md §0/§2: local spawn vs `ssh host "cd repo && <cli> …"`).
export function spawnAgent(target: ExecTarget, cwd: string, bin: string, args: string[], prompt: string) {
  let child;
  if (target.kind === "ssh") {
    const remote = `cd ${shq(cwd)} && ${bin} ${args.map(shq).join(" ")}`;
    child = spawn("ssh", [target.host, remote], { stdio: ["pipe", "pipe", "pipe"], env: augmentedEnv() });
  } else {
    child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: augmentedEnv() });
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
