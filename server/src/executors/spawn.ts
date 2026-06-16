import { spawn } from "node:child_process";
import type { ExecTarget } from "@harness/shared";

// shell-quote a single argument for a remote (ssh) command line
export const shq = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

// Spawn an agent CLI either locally or over ssh, feeding the prompt via stdin
// (avoids escaping large prompts in argv, and works identically for both
// targets — DESIGN.md §0/§2: local spawn vs `ssh host "cd repo && <cli> …"`).
export function spawnAgent(target: ExecTarget, cwd: string, bin: string, args: string[], prompt: string) {
  let child;
  if (target.kind === "ssh") {
    const remote = `cd ${shq(cwd)} && ${bin} ${args.map(shq).join(" ")}`;
    child = spawn("ssh", [target.host, remote], { stdio: ["pipe", "pipe", "pipe"] });
  } else {
    child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
