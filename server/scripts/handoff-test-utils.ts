// test-handoff 的进程/仓库/HTTP 工具。从主文件拆出来只为压体积,不含断言编排逻辑。
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

export function makeRepo(path: string): string {
  execFileSync("git", ["init", "-b", "main", path]);
  git(path, "config", "user.name", "Ash Handoff Test");
  git(path, "config", "user.email", "handoff@example.test");
  writeFileSync(join(path, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(path, "seed.txt"), "seed\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "seed");
  return path;
}

/** 起对端 server(PORT=0),等 ready 行,返回 baseUrl。onProc 在 spawn 后立即回调,
 * 让调用方在 ready 之前就持有进程句柄——超时/早退时也能兜底击杀。 */
export async function startPeer(
  env: Record<string, string>,
  onProc: (proc: ChildProcess) => void,
): Promise<string> {
  const serverDir = join(import.meta.dirname, "..");
  const tsxCli = join(serverDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
  const peer = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, ...env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  onProc(peer);
  let buf = "";
  return new Promise<string>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`对端 server 30s 没 ready,输出:\n${buf}`)), 30_000);
    const onChunk = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/server on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolvePort(`http://127.0.0.1:${m[1]}`);
      }
    };
    peer.stdout!.on("data", onChunk);
    peer.stderr!.on("data", onChunk);
    peer.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`对端 server 提前退出(code ${code}),输出:\n${buf}`));
    });
  });
}

export async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}/api${path}`, init);
  const body = (await res.json()) as T & { error?: string };
  assert.ok(res.ok, `${path} 应答 ${res.status}: ${body?.error ?? JSON.stringify(body).slice(0, 200)}`);
  return body;
}
