// 回复框里 `@` 一个人的纯逻辑那一半（replyCall.ts、dispatchNotes.ts、taskDerivation 的派出去正文）。
// 浏览器那一半在 test-reply-call-dom.mjs。
// 跑：npm -w web run test:reply-call
import assert from "node:assert/strict";
import {
  callChoices, callCommandVerb, dispatchBaseOptions, initialVerb, nextRounds, parseCallCommand, parseDispatchCommand,
  rememberedTarget, SELF_ASK_HELD, SELF_DISCUSS_HELD, toggleDiscussPerson,
} from "../src/task-detail/replyCall.ts";
import { dispatchNotes } from "../src/task-detail/dispatchNotes.ts";
import { interleaveAsides } from "../src/task-detail/feedAsides.ts";
import { buildDispatchBody } from "../src/task-detail/taskDerivation.ts";

// —— 停在哪一种做法 ——
const ALL = { dispatchable: true, discussable: true };
const ASK_DISPATCH = { dispatchable: true, discussable: false };
const ASK_ONLY = { dispatchable: false, discussable: false };
assert.equal(initialVerb(false, null, ALL), "ask", "选完别人默认问一句");
assert.equal(initialVerb(true, null, ALL), "dispatch", "自己只能派出去");
assert.equal(initialVerb(true, "ask", ALL), "dispatch", "自己：哪怕之前停在问一句也只能派出去");
assert.equal(initialVerb(true, "discuss", ALL), "dispatch", "自己：/讨论 叫上的也不能讨论（它本来就是讨论的一方）");
assert.equal(initialVerb(false, "dispatch", ALL), "dispatch", "/派 叫上的人停在派出去");
assert.equal(initialVerb(false, "discuss", ALL), "discuss", "/讨论 叫上的人停在讨论");
assert.equal(initialVerb(false, "discuss", ASK_DISPATCH), "ask", "开不了讨论的地方不停在讨论");
assert.equal(initialVerb(true, "dispatch", ASK_ONLY), "ask", "派不出去的地方只有问一句");

// —— 框顶那一行 ——
assert.deepEqual(callChoices(false, ASK_ONLY), [], "只有问一句：不摆这一行");
assert.deepEqual(callChoices(false, ALL).map((choice) => [choice.id, choice.label, choice.held]),
  [["ask", "问一句", null], ["discuss", "讨论", null], ["dispatch", "派出去", null]], "问一句 / 讨论 / 派出去");
assert.deepEqual(callChoices(false, ASK_DISPATCH).map((choice) => choice.id), ["ask", "dispatch"], "开不了讨论：没有那一颗");
assert.deepEqual(callChoices(true, ALL).map((choice) => [choice.id, choice.held]),
  [["ask", SELF_ASK_HELD], ["discuss", SELF_DISCUSS_HELD], ["dispatch", null]], "自己：问一句、讨论按不动，原因指到才出");

// —— /派 ——
assert.equal(parseDispatchCommand("/派"), "");
assert.equal(parseDispatchCommand("/派 写文档"), "写文档");
assert.equal(parseDispatchCommand("  /派\n两行"), "两行");
assert.equal(parseDispatchCommand("/派遣"), null, "别的命令不算");
assert.equal(parseDispatchCommand("先说 /派"), null, "句中不算");

// —— `/讨论` ——
assert.deepEqual(parseCallCommand("/讨论 幽灵锁走哪条路"), { verb: "discuss", rest: "幽灵锁走哪条路" });
assert.deepEqual(parseCallCommand("/讨论"), { verb: "discuss", rest: "" });
assert.deepEqual(parseCallCommand("/派 写文档"), { verb: "dispatch", rest: "写文档" });
assert.equal(parseCallCommand("/讨论区"), null, "别的命令不算");
assert.equal(parseDispatchCommand("/讨论 x"), null, "/讨论 不是 /派");
assert.equal(callCommandVerb("/讨论"), "discuss");
assert.equal(callCommandVerb("/派"), "dispatch");
assert.equal(callCommandVerb("/team"), null);

// —— 讨论：几轮那一段点一下换一档，转回第一档 ——
assert.deepEqual([1, 2, 3, "agreed"].map(nextRounds), [2, 3, "agreed", 1]);

// —— 讨论：「和谁」那一段多选，最多再叫两个（三方），最后一个放不掉 ——
const person = (agent) => ({ agent, executorId: null, model: null, reasoningEffort: null });
const one = { target: person("codex"), others: [] };
const two = toggleDiscussPerson(one, "gemini", person);
assert.deepEqual([two.target.agent, ...two.others.map((item) => item.agent)], ["codex", "gemini"], "再勾一个就是三方");
const swapped = toggleDiscussPerson(two, "grok", person);
assert.deepEqual([swapped.target.agent, ...swapped.others.map((item) => item.agent)], ["codex", "grok"], "满了再勾，换掉后加的那一个");
const dropped = toggleDiscussPerson(two, "codex", person);
assert.deepEqual([dropped.target.agent, ...dropped.others.map((item) => item.agent)], ["gemini"], "放掉胶囊上那个人，下一个顶上来");
assert.equal(toggleDiscussPerson(one, "codex", person), one, "最后一个放不掉");

