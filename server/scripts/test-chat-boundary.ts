import assert from "node:assert/strict";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AgentEvent } from "@ash/shared";
import type { ChatMember, ChatSnapshot } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-boundary-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const projectDir = join(stage, "project");
mkdirSync(projectDir);
mkdirSync(join(projectDir, "node_modules", "pkg"), { recursive: true });
const source = join(projectDir, "source.txt");
writeFileSync(source, "before");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects, tasks, chatRooms, chatMessages } = await import("../src/db/schema.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
const { invokeChat } = await import("../src/chat/execution.js");
const { ChatBoundaryError, readOnlyChatTool } = await import("../src/chat/boundary.js");
const { ChatService } = await import("../src/chat/service.js");
const { mountChatRoutes } = await import("../src/chat/routes.js");
await ensureSchema();
await setInstanceMode("single", stage);
await db.insert(projects).values({ id: "project", name: "边界测试", repoPath: projectDir, createdAt: new Date().toISOString() });

for (const detail of ["cat source.txt", "/bin/zsh -lc 'cat source.txt'", 'head "source.txt"', "rg --files", JSON.stringify({ command: "cat source.txt" })]) {
  assert.equal(readOnlyChatTool({ kind: "tool", name: "exec", detail }), true, detail);
}
for (const detail of ["touch evil.txt", "cat source.txt > evil.txt", "cat source.txt; touch evil.txt", "cat $(touch evil.txt)", "rg --pre touch x", "python -c 'print(1)'", "git commit -am surprise", "cat source.txt\ntouch evil.txt", "/bin/zsh -lc 'cat source.txt; touch evil.txt'", "cat 'unterminated", "./cat source.txt", "/tmp/evil/cat source.txt"]) {
  assert.equal(readOnlyChatTool({ kind: "tool", name: "exec", detail }), false, detail);
}
assert.equal(readOnlyChatTool({ kind: "tool", name: "Read", detail: source }), true);
for (const name of ["Write", "Edit", "apply_patch", "mcp__unknown__run"]) assert.equal(readOnlyChatTool({ kind: "tool", name }), false);

const original = CLI_SPEC_BY_KEY.codex.factory;
const member: ChatMember = { id: "codex", name: "codex", agentType: "codex", executorId: null, model: null, reasoningEffort: null };
let mode = "read";
let runs = 0;
let cleanup = 0;
let changed: (() => void) | undefined;
let release: (() => void) | undefined;
CLI_SPEC_BY_KEY.codex.factory = () => ({
  type: "codex", label: "fixture", resumeCommand: () => "",
  run: (opts) => {
    runs++;
    if (mode === "sync-write") writeFileSync(join(opts.cwd, "unexpected-side-effect.txt"), "written before any event");
    if (mode === "dependency-write") writeFileSync(join(opts.cwd, "node_modules", "pkg", "side-effect.txt"), "written without any tool event");
    return {
      sessionId: "fixture", commandLine: "fixture", kill: () => { release?.(); }, cleanup: async () => { cleanup++; },
      events: (async function* (): AsyncGenerator<AgentEvent> {
        if (mode === "runtime-write") {
          await db.update(projects).set({ name: "运行期状态更新" }).where(eq(projects.id, "project"));
          mkdirSync(process.env.ASH_RUNS_DIR!, { recursive: true });
          writeFileSync(join(process.env.ASH_RUNS_DIR!, "runtime-event.json"), "{}");
        }
        if (mode === "edit-existing") writeFileSync(source, "after!");
        if (mode === "delete") rmSync(source);
        if (mode === "rename") renameSync(source, join(opts.cwd, "renamed.txt"));
        if (mode === "transient") {
          const transient = join(opts.cwd, "transient.txt");
          writeFileSync(transient, "created and deleted");
          rmSync(transient);
          await delay(100);
        }
        if (mode === "write-event") yield { kind: "tool", name: "Write", detail: "sensitive arguments not shown" };
        if (mode === "command-event") yield { kind: "tool", name: "exec", detail: "npm install something" };
        if (mode === "stream-write" || mode === "stop-write" || mode === "hold") {
          await delay(30);
          if (mode !== "hold") writeFileSync(join(opts.cwd, "during-stream.txt"), "side effect");
          const released = new Promise<void>((resolve) => { release = resolve; });
          const timeout = setTimeout(() => release?.(), 1500);
          changed?.();
          try { await released; } finally { clearTimeout(timeout); }
        }
        yield { kind: "tool", name: "Read", detail: source };
        const reply = mode === "invalid-reply" ? "这不是有效的 JSON 回复"
          : mode === "delegate" ? '{"reply":"已整理为任务。","task":{"title":"边界委派","body":"验证附注在任务启动失败时保留。"}}'
          : '{"reply":"这是咨询回复，不建任务。","task":null}';
        yield { kind: "text", text: reply };
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
  },
});
const invoke = () => invokeChat(member, null, "@codex 你建议登录页怎么改？", AbortSignal.timeout(5000), "project");
try {
  assert.equal((await invoke()).notice, undefined, "纯只读咨询不该有附注");

  // 工具事件闸门可归因，照旧硬中止。
  for (const scenario of ["write-event", "command-event"]) {
    mode = scenario;
    await assert.rejects(invoke(), (error: unknown) => error instanceof ChatBoundaryError && error.message.includes("咨询已中止") && !error.message.includes("sensitive arguments"), scenario);
  }

  // 无工具事件的目录变化无法归因（可能是智能体，也可能是任何并发操作）：不再中止，
  // 回复照常返回，附注如实报出路径，也不代为回滚。
  const observed: [string, RegExp][] = [
    ["sync-write", /unexpected-side-effect\.txt/],
    ["edit-existing", /source\.txt/],
    ["delete", /source\.txt/],
    ["rename", /renamed\.txt|source\.txt/],
    ["transient", /transient\.txt/],
    ["stream-write", /during-stream\.txt/],
  ];
  for (const [scenario, pattern] of observed) {
    mode = scenario!;
    const result = await invoke();
    assert.ok(result.text.includes("这是咨询回复"), `${scenario}: 回复不得作废`);
    assert.match(result.notice ?? "", pattern!, `${scenario}: 附注`);
    if (scenario === "sync-write") assert.ok(existsSync(join(projectDir, "unexpected-side-effect.txt")), "不代为回滚已发生的写入");
    for (const file of ["unexpected-side-effect.txt", "during-stream.txt", "renamed.txt"]) rmSync(join(projectDir, file), { force: true });
    writeFileSync(source, "before");
    release = undefined;
  }

  // 2026-09-08 事故的回归：咨询进行中，别的进程（验收合并 / 其他任务 / 用户编辑）写了项目
  // 文件。回复必须照常完成并附注，不得把成员中止。
  mode = "hold";
  changed = () => { writeFileSync(join(projectDir, "merge-artifact.txt"), "并发合并产物"); release?.(); };
  const concurrent = await invoke();
  assert.ok(concurrent.text.includes("这是咨询回复"), "并发变更不得作废回复");
  assert.match(concurrent.notice ?? "", /merge-artifact\.txt/, "并发变更须附注");
  rmSync(join(projectDir, "merge-artifact.txt"));
  changed = undefined;
  release = undefined;

  // 观察器自身失效（fs.watch 不可用）时，「没观察到」不能结算成「没有变化」：
  // 回复照常完成，但必须附注观察不可用，不得展示一条看似确认过只读的正常回复。
  mode = "read";
  const realWatch = fs.watch;
  (fs as { watch: typeof fs.watch }).watch = () => { throw Object.assign(new Error("simulated watcher unavailable"), { code: "ENOSYS" }); };
  syncBuiltinESMExports();
  try {
    const blind = await invoke();
    assert.ok(blind.text.includes("这是咨询回复"), "观察不可用时回复照常完成");
    assert.match(blind.notice ?? "", /目录观察不可用/, "观察不可用必须如实附注");
  } finally {
    (fs as { watch: typeof fs.watch }).watch = realWatch;
    syncBuiltinESMExports();
  }

  mode = "runtime-write";
  await db.insert(projects).values({ id: "runtime", name: "包含 ash 数据的项目", repoPath: stage, createdAt: new Date().toISOString() });
  assert.equal((await invokeChat(member, null, "只读咨询", AbortSignal.timeout(5000), "runtime")).notice, undefined, "ash 自身写入不附注");

  const service = new ChatService(invokeChat, async () => { throw new Error("咨询不应启动任务"); });
  const app = new Hono();
  mountChatRoutes(app, service);
  const request = (path: string, body?: unknown) => app.request(path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const room = await (await request("/chats", { projectId: "project", name: "咨询测试", members: [member] })).json() as { id: string };
  const settle = async (status: string) => {
    for (let tries = 0; tries < 150; tries++) {
      const snapshot = await (await request(`/chats/${room.id}`)).json() as ChatSnapshot;
      if (snapshot.messages.at(-1)?.status === status) return snapshot;
      await delay(20);
    }
    throw new Error(`消息未落到 ${status}`);
  };
  for (const [scenario, path] of [["sync-write", "unexpected-side-effect"], ["dependency-write", "node_modules"]]) {
    mode = scenario!;
    await request(`/chats/${room.id}/messages`, { id: `consultation-${scenario}`, body: "@codex 你建议登录页怎么改？" });
    const done = await settle("done");
    const last = done.messages.at(-1)!;
    assert.ok(last.body.includes("这是咨询回复"), `${scenario}: 回复保留`);
    assert.ok(last.body.includes(path!), `${scenario}: 附注持久化并包含路径`);
    assert.equal(last.taskId, null);
    const stored = (await db.select().from(chatMessages).where(eq(chatMessages.id, last.id))).at(0)!;
    assert.equal(stored.modelReply, "这是咨询回复，不建任务。", "附注不得混入模型回复原文");
    await service.recover();
    const refreshed = await (await request(`/chats/${room.id}`)).json() as ChatSnapshot;
    assert.equal(refreshed.messages.at(-1)!.body, last.body, "刷新/恢复后附注保留");
    assert.equal((await db.select().from(tasks)).length, 0);
  }
  rmSync(join(projectDir, "unexpected-side-effect.txt"));
  mode = "stop-write";
  let stopped: Promise<void> | undefined;
  changed = () => { stopped = service.stop(room.id); };
  await request(`/chats/${room.id}/messages`, { id: "stop-while-writing", body: "@codex 再给建议" });
  const stoppedSnapshot = await settle("stopped");
  await stopped;
  assert.match(stoppedSnapshot.messages.at(-1)!.body, /你已停止这次回复/);
  changed = undefined;
  release = undefined;

  // 审查第 2 轮回归：附注与结算结果正交——模型输出非法、任务启动失败这些终态的正文
  // 也必须保留目录附注，且刷新/恢复后仍在。附注由包装 invoke 确定性注入（正交性是
  // service 结算的性质，不依赖 fs.watch 的事件时序；watcher 端到端已由上面的场景覆盖）。
  const snapshot = async () => await (await request(`/chats/${room.id}`)).json() as ChatSnapshot;
  const roomRow = (await db.select().from(chatRooms).where(eq(chatRooms.id, room.id))).at(0)!;
  const injected = "⚠️ 注入的目录附注（injected-side-effect）";
  const injectService = new ChatService(async (...args: Parameters<typeof invokeChat>) => {
    const invoked = await invokeChat(...args);
    return { ...invoked, notice: injected };
  }, async () => { throw new Error("咨询不应启动任务"); });
  mode = "invalid-reply";
  await injectService.send(roomRow, "@codex 再给建议", "invalid-with-change", "tester");
  const invalidFailed = (await settle("failed")).messages.at(-1)!;
  assert.ok(invalidFailed.body.includes("未返回有效的简短回复"), "解析失败保留错误说明");
  assert.ok(invalidFailed.body.includes("injected-side-effect"), "解析失败不得丢弃目录附注");
  await injectService.recover();
  assert.equal((await snapshot()).messages.at(-1)!.body, invalidFailed.body, "解析失败的附注恢复后保留");

  mode = "delegate";
  await injectService.send(roomRow, "@codex 建个任务", "delegate-with-change", "tester");
  const startFailed = (await settle("failed")).messages.at(-1)!;
  assert.ok(startFailed.body.includes("任务已创建，但启动失败"), "启动失败保留错误说明");
  assert.ok(startFailed.body.includes("injected-side-effect"), "启动失败的覆盖不得删掉目录附注");
  assert.ok(startFailed.taskId, "任务回链保留");
  assert.equal((await db.select().from(tasks)).length, 1);
  await injectService.recover();
  assert.equal((await snapshot()).messages.at(-1)!.body, startFailed.body, "启动失败的附注恢复后保留");

  // 审查第 3 轮回归：任务已创建、尚未启动的窗口内停止（task.created 总线事件触发 stop）——
  // 停止文案落成后，本轮已取得的附注必须补写在其后，任务回链保留。
  const { bus } = await import("../src/bus.js");
  const raceMember: ChatMember = { id: "codex", name: "codex", agentType: "codex", executorId: null, model: null, reasoningEffort: null };
  await db.insert(chatRooms).values({ id: "stop-race", projectId: "project", name: "停止竞态", members: JSON.stringify([raceMember]), createdAt: new Date().toISOString() });
  const raceRoomRow = (await db.select().from(chatRooms).where(eq(chatRooms.id, "stop-race"))).at(0)!;
  let raceStarts = 0;
  const raceService = new ChatService(async () => ({
    text: '{"reply":"已整理为任务。","task":{"title":"竞态任务","body":"验证停止时附注不丢失。"}}',
    notice: "⚠️ 竞态目录附注（race-side-effect）",
  }), async () => { raceStarts++; });
  let raceStop: Promise<void> | undefined;
  const unsubscribe = bus.subscribe((event) => { if (event.type === "task.created") raceStop = raceService.stop("stop-race"); });
  await raceService.send(raceRoomRow, "@codex 建个任务", "stop-race-message", "tester");
  let raceRow: typeof chatMessages.$inferSelect | undefined;
  for (let tries = 0; tries < 300; tries++) {
    const rows = await db.select().from(chatMessages).where(eq(chatMessages.roomId, "stop-race"));
    const agentRow = rows.find((row) => row.role === "agent");
    if (agentRow && !["queued", "running"].includes(agentRow.status ?? "") && agentRow.body.includes("race-side-effect")) { raceRow = agentRow; break; }
    await delay(10);
  }
  await raceStop;
  unsubscribe();
  assert.ok(raceRow, "停止竞态下附注未持久化");
  assert.equal(raceRow!.status, "stopped");
  assert.match(raceRow!.body, /你已停止这次回复/);
  assert.ok(raceRow!.taskId, "竞态下任务回链保留");
  assert.equal(raceStarts, 0, "停止阻止任务启动");
  assert.equal((await db.select().from(chatMessages).where(eq(chatMessages.id, raceRow!.id))).at(0)!.body.split("race-side-effect").length, 2, "附注只补一次");
  assert.equal((await db.select().from(chatRooms)).length, 2);
  assert.equal(cleanup, runs, "每次咨询都要清理执行器会话");
  console.log("chat boundary: 只读工具通过；写入/未知命令的工具事件仍硬中止；无工具事件的目录变化（含并发合并）不再中止、附注如实持久展示且不进模型回复；观察器失效时如实附注不可用；解析失败/任务启动失败的终态正文保留附注；ash 自身写入不附注；停止照常生效；咨询不创建任务");
} finally {
  release?.();
  CLI_SPEC_BY_KEY.codex.factory = original;
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
