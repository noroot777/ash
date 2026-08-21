// 证明「agent 活得过 server 重启」这件事本身。
//
// 时序（三个进程，真的杀掉中间那个）：
//   ① server-v1 用 spawnDetachedAgent 起一个假 agent，读到前几行就 **process.exit**
//      —— 模拟 `npm run restart` 里那句 kill，连 finally 都不给跑
//   ② 断言：假 agent **仍然活着**（这就是整个方案的立论；管道模式下它此刻已经死了）
//   ③ server-v2 用 reattachDetachedAgent 按 pid+offset 接管，读完剩下的
//   ④ 断言：两段拼起来 = 假 agent 完整输出，不丢行、不重行、退出码正确
//
// 假 agent 每 120ms 打一行 JSON（贴近 claude 的 stream-json），最后 exit 7。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ash-detached-"));
const TOTAL = 24;
const EXIT_CODE = 7;

const agentScript = join(dir, "fake-agent.mjs");
writeFileSync(
  agentScript,
  `let i = 0;
const t = setInterval(() => {
  i++;
  process.stdout.write(JSON.stringify({ type: "line", n: i }) + "\\n");
  if (i >= ${TOTAL}) { clearInterval(t); process.exit(${EXIT_CODE}); }
}, 120);
`,
);

// 两个「server」都是独立进程：v1 必须能被真的杀死，v2 必须在全新进程里接管。
const serverScript = join(dir, "server.mjs");
writeFileSync(
  serverScript,
  `import { spawnDetachedAgent, reattachDetachedAgent, detachedPathsFor } from ${JSON.stringify(join(HERE, "../src/executors/detached.ts"))};
import { inspectProcess } from ${JSON.stringify(join(HERE, "../src/proc.ts"))};
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const [mode, dir, agentScript, stateFile] = process.argv.slice(2);
const paths = detachedPathsFor(dir, "sess", "T0");
const lines = [];

// 保活：detached 里所有定时器都 unref 了（真 server 由 HTTP 监听撑着事件循环，
// 不该让一个 tail 定时器挡住关服）。独立进程里没人撑，得自己来。
const keepAlive = setInterval(() => {}, 1000);

function consume(child, stopAfter) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (l) => {
      if (!l.trim()) return;
      lines.push(l);
      if (stopAfter && lines.length >= stopAfter) resolve("stopped");
    });
    child.on("close", (code) => resolve("closed:" + code));
  });
}

if (mode === "v1") {
  const child = spawnDetachedAgent(dir, process.execPath, [agentScript], "", paths);
  // 读到第 6 行就「被重启」：记下 pid / 启动时间 / 已消费到的字节位置，然后硬退出。
  await consume(child, 6);
  const info = inspectProcess(child.pid);
  writeFileSync(stateFile, JSON.stringify({
    pid: child.pid, startedAt: info?.startedAt ?? null,
    offset: child.ashCommitted(), lines,
  }));
  process.exit(0); // 模拟 kill：不给任何收尾机会
} else {
  const prev = JSON.parse(process.env.ASH_PREV_STATE);
  const child = reattachDetachedAgent({ pid: prev.pid, startedAt: prev.startedAt, paths, offset: prev.offset });
  if (!child) { clearInterval(keepAlive); writeFileSync(stateFile, JSON.stringify({ reattached: false })); process.exit(0); }
  const how = await consume(child, 0);
  clearInterval(keepAlive);
  writeFileSync(stateFile, JSON.stringify({ reattached: true, how, lines, exitCode: child.exitCode }));
  process.exit(0);
}
`,
);

const run = (args, env) =>
  new Promise((resolve) => {
    const p = spawn("npx", ["tsx", serverScript, ...args], {
      cwd: join(HERE, ".."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    p.on("close", resolve);
  });

const stateA = join(dir, "a.json");
const stateB = join(dir, "b.json");

console.log("① 起 server-v1，读几行后硬杀掉它…");
await run(["v1", dir, agentScript, stateA]);
const a = JSON.parse(readFileSync(stateA, "utf8"));
console.log(`   v1 读到 ${a.lines.length} 行，agent pid=${a.pid}，offset=${a.offset}`);

console.log("② 检查 agent 是否活过了这次「重启」…");
let alive = true;
try { process.kill(a.pid, 0); } catch { alive = false; }
console.log(`   agent 还活着 = ${alive}   ← 管道模式下这里必然是 false`);

console.log("③ 起 server-v2，按 pid+offset 接管…");
await run(["v2", dir, agentScript, stateB], { ASH_PREV_STATE: JSON.stringify(a) });
const b = JSON.parse(readFileSync(stateB, "utf8"));
console.log(`   接管成功 = ${b.reattached}，又读到 ${b.lines?.length ?? 0} 行，退出码 = ${b.exitCode}`);

// ── 断言 ──
let bad = 0;
const fail = (m) => { console.log("   ✕ " + m); bad++; };

if (!alive) fail("agent 没能活过 server 退出 —— 解绑没生效");
if (!b.reattached) fail("接管失败");

const all = [...(a.lines ?? []), ...(b.lines ?? [])];
const nums = all.map((l) => JSON.parse(l).n);
const expected = Array.from({ length: TOTAL }, (_, i) => i + 1);
if (JSON.stringify(nums) !== JSON.stringify(expected)) {
  fail(`行不连续：期望 1..${TOTAL}，实到 [${nums.join(",")}]`);
  const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
  if (dup.length) fail(`重复行：${[...new Set(dup)].join(",")}`);
  const missing = expected.filter((n) => !nums.includes(n));
  if (missing.length) fail(`丢失行：${missing.join(",")}`);
}
if (b.exitCode !== EXIT_CODE) fail(`退出码应为 ${EXIT_CODE}，实到 ${b.exitCode}`);
if (!existsSync(paths_rc())) fail("rc 文件没写出来");

function paths_rc() { return join(dir, "sess-T0.agent-rc"); }

console.log(
  bad === 0
    ? `\n✅ 全部通过：agent 活过了 server 退出，接管后 ${TOTAL} 行不丢不重，退出码正确`
    : `\n❌ ${bad} 项不符（现场保留在 ${dir}）`,
);
process.exit(bad === 0 ? 0 : 1);
