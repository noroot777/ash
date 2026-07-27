import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { DEBATE_DEFAULTS } from "@harness/shared";

if (!process.env.HARNESS_DB?.startsWith("/tmp/")) {
  throw new Error("test-debate-iteration requires HARNESS_DB under /tmp");
}

const [{ db, ensureSchema }, schema, iteration, transcript] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/debate/iteration.js"),
  import("../src/transcript.js"),
]);
const { projects, sessions, tasks } = schema;
await ensureSchema();

const at = "2026-07-27T12:00:00.000Z";
const projectId = "iteration-project";
const debateId = "iteration-debate";
const teamId = "iteration-team";
const workerId = "iteration-worker";
const leadSessionId = "iteration-lead-session";
const leadTranscript = transcript.sessionTranscriptPath(teamId, leadSessionId);
const debateTranscript = leadTranscript.replace(`${teamId}/${leadSessionId}.md`, `${debateId}/transcript.jsonl`);

const taskRow = (overrides: Record<string, unknown>) => ({
  id: "base-task",
  projectId,
  groupId: null,
  parentId: null,
  title: "base",
  body: "",
  mode: "single",
  status: "backlog",
  priority: "none",
  labels: "[]",
  dependsOn: "[]",
  resumeDependsOn: "[]",
  agentType: null,
  executorId: null,
  autoTitle: false,
  debate: null,
  team: null,
  scheduleId: null,
  createdAt: at,
  updatedAt: at,
  useWorktree: false,
  worktreeBase: null,
  originTaskId: null,
  ...overrides,
});

try {
  await db.insert(projects).values({ id: projectId, name: "iteration", repoPath: "/tmp", apiKeys: null, createdAt: at });
  await db.insert(tasks).values([
    taskRow({
      id: debateId,
      title: "选择稳定的架构",
      body: "旧辩论正文",
      mode: "debate",
      status: "done",
      debate: JSON.stringify({
        ...DEBATE_DEFAULTS,
        topic: "应该采用方案甲还是方案乙？",
        debaterA: "codex",
        debaterB: "claude",
        debaterAExecutorId: "executor-a",
        debaterBExecutorId: "executor-b",
        maxRounds: 6,
        gateG1: "off",
      }),
    }),
    taskRow({ id: teamId, title: "落实架构", mode: "team", status: "running", originTaskId: debateId }),
    taskRow({ id: workerId, title: "验证方案", parentId: teamId, status: "running" }),
  ]);
  await db.insert(sessions).values({
    id: leadSessionId,
    taskId: teamId,
    role: "lead",
    agentType: "codex",
    executor: "Codex",
    target: "local",
    startedAt: at,
  });
  mkdirSync(dirname(leadTranscript), { recursive: true });
  mkdirSync(dirname(debateTranscript), { recursive: true });
  writeFileSync(leadTranscript, "团队完成了实现，并发现数据库升级需要保持幂等。\n");
  writeFileSync(debateTranscript, [
    JSON.stringify({ round: 2, speaker: "A", raised: true, agrees: true, conclusion: "采用方案甲并补充迁移保护" }),
    JSON.stringify({ round: 2, speaker: "B", raised: true, agrees: true, conclusion: "采用方案甲并补充迁移保护" }),
    JSON.stringify({
      type: "debate.gate",
      taskId: debateId,
      gate: "G1",
      open: true,
      consensus: true,
      conclusionA: "采用方案甲并补充迁移保护",
      conclusionB: "采用方案甲并补充迁移保护",
    }),
    JSON.stringify({ type: "debate.gate", taskId: debateId, gate: "G1", open: false }),
  ].join("\n") + "\n");

  const app = new Hono();
  iteration.mountDebateIterationRoutes(app);
  let response = await app.request(`/tasks/${teamId}/team/iterate-debate`, { method: "POST" });
  assert.equal(response.status, 409, "active team must not iterate");

  await db.update(tasks).set({ status: "idle" }).where(eq(tasks.id, teamId));
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, workerId));
  response = await app.request(`/tasks/${teamId}/team/iterate-debate`, { method: "POST" });
  assert.equal(response.status, 201);
  const created = await response.json() as {
    id: string;
    body: string;
    originTaskId: string;
    debate: typeof DEBATE_DEFAULTS;
  };
  assert.equal(created.originTaskId, teamId);
  assert.match(created.body, /共识结论：采用方案甲并补充迁移保护/);
  assert.match(created.body, new RegExp(leadSessionId));
  assert.match(created.body, /执行暴露了什么新问题/);
  assert.equal(created.debate.debaterAExecutorId, "executor-a");
  assert.equal(created.debate.debaterBExecutorId, "executor-b");
  assert.equal(created.debate.maxRounds, 6);
  assert.equal(created.debate.gateG1, "off");
  assert.equal(created.debate.topic, "应该采用方案甲还是方案乙？", "stored config must be reused unchanged");

  const repeated = await app.request(`/tasks/${teamId}/team/iterate-debate`, { method: "POST" });
  assert.equal(repeated.status, 200);
  assert.equal(((await repeated.json()) as { id: string }).id, created.id);
  console.log("debate iteration endpoint: ok");
} finally {
  rmSync(dirname(leadTranscript), { recursive: true, force: true });
  rmSync(dirname(debateTranscript), { recursive: true, force: true });
}
