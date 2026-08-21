// 验证「重启接管」的接线本身（detached 机制的存活性由 test-detached-survival 证明）。
//
// 用真数据库 + 真进程走一遍实际代码路径：
//   ① 建一个 running 的任务，用 spawnDetachedAgent 起一个仍在输出的假 agent，
//      按 orchestrator 的写法把 pid / 启动时间 / 落盘路径 / offset 存进 sessions
//   ② 调 reattachRunningTasks()：应当认回它、注册进 runs（isRunning 为真）
//   ③ 调 reconcileInterrupted()：**绝不能**把它判成 failed
//   ④ 等假 agent 自然结束：任务应按结算规则落位，且 .md 里能看到接管之后的输出
// 反向用例：pid 是死的 → 不接管 → reconcile 照常把它判 failed（老语义不回退）。
process.env.ASH_DB ||= `/tmp/test-reattach-${Math.random().toString(36).slice(2)}.db`;
process.env.ASH_LAX_DONE = "1"; // 这里验的是接管，不是严格 done 协议

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const { ensureSchema, db } = await import("../src/db/index.js");
const { tasks, projects, sessions } = await import("../src/db/schema.js");
const { spawnDetachedAgent, detachedPathsFor } = await import("../src/executors/detached.js");
const { inspectProcess } = await import("../src/proc.js");
const { reattachRunningTasks } = await import("../src/reattach.js");
const { reconcileInterrupted } = await import("../src/orchestrator.js");
const { isRunning } = await import("../src/runs.js");
const { RUNS_DIR } = await import("../src/paths.js");

await ensureSchema();

const dir = mkdtempSync(join(tmpdir(), "ash-reattach-"));
const TOTAL = 20;
const agentScript = join(dir, "agent.mjs");
// 冒充 claude 的 stream-json。**正文必须走 stream_event 增量**：claude 开了
// --include-partial-messages 后正文由 content_block_delta 流出，parseClaudeStream
// 刻意不再从尾随的完整 assistant 消息里取文本（否则每段会重复一遍）。
// 第一版测试桩只发了 assistant 消息，结果 .md 全空——那是桩写错，不是代码错。
writeFileSync(
  agentScript,
  `let i = 0;
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({type:"system",session_id:"cli-sess-1"});
const t = setInterval(() => {
  i++;
  emit({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"第"+i+"段\\n"}}});
  if (i >= ${TOTAL}) {
    clearInterval(t);
    emit({type:"result",subtype:"success",session_id:"cli-sess-1"});
    process.exit(0);
  }
}, 100);
`,
);

// 任务 id 每次跑都换一个：RUNS_DIR 固定锚在 <repo>/data/runs（没有 env 覆盖），
// 用固定 id 的话 .md 会被 flags:"a" 一轮轮追加，第二次跑就看到 40 段。
const RUN = Math.random().toString(36).slice(2, 8);
const LIVE = `T-live-${RUN}`;
const DEAD = `T-dead-${RUN}`;
const now = () => new Date().toISOString();
let bad = 0;
const fail = (m: string) => { console.log("   ✕ " + m); bad++; };
const okLine = (m: string) => console.log("   ✓ " + m);

