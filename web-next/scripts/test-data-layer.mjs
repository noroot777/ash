import assert from "node:assert/strict";
import { ApiError, api } from "../src/lib/api.ts";
import { applyTaskStatusEvent } from "../src/lib/useTasks.ts";
import { buildConversationItems, conversationToMarkdown } from "../src/task-detail/conversationModel.ts";
import { taskDurationInfo } from "../src/task-detail/utils.ts";
import { stickStateAfterScroll } from "../src/lib/useStickToBottom.ts";
import { sharedTeamParent } from "../src/review/reviewModel.ts";
import { gateAllowsRevision, isOpenDebateGate, runCreatedHandoffFollowUps } from "../src/debate/handoffPolicy.ts";
import { emptyComposerExecutorConfigs, patchComposerExecutor, setComposerExecutorProfile } from "../src/composer/executorOverrides.ts";
import { activeGroupTasks, resumeQueueModel } from "../src/settings/groupQueueModel.ts";

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
  assert.equal(conversation[0].kind === "agent" ? conversation[0].at : null, "2026-07-30T01:00:00.000Z");
  assert.equal(conversation[0].kind === "agent" ? conversation[0].endedAt : null, "2026-07-30T01:01:00.000Z");
  assert.equal(conversation[2].kind === "agent" ? conversation[2].at : null, "2026-07-30T01:01:00.000Z");
  assert.equal(conversation[0].kind === "agent" ? conversation[0].showSessionMeta : null, false);
  assert.equal(conversation[2].kind === "agent" ? conversation[2].showSessionMeta : null, true);
  assert.match(conversationToMarkdown(conversation, { ...task, title: "测试会话", body: "目标" }), /## 你 ·/);

  const timedConversation = buildConversationItems(
    [{ session, output: "第一回合。\n\u001e{\"t\":\"agentEnd\",\"at\":\"2026-07-30T01:00:30.000Z\"}\n\u001e{\"t\":\"user\",\"text\":\"继续\",\"at\":\"2026-07-30T01:01:00.000Z\"}\n第二回合。\n\u001e{\"t\":\"agentEnd\",\"at\":\"2026-07-30T01:03:00.000Z\"}" }],
    [session],
    [],
  );
  assert.equal(timedConversation[0].kind === "agent" ? timedConversation[0].endedAt : null, "2026-07-30T01:00:30.000Z");
  assert.equal(timedConversation[2].kind === "agent" ? timedConversation[2].at : null, "2026-07-30T01:01:00.000Z");
  assert.equal(timedConversation[2].kind === "agent" ? timedConversation[2].endedAt : null, "2026-07-30T01:03:00.000Z");

  const durationInfo = taskDurationInfo(task, Date.parse("2026-07-30T01:10:00.000Z"));
  assert.equal(durationInfo?.label, "用时");
  assert.equal(durationInfo?.text, "10m 0s");
  assert.match(durationInfo?.title ?? "", /^结束 /);
  assert.equal(taskDurationInfo({ ...task, activeMs: null })?.label, "跨度");

  // 用户从底部按住滚动条向上拖时，pointerdown 会建立 detaching user intent。
  // 随后的 scroll 必须解除贴底；内容 resize/mutation 只能在 stuck=true 时补滚，
  // 因而此状态会保持在历史位置，不被下一段流式输出抢回底部。
  assert.equal(stickStateAfterScroll({
    stuck: true,
    nearBottom: false,
    programmatic: false,
    userDriven: true,
    detaching: true,
  }), false);
  assert.equal(stickStateAfterScroll({
    stuck: false,
    nearBottom: false,
    programmatic: false,
    userDriven: false,
    detaching: false,
  }), false);

  const team = { id: "team-1", mode: "team", projectId: "project-1", title: "父团队" };
  const sharedWorker = { id: "worker-1", parentId: "team-1", useWorktree: false };
  assert.equal(sharedTeamParent(sharedWorker, [team])?.id, "team-1");
  assert.equal(sharedTeamParent({ ...sharedWorker, useWorktree: true }, [team]), null);

  const gate = { gate: "G1", open: true };
  assert.equal(isOpenDebateGate(gate, "awaiting_review"), true);
  assert.equal(isOpenDebateGate({ ...gate, consensus: false }, "awaiting_review"), true);
  assert.equal(isOpenDebateGate(gate, "done"), false);
  assert.equal(gateAllowsRevision(), true);
  assert.equal(gateAllowsRevision({ id: "team-1" }), false);
  const followUps = [];
  const failures = await runCreatedHandoffFollowUps({
    closeGate: async () => { followUps.push("gate"); throw new Error("gate failed"); },
    startTeam: async () => { followUps.push("start"); throw new Error("start failed"); },
  });
  assert.deepEqual(followUps, ["gate", "start"]);
  assert.deepEqual(failures.map(({ phase }) => phase), ["gate", "start"]);

  const roles = ["single", "lead", "worker", "reviewer"];
  for (const role of roles) {
    let executors = emptyComposerExecutorConfigs();
    executors = setComposerExecutorProfile(executors, role, "codex@local");
    executors = patchComposerExecutor(executors, role, { model: "gpt-5.6-sol", effort: "ultra" });
    executors = setComposerExecutorProfile(executors, role, "claude@ccb");
    assert.deepEqual(executors[role], { profile: "claude@ccb", model: "", effort: "" });
  }

  const groupTasks = [
    { id: "done", groupId: "group-1", archived: false, status: "done", createdAt: "2026-07-30T01:00:00.000Z", resumeDependsOn: [] },
    { id: "paused", groupId: "group-1", archived: false, status: "paused", createdAt: "2026-07-30T02:00:00.000Z", resumeDependsOn: ["done"] },
    { id: "archived", groupId: "group-1", archived: true, status: "done", createdAt: "2026-07-30T00:00:00.000Z", resumeDependsOn: [] },
  ];
  const active = activeGroupTasks(groupTasks, "group-1");
  assert.deepEqual(active.map(({ id }) => id), ["done", "paused"]);
  const queue = resumeQueueModel(active);
  assert.deepEqual(queue?.ordered.map(({ id }) => id), ["done", "paused"]);
  assert.equal(queue?.doneCount, 1);
  console.log("数据层回归验证通过");
} finally {
  globalThis.fetch = originalFetch;
}
