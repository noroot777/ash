import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { cliCommandCatalog, cliCommandsForMode, goalRequest, hasCliGoalHold, isGoalExecution, isGoalRecovery, parseCliCommand, validateCliCommand, type CliCommand, type CliGoal } from "@ash/shared/cli-commands";
import { CodexNativeCommands, redactCommandData } from "../src/executors/codex-native-commands.js";
import { claudeGoalInvocation, cleanupClaudeGoalContext, formatClaudeGoal } from "../src/executors/claude-goal.js";

const root = mkdtempSync(join(tmpdir(), "ash-cli-commands-"));
process.env.ASH_DB = join(root, "ash.db");
const { CodexExecutor } = await import("../src/executors/codex.js");
const command = (text: string, agent = "codex") => validateCliCommand(agent, text)!;
try {
  assert.equal(parseCliCommand("codex", "说明 /goal 做完"), null);
  for (const agent of ["codex", "claude"]) {
    assert.equal(isGoalRecovery(command("/goal 新目标", agent)), false);
    assert.equal(isGoalRecovery(command("/goal resume", agent)), true);
    assert.equal(isGoalRecovery(command("/goal resume --scope original", agent)), true);
  }
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
  assert.equal(isGoalExecution(command("/goal --scopes")), false);
  for (const agent of ["codex", "claude"]) {
    const selected = command("/goal resume --scope codex:encoded-scope", agent);
    assert.equal(selected.args, "resume");
    assert.equal(selected.goalScope, "codex:encoded-scope");
    assert.equal(isGoalExecution(selected), true);
    assert.equal(command("/goal clear --scope claude:encoded-scope", agent).args, "clear");
    for (const text of ["/goal --scopes extra", "/goal resume --scope", "/goal resume --scope id extra", "/goal pause --scope id"]) assert.throws(() => command(text, agent));
  }
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

  const savedGoal: CliGoal = { objective: "原作用域目标", status: "paused", tokenBudget: 150, tokensUsed: 150 };
  for (const nativeGoal of [null, { ...savedGoal, objective: "另一个目标", status: "active" as const }, { ...savedGoal, tokenBudget: 300 }, { ...savedGoal, tokensUsed: 149 }]) {
    const guardedCalls: string[] = [];
    const guarded = new CodexNativeCommands({
      threadId: () => "guarded", turnId: () => "", model: () => "model", cwd: root, prompt: "", state: { goal: savedGoal, goalHold: true }, push() {},
      request: async (method) => { guardedCalls.push(method); return { goal: nativeGoal }; },
    });
    for (const text of ["/goal resume", "/goal budget 300"]) {
      guardedCalls.length = 0;
      await assert.rejects(guarded.prepare(command(text)), /作用域|快照/);
      assert.deepEqual(guardedCalls, ["thread/goal/get"], "mismatched goals must never issue model, setter or pause calls");
    }
    for (const text of ["/goal", "/goal pause"]) {
      guardedCalls.length = 0;
      await guarded.prepare(command(text));
      assert.match(await guarded.control(command(text)), /原作用域目标[\s\S]*150 \/ 150[\s\S]*原生会话里[\s\S]*保存快照/);
      assert.deepEqual(guarded.goal, savedGoal);
      assert.equal(guarded.goalStarted, false);
      guarded.notification("thread/goal/updated", { goal: { ...savedGoal, tokenBudget: 999 } });
      guarded.notification("thread/goal/cleared", {});
      assert.deepEqual(guarded.goal, savedGoal, "unrelated native notifications cannot overwrite the displayed or persisted snapshot");
      assert.deepEqual(guardedCalls, ["thread/goal/get"], "snapshot query/pause must not mutate or interrupt another native goal");
    }
    guardedCalls.length = 0;
    await guarded.prepare(command("/goal clear"));
    if (nativeGoal) {
      assert.match(await guarded.control(command("/goal clear")), /原生会话属于其他目标/);
      assert.deepEqual(guardedCalls, ["thread/goal/get"], "selected snapshot cleanup must not clear another native goal's budget or usage");
    }
  }
  for (const text of ["/goal", "/goal pause", "/goal budget 300", "/goal clear"]) {
    const noSavedGoal = new CodexNativeCommands({
      threadId: () => "unsaved", turnId: () => "", model: () => "model", cwd: root, prompt: "", state: { profileId: "cleared-scope", ownerUserId: null }, push() {},
      request: async (method) => { assert.equal(method, "thread/goal/get"); return { goal: savedGoal }; },
    });
    if (text === "/goal clear") {
      await noSavedGoal.prepare(command(text));
      assert.match(await noSavedGoal.control(command(text)), /未清除其目标、预算或已用量/);
    } else if (text === "/goal budget 300") await assert.rejects(noSavedGoal.prepare(command(text)), /未改变目标、预算或已用量/);
    else {
      await noSavedGoal.prepare(command(text));
      assert.match(await noSavedGoal.control(command(text)), /当前没有目标[\s\S]*原生会话属于其他目标/);
      assert.equal(noSavedGoal.goal, null);
    }
  }
  const matching = new CodexNativeCommands({
    threadId: () => "matching", turnId: () => "", model: () => "model", cwd: root, prompt: "", state: { goal: savedGoal }, push() {},
    request: async (method) => { assert.equal(method, "thread/goal/get"); return { goal: { ...savedGoal, tokensUsed: 160 } }; },
  });
  await matching.prepare(command("/goal resume"));
  assert.equal(matching.goal?.tokenBudget, 150);
  assert.equal(matching.goal?.tokensUsed, 160);
  const matchingCalls: string[] = [];
  let activeGoal: CliGoal = { ...savedGoal, status: "active", tokensUsed: 160 };
  const matchingControl = new CodexNativeCommands({
    threadId: () => "matching-control", turnId: () => "other-turn", model: () => "model", cwd: root, prompt: "", state: { goal: savedGoal }, push() {},
    request: async (method, params) => {
      matchingCalls.push(method);
      if (method === "thread/goal/set") activeGoal = { ...activeGoal, ...params };
      return { goal: activeGoal };
    },
  });
  await matchingControl.prepare(command("/goal"));
  assert.match(await matchingControl.control(command("/goal")), /运行中[\s\S]*160 \/ 150/);
  assert.deepEqual(matchingCalls, ["thread/goal/get", "thread/goal/get"], "matching query remains read-only");
  matchingCalls.length = 0;
  await matchingControl.prepare(command("/goal pause"));
  assert.match(await matchingControl.control(command("/goal pause")), /已暂停[\s\S]*160 \/ 150/);
  assert.deepEqual(matchingCalls, ["thread/goal/get", "thread/goal/set"], "matching pause only changes the native status, without a model turn");
  const missingGoal = new CodexNativeCommands({ threadId: () => "missing", turnId: () => "", model: () => "model", cwd: root, prompt: "", push() {}, request: async (method) => { assert.equal(method, "thread/goal/get"); return { goal: null }; } });
  await missingGoal.prepare(command("/goal pause"));
  assert.match(await missingGoal.control(command("/goal pause")), /当前没有目标/);
  const standalone = new CodexNativeCommands({
    threadId: () => "standalone", turnId: () => "", model: () => "model", cwd: root, prompt: "", state: { plan: false }, push() {},
    request: async (method, params) => ({ goal: method === "thread/goal/set" ? { ...savedGoal, ...params } : savedGoal }),
  });
  await standalone.prepare(command("/goal budget 300"));
  assert.match(await standalone.control(command("/goal budget 300")), /150 \/ 300/);

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
