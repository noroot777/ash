import assert from "node:assert/strict";
import { ApiError, api } from "../src/lib/api.ts";
import { applyTaskStatusEvent } from "../src/lib/useTasks.ts";

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
  console.log("数据层回归验证通过");
} finally {
  globalThis.fetch = originalFetch;
}
