import assert from "node:assert/strict";
import { ApiError, api } from "../src/lib/api.ts";
import { applyTaskStatusEvent } from "../src/lib/useTasks.ts";
import { buildConversationItems, conversationToMarkdown } from "../src/task-detail/conversationModel.ts";

const originalFetch = globalThis.fetch;

try {
  const failure = {
    accepted: false,
    taskId: "missing",
    reason: "not_found",
    error: "not found",
    phase: "initial",
    conflictHandoff: { notified: true, message: "已交接" },
  };
  globalThis.fetch = async () => new Response(JSON.stringify(failure), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

  assert.deepEqual(await api.acceptTask("missing"), failure);

  globalThis.fetch = async () => new Response(JSON.stringify({ error: "服务异常" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(() => api.acceptTask("broken"), ApiError);

  const task = {
    id: "task-1",
    status: "done",
    startedAt: "2026-07-30T01:00:00.000Z",
    endedAt: "2026-07-30T01:10:00.000Z",
    activeMs: 600000,
    liveSince: "2026-07-30T01:00:00.000Z",
  };
  const updated = applyTaskStatusEvent(task, {
    type: "task.status",
    taskId: "task-1",
    status: "running",
    endedAt: null,
    liveSince: null,
  });

  assert.equal(updated.startedAt, task.startedAt);
  assert.equal(updated.activeMs, task.activeMs);
  assert.equal(updated.endedAt, null);
  assert.equal(updated.liveSince, null);

  const session = {
    id: "session-1",
    taskId: "task-1",
    role: "single",
    agentType: "codex",
    executor: "codex@local",
    target: "local",
    worktreePath: null,
    branch: null,
    cwd: null,
    transcriptPath: "/tmp/session.md",
    cliSessionId: "cli-1",
    resumeCommand: null,
    commandLine: null,
    startedAt: "2026-07-30T01:00:00.000Z",
    endedAt: null,
    exitStatus: null,
  };
  const conversation = buildConversationItems(
    [{ session, output: "先检查现状。\n\u001e{\"t\":\"user\",\"text\":\"继续\",\"at\":\"2026-07-30T01:01:00.000Z\"}\n正在处理。" }],
    [session],
    [{
      kind: "server",
      id: "live-1",
      event: {
        type: "agent.event",
        taskId: "task-1",
        sessionId: "session-1",
        role: "single",
        agentType: "codex",
        event: { kind: "text", text: " 已完成。" },
      },
    }],
  );
  assert.deepEqual(conversation.map((item) => item.kind), ["agent", "user", "agent"]);
  assert.equal(conversation[2].kind === "agent" ? conversation[2].markdown : "", "正在处理。 已完成。");
  assert.match(conversationToMarkdown(conversation, { ...task, title: "测试会话", body: "目标" }), /## 你 ·/);
  console.log("数据层回归验证通过");
} finally {
  globalThis.fetch = originalFetch;
}
