import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionDetails, executionSummaryText } from "../src/components/ExecutionTrace.tsx";
import type { ExecutionEvent } from "../src/lib/executionTrace.ts";
import type { AgentEvent, ServerEvent } from "@ash/shared";
import { applyDuetEvent, emptyDuet, rebuildDuetState } from "../src/duet/duetState.ts";
import { NativeWorkHeadline } from "../src/task-detail/NativeWorkMeta.tsx";
import { agentListRows, agentProvenance, agentSideText } from "../src/task-detail/nativeWorkList.ts";
import { NativeAgentConversation } from "../src/task-detail/NativeAgentConversation.tsx";
import type { NativeWorkItem } from "../src/task-detail/nativeWorkModel.ts";

const call: ExecutionEvent = { kind: "tool", label: "Agent", detail: "派活",
  nativeWork: { type: "call", id: "a", name: "Agent", input: { description: "派活" } } };
const progress: ExecutionEvent = { kind: "tool", label: "Agent", detail: "不应出现在主执行过程的进度",
  nativeWork: { type: "agent", id: "a", status: "running", message: "进度" } };
const nested: ExecutionEvent = { kind: "tool", label: "TaskCreate", detail: "子任务",
  nativeWork: { type: "call", id: "child", parentId: "a", name: "TaskCreate", input: { subject: "子任务" } } };
const activity: ExecutionEvent = { kind: "tool", label: "Agent",
  nativeWork: { type: "activity", id: "a", event: { kind: "text", text: "子智能体的完整实时正文" } } };
const events = [call, progress, nested, activity];
const html = renderToStaticMarkup(<ExecutionDetails events={events} running={false} />);
// 只剩那一次派活:摘要直接说那一步。
assert.equal(executionSummaryText(events), "派了 子智能体「派活」");
assert.equal((html.match(/class="task-tool-verb"/g) ?? []).length, 1);
assert.ok(!html.includes("不应出现在主执行过程的进度"));
assert.ok(!html.includes("子智能体的完整实时正文"));
assert.equal(renderToStaticMarkup(<ExecutionDetails events={[progress, nested]} running={false} />), "");
console.log("子智能体动态只在侧栏呈现，主执行过程保留一次派活且不产生空折叠块");

for (const name of ["Agent", "spawn_agent"]) {
  for (const speaker of ["A", "B"] as const) {
    const start: ServerEvent = { type: "duet.progress", taskId: "duet", round: 1, speaker, phase: "start" };
    let state = applyDuetEvent(emptyDuet(), start);
    const emit = (event: AgentEvent) => {
      state = applyDuetEvent(state, { type: "agent.event", taskId: "duet", sessionId: "session",
        role: speaker === "A" ? "voiceA" : "voiceB", event });
    };
    emit({ kind: "tool", name: "Bash", detail: "git status --short" });
    emit({ kind: "tool", name, detail: "查资料", nativeWork: { type: "call", id: "a", name, input: { description: "查资料" } } });
    for (let index = 0; index < 240; index++) {
      for (const kind of ["text", "thinking"] as const) {
        emit({ kind: "tool", name: "Agent", nativeWork: { type: "activity", id: "a", event: { kind, text: "子智能体内容" } } });
      }
    }
    for (const event of [progress, nested]) emit({ kind: "tool", name: event.label, detail: event.detail, nativeWork: event.nativeWork });
    emit({ kind: "tool", name: "Agent", nativeWork: { type: "result", id: "a", result: "子智能体结果", failed: false } });
    emit({ kind: "tool", name: "Agent", nativeWork: { type: "activity", id: "a", event: { kind: "tool", name: "Read", detail: "child-only.ts" } } });
    emit({ kind: "tool", name: "Agent", nativeWork: { type: "activity", id: "a", event: { kind: "attachment", path: "child-only.png" } } });
    emit({ kind: "tool", name: "Agent", nativeWork: { type: "activity", id: "a", event: { kind: "error", message: "子智能体错误" } } });
    emit({ kind: "thinking", text: "讨论者的分析" });
    emit({ kind: "tool", name: "Edit", detail: "plan.md" });
    emit({ kind: "tool", name: "Read", detail: "plan.md" });
    emit({ kind: "tool", name: "Bash", detail: "npm test" });
    emit({ kind: "tool", name: "Agent", detail: "旧执行器的派活记录" });
    emit({ kind: "text", text: "讨论结论" });

    const live = state.turns[0]!;
    const reloaded = rebuildDuetState([JSON.parse(JSON.stringify({ ...live, done: undefined }))]).turns[0]!;
    for (const turn of [live, reloaded]) {
      assert.equal(turn.events.length, 7);
      // 读、改按文件去重(都是 plan.md);只说前三类,两次派活并进「另有 2 步」;思考不计数。
      assert.equal(executionSummaryText(turn.events), "读了 1 个文件，改了 1 个，跑了 2 条命令，另有 2 步");
      const markup = renderToStaticMarkup(<ExecutionDetails events={turn.events} running={!turn.done} />);
      assert.equal((markup.match(/class="task-tool-verb"/g) ?? []).length, 7);
      assert.ok(markup.includes(">改</span>") && markup.includes(">读</span>") && markup.includes("npm test"));
      assert.ok(markup.includes("旧执行器的派活记录"), "unmarked legacy Agent tools stay visible");
      // 盯的是子智能体那条线上的**内容**漏没漏进来;折叠条自己会说「派了 子智能体「…」」,那是派活这一步本身。
      assert.ok(!/子智能体内容|子智能体结果|子智能体错误|child-only|嵌套派活/.test(markup));
      assert.equal(turn.text, "讨论结论");
      assert.equal(turn.error, undefined, "a child's error does not become the speaker's failure");
    }
  }
}
console.log("duet 实时与刷新渲染一致：子智能体动态不产生空 Agent 行，讨论者工具、分析和旧派活记录完整保留");

