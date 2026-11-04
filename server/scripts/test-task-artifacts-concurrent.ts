// 共享目录上**同时在跑**的任务，生成物怎么分开（server/src/task-artifacts.ts 顶部那几条）。
//
// 起因（2026-11-04）：两个任务都没开 worktree、都在同一个不是 git 仓库的目录里干活，运行区间
// 重叠了半个多小时，一个任务的生成物面板混进了另一个任务的几百个文件。时间分不开它们；曾经按
// 「谁在附近写过东西」去猜作者，每一种猜法都有反例。现在的判法只认直接证据：
//
//   1. 执行器那一侧把写入位置报出来（claude 主会话与子智能体、codex 主线程与子线程），只报
//      **写成了的**，写成那一刻当场记下产物文件的内容指纹；
//   2. 记录端：相对路径按会话目录展开、软链解开、同一路径去重，乱序到达只往外扩，指纹认更晚的；
//   3. 归属：亲手写下且一字未变 → 确定，不问时间和还有谁；现在这份正是别人亲手写下的 → 不列；
//      两边写下过同样内容 → 候选；只能按时间认的，那一刻有别人在场（按工作目录找、按写进来的
//      记录找、跨项目、上层目录）→ 候选并说出是谁，没核全 / 核对失败 → 候选；协作关系不算别人；
//   4. 没有并发的时候行为一点不变。
// git 仓库那一半（提交、分支版本）在 test-task-artifacts-evidence.ts。
// 跑：npm -w server run test:task-artifacts-concurrent
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { eq, sql } from "drizzle-orm";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const tmp = mkdtempSync(join(tmpdir(), "ash-artifacts-concurrent-"));
process.env.ASH_DB = join(tmp, "ash.db");
// 解开软链（macOS 的 /var 是 /private/var）：记录端存的是真实路径，断言按同一种写法比。
const stage = realpathSync(tmp);
requireTmpDb("task-artifacts-concurrent");

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const writesOf = (events: AgentEvent[]) =>
  events.filter((event): event is Extract<AgentEvent, { kind: "writes" }> => event.kind === "writes");

