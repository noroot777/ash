import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentType } from "@ash/shared";
import type { CliGoal } from "@ash/shared/cli-commands";
import type { RunHandle } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-active-goal-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_ALLOW_REAL_AGENT;
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions, scheduledMessages } = await import("../src/db/schema.js");
const { replyToTask } = await import("../src/task-reply.js");
const { readCliState, saveCliState } = await import("../src/task-cli-state.js");
const { setActor } = await import("../src/auth/context.js");
const { trackRun, untrackRun, takeStopped } = await import("../src/runs.js");
await ensureSchema();
const app = new Hono();
app.post("/:id/reply", (context) => {
  const userId = context.req.header("x-test-user");
  if (userId) setActor(context, { kind: "user", userId, role: "member", name: userId });
  return replyToTask(context, context.req.param("id"));
});
const at = new Date().toISOString();
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const create = (taskId: string, agentType: AgentType) => db.insert(tasks).values({
  id: taskId, projectId: "project", title: taskId, body: "活动会话目标提示", mode: "single", agentType,
  executorId: "configured-profile", status: "running", goalTurn: true, autoTitle: false, useWorktree: false, createdAt: at, updatedAt: at,
});
const createSession = (taskId: string, agentType: AgentType, executorId: string | null = "active-profile", runOwnerUserId: string | null = "active-owner") => db.insert(sessions).values({
  id: `${taskId}-session`, taskId, role: "single", agentType, executor: `${agentType} 活动执行器`, executorId,
  runOwnerUserId, cwd: root, startedAt: at, turnStartedAt: at,
});
const reply = (taskId: string, text: string, extra: Record<string, unknown> = {}, userId: string | null = "active-owner") => app.request(`/${taskId}/reply`, {
  method: "POST", headers: { "content-type": "application/json", ...(userId ? { "x-test-user": userId } : {}) }, body: JSON.stringify({ text, ...extra }),
});
const rejection = async (response: Response) => {
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.started, false);
  return result.error as string;
};
const handles = new Map<string, RunHandle>();
const kills = new Map<string, number>();
const calls = new Map<string, number>();
function track(taskId: string, goal: CliGoal | null = null, withGoal = false) {
  let snapshot = goal;
  const handle: RunHandle = {
    sessionId: `fixture-${taskId}`, commandLine: "active goal fixture; no CLI/model",
    kill() { kills.set(taskId, (kills.get(taskId) ?? 0) + 1); },
    command: async (command) => {
      calls.set(taskId, (calls.get(taskId) ?? 0) + 1);
      if (snapshot && command.args === "pause") snapshot = { ...snapshot, status: "paused" };
      return "当前目标已暂停";
    },
    ...(withGoal ? { goal: () => snapshot } : {}),
    events: (async function* () {})(),
  };
  handles.set(taskId, handle);
  trackRun(taskId, handle);
}