// —— 记下的那一套 ——
const memory = { last: "codex", byAgent: { codex: { executorId: "p-codex", model: "gpt-5.6-sol", reasoningEffort: "high" } } };
assert.deepEqual(rememberedTarget("codex", memory), { agent: "codex", executorId: "p-codex", model: "gpt-5.6-sol", reasoningEffort: "high" });
assert.deepEqual(rememberedTarget("gemini", memory), { agent: "gemini", executorId: null, model: null, reasoningEffort: null }, "没叫过：跟随这个执行器的默认");

// —— 从哪开工 ——
const context = { isRepo: true, branches: ["main", "dev", "ash/t-source"], current: "main", worktreeDefault: true };
const source = { id: "t-source-1", useWorktree: true, mergeTargetBranch: null };
assert.deepEqual(dispatchBaseOptions(source, context), [
  { id: "here", label: "接着这里的代码", worktreeBase: "ash/t-source" },
  { id: "trunk", label: "从 main 开工", worktreeBase: "main" },
], "有自己的分支：接着它，或从项目检出的那条开工");
assert.deepEqual(dispatchBaseOptions({ ...source, mergeTargetBranch: "dev" }, context)[1], { id: "trunk", label: "从 dev 开工", worktreeBase: "dev" }, "主分支取这条任务最终合进去的那条");
assert.deepEqual(dispatchBaseOptions({ ...source, mergeTargetBranch: "gone" }, context), [{ id: "here", label: "接着这里的代码", worktreeBase: "ash/t-source" }],
  "合并目标不在本地了：只剩接着这里，别连这条任务的分支一起丢掉");
assert.deepEqual(dispatchBaseOptions({ ...source, useWorktree: false }, context), [], "在项目目录里干活、项目检出的就是主分支：两种一样，不必选");
assert.deepEqual(dispatchBaseOptions({ ...source, useWorktree: false }, { ...context, current: "feat", branches: ["main", "feat"] }), [],
  "没定合并目标：主分支就是项目目录检出的那条，跟「接着这里」一样，不必选");
assert.deepEqual(dispatchBaseOptions({ ...source, useWorktree: false, mergeTargetBranch: "main" }, { ...context, current: "feat", branches: ["main", "feat"] }), [
  { id: "here", label: "接着这里的代码", worktreeBase: null },
  { id: "trunk", label: "从 main 开工", worktreeBase: "main" },
], "在项目目录里干活：接着这里 = 项目目录此刻的 HEAD");
assert.deepEqual(dispatchBaseOptions({ ...source, id: "t-gone-01" }, context), [], "这条任务的分支没了：接着这里无从说起");
assert.deepEqual(dispatchBaseOptions(source, { ...context, isRepo: false }), [], "不是仓库：没有开工起点可选");
assert.deepEqual(dispatchBaseOptions(source, { ...context, worktreeDefault: false }), [], "新任务不开 worktree：没有开工起点可选");
assert.deepEqual(dispatchBaseOptions(source, null), [], "还没读到");

// —— 会话里那一句 ——
const task = (id, extra) => ({ id, title: id, agentType: "codex", createdAt: "2026-11-15T02:00:00.000Z", dispatchedBy: null, creationOrigin: { kind: "user" }, ...extra });
const notes = dispatchNotes("src", [
  task("late", { dispatchedBy: "src", createdAt: "2026-11-15T03:00:00.000Z" }),
  task("early", { dispatchedBy: "src", createdAt: "2026-11-15T01:30:00.000Z", title: "" }),
  task("by-agent", { dispatchedBy: "src", creationOrigin: { kind: "agent", taskId: "src" } }),
  task("other", { dispatchedBy: "else" }),
  task("plain"),
]);
assert.deepEqual(notes.map((note) => [note.id, note.title, note.agent]), [["early", "未命名任务", "codex"], ["late", "late", "codex"]],
  "只认你从回复框派的（用户建、挂在这条名下），按时间排");
const rows = [{ at: "2026-11-15T01:00:00.000Z", id: "a" }, { at: null, id: "lane" }, { at: "2026-11-15T02:00:00.000Z", id: "b" }];
const asides = notes.map((note) => ({ key: note.id, at: note.at, node: null }));
assert.deepEqual(interleaveAsides(rows, asides, (row) => row.at).map((entry) => entry.row ? entry.row.id : entry.aside.key),
  ["a", "lane", "early", "b", "late"], "按派出去那一刻插进会话：排在第一个比它晚的行前面，最晚的跟在最后");

// —— 派出去的新任务正文：写的那句在最前，后面带着这场对话 ——
const sourceTask = { id: "src", title: "登录页", body: "改成新样式", status: "running" };
const sessions = [
  { startedAt: "2026-11-15T01:00:00.000Z", transcriptPath: "/runs/src/old.md" },
  { startedAt: "2026-11-15T02:00:00.000Z", transcriptPath: "/runs/src/new.md" },
];
const body = buildDispatchBody(sourceTask, sessions, "  补单测  ");
assert.ok(body.startsWith("补单测\n"), "要做的事排在最前");
assert.match(body, /## 来源普通任务\n任务标题：登录页\n改成新样式/);
assert.match(body, /来源任务当前为「[^」]+」；创建这条任务不会改变来源任务的状态。/);
assert.match(body, /最新会话记录：`\/runs\/src\/new\.md`/, "带最新那条会话");
assert.match(body, /来源任务 ID（仅供溯源）：src$/);
console.log("reply call test passed");
