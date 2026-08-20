// 老库升级回归:注册过 ssh 执行器的库升上来之后,那条 profile 必须消失,而不是丢掉
// 「它在远端」这件事继续当本机 profile 用(第 1 轮审查:label 还是 claude@build.example,
// resume 却已经是本机的 `cd /repo && claude --resume`,默认 profile 还照样默认)。
//
// 跑法:
//   HARNESS_DB=/tmp/test-ssh-profile-retire-$RANDOM.db npx tsx server/scripts/test-ssh-profile-retire.ts
import assert from "node:assert/strict";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

requireTmpDb("test-ssh-profile-retire");

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { agents } = await import("../src/db/schema.js");

// 先建出当前 schema,再把已退役的 agents.target 加回来 —— 这就是「装着老版本的库」:
// 表结构齐全、agents 上还带着执行位置那一列。
await ensureSchema();
await dbClient.execute(`ALTER TABLE agents ADD COLUMN target TEXT NOT NULL DEFAULT '{"kind":"local"}'`);
await db.delete(agents);

const insert = (id: string, name: string, target: string, isDefault: number) =>
  dbClient.execute({
    sql: "INSERT INTO agents (id, name, type, target, extra_args, config_overrides, is_default) VALUES (?, ?, 'claude', ?, '[]', '{}', ?)",
    args: [id, name, target, isDefault],
  });

await insert("ssh-prof", "claude@build.example", JSON.stringify({ kind: "ssh", host: "build.example" }), 1);
await insert("local-prof", "claude@本机", JSON.stringify({ kind: "local" }), 0);

const stamp = new Date().toISOString();
await dbClient.execute({
  sql: "INSERT INTO tasks (id, project_id, title, status, agent_type, executor_id, created_at, updated_at) VALUES (?, 'proj', 't', 'backlog', 'claude', 'ssh-prof', ?, ?)",
  args: ["task-on-ssh", stamp, stamp],
});
await dbClient.execute({
  sql: "INSERT INTO scheduled_messages (id, task_id, text, send_at, created_at, executor_id) VALUES ('msg', 'task-on-ssh', 'hi', ?, ?, 'ssh-prof')",
  args: [stamp, stamp],
});
await dbClient.execute({
  sql: "INSERT INTO reviewer_profiles (id, name, agent_type, executor_id, created_at, updated_at) VALUES ('rev', '远端审查者', 'claude', 'ssh-prof', ?, ?)",
  args: [stamp, stamp],
});
await dbClient.execute({
  sql: "INSERT INTO free_workflow_states (task_id, review_executor_id, updated_at) VALUES ('task-on-ssh', 'ssh-prof', ?)",
  args: [stamp],
});
// 会话行是历史,里面记着「上一回合真的跑在远端」;它的 executor_id 必须留着悬空。
await dbClient.execute({
  sql: "INSERT INTO sessions (id, task_id, role, agent_type, executor, started_at, executor_id, executor_fingerprint) VALUES ('sess', 'task-on-ssh', 'single', 'claude', 'claude@build.example', ?, 'ssh-prof', 'fp-old')",
  args: [stamp],
});

// ── 升级 ──────────────────────────────────────────────────────────────────
await ensureSchema();

const left = await dbClient.execute("SELECT id, name, is_default FROM agents ORDER BY id");
assert.deepEqual(
  left.rows.map((r) => String(r.id)),
  ["local-prof"],
  "ssh 执行器 profile 升级后还在:它会被当成本机 profile 继续派任务",
);

const columns = await dbClient.execute("PRAGMA table_info(agents)");
assert.equal(columns.rows.some((r) => r.name === "target"), false, "ssh profile 清掉之后才轮到删列,结果列还在");

const task = (await dbClient.execute("SELECT executor_id, updated_at FROM tasks WHERE id = 'task-on-ssh'")).rows[0]!;
assert.equal(task.executor_id, null, "指向 ssh profile 的任务必须回到「按类型默认执行器」");
assert.notEqual(task.updated_at, stamp, "改了任务的执行器归属就得动 updated_at,否则前端拿不到新值");

const msg = (await dbClient.execute("SELECT executor_id FROM scheduled_messages WHERE id = 'msg'")).rows[0]!;
assert.equal(msg.executor_id, null, "待发送消息还钉着已删的 ssh profile");

const reviewer = (await dbClient.execute("SELECT executor_id FROM reviewer_profiles WHERE id = 'rev'")).rows[0]!;
assert.equal(reviewer.executor_id, null, "审查者 profile 还钉着已删的 ssh profile");

const freeState = (await dbClient.execute("SELECT review_executor_id FROM free_workflow_states WHERE task_id = 'task-on-ssh'")).rows[0]!;
assert.equal(freeState.review_executor_id, null, "预约的审查执行器还钉着已删的 ssh profile");

const session = (await dbClient.execute("SELECT executor_id FROM sessions WHERE id = 'sess'")).rows[0]!;
assert.equal(
  session.executor_id,
  "ssh-prof",
  "会话行的 executor_id 不能清:重跑校验靠它认出「上一回合那条 profile 没了」并拒绝重放到本机",
);

// 悬空 id 的降级必须是老实的本机默认 profile,不能再顶着远端那个名字。
const { resolveExecutorFor } = await import("../src/executors/index.js");
const executor = await resolveExecutorFor({ executorId: "ssh-prof", type: "claude" });
assert.notEqual(executor.label, "claude@build.example", "已删的 ssh profile 还在冒充执行器");

const { profileDrift } = await import("../src/executors/index.js");
assert.equal(await profileDrift("ssh-prof", "fp-old"), "missing", "远端跑过的会话必须被判成「执行器已删」而不是可原样重放");

// 幂等:再升一次不该报错,也不该动剩下那条本机 profile。
await ensureSchema();
assert.equal((await dbClient.execute("SELECT COUNT(*) AS n FROM agents")).rows[0]!.n, 1);

await releaseTmpDb();
console.log("ok: ssh 执行器 profile 在升级时被连根清掉");