try {
  await db.insert(projects).values({ id: "project", name: "活动目标回归", repoPath: root, createdAt: at });
  for (const activeAgent of ["claude", "codex"] as const) {
    const configuredAgent = activeAgent === "claude" ? "codex" : "claude";
    const taskId = `invited-${activeAgent}`;
    const liveGoal: CliGoal = { objective: `${activeAgent} 本轮真实目标`, status: "active", tokensUsed: 25 };
    await create(taskId, configuredAgent);
    await createSession(taskId, activeAgent);
    await saveCliState(taskId, configuredAgent, { profileId: "configured-profile", ownerUserId: "active-owner", goal: { objective: "已停掉的常设旧目标", status: "paused" } }, true);
    await saveCliState(taskId, activeAgent, { profileId: "active-profile", ownerUserId: "active-owner", goal: liveGoal }, true);
    track(taskId, liveGoal, activeAgent === "codex");
    const before = await row(taskId);
    for (const command of ["/goal 换个目标", "/goal resume"]) {
      const error = await rejection(await reply(taskId, command));
      assert.match(error, new RegExp(liveGoal.objective));
      assert.doesNotMatch(error, /常设旧目标/);
      assert.match(error, new RegExp(`@${activeAgent}`));
      assert.match(error, /活动执行器/);
      assert.match(error, /active-profile/);
      assert.match(error, /\/goal pause/);
      assert.match(error, /等待回合结束/);
    }
    const wrongAgent = await rejection(await reply(taskId, "/goal pause"));
    assert.match(wrongAgent, /原生命令必须发给当前正在运行的执行器/);
    assert.match(wrongAgent, new RegExp(`@${activeAgent}`));
    assert.match(wrongAgent, /活动执行器/);
    assert.match(wrongAgent, /active-profile/);
    assert.match(wrongAgent, /\/goal pause/);
    if (activeAgent === "claude") assert.match(wrongAgent, /\/goal（查询）、\/goal pause 或 \/goal clear/);
    const wrongProfile = await rejection(await reply(taskId, "/goal pause", { agent: activeAgent, executorId: "configured-profile" }));
    assert.match(wrongProfile, /active-profile/);
    const wrongOwner = await rejection(await reply(taskId, "/goal pause", { agent: activeAgent, executorId: "active-profile" }, "other-owner"));
    assert.match(wrongOwner, /只有当前回合的发起人/);
    assert.deepEqual(await row(taskId), before);
    assert.equal(kills.get(taskId) ?? 0, 0);
    assert.equal(calls.get(taskId) ?? 0, 0);
    assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, taskId))).length, 0);
    const paused = await reply(taskId, "/goal pause", { agent: activeAgent, executorId: "active-profile" });
    assert.equal(paused.status, 200);
    assert.match((await paused.json()).text, activeAgent === "claude" ? /本轮真实目标[\s\S]*已暂停/ : /当前目标已暂停/);
    assert.equal(kills.get(taskId), 1);
    assert.equal(takeStopped(taskId), "paused");
    const snapshot = readCliState((await row(taskId)).cliState, activeAgent, "active-profile", "active-owner");
    assert.equal(snapshot.goal?.objective, liveGoal.objective);
    assert.equal(snapshot.goal?.status, "paused");
    assert.equal(readCliState((await row(taskId)).cliState, configuredAgent, "configured-profile", "active-owner").goal?.objective, "已停掉的常设旧目标");
    console.log(`${activeAgent}: invited goal names and pause routing follow the active session; profile/owner restrictions remain intact: passed`);
  }

  for (const agentType of ["claude", "codex"] as const) {
    const taskId = `scoped-${agentType}`;
    await create(taskId, agentType);
    await createSession(taskId, agentType);
    await saveCliState(taskId, agentType, { profileId: "active-profile", ownerUserId: "active-owner", goal: { objective: "精确活动作用域目标", status: "active" } }, true);
    await saveCliState(taskId, agentType, { profileId: "other-profile", ownerUserId: "active-owner", goal: { objective: "另一个 profile 的旧目标", status: "paused" } }, true);
    await saveCliState(taskId, agentType, { profileId: "active-profile", ownerUserId: "other-owner", goal: { objective: "另一发起人的旧目标", status: "paused" } }, true);
    await db.insert(sessions).values({ id: `${taskId}-closed`, taskId, role: "single", agentType, executor: "已结束执行器", executorId: "other-profile", runOwnerUserId: "other-owner", cwd: root, startedAt: "2099-01-01", turnStartedAt: "2099-01-01", endedAt: at });
    track(taskId);
    const before = await row(taskId);
    const error = await rejection(await reply(taskId, "/goal 替换"));
    assert.match(error, /精确活动作用域目标/);
    assert.doesNotMatch(error, /旧目标|已结束执行器/);
    assert.deepEqual(await row(taskId), before);
    console.log(`${agentType}: objective lookup matches the active session's exact profile and owner, excluding closed sessions: passed`);
  }

  for (const [taskId, hasSession] of [["missing-snapshot", true], ["missing-session", false]] as const) {
    await create(taskId, "codex");
    if (hasSession) await createSession(taskId, "claude");
    await saveCliState(taskId, "codex", { profileId: "configured-profile", ownerUserId: "active-owner", goal: { objective: "不应冒充活动目标", status: "paused" } }, true);
    await saveCliState(taskId, "claude", { profileId: "other-profile", ownerUserId: "active-owner", goal: { objective: "也不能回落此目标", status: "paused" } }, true);
    track(taskId);
    const error = await rejection(await reply(taskId, "/goal 替换"));
    assert.match(error, /当前目标正在执行/);
    assert.doesNotMatch(error, /不应冒充活动目标|也不能回落此目标|「当前目标/);
    if (hasSession) assert.match(error, /@claude/);
    else assert.match(await rejection(await reply(taskId, "/goal pause")), /正在启动或收尾/);
  }
  console.log("missing active scope/session never falls back to a stale goal: passed");

  await create("live-handle", "claude");
  await createSession("live-handle", "codex", null, null);
  await saveCliState("live-handle", "codex", { profileId: null, ownerUserId: null, goal: { objective: "落库前的旧快照", status: "active" } }, true);
  track("live-handle", { objective: "句柄里的实时目标", status: "active" }, true);
  assert.match(await rejection(await reply("live-handle", "/goal 替换", {}, null)), /句柄里的实时目标/);
  console.log("Codex live handle retains precedence over persisted snapshots: passed");
} finally {
  for (const [taskId, handle] of handles) { untrackRun(taskId, handle); takeStopped(taskId); }
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
