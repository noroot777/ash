import assert from "node:assert/strict";
import { mergeFeed, timeMs } from "@harness/shared/team";
import { ApiError, api } from "../src/lib/api.ts";
import { mergeUserTimeline } from "../src/lib/useConversation.ts";
import { deriveTaskStatusIndicator, readEventForTask, readTaskIds } from "../src/lib/useTaskReadState.ts";
import { buildConversationItems, conversationToMarkdown } from "../src/task-detail/conversationModel.ts";
import { taskDurationInfo } from "../src/task-detail/utils.ts";
import { stickStateAfterScroll } from "../src/lib/useStickToBottom.ts";
import { sharedTeamParent } from "../src/review/reviewModel.ts";
import { gateAllowsRevision, isOpenDuetGate, runCreatedHandoffFollowUps, teamDuetIterationState } from "../src/duet/handoffPolicy.ts";
import { emptyComposerExecutorConfigs, patchComposerExecutor, setComposerExecutorProfile } from "../src/composer/executorOverrides.ts";
import { activeGroupTasks, resumeQueueModel } from "../src/settings/groupQueueModel.ts";
import { leadTurns, teamFeedOptions } from "../src/team/teamModel.ts";
import {
  executorRunSummary,
  executorOptions,
  registeredAgentTypes,
  teamExecutorCandidates,
} from "../src/lib/agentAvailability.ts";
import { isLocalDiskImagePath, localDiskPath } from "../src/components/markdownPolicy.ts";
import { createTerminalTab, withoutTerminalTab } from "../src/workspace/terminalTabs.ts";

const originalFetch = globalThis.fetch;

