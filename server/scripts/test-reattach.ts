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

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const { ensureSchema, db } = await import("../src/db/index.js");
const { tasks, projects, sessions } = await import("../src/db/schema.js");
const { spawnControllableDetachedAgent, spawnDetachedAgent, detachedPathsFor } = await import("../src/executors/detached.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { readCodexAppServerState } = await import("../src/executors/codex-app-server.js");
const { inspectProcess } = await import("../src/proc.js");
const { reattachRunningTasks } = await import("../src/reattach.js");
const { reconcileInterrupted } = await import("../src/orchestrator.js");
const { isRunning, reserveNativeSteerTask } = await import("../src/runs.js");
const { RUNS_DIR } = await import("../src/paths.js");

await ensureSchema();

const dir = mkdtempSync(join(tmpdir(), "ash-reattach-"));
const TOTAL = 20;
const agentScript = join(dir, "agent.mjs");
const steerAgentScript = join(dir, "steer-agent.mjs");
const codexAppScript = join(dir, "codex-app.mjs");
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
writeFileSync(
  steerAgentScript,
  `import { createInterface } from "node:readline";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({type:"system",session_id:"claude-steer-session"});
let users = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    emit({type:"control_response",response:{subtype:"success",request_id:message.request_id}});
    emit({type:"result",subtype:"success",session_id:"claude-steer-session"});
    return;
  }
  if (message.type !== "user") return;
  users++;
  if (users === 1) {
    emit({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"CLAUDE-OLD\\n"}}});
    return;
  }
  setTimeout(() => {
    emit({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"CLAUDE-STEERED\\n"}}});
    emit({type:"result",subtype:"success",session_id:"claude-steer-session"});
  }, 20);
});
`,
);
writeFileSync(
  codexAppScript,
  `let input = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const receive = (message) => {
  if (message.id === undefined) return;
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "thread/goal/get") send({ id: message.id, result: { goal: null } });
  else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "codex-steer-thread" } } });
    send({ method: "thread/started", params: { thread: { id: "codex-steer-thread" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "codex-steer-turn" } } });
    send({ method: "turn/started", params: {
      threadId: "codex-steer-thread", turn: { id: "codex-steer-turn" },
    } });
  } else if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: "codex-steer-turn" } });
    setTimeout(() => {
      send({ method: "item/agentMessage/delta", params: {
        threadId: "codex-steer-thread", turnId: "codex-steer-turn",
        itemId: "steered-message", delta: "CODEX-STEERED",
      } });
      send({ method: "item/completed", params: {
        threadId: "codex-steer-thread", turnId: "codex-steer-turn",
        item: { type: "agentMessage", id: "steered-message", text: "CODEX-STEERED" },
      } });
      send({ method: "turn/completed", params: {
        threadId: "codex-steer-thread",
        turn: { id: "codex-steer-turn", status: "completed", error: null },
      } });
    }, 20);
  }
};
process.stdin.on("data", (chunk) => {
  input += chunk.toString();
  for (;;) {
    const newline = input.indexOf("\\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line) receive(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
`,
);

// 任务 id 每次跑都换一个：RUNS_DIR 固定锚在 <repo>/data/runs（没有 env 覆盖），
// 用固定 id 的话 .md 会被 flags:"a" 一轮轮追加，第二次跑就看到 40 段。
const RUN = Math.random().toString(36).slice(2, 8);
const LIVE = `T-live-${RUN}`;
const DEAD = `T-dead-${RUN}`;
const CLAUDE_STEER = `T-claude-steer-${RUN}`;
const CODEX_STEER = `T-codex-steer-${RUN}`;
const now = () => new Date().toISOString();
let bad = 0;
const cleanupPids = new Set<number>();
process.on("exit", () => {
  for (const pid of cleanupPids) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* 已退出 */ }
  }
});
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
  cleanupPids.add(pid);
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

async function insertRunningTask(taskId: string, agentType: "claude" | "codex") {
  await db.insert(projects).values({ id: `p-${taskId}`, name: "t", repoPath: dir, createdAt: now() } as never);
  await db.insert(tasks).values({
    id: taskId, projectId: `p-${taskId}`, title: "原生引导接管", body: "", status: "running",
    mode: "single", agentType, labels: "[]", createdAt: now(), updatedAt: now(), autoTitle: 0, useWorktree: 0,
  } as never);
}

async function makeClaudeSteerCase() {
  await insertRunningTask(CLAUDE_STEER, "claude");
  const sessId = `s-${CLAUDE_STEER}`;
  const runDir = join(RUNS_DIR, CLAUDE_STEER);
  mkdirSync(runDir, { recursive: true });
  const paths = detachedPathsFor(runDir, sessId, "T0");
  const initial = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "OLD" }] } }) + "\n";
  const child = spawnControllableDetachedAgent(dir, process.execPath, [steerAgentScript], initial, paths);
  cleanupPids.add(child.pid!);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await db.insert(sessions).values({
    id: sessId, taskId: CLAUDE_STEER, role: "single", agentType: "claude", executor: "claude@local",
    cwd: dir, cliSessionId: "claude-steer-session", commandLine: "claude --input-format stream-json",
    startedAt: now(), turnStartedAt: now(), activeMs: 0,
    agentPid: child.pid, agentStartedAt: inspectProcess(child.pid!)?.startedAt ?? null,
    agentOutPath: paths.out, agentErrPath: paths.err, agentRcPath: paths.rc, agentOffset: 0,
  } as never);
  return { sessId, pid: child.pid! };
}