function macChineseStart(pid: number): string | null {
  const ms = inspectProcess(pid)?.startedAtMs;
  if (ms === null || ms === undefined) return null;
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `六  ${d.getMonth() + 1}月/${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

async function makeCase(taskId: string, live: boolean) {
  await db.insert(projects).values({ id: `p-${taskId}`, name: "t", repoPath: dir, createdAt: now() } as never);
  await db.insert(tasks).values({
    id: taskId, projectId: `p-${taskId}`, title: "接管用例", body: "", status: "running",
    mode: "single", agentType: "claude", labels: "[]",
    createdAt: now(), updatedAt: now(), autoTitle: 0, useWorktree: 0,
  } as never);

  const sessId = `s-${taskId}`;
  const runDir = join(RUNS_DIR, taskId);
  mkdirSync(runDir, { recursive: true });
  const paths = detachedPathsFor(runDir, sessId, "T0");
  const child = spawnDetachedAgent(dir, process.execPath, [agentScript], "", paths);
  const pid = child.pid!;
  // 让它先吐几行再「重启」，这样接管时确实有历史内容与未读内容之分。
  await new Promise((r) => setTimeout(r, 450));
  if (!live) {
    process.kill(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
  }
  await db.insert(sessions).values({
    id: sessId, taskId, role: "single", agentType: "claude", executor: "claude@local",
    cwd: dir, cliSessionId: "cli-sess-1", commandLine: "fake",
    startedAt: now(), turnStartedAt: now(), activeMs: 0,
    // 模拟旧 server 在中文 locale 下落库、重启后新 server 用 C locale 读取 ps。
    // 两段字符串不同，但指向同一秒，必须仍能接管。
    agentPid: pid, agentStartedAt: live ? macChineseStart(pid) : inspectProcess(pid)?.startedAt ?? null,
    agentOutPath: paths.out, agentErrPath: paths.err, agentRcPath: paths.rc,
    agentOffset: 0,
  } as never);
  return { sessId, paths, pid };
}

console.log("① 造两个 running 任务：一个 agent 还活着，一个已被杀死");
const liveCase = await makeCase(LIVE, true);
const deadCase = await makeCase(DEAD, false);

console.log("② reattachRunningTasks()");
const adopted = await reattachRunningTasks();
console.log(`   接管集合 = [${[...adopted].join(", ")}]`);
if (!adopted.has(LIVE)) fail("活着的 agent 没被接管"); else okLine("活着的被接管了");
if (adopted.has(DEAD)) fail("已死的 agent 不该被接管"); else okLine("已死的正确地没被接管");
if (!isRunning(LIVE)) fail("接管后 isRunning 应为真（停止按钮要靠它）"); else okLine("isRunning 为真，停止按钮仍有效");

console.log("③ reconcileInterrupted()：不能误伤被接管的那个");
await reconcileInterrupted();
const stLive = (await db.select().from(tasks).where(eq(tasks.id, LIVE))).at(0)?.status;
const stDead = (await db.select().from(tasks).where(eq(tasks.id, DEAD))).at(0)?.status;
console.log(`   ${LIVE} = ${stLive}   ${DEAD} = ${stDead}`);
if (stLive !== "running") fail(`被接管的任务被误判成了 ${stLive}`); else okLine("被接管的仍是 running");
if (stDead !== "failed") fail(`真被打断的应判 failed，实为 ${stDead}`); else okLine("真被打断的仍按老语义判 failed");

console.log("④ 等假 agent 自然结束，看接管之后的输出有没有落进 .md");
for (let i = 0; i < 60 && isRunning(LIVE); i++) await new Promise((r) => setTimeout(r, 200));
const mdPath = join(RUNS_DIR, LIVE, `${liveCase.sessId}.md`);
const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
const seen = [...md.matchAll(/第(\d+)段/g)].map((m) => Number(m[1]));
console.log(`   .md 里读到 ${seen.length} 段：${seen.slice(0, 3).join(",")}…${seen.slice(-2).join(",")}`);
if (!seen.length) fail(".md 里什么都没有 —— 接管后的输出没落盘");
else {
  // 接管是从 offset 0 开始的（本用例刻意没存中途 offset），所以应当看到全部 TOTAL 段。
  if (seen[seen.length - 1] !== TOTAL) fail(`最后一段应是 ${TOTAL}，实为 ${seen[seen.length - 1]}`);
  else okLine(`一路读到第 ${TOTAL} 段，接管后的输出完整落盘`);
  const dup = seen.filter((n, i) => seen.indexOf(n) !== i);
  if (dup.length) fail(`有重复段：${[...new Set(dup)].join(",")}`);
}
const finalStatus = (await db.select().from(tasks).where(eq(tasks.id, LIVE))).at(0)?.status;
console.log(`   任务最终状态 = ${finalStatus}`);
if (finalStatus === "running") fail("agent 结束后任务仍卡在 running —— 结算没跑");
else okLine(`agent 结束后正常结算为 ${finalStatus}`);

console.log(bad === 0 ? "\n✅ 接管接线全部正确" : `\n❌ ${bad} 项不符（现场：${dir}）`);
process.exit(bad === 0 ? 0 : 1);
