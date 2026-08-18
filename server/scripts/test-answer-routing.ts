// 答复要送回给「提问的那一个」,而不是任务的常设执行器。
//
// 一个普通任务可以住着好几个智能体(每个 @ 召唤进来的都有自己的会话行)。停下来
// 提问的完全可能是被召唤来的那个;照 task.agentType 续跑等于把答复念给了另一个
// CLI——它既没提过这个问题,也没有那一回合的上下文,而且没有任何报错。
//
// 跑法:
//   HARNESS_DB=/tmp/test-answer-routing-$RANDOM.db npx tsx server/scripts/test-answer-routing.ts
import assert from "node:assert/strict";
import { requireTmpDb } from "./tmp-db.js";

requireTmpDb("test-answer-routing");

const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, sessions } = await import("../src/db/schema.js");
const { askingAgentFor } = await import("../src/task-question.js");

await ensureSchema();
await db.delete(sessions);
await db.delete(agents);

const localTarget = JSON.stringify({ kind: "local" });
await db.insert(agents).values([
  {
    id: "grok-local",
    name: "grok@local",
    type: "grok",
    target: localTarget,
    model: null,
    extraArgs: "[]",
    reasoningEffort: null,
    speed: null,
    providerId: null,
    isDefault: true,
  },
]);

const session = (over: Record<string, unknown>) => ({
  id: `s-${Math.round(Math.random() * 1e9)}`,
  taskId: "task-1",
  role: "single",
  agentType: "codex",
  executor: "codex@cpa·gpt-5.6-sol",
  target: localTarget,
  startedAt: "2026-08-02T07:10:00.000Z",
  turnStartedAt: "2026-08-02T07:10:00.000Z",
  endedAt: "2026-08-02T07:40:00.000Z",
  ...over,
});

assert.equal(await askingAgentFor("task-1"), null, "一条会话都没有时不该编出一个执行器来");

// 任务常设 codex,@grok 被召唤进来跑了最新这一回合并停下提问。
await db.insert(sessions).values([
  session({}),
  session({
    agentType: "grok",
    executor: "grok@local",
    startedAt: "2026-08-02T07:48:00.000Z",
    turnStartedAt: "2026-08-02T07:49:00.000Z",
    endedAt: null,
  }),
]);
assert.deepEqual(
  await askingAgentFor("task-1"),
  { agent: "grok", executorId: "grok-local", role: "single" },
  "提问的是被召唤进来的 grok,答复就该回到 grok(executorId 由 profile 名反查)",
);

// profile 被改名/删掉:类型仍要认对,executorId 交回 null 走类型默认执行器降级。
await db.delete(agents);
assert.deepEqual(
  await askingAgentFor("task-1"),
  { agent: "grok", executorId: null, role: "single" },
  "profile 查不到时只降级 executorId,不能连 agentType 一起丢",
);

// 顺序按**回合时间**而不是会话创建时间:老会话被 resume 后接着提问,它才是最新的那个。
await db.delete(sessions);
await db.insert(sessions).values([
  session({ turnStartedAt: "2026-08-02T08:20:00.000Z", endedAt: null }),
  session({
    agentType: "grok",
    executor: "grok@local",
    startedAt: "2026-08-02T07:48:00.000Z",
    turnStartedAt: "2026-08-02T07:49:00.000Z",
    endedAt: "2026-08-02T08:00:00.000Z",
  }),
]);
assert.equal((await askingAgentFor("task-1"))?.agent, "codex", "取回合时间最新的那条会话");

// 团队调度台的 lead 会话不参与单飞/审查任务的答复路由。
await db.delete(sessions);
await db.insert(sessions).values([session({ role: "lead", agentType: "claude", executor: "claude@ccb" })]);
assert.equal(await askingAgentFor("task-1"), null, "只认 single/reviewer 会话行");

console.log("answer routing tests passed");
