import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
let killed = 0;
let cleanup = 0;
let changed: (() => void) | undefined;
let release: (() => void) | undefined;
CLI_SPEC_BY_KEY.codex.factory = () => ({
  type: "codex", label: "fixture", resumeCommand: () => "",
  run: (opts) => {
    if (mode === "sync-write") writeFileSync(join(opts.cwd, "unexpected-side-effect.txt"), "written before any event");
    if (mode === "dependency-write") writeFileSync(join(opts.cwd, "node_modules", "pkg", "side-effect.txt"), "written without any tool event");
    return {
      sessionId: "fixture", commandLine: "fixture", kill: () => { killed++; release?.(); }, cleanup: async () => { cleanup++; },
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
        if (mode === "stream-write" || mode === "stop-write") {
          await delay(30);
          writeFileSync(join(opts.cwd, "during-stream.txt"), "side effect");
          const released = new Promise<void>((resolve) => { release = resolve; });
          const timeout = setTimeout(() => release?.(), 2000);
          changed?.();
          try { await released; } finally { clearTimeout(timeout); }
        }
        yield { kind: "tool", name: "Read", detail: source };
        yield { kind: "text", text: '{"reply":"这是咨询回复，不建任务。","task":null}' };
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
  },
});
const invoke = () => invokeChat(member, null, "@codex 你建议登录页怎么改？", AbortSignal.timeout(5000), "project");
try {
  await invoke();
  for (const scenario of ["sync-write", "edit-existing", "delete", "rename", "transient", "write-event", "command-event", "stream-write"]) {
    mode = scenario;
    const began = Date.now();
    await assert.rejects(invoke(), (error: unknown) => error instanceof ChatBoundaryError && error.message.includes("咨询已中止") && !error.message.includes("sensitive arguments"), scenario);
    if (scenario === "stream-write") assert.ok(Date.now() - began < 1800, "流式写入须在回合结束前被监测并中止");
    if (scenario === "sync-write") assert.ok(existsSync(join(projectDir, "unexpected-side-effect.txt")), "不自动回滚或隐藏已发生的写入");
    for (const file of ["unexpected-side-effect.txt", "during-stream.txt", "renamed.txt"]) rmSync(join(projectDir, file), { force: true });
    writeFileSync(source, "before");
    release = undefined;
  }
  assert.ok(killed >= 9);
  assert.equal(cleanup, 9);
  mode = "runtime-write";
  await db.insert(projects).values({ id: "runtime", name: "包含 ash 数据的项目", repoPath: stage, createdAt: new Date().toISOString() });
  await invokeChat(member, null, "只读咨询", AbortSignal.timeout(5000), "runtime");
  const service = new ChatService(invokeChat, async () => { throw new Error("咨询不应启动任务"); });
  const app = new Hono();
  mountChatRoutes(app, service);
  const request = (path: string, body?: unknown) => app.request(path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const room = await (await request("/chats", { projectId: "project", name: "咨询测试", members: [member] })).json() as { id: string };
  const settle = async () => {
    for (let tries = 0; tries < 100; tries++) {
      const snapshot = await (await request(`/chats/${room.id}`)).json() as ChatSnapshot;
      if (snapshot.messages.at(-1)?.status === "failed") return snapshot;
      await delay(20);
    }
    throw new Error("副作用警告未持久化");
  };
  for (const [scenario, path] of [["sync-write", "unexpected-side-effect"], ["dependency-write", "node_modules"]]) {
    mode = scenario!;
    await request(`/chats/${room.id}/messages`, { id: `consultation-${scenario}`, body: "@codex 你建议登录页怎么改？" });
    const failed = await settle();
    assert.ok(failed.messages.at(-1)!.body.includes(path!));
    assert.equal(failed.messages.at(-1)!.taskId, null);
    const refreshed = await (await request(`/chats/${room.id}`)).json() as ChatSnapshot;
    assert.equal(refreshed.messages.at(-1)!.body, failed.messages.at(-1)!.body);
    await service.recover();
    assert.equal((await (await request(`/chats/${room.id}`)).json() as ChatSnapshot).messages.at(-1)!.body, failed.messages.at(-1)!.body);
    assert.equal((await db.select().from(tasks)).length, 0);
  }
  rmSync(join(projectDir, "unexpected-side-effect.txt"));
  mode = "stop-write";
  let stopped: Promise<void> | undefined;
  changed = () => { stopped = service.stop(room.id); };
  await request(`/chats/${room.id}/messages`, { id: "stop-while-writing", body: "@codex 再给建议" });
  const stoppedResult = await settle();
  await stopped;
  assert.match(stoppedResult.messages.at(-1)!.body, /咨询已中止/);
  assert.equal(stoppedResult.messages.at(-1)!.status, "failed", "停止不能覆盖副作用警告");
  const stored = (await db.select().from(chatMessages).where(eq(chatMessages.id, stoppedResult.messages.at(-1)!.id))).at(0)!;
  assert.equal(stored.status, "failed");
  assert.equal(readFileSync(source, "utf8"), "before");
  assert.equal((await db.select().from(chatRooms)).length, 1);
  console.log("chat boundary: 只读工具通过；写入/未知命令失败；无工具事件的同步/流式写入、修改、删除、重命名均告警；源码和依赖写入的警告刷新/恢复后保留，停止不覆盖警告，咨询不创建任务");
} finally {
  release?.();
  CLI_SPEC_BY_KEY.codex.factory = original;
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
