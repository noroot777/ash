import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { cliCommandCatalog, cliCommandsForMode, goalRequest, hasCliGoalHold, isGoalExecution, parseCliCommand, validateCliCommand, type CliCommand, type CliGoal } from "@ash/shared/cli-commands";
import { CodexNativeCommands, redactCommandData } from "../src/executors/codex-native-commands.js";
import { claudeGoalInvocation, cleanupClaudeGoalContext, formatClaudeGoal } from "../src/executors/claude-goal.js";

const root = mkdtempSync(join(tmpdir(), "ash-cli-commands-"));
process.env.ASH_DB = join(root, "ash.db");
const { CodexExecutor } = await import("../src/executors/codex.js");
const command = (text: string, agent = "codex") => validateCliCommand(agent, text)!;
try {
  assert.equal(parseCliCommand("codex", "说明 /goal 做完"), null);
  assert.equal(parseCliCommand("codex", "/unknown skill"), null);
  assert.equal(validateCliCommand("codex", "/constructor"), null);
  assert.equal(validateCliCommand("claude", "/toString"), null);
  assert.deepEqual(cliCommandsForMode(undefined, "codex", "team"), []);
  assert.throws(() => command("/goal budget"), /预算/);
  assert.throws(() => command("/goal budget 100 extra"), /预算/);
  assert.equal(validateCliCommand("claude", "/review 检查改动"), null);
  assert.equal(command("/compact 保留结论", "claude").args, "保留结论");
  for (const agent of ["gemini", "kimi", "claude"]) assert.throws(() => command("/fast on", agent), /不支持/);
  assert.equal(isGoalExecution(command("/goal 通过所有测试")), true);
  assert.equal(isGoalExecution(command("/goal resume")), true);
  assert.equal(isGoalExecution(command("/goal pause")), false);
  assert.equal(isGoalExecution(command("/goal budget 400")), false);
  assert.deepEqual(goalRequest(command("/goal 通过所有测试 --budget 400"), "codex"), { objective: "通过所有测试", status: "active", tokenBudget: 400 });
  assert.deepEqual(goalRequest(command("/goal budget 700"), "codex"), { tokenBudget: 700 });
  for (const text of ["/goal --budget", "/goal A --budget -1", "/goal A --budget 0", "/goal A --budget 1.5", "/goal A --budget NaN", "/goal A --budget 9 --budget 7", "/goal pause now", "/goal budget abc"]) assert.throws(() => command(text));
  assert.throws(() => command("/goal A --budget 10", "claude"), /不支持 token 预算/);
  assert.throws(() => command(`/goal ${"字".repeat(4001)}`), /4000/);
  assert.throws(() => command("/review --base"), /审查目标/);
  assert.throws(() => command("/review --commit abc extra"), /审查目标/);
  assert.throws(() => command("/rename"), /名称/);
  assert.throws(() => command("/personality angry"), /friendly/);
  const entries = Object.keys(cliCommandCatalog("codex")).map((name) => ({ name, source: "builtin" }));
  assert.equal(cliCommandsForMode(entries, "codex", "single").length, entries.length);
  assert.equal(cliCommandsForMode(entries, "codex", "team").length, 0);
  assert.deepEqual(cliCommandsForMode([{ name: "goal", source: "builtin" }, { name: "compact", source: "builtin" }, { name: "review", source: "builtin" }], "claude", "team").map((entry) => entry.name), ["compact", "review"]);
  assert.equal(hasCliGoalHold('{"codex":{"goalHold":true}}'), false);
  assert.equal(hasCliGoalHold('{"codex":{"goalHold":true,"goal":{"objective":"等待恢复","status":"paused"}}}'), true);
  assert.equal(hasCliGoalHold("broken"), false);

  const privateData = { apiKey: "key-a", accessToken: "token-a", nested: { ASH_AUTH_TOKEN: "token-b", GITHUB_TOKEN: "token-c", env: { SAFE: "private" }, http_headers: { "x-api-key": "secret-header-value" } }, tokenBudget: 400, tokensUsed: 20 };
  const redacted = JSON.stringify(redactCommandData(privateData));
  for (const secret of ["key-a", "token-a", "token-b", "token-c", "private", "secret-header-value"]) assert.ok(!redacted.includes(secret));
  assert.ok(redacted.includes('"tokenBudget":400'));
  assert.ok(redacted.includes('"tokensUsed":20'));
  assert.equal(redactCommandData("https://user:password@example.com/api?api_key=uri-secret&safe=1"), "https://[已隐藏]@example.com/api?api_key=[已隐藏]&safe=1");

  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const events: AgentEvent[] = [];
  let goal: CliGoal | null = null;
  let pageCount = 0;
  const native = new CodexNativeCommands({
    threadId: () => "thread", turnId: () => "turn", model: () => "model", cwd: root, prompt: "完整 ash 协议与本回合身份",
    state: { plan: true, personality: "friendly", serviceTier: "default" }, turnOptions: { effort: "high", serviceTierForTurn: "default" }, push: (event) => events.push(event),
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/goal/get") return { goal };
      if (method === "thread/goal/set") {
        goal = { ...(goal ?? { objective: "", status: "paused" }), ...params } as CliGoal;
        return { goal };
      }
      if (method === "thread/goal/clear") { goal = null; return {}; }
      if (method === "turn/start" || method === "review/start") return { turn: { id: "turn" } };
      if (method === "mcpServerStatus/list" || method === "app/list") return { data: [{ name: `page-${++pageCount}` }], nextCursor: params.cursor ? null : "next" };
      if (method === "config/read") return privateData;
      return {};
    },
  });
  assert.equal(native.collaborationMode().settings.reasoning_effort, "high");
  assert.equal(native.collaborationMode("default").settings.reasoning_effort, "high");
  await native.prepare(command("/goal 完成目标 --budget 400"));
  assert.deepEqual(await native.start(command("/goal 完成目标 --budget 400")), { immediate: false, turnId: "turn" });
  assert.deepEqual(calls.slice(1, 4).map((call) => call.method), ["thread/goal/set", "turn/start", "thread/goal/set"]);
  assert.equal(calls[1]!.params.status, "paused");
  assert.equal((calls[2]!.params.input as any[])[0].text, "完整 ash 协议与本回合身份");
  assert.equal(calls[2]!.params.effort, "high");
  assert.equal(calls[2]!.params.serviceTierForTurn, "default");
  assert.equal((calls[2]!.params.collaborationMode as any).mode, "default");
  assert.equal(await native.afterTurn(), false);
  assert.match(await native.control(command("/goal pause")), /已暂停/);
  assert.equal(calls.at(-1)!.method, "turn/interrupt");
  assert.equal(native.expectedInterruption, true);
  assert.equal(await native.afterTurn(), true);
  await native.control(command("/goal clear"));
  assert.equal(native.goal, null);
  assert.match(await native.control(command("/debug-config")), /已隐藏/);
  assert.equal((JSON.parse(await native.control(command("/mcp"))) as unknown[]).length, 2);
  assert.equal((JSON.parse(await native.control(command("/apps"))) as unknown[]).length, 2);
  await native.start(command("/compact"));
  assert.equal(calls.at(-1)!.method, "thread/compact/start");
  await native.start(command("/review --base main"));
  assert.deepEqual(calls.at(-1)!.params.target, { type: "baseBranch", branch: "main" });
  await native.start(command("/review --commit abc"));
  assert.deepEqual(calls.at(-1)!.params.target, { type: "commit", sha: "abc" });
  await native.start(command("/plan 怎样拆分"));
  assert.equal((calls.at(-1)!.params.collaborationMode as any).mode, "plan");
  await native.control(command("/stop"));
  assert.equal(calls.at(-1)!.method, "thread/backgroundTerminals/clean");
  await native.control(command("/usage"));
  assert.deepEqual(calls.find((call) => call.method === "account/usage/read")!.params, {});
  const forkNotice = await native.control(command("/fork"));
  assert.match(forkNotice, /分叉后的会话不保留原目标、预算和已用量/);
  assert.match(forkNotice, /\/goal 描述 重新设置目标/);
  assert.match(forkNotice, /--budget 上限/);
  assert.doesNotMatch(forkNotice, /\/goal resume/);
  const idle = new CodexNativeCommands({ threadId: () => "idle", turnId: () => "ordinary", model: () => "model", cwd: root, prompt: "", push() {}, request: async (method) => { assert.notEqual(method, "turn/interrupt"); return { goal: null }; } });
  await idle.control(command("/goal"));

  const goalNotifications: AgentEvent[] = [];
  const goalChannel = new CodexNativeCommands({ threadId: () => "ordinary", turnId: () => "turn", model: () => "model", cwd: root, prompt: "", push: (event) => goalNotifications.push(event), request: async () => ({ goal: null }) });
  for (const turn of [1, 2, 3]) {
    goalChannel.notification("thread/goal/cleared", { threadId: "ordinary" });
    assert.deepEqual(goalNotifications, [], `goal-free turn ${turn} must not announce a cleared goal`);
  }
  for (const status of ["active", "paused", "budgetLimited", "blocked", "usageLimited", "complete"] as const) {
    goalChannel.notification("thread/goal/updated", { goal: { objective: "已设置的目标", status } });
    const beforeClear = goalNotifications.length;
    goalChannel.notification("thread/goal/cleared", { threadId: "ordinary" });
    assert.equal(goalChannel.goal, null);
    const cleared = goalNotifications.at(-1);
    assert.ok(cleared?.kind === "system");
    assert.equal(cleared.level, "notice");
    assert.equal(cleared.aside, true);
    assert.equal(cleared.text, "〔目标〕已清除；任务和会话历史保留。");
    assert.equal(goalNotifications.length, beforeClear + 1);
    goalChannel.notification("thread/goal/cleared", { threadId: "ordinary" });
    assert.equal(goalNotifications.length, beforeClear + 1, "duplicate clears must not announce another removed goal");
  }

  const invocation = claudeGoalInvocation({ cwd: root, prompt: "完整方向身份 private-direction-token", cliCommand: command("/goal 测试通过", "claude") });
  const contextPath = invocation.args[1]!;
  assert.equal(invocation.input, "/goal 测试通过");
  assert.equal(statSync(contextPath).mode & 0o777, 0o600);
  assert.match(readFileSync(contextPath, "utf8"), /private-direction-token/);
  assert.ok(!invocation.marker.includes("private-direction-token"));
  assert.ok(!invocation.args.join(" ").includes("private-direction-token"));
  cleanupClaudeGoalContext(invocation.marker);
  assert.equal(existsSync(contextPath), false);
  invocation.cleanup();
  const resumed = claudeGoalInvocation({ cwd: root, prompt: "新方向", cliCommand: command("/goal resume", "claude"), cliState: { goal: { objective: "旧目标", status: "paused" } } });
  assert.equal(resumed.input, "/goal 旧目标");
  resumed.cleanup();
  assert.throws(() => claudeGoalInvocation({ cwd: root, prompt: "", cliCommand: command("/goal resume", "claude") }), /没有可恢复/);
  assert.ok(!formatClaudeGoal({ objective: "goal", status: "paused" }).includes("0 tokens"));

  const incompatible = new CodexExecutor({ extraArgs: ["--ephemeral"] });
  assert.throws(() => incompatible.runSteerable({ cwd: root, prompt: "/status", cliCommand: command("/status") }), /不兼容参数/);
  console.log("cli command parsing, catalog, native RPC, privacy, Claude context, exec rejection: passed");
} finally {
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  rmSync(root, { recursive: true, force: true });
}
