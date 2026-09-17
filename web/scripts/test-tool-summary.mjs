import assert from "node:assert/strict";
import { appendExecutionEvent, hasMoreThanSummary, shortenPath, traceSummary } from "../src/lib/executionTrace.ts";

const tool = (label, detail) => ({ kind: "tool", label, detail });

// claude:detail 是 tool_use.input 的 JSON —— 展开后要当场看见命令,而不是「Bash」。
assert.equal(traceSummary(tool("Bash", JSON.stringify({ command: "npm -w web run build", description: "构建前端" }))), "npm -w web run build");
assert.equal(traceSummary(tool("Read", JSON.stringify({ file_path: "/Users/example/code/ash/server/src/debate/index.ts" }))), "…/debate/index.ts");
assert.equal(traceSummary(tool("Read", JSON.stringify({ file_path: "server/src/db.ts" }))), "server/src/db.ts"); // 短路径不缩
assert.equal(traceSummary(tool("Grep", JSON.stringify({ pattern: "ExecutionDetails", path: "web/src" }))), "ExecutionDetails");
assert.equal(traceSummary(tool("Glob", JSON.stringify({ pattern: "**/*.tsx" }))), "**/*.tsx");
assert.equal(traceSummary(tool("WebFetch", JSON.stringify({ url: "https://example.com/a", prompt: "读它" }))), "https://example.com/a");
assert.equal(traceSummary(tool("WebSearch", JSON.stringify({ query: "claude code" }))), "claude code");
assert.equal(traceSummary(tool("Task", JSON.stringify({ subagent_type: "Explore", description: "找工具渲染点", prompt: "很长的 prompt" }))), "找工具渲染点");
assert.equal(traceSummary(tool("Edit", JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: "y" }))), "a.ts");

// 命令里的换行折成一行,别把折叠块撑成一段代码。
assert.equal(traceSummary(tool("Bash", JSON.stringify({ command: "cd /tmp\nls -la" }))), "cd /tmp ls -la");

// TodoWrite 的 input 里没有一句「在干什么」:取正在做的那条。
const todos = JSON.stringify({ todos: [
  { content: "写组件", activeForm: "写组件中", status: "completed" },
  { content: "接辩论", activeForm: "接入辩论表面", status: "in_progress" },
] });
assert.equal(traceSummary(tool("TodoWrite", todos)), "接入辩论表面（共 2 项）");

// 执行器把超长 input 截断过(claude 的 shortJson 到 1500 字加省略号),
// 半截 JSON 解析必然失败 —— 仍要能取出命令,不能退回空白。
const truncated = `{"command":"grep -rn \\"ExecutionDetails\\" web/src","descripti`;
assert.equal(traceSummary(tool("Bash", truncated)), 'grep -rn "ExecutionDetails" web/src');

// codex:detail 是纯文本(exec 给命令原文、edit 给路径)。
assert.equal(traceSummary(tool("exec", "bash -lc 'npm test'")), "bash -lc 'npm test'");
assert.equal(traceSummary(tool("edit", "/Users/example/code/ash/web/src/lib/executionTrace.ts")), "…/lib/executionTrace.ts");
// server 跑在 Windows 上时,同一个 edit 报上来的是盘符路径。纯文本这条路曾经只认 `/`,
// 于是整条 `C:\...` 糊在行内摘要里,而包在 JSON 里的同一个路径是缩过的 —— 同一份 trace
// 两种长相。JSON 与纯文本两条路都钉在这里。
const winPath = "C:\\Users\\example\\code\\ash\\server\\src\\db\\index.ts";
assert.equal(traceSummary(tool("edit", winPath)), "…\\db\\index.ts");
assert.equal(traceSummary(tool("Edit", JSON.stringify({ file_path: winPath }))), "…\\db\\index.ts");
// 带空格的命令原文照旧当命令,不因为里面有反斜杠就被当成路径切掉。
assert.equal(traceSummary(tool("exec", 'cmd /c dir C:\\Users')), "cmd /c dir C:\\Users");

// 认不出的形状不能报错,也不能吐 undefined:退回原文/空串。
assert.equal(traceSummary(tool("Wat", JSON.stringify({ foo: 12, bar: "值" }))), "12");
assert.equal(traceSummary(tool("Wat", JSON.stringify({}))), "");
assert.equal(traceSummary(tool("Wat", undefined)), "");
assert.equal(traceSummary(tool("Wat", "   ")), "");
assert.equal(traceSummary(tool("Wat", "[1,2,3]")), "[1,2,3]");

// 思考/异常:label 是分类,detail 才是内容。
assert.equal(traceSummary({ kind: "thinking", label: "思考过程", detail: "先看\n再改" }), "先看 再改");
assert.equal(traceSummary({ kind: "error", label: "boom", detail: "stack" }), "stack");

// 超长摘要截断,别把一行撑爆。
const long = traceSummary(tool("Bash", JSON.stringify({ command: "x".repeat(600) })));
assert.ok(long.length <= 220 && long.endsWith("…"));

// 行内已经把 detail 说完时,这行不该再做成可展开的(点开只是同一句话)。
assert.equal(hasMoreThanSummary(tool("exec", "ls -la"), "ls -la"), false);
assert.equal(hasMoreThanSummary(tool("Bash", JSON.stringify({ command: "ls" })), "ls"), true);
assert.equal(hasMoreThanSummary(tool("Wat", undefined), ""), false);

assert.equal(shortenPath("index.ts"), "index.ts");
assert.equal(shortenPath("/a/b"), "/a/b");

// 思考是流式小块：相邻的合并成一行，否则 DeepSeek 那种一词一块的 reasoning 会把
// 「执行过程」刷成几百行「思考过程 The」「思考过程 output」（用户 2026-09-17 反馈）。
const think = (detail) => ({ kind: "thinking", label: "思考过程", detail });
const merged = ["The", " output", " was", " truncated"]
  .reduce((events, word) => appendExecutionEvent(events, think(word)), []);
assert.equal(merged.length, 1, "相邻思考只占一行");
assert.deepEqual(merged[0], think("The output was truncated"));
// 中间隔了工具就不是「相邻」了：思考分属两次，合并会把两段不同的思考粘成一句。
const split = [think("先看看"), tool("exec", "ls -la"), think("再改"), think("这里")]
  .reduce((events, event) => appendExecutionEvent(events, event), []);
assert.deepEqual(split.map((event) => event.detail), ["先看看", "ls -la", "再改这里"]);
// 子智能体的活动事件渲染在别处（isVisibleExecutionEvent 过滤掉），不能拿它当分隔：
// 不跳过的话主会话一段思考会被一串看不见的事件劈成几十行。
const hidden = { kind: "tool", label: "Agent", detail: "子智能体", nativeWork: { type: "activity", id: "child", event: { kind: "text", text: "x" } } };
const acrossHidden = [think("主会话在想"), hidden, think("接着想")]
  .reduce((events, event) => appendExecutionEvent(events, event), []);
assert.deepEqual(acrossHidden.map((event) => event.detail), ["主会话在想接着想", "子智能体"]);
// 原数组不被就地改写：duet 那路把它当 React state 用，就地改不会触发重渲染。
const before = [think("A")];
assert.notEqual(appendExecutionEvent(before, think("B")), before);
assert.deepEqual(before, [think("A")]);

console.log("tool-summary ok");
