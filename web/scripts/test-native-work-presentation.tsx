import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionDetails, executionCountsLabel } from "../src/components/ExecutionTrace.tsx";
import type { ExecutionEvent } from "../src/lib/executionTrace.ts";
import type { AgentEvent, ServerEvent } from "@ash/shared";
import { applyDuetEvent, emptyDuet, rebuildDuetState } from "../src/duet/duetState.ts";

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
assert.equal(executionCountsLabel(events), "执行过程 · 1 工具");
assert.equal((html.match(/class="task-tool-name"/g) ?? []).length, 1);
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
      assert.equal(executionCountsLabel(turn.events), "执行过程 · 1 分析 · 6 工具");
      const markup = renderToStaticMarkup(<ExecutionDetails events={turn.events} running={!turn.done} />);
      assert.equal((markup.match(/class="task-tool-name"/g) ?? []).length, 7);
      assert.ok(markup.includes(">Edit</span>") && markup.includes(">Read</span>") && markup.includes("npm test"));
      assert.ok(markup.includes("旧执行器的派活记录"), "unmarked legacy Agent tools stay visible");
      assert.ok(!/子智能体|child-only|嵌套派活/.test(markup));
      assert.equal(turn.text, "讨论结论");
      assert.equal(turn.error, undefined, "a child's error does not become the speaker's failure");
    }
  }
}
console.log("duet 实时与刷新渲染一致：子智能体动态不产生空 Agent 行，讨论者工具、分析和旧派活记录完整保留");
