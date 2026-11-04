// 共享目录上**同时在跑**的两个任务，生成物怎么分开（server/src/task-artifact-footprint.ts）。
//
// 起因（2026-11-04）：两个任务都没开 worktree、都在同一个不是 git 仓库的目录里干活，运行区间
// 重叠了半个多小时。时间判据对这种情形无能为力——两边的文件修改时间都落在两边的区间里——于是
// 一个任务的生成物面板混进了另一个任务的 572 个文件。分开它们的证据是「谁在附近写过东西」：
// 执行器当场报出写文件工具的目标路径和命令的工作目录，ash 记进 task_writes。
//
// 这里钉四件事：
//   1. 执行器那一侧真的把写入位置报出来了（claude 主会话与子智能体、codex 主线程与子线程），
//      而且是从结构化参数取的，不受展示用 detail 的截短影响；
//   2. 记录端：相对路径按会话目录展开、同一路径去重；
//   3. 裁决：离谁写过的地方更近就归谁；一样近、或有一方没记录可比，就只当候选；进去看一眼
//      （命令工作目录）压不过真写过（写文件工具）；
//   4. 没有并发的时候行为一点不变。
// 跑：npm -w server run test:task-artifacts-concurrent
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-artifacts-concurrent-"));
process.env.ASH_DB = join(stage, "ash.db");
requireTmpDb("task-artifacts-concurrent");

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const writesOf = (events: AgentEvent[]) =>
  events.filter((event): event is Extract<AgentEvent, { kind: "writes" }> => event.kind === "writes");

