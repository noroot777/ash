// Claude Code 计划模式（`/plan`）：命令层、计划闸、执行器起跑参数、状态与「实施此计划」前置校验。
// 真 CLI 的协议形状（ExitPlanMode 以 can_use_tool 到达、input 为空、正文在计划文件里）见
// src/executors/claude-plan-gate.ts 文件头；这里用假 CLI 按同一形状回放。
import "./isolated-data.js";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentEvent } from "@navi/shared";
import { cliCommandCatalog, parseCliCommand, validateCliCommand } from "@navi/shared/cli-commands";
import { IS_WINDOWS } from "../src/platform.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "navi-claude-plan-"));
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { ClaudePlanGate, CLAUDE_PLAN_ARGS, claudePlansDir, planFilesMarker, planSafeExtraArgs, plansDirOfCommandLine } = await import("../src/executors/claude-plan-gate.js");
const { planTurnInput, PLAN_IMPLEMENT_TEXT } = await import("../src/plan-turn.js");
const { nativeCliCommand } = await import("../src/skills.js");
const { inputStartsExecution } = await import("../src/task-continuation-entry.js");
const { PLANNING_TURN } = await import("../src/run-prompts.js");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions } = await import("../src/db/schema.js");
const { replyToTask } = await import("../src/task-reply.js");
const { prepareCliInvocation, readCliState, saveCliState } = await import("../src/task-cli-state.js");
const { enrichTasks } = await import("../src/task-store.js");
const { assertPlanReady } = await import("../src/task-plan.js");
const { sessionTracePath } = await import("../src/transcript.js");

