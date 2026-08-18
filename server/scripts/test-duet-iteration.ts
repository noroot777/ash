import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { DUET_DEFAULTS } from "@harness/shared";
import { requireTmpDb } from "./tmp-db.js";

requireTmpDb("test-duet-iteration");

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

  // 用户意见已落盘、讨论者还没跑完就中断:A/B 轮次没动,但旧合稿已被那条意见推翻。
  const interrupted = iteration.conclusionLines([
    { round: 2, speaker: "A", raised: true, agrees: true, conclusion: "结论X" },
    { round: 2, speaker: "B", raised: true, agrees: true, conclusion: "结论X" },
    { round: 2, speaker: "synthesis", text: "# 旧方案" },
    { round: 3, speaker: "user", text: "这个方向不对，推翻重来" },
  ]);
  assert.ok(!interrupted.join("\n").includes("旧方案"), "a user note after the plan must invalidate it");

  // 未共识的合稿(agreedToStop/roundCap/midway)不能被冠以「收敛后的共同方案」。
  const split = iteration.conclusionLines([
    { round: 4, speaker: "A", raised: true, agrees: false, conclusion: "方案甲" },
    { round: 4, speaker: "B", raised: true, agrees: false, conclusion: "方案乙" },
    { round: 4, speaker: "synthesis", text: "# 方案\n共同点……\n## 残留分歧\n甲 vs 乙", stop: "agreedToStop" },
  ]);
  assert.match(split.join("\n"), /没有达成共识/, "non-consensus plan must not be presented as agreed");
  assert.doesNotMatch(split.join("\n"), /收敛后的共同方案/);
  assert.match(split.join("\n"), /甲 vs 乙/);

  // retry 重放判定:失败轮若是 gate 介入轮,要用原 inject/question prompt 重放。
  const { gateRoundOf } = await import("../src/duet/index.js");
  assert.equal(gateRoundOf([{ speaker: "user", round: 3, text: "补充意见", kind: "inject" }], 3)?.kind, "inject");
  assert.equal(gateRoundOf([{ speaker: "user", round: 3, text: "只问B", target: "B" }], 3)?.kind, "ask", "old rows without kind: target implies ask");
  assert.equal(gateRoundOf([{ speaker: "user", round: 3, text: "无kind无target" }], 3)?.kind, "inject", "old rows without kind/target default to inject");
  assert.equal(gateRoundOf([{ speaker: "user", round: 2, text: "别的轮" }], 3), null);

  const repeated = await app.request(`/tasks/${teamId}/team/iterate-duet`, { method: "POST" });
  assert.equal(repeated.status, 200);
  assert.equal(((await repeated.json()) as { id: string }).id, created.id);

  // 复用同一条 session 行接着跑下一轮时,「这活在哪台机器、哪个目录、带什么参数跑」必须
  // 整组跟着刷新:门禁能等很久,这期间 profile 可能被改到另一台机器、worktree 可能被删
  // 后重建。漏掉哪一列,「复制到终端接着聊」就给出一条跑不起来的命令(第 2 轮 finding 6)。
  const { reusedSessionPatch } = await import("../src/duet/index.js");
  const seen: string[] = [];
  const executor = {
    label: "claude@build",
    type: "claude",
    target: { kind: "ssh", host: "build.example" },
    resumeFields: (cwd: string, sessionId: string) => {
      seen.push(`${cwd}|${sessionId}`);
      return { resumeCommand: `cd ${cwd} && claude --resume ${sessionId}`, resumeEnv: "K=v ", resumeArgs: "--settings '{}'" };
    },
  } as unknown as Parameters<typeof reusedSessionPatch>[0];
  assert.deepEqual(reusedSessionPatch(executor, "/repo/next", "claude --resume x", "sess-9"), {
    commandLine: "claude --resume x",
    executor: "claude@build",
    target: "ssh:build.example",
    cwd: "/repo/next",
    resumeCommand: "cd /repo/next && claude --resume sess-9",
    resumeEnv: "K=v ",
    resumeArgs: "--settings '{}'",
  }, "换机器/换目录/换参数都要落库,少一列就是一条恢复不了的恢复命令");
  // `--settings` 的内容跟 cwd 有关,所以必须拿**这一轮的** cwd 去算,不能用建执行器时
  // 冻好的那份(第 3 轮 finding 2)。
  assert.deepEqual(seen, ["/repo/next|sess-9"], "恢复三件套必须按本轮 cwd + 本轮会话 id 现算");
  // 还没拿到 CLI 会话 id 时:三列一律不碰(写一条缺 id 的恢复命令,比留着上一轮那条更糟)。
  const withoutId = reusedSessionPatch(executor, "/repo/next", "claude --resume x", "");
  assert.equal("resumeCommand" in withoutId, false, "没有会话 id 就不该产出 resumeCommand");
  assert.equal("resumeEnv" in withoutId, false);
  assert.equal("resumeArgs" in withoutId, false);
  assert.deepEqual(seen, ["/repo/next|sess-9"], "没有会话 id 时压根不该去算");

  console.log("duet iteration endpoint: ok");
} finally {
  rmSync(dirname(leadTranscript), { recursive: true, force: true });
  rmSync(dirname(duetTranscript), { recursive: true, force: true });
}