try {
  assert.equal(isLocalDiskImagePath("/tmp/cli-drawer.jpg"), true);
  assert.equal(isLocalDiskImagePath("file:///Users/fjh/cli-drawer.png"), true);
  assert.equal(isLocalDiskImagePath("/api/uploads/cli-drawer.jpg"), false);
  assert.equal(localDiskPath("/Users/fjh/My%20Demo/index.html"), "/Users/fjh/My Demo/index.html");
  assert.equal(localDiskPath("file:///Volumes/demo/My%20Demo/index.html"), "/Volumes/demo/My Demo/index.html");
  assert.equal(localDiskPath("C:\\work\\demo\\index.html"), "C:\\work\\demo\\index.html");
  assert.equal(localDiskPath("/api/tasks/demo/file"), null);
  assert.equal(localDiskPath("https://example.com/index.html"), null);
  const terminalTabs = [
    createTerminalTab("cli-1", 1, "harness", "/repo"),
    createTerminalTab("cli-2", 2, "harness", "/repo"),
    createTerminalTab("cli-3", 3, "harness", "/repo"),
  ];
  assert.deepEqual(terminalTabs.map((tab) => tab.label), ["harness", "harness 2", "harness 3"]);
  assert.deepEqual(withoutTerminalTab(terminalTabs, "cli-2", "cli-2"), {
    tabs: [terminalTabs[0], terminalTabs[2]],
    activeId: "cli-3",
  });
  assert.equal(withoutTerminalTab([terminalTabs[0]], "cli-1", "cli-1").activeId, null);

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
    updatedAt: "2026-07-30T01:10:00.000Z",
  };
  // useTasks 数据同步纯函数（SSE 事件应用 / 星标回写 / GET 快照合并）的用例在
  // scripts/test-task-sync.mjs（npm -w web-next run test:task-sync）。

  const session = {
    id: "session-1",
    taskId: "task-1",
    role: "single",
    agentType: "codex",
    executor: "codex@local",
    model: "gpt-5.5",
    reasoningEffort: "medium",
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
    [{
      session,
      output: "先检查现状。\n\u001e{\"t\":\"user\",\"text\":\"继续\",\"at\":\"2026-07-30T01:01:00.000Z\"}\n正在处理。",
      trace: [{
        at: "2026-07-30T01:01:02.000Z",
        turnStartedAt: "2026-07-30T01:01:00.000Z",
        event: { kind: "tool", name: "exec", detail: "rg -n trace" },
      }, {
        at: "2026-07-30T01:01:00.000Z",
        turnStartedAt: "2026-07-30T01:01:00.000Z",
        event: { kind: "run", model: "gpt-5.6-sol", reasoningEffort: "high" },
      }],
    }],
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
  assert.equal(conversation[2].kind === "agent" ? conversation[2].segments[0]?.events.length : 0, 1);
  assert.deepEqual(conversation[2].kind === "agent" ? conversation[2].run : null, { model: "gpt-5.6-sol", reasoningEffort: "high" });
  assert.equal(conversation[0].kind === "agent" ? conversation[0].at : null, "2026-07-30T01:00:00.000Z");
  assert.deepEqual(conversation[0].kind === "agent" ? conversation[0].run : null, { model: "gpt-5.5", reasoningEffort: "medium" });
  assert.equal(conversation[0].kind === "agent" ? conversation[0].endedAt : null, "2026-07-30T01:01:00.000Z");
  assert.equal(conversation[2].kind === "agent" ? conversation[2].at : null, "2026-07-30T01:01:00.000Z");
  assert.equal(conversation[0].kind === "agent" ? conversation[0].showSessionMeta : null, false);
  assert.equal(conversation[2].kind === "agent" ? conversation[2].showSessionMeta : null, true);

  const optimisticReply = {
    kind: "user",
    id: "optimistic-reply",
    text: "请继续",
    attachments: ["/tmp/proof.png"],
    at: "2026-07-30T01:01:00.000Z",
    source: "optimistic",
  };
  const serverReply = {
    kind: "user",
    id: "server-reply",
    text: "请继续\n\n[用户附带的文件，请用 Read 工具查看以下本地文件]\n- /tmp/proof.png",
    attachments: [],
    at: "2026-07-30T01:01:00.020Z",
    source: "server",
  };
  assert.deepEqual(mergeUserTimeline([optimisticReply], serverReply), [serverReply], "服务端落盘事件应替换同一条乐观消息");
  assert.deepEqual(mergeUserTimeline([serverReply], optimisticReply), [serverReply], "事件先到时，后来的乐观消息不能重复追加");

  const systemHandoff = { ...serverReply, id: "system-handoff", text: "请读取 report.md", bySystem: true };
  const handoffConversation = buildConversationItems([], [session], mergeUserTimeline([], systemHandoff));
  assert.equal(handoffConversation[0]?.kind === "user" ? handoffConversation[0].bySystem : false, true);
  assert.match(conversationToMarkdown(handoffConversation, { ...task, title: "test", body: "" }), /## 系统/);

  const cumulative1 = { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, reasoning: 3, costUsd: null, turns: 1 };
  const cumulative2 = { input: 20, output: 10, cacheRead: 180, cacheWrite: 0, reasoning: 6, costUsd: null, turns: 1 };
  const repairedSession = { ...session, usage: { ...cumulative2, turns: 2 } };
  const repairedConversation = buildConversationItems(
    [{
      session: repairedSession,
      output: `第一轮。\n\u001e${JSON.stringify({ t: "user", text: "继续", at: "2026-07-30T01:01:00.000Z" })}\n第二轮。`,
      trace: [
        { at: "2026-07-30T01:00:30.000Z", turnStartedAt: session.startedAt, event: { kind: "usage", usage: cumulative1 } },
        { at: "2026-07-30T01:01:30.000Z", turnStartedAt: "2026-07-30T01:01:00.000Z", event: { kind: "usage", usage: cumulative2 } },
      ],
    }],
    [repairedSession],
    [],
  );
  const repairedAgentTurns = repairedConversation.filter((item) => item.kind === "agent");
  assert.equal(repairedAgentTurns[0]?.usage && repairedAgentTurns[0].usage.input + repairedAgentTurns[0].usage.cacheRead + repairedAgentTurns[0].usage.output, 105);
  assert.equal(repairedAgentTurns[1]?.usage && repairedAgentTurns[1].usage.input + repairedAgentTurns[1].usage.cacheRead + repairedAgentTurns[1].usage.output, 105);
  assert.deepEqual(
    repairedAgentTurns.at(-1)?.sessionUsage,
    { ...cumulative2, turns: 2 },
    "Codex 旧 trace 要在读侧从累计快照换算成单轮差值，不能刷新后又显示 315",
  );
  const markedConversation = buildConversationItems(
    [{
      session: repairedSession,
      output: `第一轮。\n\u001e${JSON.stringify({ t: "user", text: "继续", at: "2026-07-30T01:01:00.000Z" })}\n第二轮。`,
      trace: [
        { at: "2026-07-30T01:00:30.000Z", turnStartedAt: session.startedAt, event: { kind: "usage", usage: cumulative1, accounting: "incremental" } },
        { at: "2026-07-30T01:01:30.000Z", turnStartedAt: "2026-07-30T01:01:00.000Z", event: { kind: "usage", usage: cumulative1, accounting: "incremental" } },
      ],
    }],
    [repairedSession],
    [],
  ).filter((item) => item.kind === "agent");
  assert.equal(markedConversation[1]?.usage?.cacheRead, 90, "新 trace 已是增量，不能被历史兼容逻辑二次求差");

  const clearedContext = buildConversationItems([], [{
    ...session,
    context: { used: 117_016, window: 353_400, windowEstimated: false },
  }], [
    { kind: "server", id: "context-text", event: { type: "agent.event", taskId: "task-1", sessionId: session.id, role: "single", event: { kind: "text", text: "新一轮。" } } },
    { kind: "server", id: "context-clear", event: { type: "agent.event", taskId: "task-1", sessionId: session.id, role: "single", event: { kind: "context", context: { used: 0, window: null, windowEstimated: false } } } },
  ]);
  assert.deepEqual(
    clearedContext.at(-1)?.kind === "agent" ? clearedContext.at(-1)?.sessionContext : undefined,
    { used: 0, window: null, windowEstimated: false },
    "直播没采到哨兵必须压过 sessions 行上的旧水位，渲染层会因 used=0 隐藏胶囊",
  );

  const exported = conversationToMarkdown(conversation, { ...task, title: "测试会话", body: "目标" });
  assert.match(exported, /## 你 ·/);
  assert.doesNotMatch(exported, /rg -n trace/);

  const interleavedTrace = buildConversationItems(
    [{
      session: { ...session, endedAt: "2026-07-30T01:02:00.000Z" },
      output: "第一段正文。第二段正文。",
      trace: [
        { at: "2026-07-30T01:00:01.000Z", turnStartedAt: session.startedAt, event: { kind: "thinking", text: "先分析第一段" } },
        { at: "2026-07-30T01:00:02.000Z", turnStartedAt: session.startedAt, event: { kind: "text", text: "第一段正文。" } },
        { at: "2026-07-30T01:00:03.000Z", turnStartedAt: session.startedAt, event: { kind: "tool", name: "exec", detail: "检查第二段" } },
        { at: "2026-07-30T01:00:04.000Z", turnStartedAt: session.startedAt, event: { kind: "text", text: "第二段正文。" } },
      ],
    }],
    [{ ...session, endedAt: "2026-07-30T01:02:00.000Z" }],
    [],
  );
  assert.equal(interleavedTrace[0]?.kind === "agent" ? interleavedTrace[0].segments.length : 0, 2);
  assert.equal(interleavedTrace[0]?.kind === "agent" ? interleavedTrace[0].segments[0]?.markdown : "", "第一段正文。");
  assert.equal(interleavedTrace[0]?.kind === "agent" ? interleavedTrace[0].segments[0]?.events[0]?.kind : null, "thinking");
  assert.equal(interleavedTrace[0]?.kind === "agent" ? interleavedTrace[0].segments[1]?.markdown : "", "第二段正文。");
  assert.equal(interleavedTrace[0]?.kind === "agent" ? interleavedTrace[0].segments[1]?.events[0]?.kind : null, "tool");

  const liveInterleaved = buildConversationItems([], [session], [
    { kind: "server", id: "think-1", event: { type: "agent.event", taskId: "task-1", sessionId: session.id, role: "single", model: "gpt-5.6-sol", reasoningEffort: "high", event: { kind: "thinking", text: "分析一" } } },
    { kind: "server", id: "text-1", event: { type: "agent.event", taskId: "task-1", sessionId: session.id, role: "single", event: { kind: "text", text: "正文一" } } },
    { kind: "server", id: "tool-1", event: { type: "agent.event", taskId: "task-1", sessionId: session.id, role: "single", event: { kind: "tool", name: "exec", detail: "命令二" } } },
    { kind: "server", id: "text-2", event: { type: "agent.event", taskId: "task-1", sessionId: session.id, role: "single", event: { kind: "text", text: "正文二" } } },
  ]);
  assert.equal(liveInterleaved[0]?.kind === "agent" ? liveInterleaved[0].segments.length : 0, 2);
  assert.deepEqual(
    liveInterleaved[0]?.kind === "agent" ? liveInterleaved[0].segments.map(({ markdown, events }) => [markdown, events[0]?.kind]) : [],
    [["正文一", "thinking"], ["正文二", "tool"]],
  );
  assert.deepEqual(liveInterleaved[0]?.kind === "agent" ? liveInterleaved[0].run : null, { model: "gpt-5.6-sol", reasoningEffort: "high" });

  const persistedAttachmentPath = "/tmp/harness/data/uploads/persisted-agent-image.png";
  const attachmentConversation = buildConversationItems(
    [{
      session: { ...session, endedAt: "2026-07-30T01:00:10.000Z" },
      output: "图片如下。",
      trace: [
        { at: "2026-07-30T01:00:01.000Z", turnStartedAt: session.startedAt, event: { kind: "text", text: "图片如下。" } },
        { at: "2026-07-30T01:00:02.000Z", turnStartedAt: session.startedAt, event: { kind: "attachment", path: persistedAttachmentPath } },
      ],
    }],
    [{ ...session, endedAt: "2026-07-30T01:00:10.000Z" }],
    [],
  );
  assert.deepEqual(
    attachmentConversation[0]?.kind === "agent"
      ? attachmentConversation[0].segments.flatMap((segment) => segment.attachments)
      : [],
    [persistedAttachmentPath],
  );

  const liveAttachmentPath = "/tmp/harness/data/uploads/live-agent-image.jpg";
  const liveAttachmentConversation = buildConversationItems([], [session], [
    { kind: "server", id: "live-text", event: { type: "agent.event", taskId: "task-1", sessionId: session.id, role: "single", event: { kind: "text", text: "实时图片。" } } },
    { kind: "server", id: "live-image", event: { type: "agent.event", taskId: "task-1", sessionId: session.id, role: "single", event: { kind: "attachment", path: liveAttachmentPath } } },
  ]);
  assert.deepEqual(
    liveAttachmentConversation[0]?.kind === "agent"
      ? liveAttachmentConversation[0].segments.flatMap((segment) => segment.attachments)
      : [],
    [liveAttachmentPath],
  );

  const traceOnlyConversation = buildConversationItems(
    [{
      session: { ...session, endedAt: "2026-07-30T01:00:10.000Z" },
      output: "",
      trace: [{
        at: "2026-07-30T01:00:02.000Z",
        turnStartedAt: "2026-07-30T01:00:00.000Z",
        event: { kind: "error", message: "执行器启动失败" },
      }],
    }],
    [{ ...session, endedAt: "2026-07-30T01:00:10.000Z" }],
    [],
  );
  assert.equal(traceOnlyConversation[0]?.kind, "agent");
  assert.equal(traceOnlyConversation[0]?.kind === "agent" ? traceOnlyConversation[0].segments[0]?.events[0]?.kind : null, "error");

  const timedConversation = buildConversationItems(
    [{ session, output: "第一回合。\n\u001e{\"t\":\"agentEnd\",\"at\":\"2026-07-30T01:00:30.000Z\"}\n\u001e{\"t\":\"user\",\"text\":\"继续\",\"at\":\"2026-07-30T01:01:00.000Z\"}\n第二回合。\n\u001e{\"t\":\"agentEnd\",\"at\":\"2026-07-30T01:03:00.000Z\"}" }],
    [session],
    [],
  );
  assert.equal(timedConversation[0].kind === "agent" ? timedConversation[0].endedAt : null, "2026-07-30T01:00:30.000Z");
  assert.equal(timedConversation[2].kind === "agent" ? timedConversation[2].at : null, "2026-07-30T01:01:00.000Z");
  assert.equal(timedConversation[2].kind === "agent" ? timedConversation[2].endedAt : null, "2026-07-30T01:03:00.000Z");

  const resumedPrimary = {
    ...session,
    id: "primary-session",
    executor: "claude@local",
    startedAt: "2026-07-30T01:00:00.000Z",
    turnStartedAt: "2026-07-30T01:10:00.000Z",
    endedAt: null,
  };
  const mentionedAgent = {
    ...session,
    id: "mentioned-session",
    executor: "codex@local",
    startedAt: "2026-07-30T01:05:00.000Z",
    turnStartedAt: "2026-07-30T01:05:00.000Z",
    endedAt: "2026-07-30T01:09:00.000Z",
  };
  const resumedAfterMention = buildConversationItems(
    [
      {
        session: resumedPrimary,
        output: `旧 Claude 回合。\n\u001e${JSON.stringify({ t: "user", text: "继续处理", at: resumedPrimary.turnStartedAt })}\n当前 Claude 回合。`,
      },
      {
        session: mentionedAgent,
        output: `\u001e${JSON.stringify({ t: "user", text: "交给 Codex", at: mentionedAgent.startedAt })}\nCodex 已完成。\n\u001e${JSON.stringify({ t: "agentEnd", at: mentionedAgent.endedAt })}`,
      },
    ],
    [resumedPrimary, mentionedAgent],
    [],
  );
  const primaryTurns = resumedAfterMention.filter((item) => item.kind === "agent" && item.sessionId === resumedPrimary.id);
  assert.equal(primaryTurns[0]?.endedAt, mentionedAgent.startedAt);
  assert.equal(primaryTurns.at(-1)?.at, resumedPrimary.turnStartedAt);
  assert.equal(primaryTurns.at(-1)?.endedAt, null);
  assert.deepEqual(
    resumedAfterMention.filter((item) => item.kind === "agent").map((item) => item.sessionId),
    [resumedPrimary.id, mentionedAgent.id, resumedPrimary.id],
  );

  const livePrimaryAfterReconnect = buildConversationItems(
    [
      { session: resumedPrimary, output: "旧 Claude 回合。" },
      { session: mentionedAgent, output: "Codex 已完成。" },
    ],
    [resumedPrimary, mentionedAgent],
    [{ kind: "server", id: "primary-tool", event: { type: "agent.event", taskId: "task-1", sessionId: resumedPrimary.id, role: "single", agentType: "claude", event: { kind: "tool", name: "Read" } } }],
  );
  const reconnectedTurn = livePrimaryAfterReconnect.at(-1);
  assert.equal(reconnectedTurn?.kind === "agent" ? reconnectedTurn.at : null, resumedPrimary.turnStartedAt);
  assert.equal(reconnectedTurn?.kind === "agent" ? reconnectedTurn.endedAt : "ended", null);

  const recycleNote = "〔系统〕调度台空闲超过 30 分钟,进程已回收(待命)。";
  const recycleAt = "2026-07-30T01:30:00.000Z";
  const dedupedRefresh = buildConversationItems(
    [{
      session,
      output: `\u001e${JSON.stringify({ t: "system", text: recycleNote, at: recycleAt })}`,
    }],
    [session],
    [
      {
        kind: "server",
        id: "done-before-refresh",
        event: {
          type: "agent.event",
          taskId: task.id,
          sessionId: session.id,
          role: "lead",
          event: { kind: "done", exitStatus: 0 },
        },
      },
      {
        kind: "server",
        id: "same-recycle-from-sse",
        receivedAt: "2026-07-30T01:30:00.020Z",
        event: {
          type: "agent.event",
          taskId: task.id,
          sessionId: session.id,
          role: "lead",
          event: { kind: "system", text: recycleNote },
        },
      },
    ],
  );
  assert.deepEqual(
    dedupedRefresh.filter((item) => item.kind === "event").map((item) => item.text),
    [recycleNote, "本轮执行结束"],
  );

  const laterRecycle = buildConversationItems(
    [{
      session,
      output: `\u001e${JSON.stringify({ t: "system", text: recycleNote, at: recycleAt })}`,
    }],
    [session],
    [{
      kind: "server",
      id: "later-recycle",
      receivedAt: "2026-07-30T02:00:00.000Z",
      event: {
        type: "agent.event",
        taskId: task.id,
        sessionId: session.id,
        role: "lead",
        event: { kind: "system", text: recycleNote },
      },
    }],
  );
  assert.equal(laterRecycle.filter((item) => item.kind === "event" && item.text === recycleNote).length, 2);

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

  const statusTask = (overrides = {}) => ({
    id: "status-task",
    mode: "single",
    status: "backlog",
    updatedAt: "2026-07-30T01:00:00.000Z",
    ...overrides,
  });
  assert.equal(deriveTaskStatusIndicator(statusTask()), "pending");
  assert.equal(deriveTaskStatusIndicator(statusTask({ parentId: "team-status" })), "pending");
  assert.equal(deriveTaskStatusIndicator(statusTask({ status: "running" })), "active");
  assert.equal(deriveTaskStatusIndicator(statusTask({ status: "paused" })), "attention");
  assert.equal(deriveTaskStatusIndicator(statusTask({ status: "done" }), [], true), "success");
  assert.equal(deriveTaskStatusIndicator(statusTask({ status: "failed" }), [], true), "error");
  assert.equal(deriveTaskStatusIndicator(statusTask({ status: "done" }), [], false), null);
  assert.deepEqual(readTaskIds({ id: "worker-status", parentId: "team-status" }), ["worker-status", "team-status"]);
  assert.deepEqual(readTaskIds({ id: "team-status", parentId: null }), ["team-status"]);

  const pendingTeamLead = statusTask({ id: "pending-team-status", mode: "team" });
  const pendingWorker = statusTask({ id: "pending-worker-status", parentId: pendingTeamLead.id });
  assert.equal(deriveTaskStatusIndicator(pendingTeamLead), "pending");
  assert.equal(deriveTaskStatusIndicator(pendingTeamLead, [pendingWorker], true), "pending");
  assert.equal(deriveTaskStatusIndicator(pendingTeamLead, [{ ...pendingWorker, status: "done" }], false), null);

  const teamLead = statusTask({ id: "team-status", mode: "team", status: "idle" });
  const runningWorker = statusTask({
    id: "worker-status",
    parentId: teamLead.id,
    status: "running",
    updatedAt: "2026-07-30T01:01:00.000Z",
  });
  assert.equal(deriveTaskStatusIndicator(teamLead, [runningWorker], true), "active");
  assert.equal(deriveTaskStatusIndicator(teamLead, [{ ...runningWorker, status: "paused" }], true), "attention");
  assert.equal(deriveTaskStatusIndicator(teamLead, [{ ...runningWorker, status: "done" }], true), "success");
  assert.equal(deriveTaskStatusIndicator(teamLead, [{ ...runningWorker, status: "failed" }], true), "error");
  assert.equal(deriveTaskStatusIndicator(teamLead, [{ ...runningWorker, status: "canceled" }], true), "error");
  assert.equal(deriveTaskStatusIndicator({ ...teamLead, status: "failed" }, [], true), "error");
  assert.equal(deriveTaskStatusIndicator(teamLead, [{ ...runningWorker, status: "done" }], false), null);
  const runningTeamEvent = readEventForTask(teamLead, [runningWorker]);
  const settledTeamEvent = readEventForTask(teamLead, [{
    ...runningWorker,
    status: "done",
    updatedAt: "2026-07-30T01:02:00.000Z",
  }]);
  assert.notEqual(runningTeamEvent, settledTeamEvent);
  assert.equal(readEventForTask(statusTask({ mode: "team", status: "backlog" })), null);

  const gate = { gate: "G1", open: true };
  assert.equal(isOpenDuetGate(gate, "awaiting_review"), true);
  assert.equal(isOpenDuetGate({ ...gate, consensus: false }, "awaiting_review"), true);
  assert.equal(isOpenDuetGate(gate, "done"), false);
  assert.equal(gateAllowsRevision(), true);
  assert.equal(gateAllowsRevision({ id: "team-1" }), false);
  const iterationOrigin = { id: "duet-1", mode: "duet" };
  const iterationTeam = { id: "team-2", mode: "team", originTaskId: "duet-1", status: "idle" };
  const settledWorker = { id: "worker-2", parentId: "team-2", status: "done", createdAt: "2026-07-30T01:00:00.000Z" };
  assert.deepEqual(teamDuetIterationState(iterationTeam, [iterationOrigin, iterationTeam, settledWorker]), {
    eligible: true,
    existing: undefined,
  });
  const existingIteration = { id: "duet-2", mode: "duet", originTaskId: "team-2" };
  assert.equal(
    teamDuetIterationState(iterationTeam, [iterationOrigin, iterationTeam, settledWorker, existingIteration]).existing?.id,
    "duet-2",
  );
  assert.equal(
    teamDuetIterationState(iterationTeam, [iterationOrigin, iterationTeam, { ...settledWorker, status: "paused" }]).eligible,
    false,
  );
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
    executors = setComposerExecutorProfile(executors, role, "codex@local", { model: "", effort: "" });
    executors = patchComposerExecutor(executors, role, { model: "gpt-5.6-sol", effort: "ultra" });
    // 换执行器：选择器算出的覆盖是空串（= 跟随执行器），旧模型/档位不许留下来。
    executors = setComposerExecutorProfile(executors, role, "claude@ccb", { model: "", effort: "" });
    assert.deepEqual(executors[role], { profile: "claude@ccb", model: "", effort: "" });
    // 同一个执行器只换模型：模型换成新的，智能水平原样留着——执行器与覆盖是同一次
    // 选择的结果，一起落地，不能拆成两次更新（后一次会带着旧值盖回执行器）。
    executors = patchComposerExecutor(executors, role, { effort: "high" });
    executors = setComposerExecutorProfile(executors, role, "claude@ccb", { model: "claude-opus-5", effort: "high" });
    assert.deepEqual(executors[role], { profile: "claude@ccb", model: "claude-opus-5", effort: "high" });
  }

  const registeredProfiles = [
    { id: "codex-local", name: "codex@local", type: "codex", model: "gpt-5.6-sol", reasoningEffort: "ultra", isDefault: true },
    { id: "qwen-ssh", name: "qwen@remote", type: "qwen", model: "qwen3", isDefault: true },
  ];
  assert.deepEqual(
    executorRunSummary({ agentType: "codex", executorId: null }, registeredProfiles),
    { model: "gpt-5.6-sol", effort: "ultra", overridden: false },
    "类型默认审查者应展示实际继承的模型与智能水平",
  );
  assert.deepEqual(
    executorRunSummary({ agentType: "codex", executorId: "codex-local" }, registeredProfiles, { effort: "high" }),
    { model: "gpt-5.6-sol", effort: "high", overridden: true },
    "审查者覆盖的智能水平应优先于执行器默认值",
  );
  assert.deepEqual(
    executorRunSummary({ agentType: "codex", executorId: "deleted-profile" }, registeredProfiles),
    { model: "gpt-5.6-sol", effort: "ultra", overridden: false },
    "失效的执行器引用应与服务端一致回退到类型默认值",
  );
  assert.deepEqual(registeredAgentTypes(registeredProfiles), ["codex", "qwen"]);
  const candidates = teamExecutorCandidates({
    status: "ready",
    agents: [
      { type: "claude", available: true, resident: true },
      { type: "codex", available: true, resident: true },
      { type: "qwen", available: true, resident: false },
    ],
  }, registeredProfiles);
  assert.deepEqual(candidates.workerTypes, ["codex", "qwen"]);
  assert.deepEqual(candidates.leadTypes, ["codex"]);
  assert.deepEqual(candidates.leadProfiles.map(({ id }) => id), ["codex-local"]);
  const executorLabels = executorOptions({
    types: candidates.workerTypes,
    profiles: registeredProfiles,
  }).map(({ label }) => label);
  assert.equal(executorLabels.some((label) => label.startsWith("claude ·")), false);
  assert.equal(executorLabels.some((label) => label.startsWith("codex ·")), true);
  assert.equal(executorLabels.some((label) => label.startsWith("qwen ·")), true);
  const staleType = executorOptions({
    types: candidates.workerTypes,
    profiles: registeredProfiles,
    selection: { agentType: "claude", executorId: null },
  }).find(({ value }) => value === "__type:claude");
  assert.deepEqual(staleType, {
    value: "__type:claude",
    label: "claude · 类型默认（当前设置 · 未注册）",
    disabled: true,
  });

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

  const batch = (key, at) => ({ key, at, workers: [], serial: false });
  const rowKinds = (rows) => rows.map((row) => (row.kind === "batch" ? `batch:${row.batch.key}` : `conv:${row.item.kind}`));
  const mixedFormatRows = mergeFeed([
    {
      kind: "agent",
      id: "lead-mixed",
      label: "lead",
      markdown: "",
      segments: [],
      at: "2026-07-27 16:35:00+08:00",
      endedAt: "2026-07-27 16:35:42+08:00",
    },
    { kind: "event", id: "worker-finished", text: "worker finished", at: "2026-07-27 16:41:29+08:00" },
  ], [batch("mixed-format", "2026-07-27T08:35:30.352Z")], teamFeedOptions());
  assert.deepEqual(rowKinds(mixedFormatRows), ["conv:agent", "batch:mixed-format", "conv:event"]);

  const snapshotRows = mergeFeed([
    { kind: "user", id: "latest-question", text: "latest question", paths: [], at: "2026-07-27T14:33:35.116Z" },
    {
      kind: "agent",
      id: "lead-latest",
      label: "lead",
      markdown: "",
      segments: [],
      at: "2026-07-27T14:33:35.116Z",
      endedAt: "2026-07-27T14:36:46.073Z",
    },
  ], [
    batch("16:35", "2026-07-27T08:35:30.352Z"),
    batch("17:00", "2026-07-27T09:00:20.000Z"),
  ], teamFeedOptions());
  assert.deepEqual(rowKinds(snapshotRows), ["batch:16:35", "batch:17:00", "conv:user", "conv:agent"]);

  const invalidTimeRows = mergeFeed([
    { kind: "event", id: "known", text: "known", at: "2026-07-27T10:00:00.000Z" },
    { kind: "event", id: "bad", text: "bad", at: "not-a-time" },
    { kind: "user", id: "untimed", text: "untimed", paths: [] },
  ], [
    batch("known", "2026-07-27T09:59:00.000Z"),
    batch("invalid-a", "not-a-time"),
    batch("invalid-b", ""),
  ], teamFeedOptions());
  assert.deepEqual(rowKinds(invalidTimeRows), [
    "batch:known",
    "conv:event",
    "conv:event",
    "conv:user",
    "batch:invalid-a",
    "batch:invalid-b",
  ]);

  assert.deepEqual(leadTurns([
    {
      kind: "agent",
      id: "lead-valid",
      label: "lead",
      markdown: "",
      segments: [],
      at: "2026-07-27 16:35:00+08:00",
      endedAt: "2026-07-27T08:35:42.000Z",
    },
    {
      kind: "agent",
      id: "lead-invalid",
      label: "lead",
      markdown: "",
      segments: [],
      at: "invalid",
      endedAt: "2026-07-27T09:00:00.000Z",
    },
  ]), [{ from: timeMs("2026-07-27T08:35:00.000Z"), to: timeMs("2026-07-27T08:35:42.000Z") }]);
  console.log("数据层回归验证通过");
} finally {
  globalThis.fetch = originalFetch;
}