const pendingRow: NativeWorkItem = { id: "pending", sessionId: "session", sessionLabel: "codex@test", kind: "task",
  title: "待处理步骤", status: "pending" };
const timedRow = { ...pendingRow, status: "completed" as const,
  startedAt: "2026-09-09T00:00:00.000Z", endedAt: "2026-09-09T00:08:00.000Z" };
const now = Date.parse("2026-09-09T00:10:00.000Z");
// 右边那几个字：在跑和跑完了的是用时，别的状态只换字；没开工没有用时可报。
assert.deepEqual(agentSideText({ ...pendingRow, kind: "agent" }, now), { text: "待处理", tone: "plain" });
assert.deepEqual(agentSideText({ ...timedRow, kind: "agent" }, now), { text: "8分 0秒", tone: "plain" });
assert.deepEqual(agentSideText({ ...timedRow, kind: "agent", status: "running", endedAt: undefined }, now), { text: "10分 0秒", tone: "live" });
assert.deepEqual(agentSideText({ ...timedRow, kind: "agent", status: "failed" }, now), { text: "失败", tone: "bad" });
assert.deepEqual(agentSideText({ ...pendingRow, kind: "agent", status: "completed", endedAt: "2026-09-09T01:00:00.000Z" }, now),
  { text: "已完成", tone: "plain" }, "没记下开始时间就算不出用时，照实说已完成");
const pendingAgent = renderToStaticMarkup(<NativeAgentConversation row={{ ...pendingRow, kind: "agent" }} statusLabel="待处理" />);
assert.ok(pendingAgent.includes("未记录") && !pendingAgent.includes("会话默认") && pendingAgent.includes("等待子智能体开始执行"));
assert.ok(!pendingAgent.includes("执行中，内容实时更新"));

// 出处那一行：模型和智能水平是一对，实跑值压过调用时点的档位，只有退回到点名的那一项标调用指定；
// 两样都没问出来就不占位（不连写两个「未记录」）。
const agentRow = { ...pendingRow, kind: "agent" as const };
assert.deepEqual(agentProvenance({ ...agentRow, requestedModel: "sonnet" }), ["sonnet（调用指定）"]);
assert.deepEqual(agentProvenance({ ...agentRow, requestedModel: "opus", model: "claude-sonnet-4-6" }), ["claude-sonnet-4-6"]);
const effortRow = { ...agentRow, model: "gpt-5.6-sol", effort: "low" };
assert.deepEqual(agentProvenance({ ...effortRow, requestedEffort: "high" }), ["gpt-5.6-sol", "智能水平 low"], "用户可见文案只叫智能水平");
assert.deepEqual(agentProvenance({ ...agentRow, requestedEffort: "xhigh" }), ["智能水平 xhigh（调用指定）"]);
assert.deepEqual(agentProvenance({ ...pendingRow, effort: "low" }), [], "内部任务没有自己的模型和智能水平");
assert.deepEqual(agentProvenance({ ...timedRow, kind: "agent", agentType: "Explore", status: "stopped" }, { now, parentTitle: "上一级", showSession: true }),
  ["Explore", "09/09 08:00 派出", "跑了 8分 0秒", "由「上一级」派出", "codex@test"], "没正常跑完的才在出处里补一句跑了多久");