try {
  // 先建表：claude 流解析会顺手起后台任务的记账，库得先就绪。
  const { db, ensureSchema } = await import("../src/db/index.js");
  await ensureSchema();
  const { claudeToolWrites, codexChangeWrites, codexCommandCwd, ClaudeWriteLedger } = await import("../src/executors/tool-writes.js");
  const { fileDigestSync } = await import("../src/file-digest.js");

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


  // ── 1d. 写成那一刻的内容指纹 ────────────────────────────────────────────────
  // 只给产物那几类文件记、只在写成了的时候记，而且是当场冻住的：之后文件再被改，事件里那份不变。
  const fresh = join(stage, "fresh");
  mkdirSync(fresh, { recursive: true });
  writeFileSync(join(fresh, "page.html"), "<p>v1</p>");
  writeFileSync(join(fresh, "build.py"), "print(1)");
  const ledger = new ClaudeWriteLedger(fresh);
  ledger.toolUse("Write", { file_path: "page.html", content: "<p>v1</p>" }, "w1");
  ledger.toolUse("Write", { file_path: "build.py", content: "print(1)" }, "w2");
  const pageWrite = ledger.toolResult("w1", false);
  const written = fileDigestSync(join(fresh, "page.html"));
  writeFileSync(join(fresh, "page.html"), "<p>changed later</p>");
  assert.deepEqual(pageWrite, { kind: "writes", paths: [join(fresh, "page.html")], digests: { [join(fresh, "page.html")]: written } },
    "网页写成要记下那一刻的指纹");
  assert.notEqual(written, fileDigestSync(join(fresh, "page.html")), "后来的改动不能混进事件里那份指纹");
  assert.deepEqual(ledger.toolResult("w2", false), { kind: "writes", paths: [join(fresh, "build.py")] }, "不是产物的文件不记指纹");
  writeFileSync(join(fresh, "out.svg"), "<svg/>");
  assert.deepEqual(codexChangeWrites({ status: "completed", changes: [{ path: "out.svg" }] }, fresh),
    { kind: "writes", paths: [join(fresh, "out.svg")], digests: { [join(fresh, "out.svg")]: fileDigestSync(join(fresh, "out.svg")) } },
    "codex 改完的产物文件同样记指纹");

  // ── 2. 记录端 ───────────────────────────────────────────────────────────────
  const { monitors, projects, sessions, sessionTurns, tasks, taskWrites } = await import("../src/db/schema.js");
  const { recordTaskWrites, watchTaskWrites } = await import("../src/task-writes.js");
  const { bus } = await import("../src/bus.js");
  const { readTaskArtifacts } = await import("../src/task-artifacts.js");

  const shared = join(stage, "empty");
  mkdirSync(shared, { recursive: true });
  const iso = (at: Date) => at.toISOString();
  const minutes = (base: Date, n: number) => new Date(base.getTime() + n * 60 * 1000);
  const T = new Date(Date.now() - 6 * 60 * 60 * 1000);
  await db.insert(projects).values({ id: "pc", name: "empty", repoPath: shared, createdAt: iso(T) });

  /** 一个任务，一条会话、一个回合（精确区间），跑在 [start, end]。 */
  const runTask = async (
    id: string, start: Date, end: Date,
    { dir = shared, project = "pc", extra = {} }: { dir?: string; project?: string; extra?: Partial<typeof tasks.$inferInsert> } = {},
  ) => {
    await db.insert(tasks).values({
      id, projectId: project, title: `任务${id}`, body: "-", mode: "single", status: "done",
      agentType: "claude", useWorktree: false, createdAt: iso(start), updatedAt: iso(end), ...extra,
    });
    await addTurn(id, `s-${id}`, start, end, dir, true);
  };
  /** 给任务再加一条会话 + 回合（续聊、换目录）。 */
  const addTurn = async (id: string, sessionId: string, start: Date, end: Date, dir: string, first = false) => {
    if (first || !(await db.select().from(sessions).where(eq(sessions.id, sessionId))).length) {
      await db.insert(sessions).values({
        id: sessionId, taskId: id, role: "main", agentType: "claude", executor: "claude",
        cwd: dir, startedAt: iso(start), endedAt: iso(end), turnStartedAt: iso(start), exitStatus: 0,
        cliSessionId: `cli-${sessionId}`, commandLine: "claude -p", activeMs: end.getTime() - start.getTime(),
        turnsStarted: 1, turnsBase: 0, turnsBaseApprox: false, turnsLost: 0,
      });
    }
    await db.insert(sessionTurns).values({
      id: `t-${sessionId}-${start.getTime()}`, sessionId, taskId: id, cwd: dir, startedAt: iso(start), endedAt: iso(end),
    });
  };
  const rowsOf = (id: string) => db.select().from(taskWrites).where(eq(taskWrites.taskId, id));

  await runTask("Host00000001", T, minutes(T, 40));
  await runTask("Explain00002", minutes(T, 10), minutes(T, 50));
  // 相对路径按会话目录展开，同一路径只留一行；乱序到达时两端只往外扩。
  await recordTaskWrites("Host00000001", "s-Host00000001", { kind: "writes", paths: ["videos/host/scripts/build.py"] }, iso(minutes(T, 20)));
  await recordTaskWrites("Host00000001", "s-Host00000001", { kind: "writes", paths: [join(shared, "videos/host/scripts/build.py")] }, iso(minutes(T, 12)));
  await recordTaskWrites("Host00000001", "s-Host00000001", { kind: "writes", paths: [join(shared, "videos/host/scripts/build.py")] }, iso(minutes(T, 15)));
  const hostRows = await rowsOf("Host00000001");
  assert.equal(hostRows.length, 1, `同一个文件写几次只留一行：${JSON.stringify(hostRows)}`);
  assert.equal(hostRows[0]!.path, join(shared, "videos/host/scripts/build.py"), "相对路径要按会话工作目录展开");
  assert.equal(hostRows[0]!.firstAt, iso(minutes(T, 12)), "晚到的记录更早：最早那一端往前扩");
  assert.equal(hostRows[0]!.lastAt, iso(minutes(T, 20)), "晚到的记录更早：最晚那一端不往回拨");
  // 内容指纹认更晚写下的那一次，哪怕它先落库。
  await recordTaskWrites("Host00000001", "s-Host00000001", { kind: "writes", paths: ["/w/x.html"], digests: { "/w/x.html": "new" } }, iso(minutes(T, 30)));
  await recordTaskWrites("Host00000001", "s-Host00000001", { kind: "writes", paths: ["/w/x.html"], digests: { "/w/x.html": "old" } }, iso(minutes(T, 25)));
  assert.equal((await rowsOf("Host00000001")).find((row) => row.path === "/w/x.html")?.digest, "new");
  await db.delete(taskWrites).where(eq(taskWrites.path, "/w/x.html"));
  // 总线上那条 writes 事件就是写入端的入口（三条执行链都把执行器事件原样广播）。
  watchTaskWrites();
  bus.publish({ type: "agent.event", taskId: "Explain00002", sessionId: "s-Explain00002", role: "main",
    event: { kind: "writes", paths: [join(shared, "videos/explain/BRIEF.md")] } });
  for (let tries = 0; tries < 50 && (await rowsOf("Explain00002")).length < 1; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await rowsOf("Explain00002")).length, 1, "总线上的 writes 事件要落进库里");
  // 同一条会话续聊换了工作目录、执行器又没给绝对路径时：按眼下这一回合的目录展开。
  await db.insert(tasks).values({ id: "Move00000011", projectId: "pc", title: "move", body: "-", mode: "single",
    status: "done", agentType: "claude", useWorktree: false, createdAt: iso(T), updatedAt: iso(T) });
  await db.insert(sessions).values({ id: "s-move", taskId: "Move00000011", role: "main", agentType: "claude",
    executor: "claude", cwd: join(stage, "old"), startedAt: iso(T) });
  await db.insert(sessionTurns).values({ id: "t-move-1", sessionId: "s-move", taskId: "Move00000011", cwd: join(stage, "old"), startedAt: iso(T), endedAt: iso(minutes(T, 5)) });
  await recordTaskWrites("Move00000011", "s-move", { kind: "writes", paths: ["output/before.md"] }, iso(minutes(T, 1)));
  await db.insert(sessionTurns).values({ id: "t-move-2", sessionId: "s-move", taskId: "Move00000011", cwd: join(stage, "new"), startedAt: iso(minutes(T, 10)) });
  await recordTaskWrites("Move00000011", "s-move", { kind: "writes", paths: ["output/after.md"] }, iso(minutes(T, 11)));
  assert.deepEqual((await rowsOf("Move00000011")).map((row) => row.path).sort(),
    [join(stage, "new/output/after.md"), join(stage, "old/output/before.md")], "换了工作目录之后写的，要记在新目录下");

  // ── 3. 归属 ─────────────────────────────────────────────────────────────────
  const place = (dir: string, rel: string, at: Date, content: string | Buffer = png) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
    utimesSync(join(dir, rel), at, at);
  };
  /** 亲手写下一份产物：落盘、按执行器那样记下指纹、再按当时的时刻落账。 */
  const handWrite = async (id: string, dir: string, rel: string, at: Date, content: string, sessionId = `s-${id}`) => {
    place(dir, rel, at, content);
    const abs = join(dir, rel);
    await recordTaskWrites(id, sessionId, { kind: "writes", paths: [abs], digests: { [abs]: fileDigestSync(abs)! } }, iso(at));
  };
  const rootAt = (dir: string, projectId: string) => ({ path: dir, branch: null, gitRepo: false, source: "repo" as const, repo: null, projectId });
  const root = rootAt(shared, "pc");
  const read = async (id: string, at = root) => {
    const got = await readTaskArtifacts(id, at);
    assert.equal(got.error, null, `${id} 读得通：${got.error}`);
    return got;
  };
  const pick = (got: Awaited<ReturnType<typeof read>>, path: string) => got.artifacts.find((artifact) => artifact.path === path);
  const conf = (got: Awaited<ReturnType<typeof read>>, path: string) => {
    const hit = pick(got, path);
    return hit ? (hit.confidence === "exact" ? "exact" : hit.doubt ?? "approx") : null;
  };

  // 宿主亲手写下的网页；一份命令渲染出来的视频；讲解任务亲手写下的网页；只有宿主在跑时出的图。
  await handWrite("Host00000001", shared, "videos/host/index.html", minutes(T, 20), "<p>host</p>");
  place(shared, "videos/host/assets/chunk-01.mp4", minutes(T, 22));
  await handWrite("Explain00002", shared, "videos/explain/index.html", minutes(T, 25), "<p>explain</p>");
  place(shared, "videos/早到的.png", minutes(T, 5));
  // 收工之后才写完的：时间判据够不着，亲手写下的证据照样认。
  await handWrite("Host00000001", shared, "videos/host/收尾.html", minutes(T, 45), "<p>late</p>");

  const host = await read("Host00000001");
  assert.equal(conf(host, "videos/host/index.html"), "exact", "亲手写下、一字未变：确定，不管同时还有谁");
  assert.equal(conf(host, "videos/host/收尾.html"), "exact", "亲手写下的不吃时间，也不靠扫描找到");
  assert.equal(conf(host, "videos/explain/index.html"), null, "现在这份正是讲解任务亲手写下的：不列（这正是起因那次串台）");
  assert.ok(host.incomplete.some((note) => note.includes("别的任务亲手写下的")), `不列的要说一声：${JSON.stringify(host.incomplete)}`);
  assert.equal(conf(host, "videos/host/assets/chunk-01.mp4"), "concurrent", "命令渲染的、那一刻讲解任务也在：分不出是谁的，当候选");
  assert.deepEqual(pick(host, "videos/host/assets/chunk-01.mp4")?.alongside, ["任务Explain00002"], "说出当时还有谁在");
  assert.equal(conf(host, "videos/早到的.png"), "exact", "那一刻只有它在跑：照旧按时间认");
  assert.ok(host.incomplete.some((note) => /有 \d+ 个归属拿不准/.test(note) && note.includes("按估出来的时间段")));
  const explain = await read("Explain00002");
  assert.equal(conf(explain, "videos/explain/index.html"), "exact");
  assert.equal(conf(explain, "videos/host/index.html"), null);
  assert.equal(conf(explain, "videos/host/assets/chunk-01.mp4"), "concurrent", "两边都不能把命令渲染的那份标成确定");
  assert.equal(conf(explain, "videos/早到的.png"), null, "讲解任务开跑之前的文件不归它（时间判据照旧）");

  // 亲手写下的网页后来被改过（谁改的不知道）：内容对不上，只能按改动那一刻的时间认。
  place(shared, "videos/host/index.html", minutes(T, 30), "<p>someone edited</p>");
  assert.equal(conf(await read("Host00000001"), "videos/host/index.html"), "concurrent");
  assert.equal(conf(await read("Explain00002"), "videos/host/index.html"), "concurrent", "不再是宿主那一版，就不能再替宿主排除掉别人");
  // 两边亲手写下过一模一样的内容：谁也证明不了。
  await handWrite("Host00000001", shared, "videos/同一份.html", minutes(T, 26), "<p>same</p>");
  await handWrite("Explain00002", shared, "videos/同一份.html", minutes(T, 27), "<p>same</p>");
  assert.equal(conf(await read("Host00000001"), "videos/同一份.html"), "contested");
  assert.equal(conf(await read("Explain00002"), "videos/同一份.html"), "contested");
  // 后来才写的东西不改判早先的成品：讲解任务两小时后续聊，在宿主网页旁边写了说明。
  await addTurn("Explain00002", "s-Explain-2", minutes(T, 120), minutes(T, 140), shared);
  await handWrite("Explain00002", shared, "videos/host/说明.html", minutes(T, 130), "<p>note</p>", "s-Explain-2");
  assert.equal(conf(await read("Host00000001"), "videos/host/收尾.html"), "exact");

  // 讲解任务回合结束后，后台渲染还在它的子目录里跑（哨兵）。那一段仍是它在往这个工作区里写；
  // 宿主那时已经收工，不沾。
  await db.insert(monitors).values({
    id: "mon-explain", taskId: "Explain00002", command: "render", cwd: join(shared, "videos/explain"),
    status: "exited", logPath: join(stage, "mon.log"), startedAt: iso(minutes(T, 50)),
    expiresAt: iso(minutes(T, 80)), endedAt: iso(minutes(T, 60)),
  });
  place(shared, "videos/explain/delivery/成片.mp4", minutes(T, 55));
  assert.equal(conf(await read("Explain00002"), "videos/explain/delivery/成片.mp4"), "exact", "哨兵挂在子目录里也是在这儿干活");
  assert.equal(conf(await read("Host00000001"), "videos/explain/delivery/成片.mp4"), null);

  // ── 3b. 在场的人怎么找 ────────────────────────────────────────────────────────
  // 一个同时在跑、一条写入记录都没有的任务（老任务、没接上的执行器）：照样算在场。
  await runTask("Blind0000003", minutes(T, 1), minutes(T, 8));
  assert.equal(conf(await read("Host00000001"), "videos/早到的.png"), "concurrent", "没有写入记录的也是在场的人");
  await db.delete(sessionTurns).where(eq(sessionTurns.taskId, "Blind0000003"));
  await db.delete(sessions).where(eq(sessions.taskId, "Blind0000003"));
  // 协作关系不算别人：领队常驻在同一个目录、审查在审讲解任务，它们的时间里本来就包着讲解的活。
  await runTask("Lead00000005", minutes(T, 45), minutes(T, 70), { extra: { mode: "team" } });
  await db.update(tasks).set({ parentId: "Lead00000005" }).where(eq(tasks.id, "Explain00002"));
  await runTask("Review000006", minutes(T, 45), minutes(T, 70), { extra: { reviewOf: "Explain00002" } });
  assert.equal(conf(await read("Explain00002"), "videos/explain/delivery/成片.mp4"), "exact", "领队、审查本任务的不是别人");
  // 从隔壁目录开工、用绝对路径写进来的任务：工作目录一点不沾，照样在场——只在它写进来的那几段。
  const sibling = join(stage, "sibling");
  mkdirSync(sibling, { recursive: true });
  await db.insert(projects).values({ id: "ps", name: "sibling", repoPath: sibling, createdAt: iso(T) });
  await runTask("Near00000007", minutes(T, 200), minutes(T, 300));
  await runTask("Far000000008", minutes(T, 210), minutes(T, 240), { dir: sibling, project: "ps" });
  await recordTaskWrites("Far000000008", "s-Far000000008", { kind: "writes", paths: [join(shared, "charts/data.csv")] }, iso(minutes(T, 211)));
  await addTurn("Far000000008", "s-Far-2", minutes(T, 260), minutes(T, 290), sibling);
  place(shared, "charts/chart.png", minutes(T, 220));
  place(shared, "charts/later.png", minutes(T, 270));
  const near = await read("Near00000007");
  assert.equal(conf(near, "charts/chart.png"), "concurrent", "写进来的那一段它在场");
  assert.equal(conf(near, "charts/later.png"), "exact", "它后来去别处续聊的那一段跟这里无关，不能整段算它在场");
  // 同一个目录换个入口（软链）：写入记录和读取都按真实路径认。
  const link = join(stage, "empty-link");
  symlinkSync(shared, link);
  await runTask("Via000000009", minutes(T, 400), minutes(T, 440), { dir: link });
  await runTask("Real00000010", minutes(T, 400), minutes(T, 440), { dir: join(stage, "elsewhere") });
  await handWrite("Real00000010", shared, "via/page.html", minutes(T, 410), "<p>real</p>");
  await recordTaskWrites("Real00000010", "s-Real00000010", { kind: "writes", paths: [join(shared, "via/x.py")] }, iso(minutes(T, 410)));
  place(shared, "via/shot.png", minutes(T, 420));
  const via = await read("Via000000009", rootAt(link, "pc"));
  assert.equal(conf(via, "via/page.html"), null, "从另一个入口看，别人亲手写下的照样认得出来");
  assert.equal(conf(via, "via/shot.png"), "concurrent", "从另一个入口写进来的人照样在场");
  // 开在上层目录、属于别的项目的任务也算在场。
  await db.insert(projects).values({ id: "pu", name: "upper", repoPath: stage, createdAt: iso(T) });
  await runTask("Upper0000011", minutes(T, 500), minutes(T, 520), { dir: stage, project: "pu" });
  await runTask("Inner0000012", minutes(T, 500), minutes(T, 520));
  place(shared, "upper/图.png", minutes(T, 510));
  assert.equal(conf(await read("Inner0000012"), "upper/图.png"), "concurrent");

  // ── 3c. 没核全、核对失败：一律候选 ──────────────────────────────────────────
  const crowd = join(stage, "crowd");
  mkdirSync(crowd, { recursive: true });
  await db.insert(projects).values({ id: "pk", name: "crowd", repoPath: crowd, createdAt: iso(T) });
  const crowdRoot = rootAt(crowd, "pk");
  await runTask("Crowd0000000", T, minutes(T, 40), { dir: crowd, project: "pk" });
  place(crowd, "mine/a.png", minutes(T, 20));
  // 跟它的区间重叠，但图出来的那一刻（T+20）都已经收工：核全了的话，答案是「没别人」。
  const crowdRival = (i: number) =>
    runTask(`Crowd${String(i).padStart(7, "0")}`, minutes(T, 10), minutes(T, 15), { dir: crowd, project: "pk" });
  for (let i = 1; i <= 48; i += 1) await crowdRival(i);
  assert.equal(conf(await read("Crowd0000000", crowdRoot), "mine/a.png"), "exact", "48 个都核到了、那一刻都不在：确定");
  await crowdRival(49);
  const crowded = await read("Crowd0000000", crowdRoot);
  assert.equal(conf(crowded, "mine/a.png"), "unchecked", "在场的人多到核不过来：没核到的里面可能就有当时在场的");
  assert.ok(crowded.incomplete.some((note) => note.includes("没能逐个核对")), `没核全要说出来：${JSON.stringify(crowded.incomplete)}`);
  await db.run(sql`ALTER TABLE task_writes RENAME TO task_writes_off`);
  try {
    const broken = await readTaskArtifacts("Host00000001", root);
    assert.equal(conf(broken, "videos/早到的.png"), "unchecked", "核对失败不能退回「没别人」");
    assert.ok(broken.error?.includes("同一时间"), `失败要说出来：${broken.error}`);
  } finally {
    await db.run(sql`ALTER TABLE task_writes_off RENAME TO task_writes`);
  }

  // ── 3d. 写过的深层目录先扫，不被预算挤掉 ─────────────────────────────────────
  const scanDir = join(stage, "scandir");
  mkdirSync(join(scanDir, "output/a"), { recursive: true });
  for (let i = 0; i < 40010; i += 1) writeFileSync(join(scanDir, `output/a/${i}.txt`), "");
  await db.insert(projects).values({ id: "pd", name: "scandir", repoPath: scanDir, createdAt: iso(T) });
  await runTask("Focus0000013", T, minutes(T, 15), { dir: scanDir, project: "pd" });
  await recordTaskWrites("Focus0000013", "s-Focus0000013", { kind: "writes", paths: [join(scanDir, "output/z/render.py")] }, iso(minutes(T, 2)));
  place(scanDir, "output/z/final.png", minutes(T, 5));
  const focused = await read("Focus0000013", rootAt(scanDir, "pd"));
  assert.equal(conf(focused, "output/z/final.png"), "exact", `写过的那处先扫，成片不能被预算挤掉：${JSON.stringify(focused.incomplete)}`);

  // ── 4. 没有并发：跟以前一模一样 ───────────────────────────────────────────
  const later = minutes(T, 900);
  await runTask("Solo00000014", later, minutes(later, 10));
  place(shared, "videos/explain/后来的.png", minutes(later, 5));
  const solo = await read("Solo00000014");
  assert.equal(conf(solo, "videos/explain/后来的.png"), "exact", "这一段只有它在跑：照旧按时间认");
  assert.ok(!solo.incomplete.some((note) => note.includes("拿不准")), `没有并发就不该说拿不准：${JSON.stringify(solo.incomplete)}`);

  console.log("✓ task writes: claude 主会话/子智能体、codex 主线程/子线程报出写入位置与写成那一刻的指纹；记录端展开相对路径、解开软链、去重、乱序只往外扩");
  console.log("✓ task artifacts: 亲手写下且未变 → 确定；别人亲手写下的 → 不列；只靠时间认的、有别人在场 → 候选并说出是谁；没核全/失败 → 候选；没并发不变");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