try {
  await ensureSchema();
  // ── 命令层：claude 也认 /plan，但不原样透传给 CLI
  assert.ok(Object.hasOwn(cliCommandCatalog("claude"), "plan"));
  assert.equal(validateCliCommand("claude", "/plan 怎么拆这个功能")?.args, "怎么拆这个功能");
  assert.throws(() => validateCliCommand("claude", "/plan --deep 怎么拆"), /不支持这个参数/);
  assert.equal(nativeCliCommand("claude", "/plan 怎么拆"), null, "claude 的 /plan 由 Navi 切权限模式实现，不当原生命令透传");
  assert.equal(nativeCliCommand("claude", "/plan off"), null);
  assert.equal(nativeCliCommand("codex", "/plan 怎么拆"), "plan", "codex 那一路照旧是原生命令");
  assert.equal(inputStartsExecution("claude", "/plan implement plan:toolu_1"), true);
  const slash = (text: string) => parseCliCommand("claude", text);
  assert.deepEqual(planTurnInput("claude", slash("/plan 怎么拆"), "/plan 怎么拆"), { question: true, text: "怎么拆" });
  assert.deepEqual(planTurnInput("claude", slash("/plan implement plan:x"), "/plan implement plan:x"), { question: false, text: PLAN_IMPLEMENT_TEXT });
  assert.deepEqual(planTurnInput("claude", slash("/plan off"), "/plan off"), { question: false, text: "/plan off" });
  assert.deepEqual(planTurnInput("codex", parseCliCommand("codex", "/plan 怎么拆"), "/plan 怎么拆"), { question: false, text: "/plan 怎么拆" });
  assert.deepEqual(planTurnInput("claude", null, "普通回复"), { question: false, text: "普通回复" });
  assert.match(PLANNING_TURN({ freshContext: false, verifying: false }, "问题", "claude"), /ExitPlanMode/);
  assert.doesNotMatch(PLANNING_TURN({ freshContext: false, verifying: false }, "问题", "codex"), /ExitPlanMode/);
  console.log("claude /plan command parsing and prompt rewriting: passed");

  // ── 计划闸：只读放行、计划文件放行、写操作拒、ExitPlanMode 交出计划并拒、提问转成答题卡
  const plansDir = join(root, "config", "plans");
  mkdirSync(plansDir, { recursive: true });
  const configEnv = { CLAUDE_CONFIG_DIR: join(root, "config") };
  assert.equal(claudePlansDir(root, configEnv, []), plansDir, "没配 plansDirectory：随这次起跑的配置目录走");
  // 计划目录按 CLI 自己的合并结果：项目 settings 的 plansDirectory 按项目根解；额外参数的 --settings 压过它；
  // 出了项目根退回默认；--setting-sources 不点名 project 时项目那层不算。
  const project = join(root, "project");
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ plansDirectory: ".plans" }));
  assert.equal(claudePlansDir(project, configEnv, []), join(project, ".plans"));
  assert.equal(claudePlansDir(project, configEnv, ["--settings", JSON.stringify({ plansDirectory: "docs/plans" })]), join(project, "docs", "plans"));
  writeFileSync(join(root, "flag-settings.json"), JSON.stringify({ plansDirectory: "notes" }));
  assert.equal(claudePlansDir(project, configEnv, [`--settings=${join(root, "flag-settings.json")}`]), join(project, "notes"));
  assert.equal(claudePlansDir(project, configEnv, ["--settings", JSON.stringify({ plansDirectory: "../outside" })]), plansDir);
  assert.equal(claudePlansDir(project, configEnv, ["--setting-sources", "user"]), plansDir);
  // 接管认回起跑时的目录：它记在 commandLine 上
  assert.equal(plansDirOfCommandLine(`claude ${CLAUDE_PLAN_ARGS.join(" ")} <messages via stdin>${planFilesMarker(join(project, "目录 \"x\""))}`), join(project, "目录 \"x\""));
  assert.equal(plansDirOfCommandLine(`claude --dangerously-skip-permissions <messages via stdin>${planFilesMarker(plansDir)}`), undefined);
  // 额外参数里改权限模式的那几个在计划回合摘掉
  assert.deepEqual(planSafeExtraArgs(["--dangerously-skip-permissions", "--permission-mode", "acceptEdits", "--permission-mode=default", "--permission-prompt-tool", "mcp__x", "--allow-dangerously-skip-permissions", "--add-dir", "/d"]), ["--add-dir", "/d"]);
  const written: any[] = [];
  const gate = new ClaudePlanGate(plansDir, (line) => written.push(JSON.parse(line)));
  const ask = (tool: string, input: unknown, id = tool) => gate.request({ type: "control_request", request_id: `req-${id}`, request: { subtype: "can_use_tool", tool_name: tool, input, tool_use_id: `toolu_${id}` } });
  const last = () => written.at(-1).response;
  assert.deepEqual(ask("Read", { file_path: "/elsewhere/a.txt" }), []);
  assert.equal(last().response.behavior, "allow");
  assert.deepEqual(last().response.updatedInput, { file_path: "/elsewhere/a.txt" });
  ask("Bash", { command: "rm -rf build" });
  assert.equal(last().response.behavior, "deny");
  assert.match(last().response.message, /计划模式只读/);
  ask("Write", { file_path: join(root, "src.ts"), content: "x" }, "w1");
  assert.equal(last().response.behavior, "deny", "计划文件以外的写一律拒");
  ask("Write", { file_path: join(plansDir, "../../escape.md"), content: "x" }, "w2");
  assert.equal(last().response.behavior, "deny", "路径穿出计划目录不算计划文件");
  writeFileSync(join(root, "outside.md"), "外面");
  symlinkSync(join(root, "outside.md"), join(plansDir, "link.md"));
  ask("Write", { file_path: join(plansDir, "link.md"), content: "x" }, "w3");
  assert.equal(last().response.behavior, "deny", "目录内指向外面的软链接不能借道写出去");
  ask("mcp__navi__complete_task", { taskId: "t" });
  assert.equal(last().response.behavior, "deny");
  const planFile = join(plansDir, "snug-milner.md");
  ask("Write", { file_path: planFile, content: "# 计划" }, "plan-write");
  assert.equal(last().response.behavior, "allow");
  writeFileSync(planFile, "# 计划\n\n1. 改 a.txt\n");
  gate.noteToolResult({ type: "tool_result", tool_use_id: "toolu_plan-write", content: "ok" });
  gate.noteAssistant([{ type: "text", text: "我准备这样做。" }]);
  const submitted = ask("ExitPlanMode", {}, "exit1");
  assert.deepEqual(submitted, [{ kind: "plan", id: "plan:toolu_exit1", text: "# 计划\n\n1. 改 a.txt", status: "complete" }]);
  assert.equal(last().response.behavior, "deny", "交计划要拒：放行等于当场退出计划模式接着动手");
  assert.equal(last().request_id, "req-exit1");
  assert.deepEqual(ask("ExitPlanMode", { plan: "老版本 CLI 把正文放在 input 里" }, "exit2"), [{ kind: "plan", id: "plan:toolu_exit2", text: "老版本 CLI 把正文放在 input 里", status: "complete" }]);
  // 改计划失败：文件里还是旧方案，不能把它当新计划交出去；改成了才交
  ask("Edit", { file_path: planFile, old_string: "a.txt", new_string: "b.txt" }, "plan-edit");
  assert.equal(last().response.behavior, "allow");
  gate.noteToolResult({ type: "tool_result", tool_use_id: "toolu_plan-edit", is_error: true, content: "EACCES" });
  gate.noteAssistant([{ type: "text", text: "新方案：改 b.txt。" }]);
  assert.deepEqual(ask("ExitPlanMode", {}, "exit3"), []);
  assert.equal(last().response.behavior, "deny");
  assert.match(last().response.message, /写计划文件失败/);
  gate.noteAssistant([{ type: "tool_use", id: "toolu_plan-edit2", name: "Edit", input: { file_path: planFile } }]);
  writeFileSync(planFile, "# 计划\n\n1. 改 b.txt\n");
  gate.noteToolResult({ type: "tool_result", tool_use_id: "toolu_plan-edit2", content: "ok" });
  assert.equal((ask("ExitPlanMode", {}, "exit4")[0] as any).text, "# 计划\n\n1. 改 b.txt", "CLI 不来问的写入照样从 tool_use 认，以回执为准");
  const noFile = new ClaudePlanGate(plansDir, (line) => written.push(JSON.parse(line)));
  noFile.noteAssistant([{ type: "text", text: "我先看看现有代码。" }, { type: "tool_use", name: "Read", input: { file_path: "/x" } }]);
  noFile.noteAssistant([{ type: "text", text: "计划写在回复里：先读再改。" }, { type: "tool_use", name: "ExitPlanMode", input: {} }]);
  assert.equal((noFile.request({ request_id: "r", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: {}, tool_use_id: "toolu_t" } })[0] as any).text, "计划写在回复里：先读再改。");
  const empty = new ClaudePlanGate(plansDir, (line) => written.push(JSON.parse(line)));
  assert.deepEqual(empty.request({ request_id: "r2", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: {} } }), []);
  assert.match(last().response.message, /没有找到计划正文/);
  assert.deepEqual(ask("AskUserQuestion", { questions: [{ question: "重置时间？", options: [{ label: "每周一", description: "零点" }] }] }, "q"), [
    { kind: "userInput", questions: [{ question: "重置时间？", options: ["每周一：零点"] }] },
  ]);
  assert.equal(last().response.behavior, "deny");
  gate.request({ request_id: "hook", request: { subtype: "hook_callback" } });
  assert.equal(last().subtype, "error", "不认的控制请求回错误，别让 CLI 干等");
  assert.equal(gate.initProblem("plan"), null);
  assert.match(gate.initProblem("bypassPermissions") ?? "", /计划模式没有生效/);
  ask("Read", { file_path: "/elsewhere/a.txt" }, "after-halt");
  assert.equal(last().response.behavior, "deny", "权限模式不对之后到达的请求一律拒");
  console.log("plan gate answers permission requests and hands over the plan: passed");

  // ── 执行器：计划回合换权限参数；假 CLI 按真 CLI 的形状走一遍
  const script = join(root, "fake-claude.mjs");
  const bin = IS_WINDOWS ? join(root, "claude.cmd") : script;
  process.env.NAVI_TEST_AGENT_BIN = bin;
  const argvFile = join(root, "argv.json");
  const answersFile = join(root, "answers.jsonl");
  writeFileSync(script, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const planMode = process.argv.includes("plan");
const planFile = ${JSON.stringify(join(plansDir, "fake-session.md"))};
const steps = [
  () => { emit({ type: "assistant", message: { model: "m", content: [{ type: "tool_use", id: "toolu_w", name: "Write", input: { file_path: planFile, content: "# 假计划" } }] } });
    emit({ type: "control_request", request_id: "c1", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: planFile, content: "# 假计划" }, tool_use_id: "toolu_w" } }); },
  () => { writeFileSync(planFile, "# 假计划\\n\\n先读后改");
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_w", content: "ok" }] } });
    emit({ type: "control_request", request_id: "c2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "touch x" }, tool_use_id: "toolu_b" } }); },
  () => { emit({ type: "assistant", message: { model: "m", content: [{ type: "tool_use", id: "toolu_exit", name: "ExitPlanMode", input: {} }] } });
    emit({ type: "control_request", request_id: "c3", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: {}, tool_use_id: "toolu_exit" } }); },
  () => { emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_exit", is_error: true, content: "计划已提交" }] } });
    emit({ type: "result", subtype: "success", session_id: "plan-session", permission_denials: [{ tool_name: "ExitPlanMode" }] }); },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "user") {
    emit({ type: "system", subtype: "init", session_id: "plan-session", permissionMode: process.env.FAKE_INIT_MODE ?? (planMode ? "plan" : "bypassPermissions"), tools: planMode ? ["ExitPlanMode"] : [] });
    if (process.env.FAKE_INIT_MODE) return; // 等着被停掉
    if (!planMode) return emit({ type: "result", subtype: "success", session_id: "plan-session" });
    return steps.shift()();
  }
  if (message.type === "control_response") { appendFileSync(${JSON.stringify(answersFile)}, line + "\\n"); steps.shift()?.(); }
});
`);
  if (IS_WINDOWS) writeFileSync(bin, `@node "%~dp0fake-claude.mjs" %*\r\n`);
  else chmodSync(bin, 0o755);
  const executor = new ClaudeExecutor({ bin });
  const plan = executor.runSteerable({ cwd: root, prompt: "怎么改", planMode: true, env: { CLAUDE_CONFIG_DIR: join(root, "config") } });
  assert.ok(plan.commandLine.includes(CLAUDE_PLAN_ARGS.join(" ")));
  assert.equal(plansDirOfCommandLine(plan.commandLine), plansDir, "计划文件目录随 commandLine 落库");
  assert.doesNotMatch(plan.commandLine, /--dangerously-skip-permissions/, "两者同传时 bypass 会赢，计划回合必须不带它");
  const events: AgentEvent[] = [];
  for await (const event of plan.events) events.push(event);
  const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
  assert.ok(argv.includes("--permission-prompt-tool") && argv.includes("--input-format"));
  const answers = readFileSync(answersFile, "utf8").trim().split("\n").map((line) => JSON.parse(line).response);
  assert.deepEqual(answers.map((answer) => [answer.request_id, answer.response.behavior]), [["c1", "allow"], ["c2", "deny"], ["c3", "deny"]]);
  assert.deepEqual(events.filter((event) => event.kind === "plan"), [{ kind: "plan", id: "plan:toolu_exit", text: "# 假计划\n\n先读后改", status: "complete" }]);
  assert.equal(events.some((event) => event.kind === "tool" && event.name === "ExitPlanMode"), false, "交计划那一步换成计划卡，不画成被拒的工具调用");
  assert.equal(events.at(-1)?.kind, "done");
  // 执行器额外参数里留着跳过权限：计划回合把它摘掉；CLI 仍报别的模式（settings 之类顶掉的）就当场停
  const bypassing = new ClaudeExecutor({ bin, extraArgs: ["--dangerously-skip-permissions"] });
  const overridden = bypassing.runSteerable({ cwd: root, prompt: "怎么改", planMode: true, env: { ...configEnv, FAKE_INIT_MODE: "bypassPermissions" } });
  assert.doesNotMatch(overridden.commandLine, /--dangerously-skip-permissions/);
  const overriddenEvents: AgentEvent[] = [];
  for await (const event of overridden.events) overriddenEvents.push(event);
  assert.ok(overriddenEvents.some((event) => event.kind === "error" && /计划模式没有生效/.test(event.message)), "实际权限模式不是 plan 时报错并停下");
  assert.equal(overriddenEvents.some((event) => event.kind === "plan"), false);
  assert.equal(JSON.parse(readFileSync(argvFile, "utf8")).includes("--dangerously-skip-permissions"), false);
  const normal = executor.runSteerable({ cwd: root, prompt: "直接改", env: { CLAUDE_CONFIG_DIR: join(root, "config") } });
  assert.match(normal.commandLine, /--dangerously-skip-permissions/);
  assert.doesNotMatch(normal.commandLine, /--permission-mode/);
  for await (const _ of normal.events) { /* drain */ }
  const oneShot = executor.run({ cwd: root, prompt: "goal", planMode: true, env: {} });
  assert.doesNotMatch(oneShot.commandLine, /--permission-mode/, "stdin 关着的一次性形态回不了权限请求，计划参数只给 resident 形态");
  for await (const _ of oneShot.events) { /* drain */ }
  console.log("claude executor switches permission mode for plan turns and turns ExitPlanMode into a plan event: passed");

  // ── 状态与回复路由：裸 /plan、/plan off 当场改开关、不起进程；作用域带出执行器类型
  const at = "2026-11-20T01:00:00.000Z";
  await db.insert(projects).values({ id: "project", name: "plan", repoPath: root, createdAt: at });
  await db.insert(tasks).values({ id: "task", projectId: "project", title: "plan", body: "plan", mode: "single", status: "done", agentType: "claude", autoTitle: false, createdAt: at, updatedAt: at });
  const app = new Hono();
  app.post("/:id/reply", (context) => replyToTask(context, context.req.param("id")));
  const reply = (text: string, extra = {}) => app.request("/task/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, ...extra }) });
  const row = async () => (await db.select().from(tasks).where(eq(tasks.id, "task")))[0]!;
  const on = await reply("/plan");
  assert.equal(on.status, 200);
  const onBody = await on.json();
  assert.equal(onBody.command, true);
  assert.equal(onBody.started, false);
  assert.equal(onBody.text, "计划模式已开启；下一条消息只做计划。/plan off 退出");
  assert.equal((await row()).status, "done", "开关不起回合");
  assert.equal(readCliState((await row()).cliState, "claude", null, null).plan, true);
  assert.deepEqual((await enrichTasks([await row()]))[0]?.planScopes, [{ agentType: "claude", executorId: null, executorLabel: "Claude Code（未绑定执行器）", isTaskOwner: true }]);
  assert.equal((await reply("/plan off", { sendAt: new Date(Date.now() + 60_000).toISOString() })).status >= 400, true, "开关当场生效，不排定时");
  const off = await reply("/plan off");
  assert.equal(off.status, 200);
  assert.equal((await off.json()).text, "计划模式已关闭");
  assert.equal((await enrichTasks([await row()]))[0]?.planMode, false);

  // 起跑新一轮（系统续跑 / 首跑）把 claude 槽的计划模式也关掉，不只 codex
  await saveCliState("task", "claude", { profileId: null, ownerUserId: null, plan: true });
  await saveCliState("task", "codex", { profileId: null, ownerUserId: null, plan: true });
  assert.equal((await enrichTasks([await row()]))[0]?.planScopes?.length, 2);
  await prepareCliInvocation(await row(), "claude", "重新运行", null, null, { resetPlan: true });
  assert.equal(readCliState((await row()).cliState, "claude", null, null).plan, false);
  assert.equal(readCliState((await row()).cliState, "codex", null, null).plan, false);
  assert.equal((await enrichTasks([await row()]))[0]?.planMode, false);

  // 「实施此计划」：要那位 claude 的最近一回合交出过这一版计划
  await saveCliState("task", "claude", { profileId: null, ownerUserId: null, plan: true });
  await assert.rejects(assertPlanReady("task", "claude", null, null, "plan:toolu_exit"), /没有可实施的计划/);
  await db.insert(sessions).values({ id: "session", taskId: "task", role: "single", agentType: "claude", executor: "claude", executorId: null, runOwnerUserId: null, cwd: root, startedAt: at, turnStartedAt: at, endedAt: at, exitStatus: 0 });
  mkdirSync(join(root, "runs", "task"), { recursive: true });
  writeFileSync(sessionTracePath("task", "session"), JSON.stringify({ at, turnStartedAt: at, event: events.find((event) => event.kind === "plan") }) + "\n");
  await assertPlanReady("task", "claude", null, null, "plan:toolu_exit");
  await assert.rejects(assertPlanReady("task", "claude", null, null, "plan:older"), /新版本/);
  await assert.rejects(assertPlanReady("task", "codex", null, null, "plan:toolu_exit"), /没有可实施的计划/, "按执行器类型找出计划的那位");
  const approved = await prepareCliInvocation(await row(), "claude", "/plan implement plan:toolu_exit", null, null);
  assert.equal(approved.cliState.plan, false, "批准即退出计划模式，实施回合以默认权限跑");
  console.log("claude plan toggles, scope listing, rerun reset and implementation preflight: passed");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