assert.ok(!agentProvenance({ ...timedRow, kind: "agent" }, { now }).some((piece) => piece.startsWith("跑了")), "跑完的用时已经在右边，不重复");

// 在跑的排最前；其余按派出去的那一轮分组，新的一轮在上；换轮的那一行多留一点空。
const listed = agentListRows([
  { ...agentRow, id: "a1", dispatchTurn: "t1", status: "completed" },
  { ...agentRow, id: "a2", dispatchTurn: "t1", status: "completed" },
  { ...agentRow, id: "b1", dispatchTurn: "t2", status: "completed" },
  { ...agentRow, id: "b2", dispatchTurn: "t2", status: "running" },
  { ...pendingRow, id: "todo" },
]);
assert.deepEqual(listed.map(({ row, batchStart }) => [row.id, batchStart]), [["b2", false], ["b1", true], ["a1", true], ["a2", false]]);

// 没有派活正文时照实说明,别留一片空白让人以为界面漏了。
const noAssignment = renderToStaticMarkup(<NativeAgentConversation row={{ ...effortRow, kind: "agent" }} statusLabel="待处理" />);
assert.ok(noAssignment.includes("未记录主会话给它的输入") && noAssignment.includes("加密"), "拿不到就说清为什么拿不到");
const assigned = renderToStaticMarkup(<NativeAgentConversation row={{ ...effortRow, description: "去验证登录页" }} statusLabel="进行中" />);
assert.ok(assigned.includes("收到的输入") && assigned.includes("去验证登录页") && !assigned.includes("未记录主会话给它的输入"));
assert.ok(!assigned.includes("任务说明"), "子智能体那一份是「收到的输入」，和内部任务的说明不是一件事");

// 抬头那条是横向摊开的一句，不是列表里那套两列表格。
const headline = renderToStaticMarkup(<NativeWorkHeadline row={{ ...timedRow, kind: "agent", model: "gpt-5.6-sol", effort: "xhigh" }} />);
assert.ok(!headline.includes("native-work__meta") && !headline.includes("<dl") && !headline.includes("开始时间"),
  "抬头不复刻两列表格");
for (const piece of ["codex@test", "gpt-5.6-sol", "xhigh", "09/09 08:00 → 08:08", "8分 0秒"]) {
  assert.ok(headline.includes(piece), `抬头该带上 ${piece}`);
}
// 抬头是摘要：问出来几项就摊开几项，一项都没问出来才留一个「未记录」。
const halfKnown = renderToStaticMarkup(<NativeWorkHeadline row={{ ...timedRow, kind: "agent", model: "gpt-5.6-sol" }} />);
assert.ok(!halfKnown.includes("未记录"), "模型有了就不必为智能水平占一格空位");
const nothingKnown = renderToStaticMarkup(<NativeWorkHeadline row={{ ...timedRow, kind: "agent" }} />);
assert.equal((nothingKnown.match(/未记录/g) ?? []).length, 1, "一项都没有时只说一次未记录");
const runningHeadline = renderToStaticMarkup(<NativeWorkHeadline
  row={{ ...timedRow, kind: "agent", status: "running", endedAt: undefined }} />);
assert.ok(runningHeadline.includes("09/09 08:00 起") && !runningHeadline.includes("尚未结束"),
  "还在跑的用「起」收尾，不占一行去说尚未结束");
const pendingHeadline = renderToStaticMarkup(<NativeWorkHeadline row={{ ...pendingRow, kind: "agent" }} />);
assert.ok(pendingHeadline.includes("尚未开始") && !pendingHeadline.includes("—"), "没时间可报时不留破折号占位");
console.log("待处理/历史缺失时间文案、时间跨度标签、内部任务不显示模型及抬头横排回归通过");
