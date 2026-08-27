// 可引导单飞的 stdin 也必须活过 server 重启：v1 发第一条后退出，v2 重开 FIFO
// writer 发第二条与 stop；同一个 agent 进程应连续收到三条，输出不丢不重。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
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
  spawnControllableDetachedAgent,
} from ${JSON.stringify(join(here, "../src/executors/detached.ts"))};
import { inspectProcess } from ${JSON.stringify(join(here, "../src/proc.ts"))};

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
  const child = spawnControllableDetachedAgent(root, process.execPath, [agentScript], "one\\n", paths);
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
  const child = spawn("npx", ["tsx", serverScript, ...args], {
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
    try { process.kill(-agentPid, "SIGKILL"); } catch { /* 已退出 */ }
  }
  rmSync(root, { recursive: true, force: true });
}