async function makeCodexSteerCase() {
  await insertRunningTask(CODEX_STEER, "codex");
  const sessId = `s-${CODEX_STEER}`;
  const runDir = join(RUNS_DIR, CODEX_STEER);
  mkdirSync(runDir, { recursive: true });
  const paths = detachedPathsFor(runDir, sessId, "T0");
  // node 的第一个非 flag 参数会被当脚本；App Server 固定参数不能这样装，因此这里用
  // 一个很薄的可执行 shim，让真实 CodexExecutor 仍走 runSteerable 生产路径。
  const shim = join(dir, "fake-codex");
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(codexAppScript)} "$@"\n`, { mode: 0o755 });
  const realExecutor = new CodexExecutor({ bin: shim });
  const handle = realExecutor.runSteerable({ cwd: dir, prompt: "OLD", detach: paths });
  cleanupPids.add(handle.detached!.pid);
  const iterator = handle.events[Symbol.asyncIterator]();
  let cliSessionId = "";
  for (let i = 0; i < 10 && !cliSessionId; i++) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<any>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 500)),
    ]);
    if (!result.done && result.value.kind === "session") cliSessionId = result.value.cliSessionId;
  }
  assert.equal(cliSessionId, "codex-steer-thread", "前提：假 App Server 完成了原始握手");
  for (let attempt = 0; attempt < 100 && !readCodexAppServerState(paths.out, cliSessionId).turnId; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readCodexAppServerState(paths.out, cliSessionId).turnId, "codex-steer-turn", "前提：原始回合已经启动");
  await db.insert(sessions).values({
    id: sessId, taskId: CODEX_STEER, role: "single", agentType: "codex", executor: "codex@local",
    cwd: dir, cliSessionId, commandLine: handle.commandLine,
    startedAt: now(), turnStartedAt: now(), activeMs: 0,
    agentPid: handle.detached!.pid, agentStartedAt: inspectProcess(handle.detached!.pid)?.startedAt ?? null,
    agentOutPath: paths.out, agentErrPath: paths.err, agentRcPath: paths.rc,
    agentOffset: handle.detached!.committed(),
  } as never);
  return { sessId, pid: handle.detached!.pid };
}

console.log("① 造两个 running 任务：一个 agent 还活着，一个已被杀死");
const liveCase = await makeCase(LIVE, true);
const deadCase = await makeCase(DEAD, false);
const claudeSteerCase = await makeClaudeSteerCase();
const codexSteerCase = await makeCodexSteerCase();

console.log("② reattachRunningTasks()");
const adopted = await reattachRunningTasks();
console.log(`   接管集合 = [${[...adopted].join(", ")}]`);
if (!adopted.has(LIVE)) fail("活着的 agent 没被接管"); else okLine("活着的被接管了");
if (adopted.has(DEAD)) fail("已死的 agent 不该被接管"); else okLine("已死的正确地没被接管");
if (!isRunning(LIVE)) fail("接管后 isRunning 应为真（停止按钮要靠它）"); else okLine("isRunning 为真，停止按钮仍有效");
if (!adopted.has(CLAUDE_STEER) || !adopted.has(CODEX_STEER)) fail("原生引导回合没有全部接回");
else okLine("Claude/Codex 原生引导回合都已接回");

console.log("③ reconcileInterrupted()：不能误伤被接管的那个");
await reconcileInterrupted();
const stLive = (await db.select().from(tasks).where(eq(tasks.id, LIVE))).at(0)?.status;
const stDead = (await db.select().from(tasks).where(eq(tasks.id, DEAD))).at(0)?.status;
console.log(`   ${LIVE} = ${stLive}   ${DEAD} = ${stDead}`);
if (stLive !== "running") fail(`被接管的任务被误判成了 ${stLive}`); else okLine("被接管的仍是 running");
if (stDead !== "failed") fail(`真被打断的应判 failed，实为 ${stDead}`); else okLine("真被打断的仍按老语义判 failed");

console.log("④ 重启接管后，Claude/Codex 原生引导仍能写入同一进程");
for (const [taskId, text] of [[CLAUDE_STEER, "CLAUDE-NEW"], [CODEX_STEER, "CODEX-NEW"]] as const) {
  const reservation = reserveNativeSteerTask(taskId);
  if (reservation.kind !== "native") {
    fail(`${taskId} 没恢复原生 steer handle`);
    continue;
  }
  await reservation.deliver(text, now());
}
for (let i = 0; i < 100 && (isRunning(CLAUDE_STEER) || isRunning(CODEX_STEER)); i++) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const claudeSteerMd = readFileSync(join(RUNS_DIR, CLAUDE_STEER, `${claudeSteerCase.sessId}.md`), "utf8");
const codexSteerMd = readFileSync(join(RUNS_DIR, CODEX_STEER, `${codexSteerCase.sessId}.md`), "utf8");
if (!claudeSteerMd.includes("CLAUDE-STEERED") || !claudeSteerMd.includes("CLAUDE-NEW")) {
  fail("Claude 接管后引导未同时留下用户消息与新回复");
} else okLine("Claude 接管后仍可 interrupt + send");
if (!codexSteerMd.includes("CODEX-STEERED") || !codexSteerMd.includes("CODEX-NEW")) {
  fail("Codex 接管后引导未同时留下用户消息与新回复");
} else okLine("Codex 接管后仍可 turn/steer");

console.log("⑤ 等普通假 agent 自然结束，看接管之后的输出有没有落进 .md");
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

// ⑥ 接管成功**之后**才暴露出来的中断,谁来结算(第 1 轮审查 F1)。
//
// reattachRunningTasks 把消费循环 `void` 出去就返回了,紧随其后的 reconcileInterrupted
// 看到 isRunning 为真、正确地跳过了这个任务(上面 ③ 钉的就是这一条)。可那条消费循环要是
// 随后在初始化段抛了错,进程收掉了、登记注销了,却**再也没有人来结算它** —— 任务永远停在
// running:界面上一个转着的任务,不会有输出,也停不掉,连重试都点不了。
// 所以那条 finally 在撤干净「有活句柄」的证据之后,必须再问一次这个任务该不该结算。
console.log("⑥ 接管后无人收尾的任务,finally 那一问必须把它结算掉");
{
  const { reconcileInterruptedTask } = await import("../src/task-reconcile.js");
  const { trackRun, untrackRun } = await import("../src/runs.js");
  const STRANDED = `T-stranded-${RUN}`;
  const GUARDED = `T-guarded-${RUN}`;
  const TEAM = `T-team-stranded-${RUN}`;
  for (const [id, mode] of [[STRANDED, "single"], [GUARDED, "single"], [TEAM, "team"]] as const) {
    await db.insert(projects).values({ id: `p-${id}`, name: "t", repoPath: dir, createdAt: now() } as never);
    await db.insert(tasks).values({
      id, projectId: `p-${id}`, title: "接管后中断", body: "", status: "running",
      mode, agentType: "claude", labels: "[]", createdAt: now(), updatedAt: now(), autoTitle: 0, useWorktree: 0,
    } as never);
  }
  const settled = await reconcileInterruptedTask(STRANDED);
  const stranded = (await db.select().from(tasks).where(eq(tasks.id, STRANDED))).at(0)?.status;
  if (stranded === "failed") okLine("没人收尾的那条被结算成 failed(用户能重试)");
  else fail(`接管后中断的任务应判 failed,实为 ${stranded}`);
  if (settled) okLine("回执说明这次接管没跑成(调用方据此把它从「已接管」里撤掉)");
  else fail("结算了却回执「没我的事」,调用方会继续把它当成接管成功");

  // 真在跑的绝不许被它动:这一问发生在消费循环结束之后,但同一个任务可能已经被别人重新
  // 跑起来了(用户点了重试、队列推进过来),判据必须是「此刻有没有活句柄」。
  const liveHandle = { kill: () => {} };
  trackRun(GUARDED, liveHandle);
  const guardedSettled = await reconcileInterruptedTask(GUARDED);
  if (guardedSettled) fail("在跑的任务不该给出「我结算了」的回执");
  const guarded = (await db.select().from(tasks).where(eq(tasks.id, GUARDED))).at(0)?.status;
  if (guarded === "running") okLine("手上还有活句柄的任务,这一问必须空转");
  else fail(`在跑的任务被误结算成了 ${guarded}`);
  untrackRun(GUARDED, liveHandle);

  // 团队调度台没有「失败」这回事(进程随 server 走,下次说话 --resume 接回),落待命。
  await reconcileInterruptedTask(TEAM);
  const team = (await db.select().from(tasks).where(eq(tasks.id, TEAM))).at(0)?.status;
  if (team === "idle") okLine("团队调度台落 idle,跟批量版同一口径");
  else fail(`团队调度台应落 idle,实为 ${team}`);

  // 已经结算过的任务再问一次 = 空转(正常收尾的那条路每轮都会走到这一问)。
  const againSettled = await reconcileInterruptedTask(STRANDED);
  if (againSettled) fail("已落终态的任务不该再给出「我结算了」的回执");
  const again = (await db.select().from(tasks).where(eq(tasks.id, STRANDED))).at(0)?.status;
  if (again === "failed") okLine("已落终态的任务再问一次不会被改写");
  else fail(`空转这一问把终态改成了 ${again}`);
}

console.log(bad === 0 ? "\n✅ 接管接线全部正确" : `\n❌ ${bad} 项不符（现场：${dir}）`);
process.exit(bad === 0 ? 0 : 1);
