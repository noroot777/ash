import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentType } from "@ash/shared";
import type { RunHandle, RunOpts } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-diagnostic-reply-"));
const repo = join(root, "repo");
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
process.env.CODEX_HOME = join(root, "codex");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
delete process.env.ASH_ALLOW_REAL_AGENT;

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions } = await import("../src/db/schema.js");
const { continueTask, runTask } = await import("../src/orchestrator.js");
const { replyToTask } = await import("../src/task-reply.js");
const { mountTaskSessionRoutes } = await import("../src/task-session-routes.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const { isTurnClaimed } = await import("../src/runs.js");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
await ensureSchema();

const api = new Hono();
api.post("/tasks/:id/reply", (context) => replyToTask(context, context.req.param("id")));
mountTaskSessionRoutes(api);
const at = "2026-10-12T00:00:00.000Z";
const body = "把登录页改成支持扫码登录，并补上单元测试";
const replyText = "先按方案 A 做";
let taskIndex = 0;
const taskIdFor = (label: string) => `${String(++taskIndex).padStart(8, "0")}-${label}`;
const captures: Array<RunOpts & { agentType: AgentType }> = [];
const originals = [ClaudeExecutor.prototype, CodexExecutor.prototype].map((prototype) => ({
  prototype, run: prototype.run, runSteerable: prototype.runSteerable,
}));
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const sessionRows = (taskId: string) => db.select().from(sessions).where(eq(sessions.taskId, taskId));
const create = (taskId: string, agentType: AgentType, extra: Partial<typeof tasks.$inferInsert> = {}) =>
  db.insert(tasks).values({
    id: taskId, projectId: "project", title: taskId, body, agentType,
    mode: "single", status: "failed", useWorktree: true, autoTitle: false,
    workflowMode: "free", worktreeBase: "main", createdAt: at, updatedAt: at, ...extra,
  });

function captureRun(this: { type: AgentType }, opts: RunOpts): RunHandle {
  const taskId = opts.env?.ASH_TASK_ID;
  assert.ok(taskId);
  captures.push({ ...opts, agentType: this.type });
  writeFileSync(join(opts.cwd, `probe-${taskId}.txt`), opts.prompt);
  return {
    sessionId: opts.sessionId ?? `fixture-${taskId}-${captures.length}`,
    commandLine: "diagnostic reply fixture",
    events: (async function* () {
      yield { kind: "text" as const, text: "fixture finished" };
      yield { kind: "done" as const, exitStatus: 0 };
    })(),
    kill() {},
  };
}

async function reply(taskId: string, agent?: AgentType): Promise<RunOpts & { agentType: AgentType }> {
  const before = captures.length;
  const response = await api.request(`/tasks/${taskId}/reply`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: replyText, ...(agent ? { agent } : {}) }),
  });
  assert.equal(response.status, 202, await response.text());
  for (let attempt = 0; attempt < 500; attempt++) {
    if (captures.length > before && !isTurnClaimed(taskId)) break;
    await delay(10);
  }
  assert.equal(isTurnClaimed(taskId), false, "回复回合必须收口并释放锁");
  const failureOutputs = captures.length === before
    ? await Promise.all((await sessionRows(taskId)).map(async (session) =>
        (await api.request(`/sessions/${session.id}/output`)).text()))
    : [];
  assert.equal(captures.length, before + 1, `回复必须恰好启动一次执行器: ${taskId}\n${failureOutputs.join("\n")}`);
  return captures[before]!;
}

async function legacyDiagnostic(taskId: string, agentType: AgentType, startedAt = at) {
  const sessionId = `${taskId}-diagnostic`;
  await db.insert(sessions).values({
    id: sessionId, taskId, role: "single", agentType, executor: agentType,
    cwd: repo, startedAt, endedAt: startedAt, exitStatus: 1, activeMs: 0,
  });
  return sessionId;
}

function assertFreshInvocation(taskId: string, target: AgentType, invocation: RunOpts & { agentType: AgentType }) {
  const cwd = join(repo, ".worktrees", taskId);
  assert.equal(invocation.cwd, cwd, "诊断记录不能把回复或邀请带到主仓");
  assert.equal(invocation.agentType, target);
  assert.equal(invocation.sessionId, undefined, "诊断记录没有可恢复的 CLI 会话");
  assert.ok(invocation.prompt.includes("【本任务的原始描述】"));
  assert.ok(invocation.prompt.includes(body));
  assert.ok(invocation.prompt.includes(replyText));
  assert.ok(existsSync(join(cwd, `probe-${taskId}.txt`)));
  assert.equal(existsSync(join(repo, `probe-${taskId}.txt`)), false);
  assert.ok(git("worktree", "list", "--porcelain").includes(`worktree ${realpathSync(cwd)}`));
}

async function assertDiagnosticVisible(taskId: string, sessionId: string, expected: RegExp) {
  const response = await api.request(`/tasks/${taskId}/sessions`);
  assert.equal(response.status, 200);
  const listed = await response.json();
  const diagnostic = listed.find((session: { id: string }) => session.id === sessionId);
  assert.ok(diagnostic, "刷新后诊断会话必须仍可读取");
  assert.equal(diagnostic.cliSessionId, null);
  assert.equal(diagnostic.turnStartedAt, null);
  assert.equal(diagnostic.exitStatus, 1);
  const output = await api.request(`/sessions/${sessionId}/output`);
  assert.equal(output.status, 200);
  assert.match(await output.text(), expected);
}

