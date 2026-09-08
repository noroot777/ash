import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionDetails, executionCountsLabel } from "../src/components/ExecutionTrace.tsx";
import type { ExecutionEvent } from "../src/lib/executionTrace.ts";

const call: ExecutionEvent = { kind: "tool", label: "Agent", detail: "派活",
  nativeWork: { type: "call", id: "a", name: "Agent", input: { description: "派活" } } };
const progress: ExecutionEvent = { kind: "tool", label: "Agent", detail: "不应出现在主执行过程的进度",
  nativeWork: { type: "agent", id: "a", status: "running", message: "进度" } };
const nested: ExecutionEvent = { kind: "tool", label: "TaskCreate", detail: "子任务",
  nativeWork: { type: "call", id: "child", parentId: "a", name: "TaskCreate", input: { subject: "子任务" } } };
const events = [call, progress, nested];
const html = renderToStaticMarkup(<ExecutionDetails events={events} running={false} />);
assert.equal(executionCountsLabel(events), "执行过程 · 1 工具");
assert.equal((html.match(/class="task-tool-name"/g) ?? []).length, 1);
assert.ok(!html.includes("不应出现在主执行过程的进度"));
assert.equal(renderToStaticMarkup(<ExecutionDetails events={[progress, nested]} running={false} />), "");
console.log("子智能体动态只在侧栏呈现，主执行过程保留一次派活且不产生空折叠块");
