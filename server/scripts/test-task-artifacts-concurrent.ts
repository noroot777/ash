// 共享目录上**同时在跑**的任务，生成物怎么分开（server/src/task-artifacts.ts 顶部那几条）。
//
// 起因（2026-11-04）：两个任务都没开 worktree、都在同一个不是 git 仓库的目录里干活，运行区间
// 重叠了半个多小时，一个任务的生成物面板混进了另一个任务的几百个文件。时间分不开它们；曾经按
// 「谁在附近写过东西」去猜作者，每一种猜法都有反例。现在的判法只认直接证据：
//
//   1. 执行器那一侧把写入位置报出来（claude 主会话与子智能体、codex 主线程与子线程），只报
//      **写成了的**；内容指纹只从这次操作自己带的内容算（Write 的全文、Edit 回执里的原文加替换、
//      codex 新建文件的全文），**不读磁盘**——回执到达之前文件可能已经被别人覆盖了；
//   2. 记录端：相对路径按会话目录展开、软链解开、同一路径去重，乱序到达只往外扩，指纹认更晚的；
//   3. 归属：亲手写下且一字未变 → 确定，不问时间和还有谁；现在这份正是别人亲手写下的 → 不列；
//      两边写下过同样内容 → 候选；只能按时间认的**一律候选**（哪怕那一刻只有它在跑：ash 管不到的
//      后台进程照样能写，用户 2026-11-04 拍板），那一刻还有别的任务在跑——不管它在哪个目录——
//      就说出是谁（看不见的项目不报标题）；协作关系不算别人。
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
  const { claudeToolWrites, codexChangeWrites, codexCommandCwd, ClaudeWriteLedger, soleReceipt } = await import("../src/executors/tool-writes.js");
  const { contentDigest, fileDigest } = await import("../src/file-digest.js");

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
    // 一条消息只装着一个结果时，回执（tool_use_result）跟着进来：Edit 的指纹靠它推出全文。
    { type: "assistant", message: { model: "m", content: [
      { type: "tool_use", id: "t7", name: "Edit", input: { file_path: "/w/page.html", old_string: "v1", new_string: "v2" } },
    ] } },
    { type: "user", tool_use_result: { filePath: "/w/page.html", originalFile: "<p>v1</p>", oldString: "v1", newString: "v2", replaceAll: false },
      message: { content: [{ type: "tool_result", tool_use_id: "t7", content: "ok" }] } },
    { type: "assistant", parent_tool_use_id: "agent1", message: { model: "m", content: [
      { type: "tool_use", id: "t8", name: "Edit", input: { file_path: "/w/child.html", old_string: "a", new_string: "b" } },
    ] } },
    { type: "user", parent_tool_use_id: "agent1", tool_use_result: { filePath: "/w/child.html", originalFile: "<a>", oldString: "a", newString: "b" },
      message: { content: [{ type: "tool_result", tool_use_id: "t8", content: "ok" }] } },
    // 等不到结果（被打断）的写调用也不算。
    { type: "assistant", message: { model: "m", content: [
      { type: "tool_use", id: "t6", name: "Write", input: { file_path: "/w/interrupted.py", content: "x" } },
    ] } },
    { type: "result", subtype: "success", session_id: "cs1", is_error: false, result: "" },
  ]);
  assert.deepEqual(writesOf(claudeEvents).map((event) => event.paths), [["/w/main.py"], ["/w/child.py"], ["/w/page.html"], ["/w/child.html"]],
    `主会话的 Write 和子智能体的 Edit 都要报出写入位置，报错的、没等到结果的不算：${JSON.stringify(writesOf(claudeEvents))}`);
  assert.deepEqual(writesOf(claudeEvents).slice(2).map((event) => event.digests),
    [{ "/w/page.html": contentDigest("<p>v2</p>") }, { "/w/child.html": contentDigest("<b>") }],
    "主会话、子智能体的回执都要接上：Edit 按回执里的原文推出写完之后的全文");

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
      const item = { type: 'fileChange', id, changes: [{ path, kind: { type: 'add' }, diff: '<p>' + id + '</p>' }] };
      send({ method: 'item/started', params: { threadId, item: { ...item, status: 'inProgress' } } });
      send({ method: 'item/completed', params: { threadId, item: { ...item, status } } });
    };
    change('main', 'f1', '/w/brief.html', 'completed');
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
    [[["/w/brief.html"], false], [["/w/sub"], true], [["/w/child.md"], false]],
    `codex 主线程、子线程的改文件和命令工作目录都要报出来，只在做完时报、没做成的不算：${JSON.stringify(writesOf(codexEvents))}`,
  );
  assert.deepEqual(writesOf(codexEvents)[0]!.digests, { "/w/brief.html": contentDigest("<p>f1</p>") }, "codex 新建的文件，diff 就是全文");


  // ── 1d. 内容指纹只从这次操作自己带的内容算 ────────────────────────────────────
  // 起因（审查 TgRjUOJWF1Ci 第 1 轮 #1）：收到「写成了」时才去读磁盘，读到的可能已经是别人覆盖
  // 之后的那一版——写完到回执被解析之间隔着进程间管道和事件排队。
  const fresh = join(stage, "fresh");
  mkdirSync(fresh, { recursive: true });
  const page = join(fresh, "page.html");
  const ledger = new ClaudeWriteLedger(fresh);
  ledger.toolUse("Write", { file_path: "page.html", content: "<h1>A original</h1>" }, "w1");
  writeFileSync(page, "<h1>A original</h1>");
  writeFileSync(page, "<h1>B replacement</h1>"); // 回执还没到，别人用命令覆盖了它
  assert.deepEqual(ledger.toolResult("w1", false), { kind: "writes", paths: [page], digests: { [page]: contentDigest("<h1>A original</h1>") } },
    "Write 的指纹是它写下的全文，不是收到回执时磁盘上那份");
  ledger.toolUse("Write", { file_path: "build.py", content: "print(1)" }, "w2");
  assert.deepEqual(ledger.toolResult("w2", false), { kind: "writes", paths: [join(fresh, "build.py")] }, "不是产物的文件不记指纹");
  const edit = (id: string, input: Record<string, unknown>, receipt?: unknown) => {
    ledger.toolUse(input.edits ? "MultiEdit" : "Edit", { file_path: "page.html", ...input }, id);
    const got = ledger.toolResult(id, false, receipt);
    return got?.kind === "writes" ? got.digests?.[page] ?? null : "missing";
  };
  assert.equal(edit("e1", { old_string: "A", new_string: "A2" }, { filePath: page, originalFile: "<h1>A original</h1>", oldString: "A", newString: "A2" }),
    contentDigest("<h1>A2 original</h1>"), "Edit：回执里改之前的原文按这次的替换推一遍");
  assert.equal(edit("e2", { old_string: "o", new_string: "0", replace_all: true }, { filePath: page, originalFile: "foo", oldString: "o", newString: "0", replaceAll: true }),
    contentDigest("f00"), "全部替换");
  assert.equal(edit("e3", { old_string: "A", new_string: "B" }), null, "没有回执就推不出全文：只报路径");
  assert.equal(edit("e4", { old_string: "A", new_string: "B" }, { filePath: join(fresh, "other.html"), originalFile: "A" }), null, "回执说的不是这个文件就不用");
  assert.equal(edit("e5", { old_string: "zz", new_string: "B" }, { filePath: page, originalFile: "A" }), null, "旧串在原文里找不到：推不出来");
  assert.equal(edit("e6", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "b", new_string: "c" }] }, { filePath: page, originalFileContents: "ab", edits: [{ old_string: "a", new_string: "b" }, { old_string: "b", new_string: "c" }] }),
    contentDigest("cb"), "MultiEdit 依次替换");
  // 一条消息里有好几个结果时，回执对应哪个说不清，不用。
  const block = (id: string) => ({ type: "tool_result", tool_use_id: id });
  assert.equal(soleReceipt({ tool_use_result: { x: 1 }, message: { content: [block("a"), block("b")] } }), undefined);
  assert.deepEqual(soleReceipt({ tool_use_result: { x: 1 }, message: { content: [block("a")] } }), { x: 1 });
  // codex：新建文件的 diff 就是全文；改已有文件的 diff、`codex exec` 不带内容的形状，都推不出来。
  const svg = join(fresh, "out.svg");
  assert.deepEqual(codexChangeWrites({ status: "completed", changes: [{ path: "out.svg", kind: { type: "add" }, diff: "<svg/>" }] }, fresh),
    { kind: "writes", paths: [svg], digests: { [svg]: contentDigest("<svg/>") } }, "codex 新建的产物文件按 diff 记指纹");
  assert.deepEqual(codexChangeWrites({ status: "completed", changes: [{ path: "out.svg", kind: { type: "update" }, diff: "@@ -1 +1 @@" }] }, fresh),
    { kind: "writes", paths: [svg] }, "改已有文件只给了 diff：只报路径");
  assert.deepEqual(codexChangeWrites({ type: "file_change", status: "completed", changes: [{ path: "out.svg", kind: "add" }] }, fresh),
    { kind: "writes", paths: [svg] }, "codex exec 的形状没有内容：只报路径");

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
  await recordTaskWrites("Host00000001", "s-Host00000001", { kind: "writes", paths: ["/w/x.html"] }, iso(minutes(T, 31)));
  assert.equal((await rowsOf("Host00000001")).find((row) => row.path === "/w/x.html")?.digest, null,
    "更晚那次推不出内容：旧指纹已经不是它最后写下的样子，清掉");
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
  // （放在几天前：下面的归属用例问的是「那一刻整台机器上还有谁在跑」，各场景的时间不能交叠。）
  const M = minutes(T, -5 * 24 * 60);
  await db.insert(tasks).values({ id: "Move00000011", projectId: "pc", title: "move", body: "-", mode: "single",
    status: "done", agentType: "claude", useWorktree: false, createdAt: iso(M), updatedAt: iso(M) });
  await db.insert(sessions).values({ id: "s-move", taskId: "Move00000011", role: "main", agentType: "claude",
    executor: "claude", cwd: join(stage, "old"), startedAt: iso(M), endedAt: iso(minutes(M, 20)) });
  await db.insert(sessionTurns).values({ id: "t-move-1", sessionId: "s-move", taskId: "Move00000011", cwd: join(stage, "old"), startedAt: iso(M), endedAt: iso(minutes(M, 5)) });
  await recordTaskWrites("Move00000011", "s-move", { kind: "writes", paths: ["output/before.md"] }, iso(minutes(M, 1)));
  await db.insert(sessionTurns).values({ id: "t-move-2", sessionId: "s-move", taskId: "Move00000011", cwd: join(stage, "new"), startedAt: iso(minutes(M, 10)) });
  await recordTaskWrites("Move00000011", "s-move", { kind: "writes", paths: ["output/after.md"] }, iso(minutes(M, 11)));
  await db.update(sessionTurns).set({ endedAt: iso(minutes(M, 20)) }).where(eq(sessionTurns.id, "t-move-2"));
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
    await recordTaskWrites(id, sessionId, { kind: "writes", paths: [abs], digests: { [abs]: contentDigest(content)! } }, iso(at));
  };
  const rootAt = (dir: string, projectId: string) => ({ path: dir, branch: null, gitRepo: false, source: "repo" as const, repo: null, projectId });
  const root = rootAt(shared, "pc");
  const read = async (id: string, at = root, visible: Set<string> | null = null) => {
    const got = await readTaskArtifacts(id, at, visible);
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
  assert.equal(conf(host, "videos/早到的.png"), "timed", "那一刻只有它在跑也只是候选：只按时间认的证明不了是它做的");
  assert.ok(!host.incomplete.some((note) => note.includes("估出来")),
    `区间都是精确的，不该说「估出来的」（并发这类原因标在卡片上）：${JSON.stringify(host.incomplete)}`);
  const explain = await read("Explain00002");
  assert.equal(conf(explain, "videos/explain/index.html"), "exact");
  assert.equal(conf(explain, "videos/host/index.html"), null);
  assert.equal(conf(explain, "videos/host/assets/chunk-01.mp4"), "concurrent", "两边都不能把命令渲染的那份标成确定");
  assert.equal(conf(explain, "videos/早到的.png"), null, "讲解任务开跑之前的文件不归它（时间判据照旧）");

  // 亲手写下的网页后来被改过（谁改的不知道）：内容对不上，只能按改动那一刻的时间认。
  place(shared, "videos/host/index.html", minutes(T, 30), "<p>someone edited</p>");
  assert.equal(conf(await read("Host00000001"), "videos/host/index.html"), "concurrent");
  assert.equal(conf(await read("Explain00002"), "videos/host/index.html"), "concurrent", "不再是宿主那一版，就不能再替宿主排除掉别人");
  // 回执晚到（审查 TgRjUOJWF1Ci 第 1 轮 #1 的复现）：宿主写下网页、回执还没到，讲解任务用命令把它
  // 覆盖成自己的内容。宿主那边不能把讲解的版本认成自己亲手写下的。
  const raceLedger = new ClaudeWriteLedger(shared);
  raceLedger.toolUse("Write", { file_path: "videos/host/report.html", content: "<h1>host original</h1>" }, "race");
  place(shared, "videos/host/report.html", minutes(T, 28), "<h1>host original</h1>");
  place(shared, "videos/host/report.html", minutes(T, 29), "<h1>explain replacement</h1>");
  await recordTaskWrites("Host00000001", "s-Host00000001", raceLedger.toolResult("race", false)!, iso(minutes(T, 29)));
  const raced = await read("Host00000001");
  assert.equal(conf(raced, "videos/host/report.html"), "concurrent", "磁盘上已经不是它写下的那份：只能按时间认，那一刻讲解也在跑");
  assert.equal(await fileDigest(join(shared, "videos/host/report.html")), contentDigest("<h1>explain replacement</h1>"));
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
  assert.equal(conf(await read("Explain00002"), "videos/explain/delivery/成片.mp4"), "timed", "哨兵挂在子目录里也是在这儿干活（宿主那时已收工，不点名）");
  assert.equal(conf(await read("Host00000001"), "videos/explain/delivery/成片.mp4"), null);

  // ── 3b. 那一刻还有谁在跑：整台机器上的全部任务 ─────────────────────────────────
  // 一个在**别的项目、别的目录**里跑、一条写入记录都没有的任务：照样算在跑——它完全可以用一条
  // 命令把东西生成到这里，而命令写到哪儿是记不下来的。
  const elsewhere = join(stage, "outside-project");
  mkdirSync(elsewhere, { recursive: true });
  await db.insert(projects).values({ id: "po", name: "outside", repoPath: elsewhere, createdAt: iso(T) });
  await runTask("Blind0000003", minutes(T, 1), minutes(T, 8), { dir: elsewhere, project: "po" });
  assert.equal(conf(await read("Host00000001"), "videos/早到的.png"), "concurrent", "别处跑的、没有写入记录的也算在跑");
  await db.delete(sessionTurns).where(eq(sessionTurns.taskId, "Blind0000003"));
  await db.delete(sessions).where(eq(sessions.taskId, "Blind0000003"));
  // 协作关系不算别人：领队常驻在同一个目录、审查在审讲解任务，它们的时间里本来就包着讲解的活。
  await runTask("Lead00000005", minutes(T, 45), minutes(T, 70), { extra: { mode: "team" } });
  await db.update(tasks).set({ parentId: "Lead00000005" }).where(eq(tasks.id, "Explain00002"));
  await runTask("Review000006", minutes(T, 45), minutes(T, 70), { extra: { reviewOf: "Explain00002" } });
  const withCrew = await read("Explain00002");
  assert.equal(conf(withCrew, "videos/explain/delivery/成片.mp4"), "timed", "领队、审查本任务的不是别人：不算「同时有别的任务」");
  // 审查 TgRjUOJWF1Ci 第 1 轮 #2 的复现：B 在兄弟目录里跑，用命令把网页写进 A 的目录；它报上来的
  // 只有命令的工作目录。A 那边这份不能是确定的；B 不在跑的那段照旧确定。
  const target = join(stage, "shell-target");
  mkdirSync(target, { recursive: true });
  await db.insert(projects).values({ id: "pt", name: "target", repoPath: target, createdAt: iso(T) });
  await runTask("Near00000007", minutes(T, 200), minutes(T, 300), { dir: target, project: "pt" });
  await runTask("Far000000008", minutes(T, 210), minutes(T, 240), { dir: elsewhere, project: "po" });
  await recordTaskWrites("Far000000008", "s-Far000000008", codexCommandCwd({ status: "completed", command: "node gen.js", cwd: elsewhere })!, iso(minutes(T, 220)));
  await addTurn("Far000000008", "s-Far-2", minutes(T, 260), minutes(T, 290), elsewhere);
  place(target, "outside.html", minutes(T, 220), "<h1>Generated only by B from another cwd</h1>");
  place(target, "between.png", minutes(T, 250));
  const near = await read("Near00000007", rootAt(target, "pt"));
  assert.equal(conf(near, "outside.html"), "concurrent", "输出目标记不下来：那一刻有别的任务在跑，就不能算确定");
  assert.deepEqual(pick(near, "outside.html")?.alongside, ["任务Far000000008"]);
  // 查看者看不见对方那个项目（审查 TgRjUOJWF1Ci 第 2 轮 #1）：照样当候选，但不报它的标题。
  const nearForMember = await read("Near00000007", rootAt(target, "pt"), new Set(["pt"]));
  assert.equal(conf(nearForMember, "outside.html"), "concurrent", "看不见的任务照样算在跑");
  assert.deepEqual(pick(nearForMember, "outside.html")?.alongside, ["另一个你无权查看的任务"], "看不见的项目不报标题");
  assert.ok(!JSON.stringify(nearForMember).includes("Far000000008"), "响应里哪儿都不能带出它");
  assert.equal(conf(near, "between.png"), "timed", "它两段之间没在跑：不点名，但仍是候选");
  // 同一个目录换个入口（软链）：亲手写下的记录按真实路径认。
  const link = join(stage, "empty-link");
  symlinkSync(shared, link);
  await runTask("Via000000009", minutes(T, 400), minutes(T, 440), { dir: link });
  await runTask("Real00000010", minutes(T, 400), minutes(T, 440), { dir: join(stage, "elsewhere") });
  await handWrite("Real00000010", shared, "via/page.html", minutes(T, 410), "<p>real</p>");
  place(shared, "via/shot.png", minutes(T, 420));
  const via = await read("Via000000009", rootAt(link, "pc"));
  assert.equal(conf(via, "via/page.html"), null, "从另一个入口看，别人亲手写下的照样认得出来");
  assert.equal(conf(via, "via/shot.png"), "concurrent");

  // ── 3c. 「那一刻只有它在跑」也不算确定 ──────────────────────────────────────
  // 审查 TgRjUOJWF1Ci 第 2 轮 #2 的复现：别的任务起了个后台进程，自己的回合收了尾，后台几秒后才把
  // 网页写进这里——ash 的记录里那一刻只有本任务在跑。按时间认的在共享目录上一律是候选（用户
  // 2026-11-04 拍板），不靠「没看到别人」升成确定。
  const bg = join(stage, "bg-target");
  mkdirSync(bg, { recursive: true });
  await db.insert(projects).values({ id: "pb", name: "bg", repoPath: bg, createdAt: iso(T) });
  const B0 = minutes(T, -2 * 24 * 60);
  await runTask("BgOwner00001", B0, minutes(B0, 40), { dir: bg, project: "pb" });
  await runTask("BgOther00002", minutes(B0, 5), minutes(B0, 10), { dir: elsewhere, project: "po" });
  place(bg, "foreign.html", minutes(B0, 10.1), "<h1>written by a background job of BgOther</h1>");
  const bgRead = await read("BgOwner00001", rootAt(bg, "pb"));
  assert.equal(conf(bgRead, "foreign.html"), "timed", "ash 记录里那一刻没别人，照样只是候选");
  assert.deepEqual(bgRead.incomplete, [], "这不是记录缺口，不往页脚说");
  await db.run(sql`ALTER TABLE task_writes RENAME TO task_writes_off`);
  try {
    const broken = await readTaskArtifacts("Host00000001", root, null);
    assert.notEqual(conf(broken, "videos/host/收尾.html"), "exact", "读不出亲手写下的记录：那条直接证据就没了");
    assert.equal(conf(broken, "videos/早到的.png"), "timed");
    assert.ok(broken.error?.includes("亲手写下"), `失败要说出来：${broken.error}`);
  } finally {
    await db.run(sql`ALTER TABLE task_writes_off RENAME TO task_writes`);
  }

  // ── 3d. 写过的深层目录先扫，不被预算挤掉 ─────────────────────────────────────
  const scanDir = join(stage, "scandir");
  mkdirSync(join(scanDir, "output/a"), { recursive: true });
  for (let i = 0; i < 40010; i += 1) writeFileSync(join(scanDir, `output/a/${i}.txt`), "");
  await db.insert(projects).values({ id: "pd", name: "scandir", repoPath: scanDir, createdAt: iso(T) });
  const F = minutes(T, -3.5 * 24 * 60);
  await runTask("Focus0000013", F, minutes(F, 15), { dir: scanDir, project: "pd" });
  await recordTaskWrites("Focus0000013", "s-Focus0000013", { kind: "writes", paths: [join(scanDir, "output/z/render.py")] }, iso(minutes(F, 2)));
  place(scanDir, "output/z/final.png", minutes(F, 5));
  const focused = await read("Focus0000013", rootAt(scanDir, "pd"));
  assert.equal(conf(focused, "output/z/final.png"), "timed", `写过的那处先扫，成片不能被预算挤掉：${JSON.stringify(focused.incomplete)}`);

  // ── 4. 没有并发：照样列出来，只是按时间认的仍是候选，页脚不多说 ──────────────
  const later = minutes(T, 900);
  await runTask("Solo00000014", later, minutes(later, 10));
  place(shared, "videos/explain/后来的.png", minutes(later, 5));
  const solo = await read("Solo00000014");
  assert.equal(conf(solo, "videos/explain/后来的.png"), "timed", "这一段只有它在跑：列出来，候选");
  assert.equal(pick(solo, "videos/explain/后来的.png")?.alongside, undefined, "没别人在跑就不点名");
  assert.deepEqual(solo.incomplete, [], `没有并发就什么都不该说：${JSON.stringify(solo.incomplete)}`);

  console.log("✓ task writes: claude 主会话/子智能体、codex 主线程/子线程报出写入位置；指纹只从这次操作写下的内容算、不读磁盘；记录端展开相对路径、解开软链、去重、乱序只往外扩");
  console.log("✓ task artifacts: 亲手写下且未变 → 确定；别人亲手写下的 → 不列；只靠时间认的一律候选，当时还有任务在跑（不管在哪）就说出是谁、看不见的不报标题");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