try {
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git("config", "user.name", "Ash Test");
  git("config", "user.email", "ash@example.test");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  git("add", ".");
  git("commit", "-m", "seed");
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  await db.insert(projects).values({ id: "project", name: "diagnostic reply", repoPath: repo, createdAt: at });
  for (const { prototype } of originals) {
    prototype.run = captureRun;
    prototype.runSteerable = captureRun;
  }

  for (const agentType of ["codex", "claude"] as const) {
    for (const invited of [false, true]) {
      const target = invited ? (agentType === "codex" ? "claude" : "codex") : agentType;
      const taskId = taskIdFor(`legacy-${agentType}-${invited}`);
      await create(taskId, agentType);
      const diagnosticId = await legacyDiagnostic(taskId, agentType);
      assertFreshInvocation(taskId, target, await reply(taskId, invited ? target : undefined));
      const diagnostic = (await sessionRows(taskId)).find((session) => session.id === diagnosticId)!;
      assert.equal(diagnostic.cwd, repo, "存量诊断原文保留，仅执行侧忽略它");
      assert.equal(diagnostic.turnStartedAt, null);
    }
  }

  for (const agentType of ["codex", "claude"] as const) {
    for (const materialized of [false, true]) {
      for (const invited of [false, true]) {
        const taskId = taskIdFor(`startup-${agentType}-${materialized}-${invited}`);
        const target = invited ? (agentType === "codex" ? "claude" : "codex") : agentType;
        await create(taskId, agentType, materialized
          ? { status: "backlog", reasoningEffort: "invalid-effort" }
          : { status: "backlog", body: "/goal 完成目标 --budget 0" });
        const before = captures.length;
        await runTask(taskId);
        assert.equal(captures.length, before, "起跑前失败不能启动 CLI");
        assert.equal((await row(taskId)).status, "failed");
        assert.equal(existsSync(join(repo, ".worktrees", taskId)), materialized);
        const [diagnostic] = await sessionRows(taskId);
        assert.ok(diagnostic);
        assert.equal(diagnostic.cwd, null, "新诊断不能声称主仓是执行目录");
        await assertDiagnosticVisible(taskId, diagnostic.id, /这一轮没能起跑/);
        await runTask(taskId);
        assert.equal((await sessionRows(taskId)).length, 1, "重复起跑失败不能堆会话");
        assert.equal((await sessionRows(taskId))[0]!.id, diagnostic.id);
        await db.update(tasks).set({ body, reasoningEffort: null }).where(eq(tasks.id, taskId));
        assertFreshInvocation(taskId, target, await reply(taskId, invited ? target : undefined));
        await assertDiagnosticVisible(taskId, diagnostic.id, /这一轮没能起跑/);
      }
    }
  }

  for (const agentType of ["codex", "claude"] as const) {
    for (const sessionId of ["real-thread", null, ""] as const) {
      const taskId = taskIdFor(`real-${agentType}-${sessionId ?? "lost"}`);
      await create(taskId, agentType);
      const workspace = await taskWorkspace(await row(taskId), repo);
      const realId = `${taskId}-session`;
      await db.insert(sessions).values({
        id: realId, taskId, role: "single", agentType, executor: agentType,
        cliSessionId: sessionId, cwd: workspace.path, worktreePath: workspace.path,
        branch: workspace.branch, commandLine: "real execution", startedAt: at,
        turnStartedAt: at, endedAt: at, exitStatus: 1, activeMs: 0,
      });
      await legacyDiagnostic(taskId, agentType, "2026-10-12T00:00:01.000Z");
      const invocation = await reply(taskId);
      assert.equal(invocation.cwd, workspace.path, "真实会话的 cwd 必须保留");
      assert.equal(invocation.sessionId, sessionId || undefined);
      assert.equal(invocation.prompt.includes("【本任务的原始描述】"), false, "真实参与者不重复注入简介");
      if (sessionId) {
        assert.equal((await sessionRows(taskId)).length, 2, "真实恢复复用原会话行");
        assert.equal((await sessionRows(taskId)).find((session) => session.id === realId)!.exitStatus, 0);
      }
      const invitee = agentType === "codex" ? "claude" : "codex";
      const invitation = await reply(taskId, invitee);
      assert.equal(invitation.cwd, workspace.path, "邀请仍共享真实执行者的工作目录");
      assert.ok(invitation.prompt.includes(body));
    }

    const taskId = taskIdFor(`legacy-real-${agentType}`);
    await create(taskId, agentType, { useWorktree: false });
    await db.insert(sessions).values({
      id: `${taskId}-session`, taskId, role: "single", agentType, executor: agentType,
      cwd: repo, startedAt: at, endedAt: "2026-10-12T00:00:01.000Z", exitStatus: 1,
    });
    const legacy = await reply(taskId);
    assert.equal(legacy.cwd, repo);
    assert.equal(legacy.prompt.includes("【本任务的原始描述】"), false, "老真实会话无计时字段也不视为诊断");
    rmSync(join(repo, `probe-${taskId}.txt`));

    const freshId = taskIdFor(`fresh-${agentType}`);
    await create(freshId, agentType);
    const diagnosticId = await legacyDiagnostic(freshId, agentType);
    await continueTask(freshId, replyText, { freshSession: true });
    assertFreshInvocation(freshId, agentType, captures.at(-1)!);
    await continueTask(freshId, replyText, { resumeSessionId: diagnosticId });
    assertFreshInvocation(freshId, agentType, captures.at(-1)!);
  }

  assert.equal(git("status", "--porcelain"), "", "诊断后的续聊不能污染主仓");
  console.log("diagnostic replies/invitations isolate worktrees and restore task context; genuine sessions retain resume behavior: passed");
} finally {
  for (const { prototype, run, runSteerable } of originals) {
    prototype.run = run;
    prototype.runSteerable = runSteerable;
  }
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
