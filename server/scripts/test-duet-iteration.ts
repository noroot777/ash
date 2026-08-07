import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { DUET_DEFAULTS } from "@harness/shared";

if (!process.env.HARNESS_DB?.startsWith("/tmp/")) {
  throw new Error("test-duet-iteration requires HARNESS_DB under /tmp");
}

const [{ db, ensureSchema }, schema, iteration, transcript] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/duet/iteration.js"),
  import("../src/transcript.js"),
]);
const { projects, sessions, tasks } = schema;
await ensureSchema();

const at = "2026-07-27T12:00:00.000Z";
const projectId = "iteration-project";
const duetId = "iteration-debate";
const teamId = "iteration-team";
const workerId = "iteration-worker";
const leadSessionId = "iteration-lead-session";
const leadTranscript = transcript.sessionTranscriptPath(teamId, leadSessionId);
const duetTranscript = leadTranscript.replace(`${teamId}/${leadSessionId}.md`, `${duetId}/transcript.jsonl`);

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
  duet: null,
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
      id: duetId,
      title: "选择稳定的架构",
      body: "旧辩论正文",
      mode: "duet",
      status: "done",
      // 刻意用改名前的旧字段(debaterA…)与旧事件类型(debate.gate)入库:
      // 钉住 normalizeDuetConfig 与 transcript 读取端的向后兼容。
      // 注意是**纯旧形状**(不混新字段) —— 老库里就是这个样子。
      duet: JSON.stringify({
        topic: "应该采用方案甲还是方案乙？",
        style: "debate",
        debaterA: "codex",
        debaterB: "claude",
        debaterAExecutorId: "executor-a",
        debaterBExecutorId: "executor-b",
        debaterAModel: null,
        debaterAReasoningEffort: null,
        debaterBModel: null,
        debaterBReasoningEffort: null,
        maxRounds: 6,
        gateG1: "off",
      }),
    }),
    taskRow({ id: teamId, title: "落实架构", mode: "team", status: "running", originTaskId: duetId }),
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
  mkdirSync(dirname(duetTranscript), { recursive: true });
  writeFileSync(leadTranscript, "团队完成了实现，并发现数据库升级需要保持幂等。\n");
  writeFileSync(duetTranscript, [
    JSON.stringify({ round: 2, speaker: "A", raised: true, agrees: true, conclusion: "采用方案甲并补充迁移保护" }),
    JSON.stringify({ round: 2, speaker: "B", raised: true, agrees: true, conclusion: "采用方案甲并补充迁移保护" }),
    JSON.stringify({ round: 2, speaker: "synthesis", text: "# 方案\n采用方案甲，迁移必须幂等。\n\n## 残留分歧\n无", raised: false }),
    JSON.stringify({
      type: "debate.gate",
      taskId: duetId,
      gate: "G1",
      open: true,
      consensus: true,
      conclusionA: "采用方案甲并补充迁移保护",
      conclusionB: "采用方案甲并补充迁移保护",
    }),
    JSON.stringify({ type: "debate.gate", taskId: duetId, gate: "G1", open: false }),
  ].join("\n") + "\n");

  const app = new Hono();
  iteration.mountDuetIterationRoutes(app);
  let response = await app.request(`/tasks/${teamId}/team/iterate-duet`, { method: "POST" });
  assert.equal(response.status, 409, "active team must not iterate");

  await db.update(tasks).set({ status: "idle" }).where(eq(tasks.id, teamId));
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, workerId));
  response = await app.request(`/tasks/${teamId}/team/iterate-duet`, { method: "POST" });
  assert.equal(response.status, 201);
  const created = await response.json() as {
    id: string;
    body: string;
    originTaskId: string;
    duet: typeof DUET_DEFAULTS;
  };
  assert.equal(created.originTaskId, teamId);
  assert.match(created.body, /上一轮讨论收敛后的共同方案如下/, "synthesis plan must take precedence");
  assert.match(created.body, /采用方案甲，迁移必须幂等/);
  assert.doesNotMatch(created.body, /共识结论：/, "with a plan present the 2-line conclusion fallback must not appear");
  assert.match(created.body, new RegExp(leadSessionId));
  assert.match(created.body, /执行暴露了什么新问题/);
  assert.equal(created.duet.voiceAExecutorId, "executor-a");
  assert.equal(created.duet.voiceBExecutorId, "executor-b");
  assert.equal(created.duet.maxRounds, 6);
  assert.equal(created.duet.gateG1, "off");
  assert.equal(created.duet.topic, "应该采用方案甲还是方案乙？", "stored config must be reused unchanged");

  // 过时合稿不作数:回炉(round 3)后重新合稿失败,留下的 round 2 旧方案不能再当正式产出。
  const stale = iteration.conclusionLines([
    { round: 2, speaker: "A", conclusion: "旧结论A" },
    { round: 2, speaker: "synthesis", text: "# 旧方案" },
    { round: 3, speaker: "A", raised: true, agrees: true, conclusion: "新结论A" },
    { round: 3, speaker: "B", raised: true, agrees: true, conclusion: "新结论A" },
    { round: 3, speaker: "synthesis", text: "", error: "合稿失败" },
  ]);
  assert.ok(!stale.join("\n").includes("旧方案"), "stale plan must not be presented as the official output");
  assert.match(stale.join("\n"), /新结论A/);

  const repeated = await app.request(`/tasks/${teamId}/team/iterate-duet`, { method: "POST" });
  assert.equal(repeated.status, 200);
  assert.equal(((await repeated.json()) as { id: string }).id, created.id);
  console.log("duet iteration endpoint: ok");
} finally {
  rmSync(dirname(leadTranscript), { recursive: true, force: true });
  rmSync(dirname(duetTranscript), { recursive: true, force: true });
}
