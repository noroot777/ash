// 可引导单飞的 stdin 也必须活过 server 重启：v1 发第一条后退出，v2 重开 writer 发第二条
// 与 stop；同一个 agent 进程应连续收到三条，输出不丢不重。
//
// 走的是**生产入口** spawnControllableForRun，所以两个平台各自跑自己那条实现：POSIX 重开
// FIFO，Windows 连回 node 壳守着的具名管道（executors/detached-win-wrap.ts）。断言两边一样
// —— 「重启后还能接着引导」是同一个契约，不是 POSIX 专属。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IS_WINDOWS, killTree } from "../src/platform.js";

const here = dirname(fileURLToPath(import.meta.url));
// file:// 而不是裸路径 —— 理由同 test-detached-survival.ts（Windows 上 `D:` 会被当协议）。
const mod = (rel: string) => JSON.stringify(pathToFileURL(join(here, rel)).href);
const root = mkdtempSync(join(tmpdir(), "ash-controllable-detached-"));
const agentScript = join(root, "agent.mjs");
const serverScript = join(root, "server.mjs");
const stateA = join(root, "a.json");
const stateB = join(root, "b.json");
let agentPid: number | null = null;

writeFileSync(agentScript, `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  process.stdout.write(JSON.stringify({ line }) + "\\n");
  if (line === "stop") process.exit(0);
});
`);

writeFileSync(serverScript, `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import {
  detachedPathsFor,
  reattachDetachedAgent,
  spawnControllableForRun,
} from ${mod("../src/executors/detached.ts")};
import { inspectProcess } from ${mod("../src/proc.ts")};

const [mode, root, agentScript, stateFile] = process.argv.slice(2);
const paths = detachedPathsFor(root, "session", "T0");
const lines = [];
const keepAlive = setInterval(() => {}, 1000);
const consume = (child, count = 0) => new Promise((resolve) => {
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    lines.push(line);
    if (count && lines.length >= count) resolve("count");
  });
  child.on("close", (code) => resolve("close:" + code));
});

if (mode === "v1") {
  const child = spawnControllableForRun(root, process.execPath, [agentScript], "one\\n", undefined, paths);
  await consume(child, 1);
  const info = inspectProcess(child.pid);
  writeFileSync(stateFile, JSON.stringify({
    pid: child.pid,
    startedAt: info?.startedAt ?? null,
    offset: child.ashCommitted(),
    lines,
  }));
  process.exit(0);
}

const previous = JSON.parse(process.env.ASH_PREV_STATE);
const child = reattachDetachedAgent({
  pid: previous.pid,
  startedAt: previous.startedAt,
  paths,
  offset: previous.offset,
});
if (!child?.stdin) {
  clearInterval(keepAlive);
  writeFileSync(stateFile, JSON.stringify({ reattached: false }));
  process.exit(0);
}
child.stdin.write("two\\nstop\\n");
const how = await consume(child);
clearInterval(keepAlive);
writeFileSync(stateFile, JSON.stringify({ reattached: true, how, lines, exitCode: child.exitCode }));
`);

const run = (args: string[], env: Record<string, string> = {}) => new Promise<number>((resolve) => {
  // 理由同 test-detached-survival.ts:`spawn("npx")` 在 Windows 上 ENOENT。
  const child = spawn(process.execPath, ["--import", "tsx", serverScript, ...args], {
    cwd: join(here, ".."),
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("close", (code) => resolve(code ?? 1));
});

try {
  assert.equal(await run(["v1", root, agentScript, stateA]), 0);
  const first = JSON.parse(readFileSync(stateA, "utf8"));
  agentPid = first.pid;
  assert.doesNotThrow(() => process.kill(first.pid, 0), "agent 应活过 server-v1 退出");

  assert.equal(await run(["v2", root, agentScript, stateB], {
    ASH_PREV_STATE: JSON.stringify(first),
  }), 0);
  const second = JSON.parse(readFileSync(stateB, "utf8"));
  assert.equal(second.reattached, true, "server-v2 应恢复可写 stdin");
  const lines = [...first.lines, ...second.lines].map((line: string) => JSON.parse(line).line);
  assert.deepEqual(lines, ["one", "two", "stop"]);
  assert.equal(second.exitCode, 0);
  console.log("✓ 可引导 detached 回合重启后恢复 stdin，同一进程继续收消息");
} finally {
  if (agentPid) {
    // Windows 没有进程组，收尾走整树强杀（killTree 内部就是 taskkill /T /F）。
    if (IS_WINDOWS) killTree(agentPid, "SIGKILL");
    else try { process.kill(-agentPid, "SIGKILL"); } catch { /* 已退出 */ }
  }
  rmSync(root, { recursive: true, force: true });
}
