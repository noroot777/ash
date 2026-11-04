// 共享目录上**同时在跑**的两个任务，生成物怎么分开（server/src/task-artifact-footprint.ts）。
//
// 起因（2026-11-04）：两个任务都没开 worktree、都在同一个不是 git 仓库的目录里干活，运行区间
// 重叠了半个多小时。时间判据对这种情形无能为力——两边的文件修改时间都落在两边的区间里——于是
// 一个任务的生成物面板混进了另一个任务的 572 个文件。分开它们的证据是「谁在附近写过东西」：
// 执行器当场报出写文件工具的目标路径和命令的工作目录，ash 记进 task_writes。
//
// 这里钉四件事：
//   1. 执行器那一侧真的把写入位置报出来了（claude 主会话与子智能体、codex 主线程与子线程），
//      而且是从结构化参数取的，不受展示用 detail 的截短影响；只报**写成了的**（报错的 Edit、
//      失败的改文件不算）；
//   2. 记录端：相对路径按会话目录展开、同一路径去重；
//   3. 裁决：离谁写过的地方更近就归谁；一样近、或有一方没记录可比，就只当候选；进去看一眼
//      （命令工作目录）压不过真写过（写文件工具）。对手按**目录**找（跨项目、开在上层目录的
//      都算），别处干活的不占名额，没比全如实降级；审查自己、领队不算对手；共享仓库里按时间
//      找到的提交也按提交时刻裁决，而且裁决的是**现在这一版**（之后被别人改过、提交过的，
//      旧提交不能替它作保；任务分支证明也要核对磁盘上这份是不是分支那一版）；判某一刻的文件
//      只认那一刻已经有的写入记录（后来续聊写的说明不能回头改判早先的成品）；裁决读失败时一律
//      当候选；任务写过的深层目录先扫，不被它写过的上层目录吞掉，也不被排序额度挤到末尾；
//      相对路径按这一趟实际的工作目录展开；
//   4. 没有并发的时候行为一点不变。
// 跑：npm -w server run test:task-artifacts-concurrent
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { eq, inArray, sql } from "drizzle-orm";
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
    codexChangeWrites({ status: "completed", changes: [{ path: "/w/a.ts", kind: { type: "update", move_path: "/w/b.ts" } }, { path: "/w/c.ts", kind: { type: "add" } }] })?.paths,
    ["/w/a.ts", "/w/b.ts", "/w/c.ts"], "codex 改名的目标也算写过",
  );
  assert.deepEqual(codexChangeWrites({ status: "completed", path: "/w/old.ts" })?.paths, ["/w/old.ts"], "老版本单个 path 的形状照认");
  assert.equal(codexChangeWrites({ status: "completed", changes: [] }), null);
  for (const status of ["failed", "declined", "inProgress", undefined]) {
    assert.equal(codexChangeWrites({ status, changes: [{ path: "/w/a.ts" }] }), null, `没做成（${status}）的改文件不算写过`);
  }
  assert.deepEqual(codexCommandCwd({ status: "completed", command: "ls", cwd: "/w/sub" }), { kind: "writes", paths: ["/w/sub"], cwd: true });
  // 相对路径在执行器这一层就按这一趟起进程的目录展开；拿不到绝对目录才原样交给记录端。
  assert.deepEqual(claudeToolWrites("Write", { file_path: "out/a.html" }, "/run/new")?.paths, ["/run/new/out/a.html"]);
  assert.deepEqual(codexChangeWrites({ status: "completed", changes: [{ path: "out/b.md" }] }, "/run/new")?.paths, ["/run/new/out/b.md"]);
  assert.deepEqual(codexCommandCwd({ status: "completed", cwd: "sub" }, "/run/new")?.paths, ["/run/new/sub"]);
  assert.deepEqual(claudeToolWrites("Write", { file_path: "out/a.html" }, ".")?.paths, ["out/a.html"], "接管进程时的 \".\" 不算基准");
  assert.deepEqual(codexCommandCwd({ status: "failed", command: "false", cwd: "/w/sub" })?.paths, ["/w/sub"], "失败的命令也确实在那儿跑过");
  assert.equal(codexCommandCwd({ status: "declined", command: "rm", cwd: "/w/sub" }), null, "被拒绝的命令压根没跑");
  assert.equal(codexCommandCwd({ status: "completed", command: "ls" }), null, "协议没带工作目录就不记");

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
      { type: "tool_use", id: "t4", name: "Edit", input: { file_path: "/w/elsewhere/nope.py", old_string: "a", new_string: "b" } },
    ] } },
    { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "tool_result", tool_use_id: "t2", content: "" },
      { type: "tool_result", tool_use_id: "t4", content: "String to replace not found", is_error: true },
    ] } },
    { type: "assistant", parent_tool_use_id: "agent1", message: { model: "m", content: [
      { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/w/child.py", old_string: "a", new_string: "b" } },
      { type: "tool_use", id: "t5", name: "Write", input: { file_path: "/w/child-failed.py", content: "x" } },
    ] } },
    { type: "user", parent_tool_use_id: "agent1", message: { content: [
      { type: "tool_result", tool_use_id: "t3", content: "ok" },
      { type: "tool_result", tool_use_id: "t5", content: "EACCES", is_error: true },
    ] } },
    // 等不到结果（被打断）的写调用也不算。
    { type: "assistant", message: { model: "m", content: [
      { type: "tool_use", id: "t6", name: "Write", input: { file_path: "/w/interrupted.py", content: "x" } },
    ] } },
    { type: "result", subtype: "success", session_id: "cs1", is_error: false, result: "" },
  ]);
  assert.deepEqual(writesOf(claudeEvents).map((event) => event.paths), [["/w/main.py"], ["/w/child.py"]],
    `主会话的 Write 和子智能体的 Edit 都要报出写入位置，报错的、没等到结果的不算：${JSON.stringify(writesOf(claudeEvents))}`);

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
    const change = (threadId, id, path, status) => {
      const item = { type: 'fileChange', id, changes: [{ path, kind: { type: 'add' }, diff: 'x' }] };
      send({ method: 'item/started', params: { threadId, item: { ...item, status: 'inProgress' } } });
      send({ method: 'item/completed', params: { threadId, item: { ...item, status } } });
    };
    change('main', 'f1', '/w/brief.md', 'completed');
    change('main', 'f3', '/w/rejected.md', 'failed');
    const command = { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/w/sub' };
    send({ method: 'item/started', params: { threadId: 'main', item: { ...command, status: 'inProgress' } } });
    send({ method: 'item/completed', params: { threadId: 'main', item: { ...command, status: 'completed', exitCode: 0 } } });
    change('child', 'f2', '/w/child.md', 'completed');
    change('child', 'f4', '/w/child-declined.md', 'declined');
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
    `codex 主线程、子线程的改文件和命令工作目录都要报出来，只在做完时报、没做成的不算：${JSON.stringify(writesOf(codexEvents))}`,
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
  const runTask = async (
    id: string, start: Date, end: Date,
    { dir = shared, project = "pc", extra = {} }: { dir?: string; project?: string; extra?: Partial<typeof tasks.$inferInsert> } = {},
  ) => {
    await db.insert(tasks).values({
      id, projectId: project, title: id, body: "-", mode: "single", status: "done",
      agentType: "claude", useWorktree: false, createdAt: iso(start), updatedAt: iso(end), ...extra,
    });
    await db.insert(sessions).values({
      id: `s-${id}`, taskId: id, role: "main", agentType: "claude", executor: "claude",
      cwd: dir, startedAt: iso(start), endedAt: iso(end), turnStartedAt: iso(start), exitStatus: 0,
      cliSessionId: `cli-${id}`, commandLine: "claude -p", activeMs: end.getTime() - start.getTime(),
      turnsStarted: 1, turnsBase: 0, turnsBaseApprox: false, turnsLost: 0,
    });
    await db.insert(sessionTurns).values({
      id: `t-${id}`, sessionId: `s-${id}`, taskId: id, cwd: dir, startedAt: iso(start), endedAt: iso(end),
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
  // 总线那两条按「现在」落的账；把它们挪回讲解任务当时写下的那一刻（T+11），下面的裁决只认
  // 文件落下时已经有的记录。
  await db.update(taskWrites).set({ firstAt: iso(minutes(T, 11)), lastAt: iso(minutes(T, 11)) })
    .where(eq(taskWrites.taskId, "Explain00002"));

  // 同一条会话续聊换了工作目录、执行器又没给绝对路径时：按眼下这一回合的目录展开，不按会话
  // 当初的目录（也不能被上一次查到的结果缓存住）。
  await db.insert(tasks).values({ id: "Move00000011", projectId: "pc", title: "move", body: "-", mode: "single",
    status: "done", agentType: "claude", useWorktree: false, createdAt: iso(T), updatedAt: iso(T) });
  await db.insert(sessions).values({ id: "s-move", taskId: "Move00000011", role: "main", agentType: "claude",
    executor: "claude", cwd: join(stage, "old"), startedAt: iso(T) });
  await db.insert(sessionTurns).values({ id: "t-move-1", sessionId: "s-move", taskId: "Move00000011", cwd: join(stage, "old"), startedAt: iso(T), endedAt: iso(minutes(T, 5)) });
  await recordTaskWrites("Move00000011", "s-move", { kind: "writes", paths: ["output/before.md"] }, iso(minutes(T, 1)));
  await db.insert(sessionTurns).values({ id: "t-move-2", sessionId: "s-move", taskId: "Move00000011", cwd: join(stage, "new"), startedAt: iso(minutes(T, 10)) });
  await recordTaskWrites("Move00000011", "s-move", { kind: "writes", paths: ["output/after.md"] }, iso(minutes(T, 11)));
  assert.deepEqual(
    (await db.select().from(taskWrites).where(eq(taskWrites.taskId, "Move00000011"))).map((row) => row.path).sort(),
    [join(stage, "new/output/after.md"), join(stage, "old/output/before.md")],
    "换了工作目录之后写的，要记在新目录下",
  );

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
  // 下面几段要看清各自那一处，不让这个没记录的对手把一切都拖成候选。
  await db.delete(sessionTurns).where(eq(sessionTurns.taskId, "Blind0000003"));
  await db.delete(sessions).where(eq(sessions.taskId, "Blind0000003"));

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

  // ── 3b. 协作关系不算对手 ──────────────────────────────────────────────────────
  // 宿主和讲解是同一个团队的两个执行者（兄弟照样是对手），领队常驻在同一个目录；另有一个
  // 审查在审讲解任务。领队、审查都没报过写入——当成对手的话，讲解任务的截图就再也确定不了。
  await runTask("Lead00000005", minutes(T, 5), minutes(T, 55), { extra: { mode: "team" } });
  await db.update(tasks).set({ parentId: "Lead00000005" }).where(inArray(tasks.id, ["Host00000001", "Explain00002"]));
  await runTask("Review000006", minutes(T, 12), minutes(T, 48), { extra: { reviewOf: "Explain00002" } });
  assert.equal(conf(await read("Explain00002"), "videos/explain/evidence/player-end.png"), "exact",
    "审查本任务的、本任务所在团队的领队，本来就跟它共用这摊活：不是对手");
  assert.equal(conf(await read("Host00000001"), "videos/explain/evidence/player-end.png"), null,
    "同一个团队的兄弟执行者仍是对手：讲解的截图照样不归宿主");

  // ── 3c. 别处干活的任务不占对手名额 ──────────────────────────────────────────
  // 同项目里一大批在别的目录干活、时间更近的任务。按项目找再截断的话，它们会把真正同在这个
  // 目录里的讲解任务挤出名单，宿主于是又把讲解的截图认成自己的。
  const noise = join(stage, "noise");
  mkdirSync(noise, { recursive: true });
  for (let i = 0; i < 30; i += 1) {
    await runTask(`Noise${String(i).padStart(7, "0")}`, minutes(T, 39), minutes(T, 41), { dir: noise });
  }
  assert.equal(conf(await read("Host00000001"), "videos/explain/evidence/player-end.png"), null,
    "先按工作目录筛掉别处的，再谈名额");
  assert.ok(!(await read("Host00000001")).incomplete.some((note) => note.includes("没能逐个比对")));

  // ── 3d. 共享仓库里按时间找到的提交也要裁决 ──────────────────────────────────
  // 两个任务都直接在同一个仓库的主分支上提交（没有属于自己的任务分支），时间上重叠。按时间
  // 找到的提交不自带归属：提交时刻那一刻谁在场、谁离得近，才说明是谁的。
  const repo = join(stage, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (args: string[], at?: Date) => execFileSync("git", ["-C", repo, ...args], {
    env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: iso(at), GIT_COMMITTER_DATE: iso(at) } : {}) },
  });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  await db.insert(projects).values({ id: "pg", name: "repo", repoPath: repo, createdAt: iso(T) });
  await runTask("GitA00000007", T, minutes(T, 40), { dir: repo, project: "pg" });
  await runTask("GitB00000008", minutes(T, 10), minutes(T, 50), { dir: repo, project: "pg" });
  await recordTaskWrites("GitA00000007", "s-GitA00000007", { kind: "writes", paths: [join(repo, "a/build.py")] }, iso(minutes(T, 15)));
  await recordTaskWrites("GitB00000008", "s-GitB00000008", { kind: "writes", paths: [join(repo, "b/notes.md")] }, iso(minutes(T, 15)));
  const commit = (rel: string, at: Date) => {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), png);
    git(["add", rel]);
    git(["commit", "-q", "-m", rel], at);
  };
  // 只有 A 在跑时它提交的两份（B 从 T+10 才开工）。
  commit("b/page.html", minutes(T, 5));
  commit("a/v.png", minutes(T, 5));
  commit("a/out.png", minutes(T, 20));
  commit("b/shot.png", minutes(T, 25));
  // A 收工之后，B 又提交改了一遍 A 的图。
  writeFileSync(join(repo, "a/v.png"), Buffer.concat([png, Buffer.from("B")]));
  git(["commit", "-q", "-am", "B touches a/v.png"], minutes(T, 45));
  // B 在两边都在跑的时候改了 A 早先提交的网页，还没提交。
  writeFileSync(join(repo, "b/page.html"), "B current version, not committed");
  utimesSync(join(repo, "b/page.html"), minutes(T, 20), minutes(T, 20));
  const repoRoot = { path: repo, branch: "main", gitRepo: true, source: "repo" as const, repo, projectId: "pg" };
  const readRepo = async (id: string) => {
    const got = await readTaskArtifacts(id, repoRoot);
    assert.equal(got.error, null, `${id} 读得通：${got.error}`);
    return got;
  };
  const gitA = await readRepo("GitA00000007");
  assert.equal(conf(gitA, "a/out.png"), "exact", "自己目录里的提交：确定是它的");
  assert.equal(conf(gitA, "b/shot.png"), null, "同一刻对方在场、离对方写过的地方更近：别人的提交不许混进来");
  assert.equal(conf(gitA, "b/page.html"), null,
    "A 早先提交过这个网页，可现在磁盘上是 B 并发时改出来的未提交版本：按现在这一版裁决，归 B");
  assert.equal(conf(gitA, "a/v.png"), "approx",
    "A 收工后被别人提交改过：现在这一版不是 A 那次提交落下的，只能当候选（也不从面板上抹掉）");
  const gitB = await readRepo("GitB00000008");
  assert.equal(conf(gitB, "b/shot.png"), "exact");
  assert.equal(conf(gitB, "a/out.png"), null, "按提交时刻裁决：那一刻两边都在场，提交在 A 的目录里");
  assert.equal(conf(gitB, "b/page.html"), "exact", "现在这一版是 B 在自己目录里改的");
  assert.equal(gitB.artifacts.find((artifact) => artifact.path === "b/page.html")?.origin, "working");

  // ── 3d'. 深层的重点目录不被上层的吞掉 ────────────────────────────────────────
  // 任务在 output/ 放了说明、又在 output/z/ 出了成片；output/ 被忽略，旁边一个子目录里堆着
  // 比扫描预算还多的无关文件。两处都写过，最深的那处要先扫——git 与非 git 两条入口都一样。
  const scanRepo = join(stage, "scanrepo");
  mkdirSync(join(scanRepo, "output/a"), { recursive: true });
  mkdirSync(join(scanRepo, "output/z"), { recursive: true });
  execFileSync("git", ["-C", scanRepo, "init", "-q"]);
  writeFileSync(join(scanRepo, ".gitignore"), "output/\n");
  for (let i = 0; i < 40010; i += 1) writeFileSync(join(scanRepo, `output/a/${i}.txt`), "");
  await db.insert(projects).values({ id: "ps", name: "scanrepo", repoPath: scanRepo, createdAt: iso(T) });
  await runTask("Focus0000010", T, minutes(T, 15), { dir: scanRepo, project: "ps" });
  for (const rel of ["output/BRIEF.md", "output/z/render.py"]) {
    await recordTaskWrites("Focus0000010", "s-Focus0000010", { kind: "writes", paths: [join(scanRepo, rel)] }, iso(minutes(T, 2)));
  }
  writeFileSync(join(scanRepo, "output/z/final.png"), png);
  utimesSync(join(scanRepo, "output/z/final.png"), minutes(T, 5), minutes(T, 5));
  for (const gitRepo of [true, false]) {
    const got = await readTaskArtifacts("Focus0000010", { ...repoRoot, path: scanRepo, repo: gitRepo ? scanRepo : null, gitRepo, projectId: "ps" });
    assert.equal(conf(got, "output/z/final.png"), "exact",
      `${gitRepo ? "git" : "非 git"}：上层也写过时，深层那处照样先扫，成片不能被预算挤掉：${JSON.stringify(got.incomplete)}`);
  }
  // 被忽略的入口比排序额度（4000）还多，任务自己写过的那个入口排在最后：它照样要先扫，不能
  // 因为没轮上排序就被扔到所有普通入口后面。
  const manyRepo = join(stage, "manyrepo");
  mkdirSync(manyRepo, { recursive: true });
  execFileSync("git", ["-C", manyRepo, "init", "-q"]);
  writeFileSync(join(manyRepo, ".gitignore"), "/d*/\n/zz-mine/\n");
  for (let d = 0; d <= 4000; d += 1) {
    const dir = join(manyRepo, `d${String(d).padStart(4, "0")}`);
    mkdirSync(dir);
    for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, `${i}.txt`), "");
  }
  mkdirSync(join(manyRepo, "zz-mine"));
  writeFileSync(join(manyRepo, "zz-mine/final.png"), png);
  utimesSync(join(manyRepo, "zz-mine/final.png"), minutes(T, 5), minutes(T, 5));
  await db.insert(projects).values({ id: "pm", name: "manyrepo", repoPath: manyRepo, createdAt: iso(T) });
  await runTask("Many00000015", T, minutes(T, 15), { dir: manyRepo, project: "pm" });
  await recordTaskWrites("Many00000015", "s-Many00000015", { kind: "writes", paths: [join(manyRepo, "zz-mine/render.py")] }, iso(minutes(T, 2)));
  const many = await readTaskArtifacts("Many00000015", { ...repoRoot, path: manyRepo, repo: manyRepo, projectId: "pm" });
  assert.equal(conf(many, "zz-mine/final.png"), "exact", `重点入口排在排序额度之外也要先扫：${JSON.stringify(many.incomplete)}`);

  // ── 3e. 没比全就如实降级 ──────────────────────────────────────────────────
  // 同一个目录里同时在跑的任务多到核不过来：没核到的那些里可能就有离得更近的人，不能判「是它的」。
  const crowd = join(stage, "crowd");
  mkdirSync(crowd, { recursive: true });
  await db.insert(projects).values({ id: "pk", name: "crowd", repoPath: crowd, createdAt: iso(T) });
  const crowdRoot = { ...root, path: crowd, projectId: "pk" };
  await runTask("Crowd0000000", T, minutes(T, 40), { dir: crowd, project: "pk" });
  await recordTaskWrites("Crowd0000000", "s-Crowd0000000", { kind: "writes", paths: [join(crowd, "mine/x.py")] }, iso(minutes(T, 5)));
  mkdirSync(join(crowd, "mine"), { recursive: true });
  writeFileSync(join(crowd, "mine/a.png"), png);
  utimesSync(join(crowd, "mine/a.png"), minutes(T, 20), minutes(T, 20));
  const crowdConf = async () => {
    const got = await readTaskArtifacts("Crowd0000000", crowdRoot);
    return { got, at: conf(got, "mine/a.png") };
  };
  for (let i = 1; i <= 48; i += 1) {
    const id = `Crowd${String(i).padStart(7, "0")}`;
    await runTask(id, minutes(T, 10), minutes(T, 30), { dir: crowd, project: "pk" });
    await recordTaskWrites(id, `s-${id}`, { kind: "writes", paths: [join(crowd, `r${i}/x.py`)] }, iso(minutes(T, 12)));
  }
  assert.equal((await crowdConf()).at, "exact", "48 个对手都核到了、都离得远：确定是它的");
  await runTask("Crowd0000049", minutes(T, 10), minutes(T, 30), { dir: crowd, project: "pk" });
  await recordTaskWrites("Crowd0000049", "s-Crowd0000049", { kind: "writes", paths: [join(crowd, "r49/x.py")] }, iso(minutes(T, 12)));
  const crowded = await crowdConf();
  assert.equal(crowded.at, "approx", "超过上限、没核全：只能当候选");
  assert.ok(crowded.got.incomplete.some((note) => note.includes("没能逐个比对")), `没比全要说出来：${JSON.stringify(crowded.got.incomplete)}`);

  // ── 3e'. 后来的记录不能回头改判早先的成品 ─────────────────────────────────────
  // A、B 曾同时在跑，A 的网页那时就做完了。B 两小时后续聊，只在 A 的网页旁边写了一份说明。
  const late = join(stage, "late");
  mkdirSync(join(late, "videos/a/deep"), { recursive: true });
  await db.insert(projects).values({ id: "pl", name: "late", repoPath: late, createdAt: iso(T) });
  const lateRoot = { ...root, path: late, projectId: "pl" };
  await runTask("LateA0000012", T, minutes(T, 40), { dir: late, project: "pl" });
  await runTask("LateB0000013", T, minutes(T, 40), { dir: late, project: "pl" });
  await recordTaskWrites("LateA0000012", "s-LateA0000012", { kind: "writes", paths: [join(late, "videos/a/build.py")] }, iso(minutes(T, 2)));
  await recordTaskWrites("LateB0000013", "s-LateB0000013", { kind: "writes", paths: [join(late, "videos/b/build.py")] }, iso(minutes(T, 2)));
  writeFileSync(join(late, "videos/a/deep/final.html"), "<p>A</p>");
  utimesSync(join(late, "videos/a/deep/final.html"), minutes(T, 20), minutes(T, 20));
  const lateConf = async (id: string) => conf(await readTaskArtifacts(id, lateRoot), "videos/a/deep/final.html");
  assert.equal(await lateConf("LateA0000012"), "exact");
  await db.insert(sessions).values({
    id: "s-LateB-2", taskId: "LateB0000013", role: "main", agentType: "claude", executor: "claude", cwd: late,
    startedAt: iso(minutes(T, 120)), endedAt: iso(minutes(T, 140)), turnStartedAt: iso(minutes(T, 120)), exitStatus: 0,
    cliSessionId: "cli-LateB-2", commandLine: "claude -p", activeMs: 20 * 60 * 1000,
    turnsStarted: 1, turnsBase: 0, turnsBaseApprox: false, turnsLost: 0,
  });
  await db.insert(sessionTurns).values({ id: "t-LateB-2", sessionId: "s-LateB-2", taskId: "LateB0000013", cwd: late, startedAt: iso(minutes(T, 120)), endedAt: iso(minutes(T, 140)) });
  await recordTaskWrites("LateB0000013", "s-LateB-2", { kind: "writes", paths: [join(late, "videos/a/deep/later.md")] }, iso(minutes(T, 130)));
  assert.equal(await lateConf("LateA0000012"), "exact", "两小时后别人在旁边写的说明，不能把 A 早就做完的网页改判出去");
  assert.equal(await lateConf("LateB0000013"), null, "B 那份说明是网页做完之后才有的，不能拿来认领它");

  // 裁决本身读失败（写入位置那张表读不了）：核不了不等于没别人，按时间认的一律当候选。
  await db.run(sql`ALTER TABLE task_writes RENAME TO task_writes_off`);
  try {
    const broken = await readTaskArtifacts("LateA0000012", lateRoot);
    assert.equal(conf(broken, "videos/a/deep/final.html"), "approx", "裁决失败不能退回「确定」");
    assert.ok(broken.error?.includes("写入位置"), `失败要说出来：${broken.error}`);
  } finally {
    await db.run(sql`ALTER TABLE task_writes_off RENAME TO task_writes`);
  }

  // ── 3e''. 任务分支证明只替分支那一版作保 ─────────────────────────────────────
  // 任务的 worktree 清理掉了、分支还在，面板退回主仓展示。主仓里这条路径后来被别的任务提交成了
  // 另一版：分支差异只证明「它的分支改过这条路径」，磁盘上这份不是它的那一版。
  const branchRepo = join(stage, "branchrepo");
  mkdirSync(branchRepo, { recursive: true });
  const bgit = (args: string[]) => execFileSync("git", ["-C", branchRepo, ...args]);
  bgit(["init", "-q", "-b", "main"]);
  bgit(["config", "user.email", "t@t"]);
  bgit(["config", "user.name", "t"]);
  writeFileSync(join(branchRepo, "README.md"), "base");
  bgit(["add", "."]);
  bgit(["commit", "-q", "-m", "base"]);
  bgit(["checkout", "-q", "-b", "ash/Branch00"]);
  writeFileSync(join(branchRepo, "report.html"), "<p>A version</p>");
  writeFileSync(join(branchRepo, "keep.png"), png);
  bgit(["add", "."]);
  bgit(["commit", "-q", "-m", "A"]);
  bgit(["checkout", "-q", "main"]);
  writeFileSync(join(branchRepo, "report.html"), "<p>B version</p>");
  writeFileSync(join(branchRepo, "keep.png"), png);
  bgit(["add", "."]);
  bgit(["commit", "-q", "-m", "B"]);
  await db.insert(projects).values({ id: "pb", name: "branchrepo", repoPath: branchRepo, createdAt: iso(T) });
  await runTask("Branch000014", T, minutes(T, 30), {
    dir: join(branchRepo, ".worktrees/Branch000014"), project: "pb", extra: { useWorktree: true, mergeTargetBranch: "main" },
  });
  const branchRead = await readTaskArtifacts("Branch000014", { ...repoRoot, path: branchRepo, repo: branchRepo, projectId: "pb" });
  assert.equal(branchRead.error, null, `${branchRead.error}`);
  assert.equal(conf(branchRead, "keep.png"), "exact", "磁盘上这份就是分支那一版：分支证明照旧成立");
  assert.equal(conf(branchRead, "report.html"), "approx", "磁盘上是别人后来提交的另一版：不能凭分支差异标成确定");

  // ── 3f. 对手按目录找：别的项目、开在上层目录的都算 ────────────────────────────
  // 另一个项目登记在上层目录，它的任务在那儿跑、往这个目录的 videos/upper 里写东西。按项目找
  // 对手的话它根本不在名单里，它做的图就落成宿主和讲解两边都比不出的候选。
  await db.insert(projects).values({ id: "pu", name: "upper", repoPath: stage, createdAt: iso(T) });
  await runTask("Upper0000009", minutes(T, 20), minutes(T, 30), { dir: stage, project: "pu" });
  await recordTaskWrites("Upper0000009", "s-Upper0000009", { kind: "writes", paths: [join(shared, "videos/upper/x.py")] }, iso(minutes(T, 21)));
  place("videos/upper/图.png", minutes(T, 25));
  assert.equal(conf(await read("Host00000001"), "videos/upper/图.png"), null,
    "开在上层目录、属于别的项目的任务也在这儿写过东西：它的图不归宿主");
  assert.equal(conf(await read("Explain00002"), "videos/upper/图.png"), null);

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
  console.log("✓ task artifacts: 对手按目录找（跨项目、上层目录）、协作关系不算对手、没比全如实降级、共享仓库的提交按提交时刻裁决");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