try {
  // 先建表：claude 流解析会顺手起后台任务的记账，库得先就绪。
  const { db, ensureSchema } = await import("../src/db/index.js");
  await ensureSchema();
  const { claudeToolWrites, codexChangeWrites, codexCommandCwd } = await import("../src/executors/tool-writes.js");

  // ── 1a. 取法本身 ────────────────────────────────────────────────────────────
  assert.deepEqual(claudeToolWrites("Write", { file_path: "/w/a.py", content: "x".repeat(5000) }), { kind: "writes", paths: ["/w/a.py"] },
    "Write 的内容再长，目标路径也要原样取出来（展示用的 detail 截到 1500 字就拆不开了）");
  assert.deepEqual(claudeToolWrites("Edit", { file_path: "rel/b.md" })?.paths, ["rel/b.md"]);
  assert.deepEqual(claudeToolWrites("NotebookEdit", { notebook_path: "/w/n.ipynb" })?.paths, ["/w/n.ipynb"]);
  assert.equal(claudeToolWrites("Read", { file_path: "/w/a.py" }), null, "读文件不是写入");
  assert.equal(claudeToolWrites("Bash", { command: "echo > /w/x" }), null, "shell 命令写到哪不从命令文本里猜");
  assert.deepEqual(
    codexChangeWrites({ changes: [{ path: "/w/a.ts", kind: { type: "update", move_path: "/w/b.ts" } }, { path: "/w/c.ts", kind: { type: "add" } }] })?.paths,
    ["/w/a.ts", "/w/b.ts", "/w/c.ts"], "codex 改名的目标也算写过",
  );
  assert.deepEqual(codexChangeWrites({ path: "/w/old.ts" })?.paths, ["/w/old.ts"], "老版本单个 path 的形状照认");
  assert.equal(codexChangeWrites({ changes: [] }), null);
  assert.deepEqual(codexCommandCwd({ command: "ls", cwd: "/w/sub" }), { kind: "writes", paths: ["/w/sub"], cwd: true });
  assert.equal(codexCommandCwd({ command: "ls" }), null, "协议没带工作目录就不记");

  // ── 1b. claude 流：主会话与子智能体的写入都报出来 ───────────────────────────
  const { parseClaudeStream } = await import("../src/executors/claude.js");
  const collectClaude = async (lines: unknown[]) => {
    const script = join(stage, `claude-${Math.random().toString(36).slice(2, 8)}.mjs`);
    writeFileSync(script, lines.map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + "\n")});`).join("\n"));
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin?.end();
    const events: AgentEvent[] = [];
    for await (const event of parseClaudeStream(child as never)) events.push(event);
    return events;
  };
  const claudeEvents = await collectClaude([
    { type: "system", subtype: "init", session_id: "cs1", cwd: stage },
    { type: "assistant", message: { model: "m", content: [
      { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/w/main.py", content: "x".repeat(4000) } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
    ] } },
    { type: "assistant", parent_tool_use_id: "agent1", message: { model: "m", content: [
      { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/w/child.py", old_string: "a", new_string: "b" } },
    ] } },
    { type: "result", subtype: "success", session_id: "cs1", is_error: false, result: "" },
  ]);
  assert.deepEqual(writesOf(claudeEvents).map((event) => event.paths), [["/w/main.py"], ["/w/child.py"]],
    `主会话的 Write 和子智能体的 Edit 都要报出写入位置：${JSON.stringify(writesOf(claudeEvents))}`);

  // ── 1c. codex app-server：主线程改文件、命令工作目录、子线程改文件 ──────────
  const { openCodexAppServer } = await import("../src/executors/codex-app-server.js");
  const app = openCodexAppServer({ bin: "fixture", args: [], cwd: stage, prompt: "fixture", startProcess: () => spawn(process.execPath, ["-e", `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'main' } } });
  if (message.method === 'thread/archive') send({ id: message.id, result: {} });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn' } } });
    send({ method: 'item/started', params: { threadId: 'main', item: { type: 'fileChange', id: 'f1', changes: [{ path: '/w/brief.md', kind: { type: 'add' }, diff: 'x' }] } } });
    send({ method: 'item/started', params: { threadId: 'main', item: { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/w/sub' } } });
    send({ method: 'item/started', params: { threadId: 'child', item: { type: 'fileChange', id: 'f2', changes: [{ path: '/w/child.md', kind: { type: 'add' }, diff: 'x' }] } } });
    send({ method: 'turn/completed', params: { threadId: 'child', turn: { status: 'completed' } } });
    send({ method: 'turn/completed', params: { threadId: 'main', turn: { status: 'completed' } } });
  }
});
`], { stdio: ["pipe", "pipe", "pipe"] }) });
  const codexEvents: AgentEvent[] = [];
  for await (const event of app.events) codexEvents.push(event);
  assert.deepEqual(
    writesOf(codexEvents).map((event) => [event.paths, !!event.cwd]),
    [[["/w/brief.md"], false], [["/w/sub"], true], [["/w/child.md"], false]],
    `codex 主线程、子线程的改文件和命令工作目录都要报出来：${JSON.stringify(writesOf(codexEvents))}`,
  );

  // ── 2. 记录端 ───────────────────────────────────────────────────────────────
  const { monitors, projects, sessions, sessionTurns, tasks, taskWrites } = await import("../src/db/schema.js");
  const { recordTaskWrites, watchTaskWrites } = await import("../src/task-writes.js");
  const { bus } = await import("../src/bus.js");
  const { readTaskArtifacts } = await import("../src/task-artifacts.js");

  const shared = join(stage, "empty");
  mkdirSync(shared, { recursive: true });
  const iso = (at: Date) => at.toISOString();
  const minutes = (base: Date, n: number) => new Date(base.getTime() + n * 60 * 1000);
  const T = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await db.insert(projects).values({ id: "pc", name: "empty", repoPath: shared, createdAt: iso(T) });

  /** 一个共享目录上的任务，回合记录完整（精确区间），跑在 [start, end]。 */
  const runTask = async (id: string, start: Date, end: Date) => {
    await db.insert(tasks).values({
      id, projectId: "pc", title: id, body: "-", mode: "single", status: "done",
      agentType: "claude", useWorktree: false, createdAt: iso(start), updatedAt: iso(end),
    });
    await db.insert(sessions).values({
      id: `s-${id}`, taskId: id, role: "main", agentType: "claude", executor: "claude",
      cwd: shared, startedAt: iso(start), endedAt: iso(end), turnStartedAt: iso(start), exitStatus: 0,
      cliSessionId: `cli-${id}`, commandLine: "claude -p", activeMs: end.getTime() - start.getTime(),
      turnsStarted: 1, turnsBase: 0, turnsBaseApprox: false, turnsLost: 0,
    });
    await db.insert(sessionTurns).values({
      id: `t-${id}`, sessionId: `s-${id}`, taskId: id, cwd: shared, startedAt: iso(start), endedAt: iso(end),
    });
  };
  // 宿主视频（Host）与讲解视频（Explain）同时在跑：[T, T+40] 和 [T+10, T+50]。Solo 在两小时后
  // 单独跑；Blind 跟 Host 同时在跑，但它的执行器什么写入都没报过（老任务、没接上的执行器）。
  await runTask("Host00000001", T, minutes(T, 40));
  await runTask("Explain00002", minutes(T, 10), minutes(T, 50));

  // 相对路径按会话目录展开，同一路径只留一行。
  await recordTaskWrites("Host00000001", "s-Host00000001", { kind: "writes", paths: ["videos/host/scripts/build.py"] }, iso(minutes(T, 12)));
  await recordTaskWrites("Host00000001", "s-Host00000001", { kind: "writes", paths: [join(shared, "videos/host/scripts/build.py")] }, iso(minutes(T, 20)));
  const hostRows = await db.select().from(taskWrites);
  assert.equal(hostRows.length, 1, `同一个文件写两次只留一行：${JSON.stringify(hostRows)}`);
  assert.equal(hostRows[0]!.path, join(shared, "videos/host/scripts/build.py"), "相对路径要按会话工作目录展开");
  assert.equal(hostRows[0]!.firstAt, iso(minutes(T, 12)));
  assert.equal(hostRows[0]!.lastAt, iso(minutes(T, 20)));
  // 总线上那条 writes 事件就是写入端的入口（三条执行链都把执行器事件原样广播）。
  watchTaskWrites();
  bus.publish({ type: "agent.event", taskId: "Explain00002", sessionId: "s-Explain00002", role: "main",
    event: { kind: "writes", paths: [join(shared, "videos/explain/BRIEF.md")] } });
  // 讲解任务曾经进到宿主的目录里看过一眼（命令工作目录，弱证据）。
  bus.publish({ type: "agent.event", taskId: "Explain00002", sessionId: "s-Explain00002", role: "main",
    event: { kind: "writes", paths: [join(shared, "videos/host/assets")], cwd: true } });
  for (let tries = 0; tries < 50 && (await db.select().from(taskWrites)).length < 3; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await db.select().from(taskWrites)).length, 3, "总线上的 writes 事件要落进库里");

  // ── 3. 裁决 ─────────────────────────────────────────────────────────────────
  const place = (rel: string, at: Date) => {
    mkdirSync(join(shared, rel, ".."), { recursive: true });
    writeFileSync(join(shared, rel), png);
    utimesSync(join(shared, rel), at, at);
  };
  // 宿主用 shell 渲染出来的视频：写文件记录里没有它，但它在宿主自己搭的目录里。
  place("videos/host/assets/chunk-01.mp4", minutes(T, 20));
  // 讲解任务的截图：落在两边都在跑的那一段里。
  place("videos/explain/evidence/player-end.png", minutes(T, 25));
  // 离两边一样近（都只共享 videos/ 这一层）。
  place("videos/封面.png", minutes(T, 30));
  // 只有宿主在跑的那十分钟里写下的，离讲解任务的目录反而更近——没有并发，照旧按时间认。
  place("videos/explain/早到的.png", minutes(T, 5));

  const root = { path: shared, branch: null, gitRepo: false, source: "repo" as const, repo: null, projectId: "pc" };
  const read = async (id: string) => {
    const got = await readTaskArtifacts(id, root);
    assert.equal(got.error, null, `${id} 读得通：${got.error}`);
    return got;
  };
  const conf = (got: Awaited<ReturnType<typeof read>>, path: string) =>
    got.artifacts.find((artifact) => artifact.path === path)?.confidence ?? null;

  const host = await read("Host00000001");
  assert.equal(conf(host, "videos/host/assets/chunk-01.mp4"), "exact",
    "两边同时在跑，但视频在宿主自己写过的目录旁边：确定是宿主的");
  assert.equal(conf(host, "videos/explain/evidence/player-end.png"), null,
    "讲解任务的截图离讲解任务写过的地方更近：不许出现在宿主的清单里（这正是起因那次串台）");
  assert.equal(conf(host, "videos/封面.png"), "approx", "一样近就比不出来，只能当候选");
  assert.equal(conf(host, "videos/explain/早到的.png"), "exact", "那一刻没有别人在跑：照旧按时间认，裁决不插手");
  assert.ok(host.incomplete.some((note) => note.includes("有 1 个文件离它们写过的地方更近")),
    `判给别人的要说一声：${JSON.stringify(host.incomplete)}`);

  const explain = await read("Explain00002");
  assert.equal(conf(explain, "videos/explain/evidence/player-end.png"), "exact");
  assert.equal(conf(explain, "videos/host/assets/chunk-01.mp4"), null,
    "讲解任务只是进宿主目录看过一眼（命令工作目录），压不过宿主在那儿真写过文件");
  assert.equal(conf(explain, "videos/封面.png"), "approx");
  assert.equal(conf(explain, "videos/explain/早到的.png"), null, "讲解任务开跑之前的文件不归它（时间判据照旧）");

  // 一个同时在跑、却一条写入记录都没有的任务：宿主那边就再也确认不了任何一个并发期间的文件，
  // 只能当候选——拿不出证据的一方不能被当成「肯定不是它」。
  await runTask("Blind0000003", minutes(T, 15), minutes(T, 35));
  const hostWithBlind = await read("Host00000001");
  assert.equal(conf(hostWithBlind, "videos/host/assets/chunk-01.mp4"), "approx",
    "有个同时在跑的对手没有任何写入记录可比：宿主离得再近也只能当候选");
  assert.equal(conf(hostWithBlind, "videos/explain/evidence/player-end.png"), null,
    "有记录的对手更近照样判给它");
  const blind = await read("Blind0000003");
  // 反过来，没记录的那一方也不能被别人「挨得近」就把东西全拿走：它可能是没接上写入记录的
  // 执行器，在隔壁目录里干活——别人只是共享了上层目录，就把它的产物判走，那是另一种串台。
  assert.equal(conf(blind, "videos/host/assets/chunk-01.mp4"), "approx", "自己没有记录：拿不出证据就不硬判，留作候选");
  assert.equal(conf(blind, "videos/封面.png"), "approx");

  // 讲解任务回合结束后，后台渲染还在它的子目录里跑（哨兵的工作目录是 videos/explain，不是
  // 工作区根）。那一段仍是它在往这个工作区里写：渲染出来的成片归它；宿主那时已经收工，不沾。
  await db.insert(monitors).values({
    id: "mon-explain", taskId: "Explain00002", command: "render", cwd: join(shared, "videos/explain"),
    status: "exited", logPath: join(stage, "mon.log"), startedAt: iso(minutes(T, 50)),
    expiresAt: iso(minutes(T, 80)), endedAt: iso(minutes(T, 60)),
  });
  place("videos/explain/delivery/成片.mp4", minutes(T, 55));
  assert.equal(conf(await read("Explain00002"), "videos/explain/delivery/成片.mp4"), "exact",
    "哨兵挂在工作区的子目录里也是在往这个工作区写——它的运行时间要算");
  assert.equal(conf(await read("Host00000001"), "videos/explain/delivery/成片.mp4"), null);

  // ── 4. 没有并发：跟以前一模一样 ───────────────────────────────────────────
  const later = minutes(T, 120);
  await runTask("Solo00000004", later, minutes(later, 10));
  place("videos/explain/后来的.png", minutes(later, 5));
  const solo = await read("Solo00000004");
  assert.equal(conf(solo, "videos/explain/后来的.png"), "exact",
    "这一段只有它在跑，哪怕文件离别的任务写过的地方更近（那是两小时前的事）也照旧算它的");
  assert.ok(!solo.incomplete.some((note) => note.includes("离它们写过的地方更近")));

  console.log("✓ task writes: claude 主会话/子智能体、codex 主线程/子线程都报出写入位置，记录端展开相对路径并去重");
  console.log("✓ task artifacts: 共享目录上同时在跑的任务按写入位置分开——近者得、一样近当候选、看一眼压不过真写过、没并发不插手");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
