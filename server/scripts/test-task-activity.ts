// 「与任务活动正交的写入不推进 updatedAt」的回归测试。
//
// updatedAt 在产品里是任务的**最后活动时间**:列表按它倒序、普通模式按它做 24 小时
// 折叠(超过一天的行收进「展开(20/N)」)、未读事件键 `${status}:${updatedAt}:${endedAt}`
// 也含它。所以推进它的后果是三连:跳到列表最前 + 解除折叠 + 已读终态退回未读。
//
// 管理动作不该有这种后果。2026-10-19 删掉两个 codex 执行器 profile,把 432 条七八月的
// 历史任务一次性推到「昨天」,普通模式的侧栏当场多出几百行 —— 删除本身没有任何界面
// 回声,等人发现时已经没人记得点过什么。同一个坑当时有三处:删执行器、删分组、以及
// 启动迁移里清 ssh profile 引用。
//
// 跑法:
//   ASH_DB=/tmp/test-task-activity-$RANDOM.db npx tsx server/scripts/test-task-activity.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "ash-task-activity-"));
process.env.ASH_DB = join(root, "ash.db");

// routes.ts 导出的 `api` 已经把 task / group 路由都挂好了,照它在真实进程里的样子请求。
const [{ db, ensureSchema }, schema, { api }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/routes.js"),
]);
const { agents, groups, projects, tasks } = schema;

await ensureSchema();
const seededAt = "2026-08-01T00:00:00.000Z";
const updatedAtOf = async (id: string) =>
  (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)?.updatedAt;

try {
  await db.insert(projects).values({ id: "project", name: "activity", repoPath: root, createdAt: seededAt });
  await db.insert(agents).values({
    id: "executor", name: "codex@doomed", type: "codex", model: "gpt-x",
    extraArgs: "[]", reasoningEffort: null, speed: null, providerId: null, isDefault: false,
  });
  await db.insert(groups).values({ id: "group", projectId: "project", name: "batch", mode: "parallel", createdAt: seededAt });
  await db.insert(tasks).values([
    { id: "old", projectId: "project", title: "七月的老任务", status: "done", stage: "accepted",
      executorId: "executor", groupId: "group", createdAt: seededAt, updatedAt: seededAt },
    { id: "bystander", projectId: "project", title: "没挂在被删对象上", status: "done",
      createdAt: seededAt, updatedAt: seededAt },
  ]);

  // 删执行器 profile:悬空引用要清掉(否则任务指着一个不存在的 profile),但这不是任务的进展。
  let response = await api.request("/agents/executor", { method: "DELETE" });
  assert.equal(response.status, 200);
  let task = (await db.select().from(tasks).where(eq(tasks.id, "old"))).at(0);
  assert.equal(task?.executorId ?? null, null, "deleting an executor must clear the dangling ref");
  assert.equal(task?.updatedAt, seededAt, "deleting an executor must not bump updatedAt");

  // 删分组同理:任务不删,只是脱离分组。
  response = await api.request("/groups/group", { method: "DELETE" });
  assert.equal(response.status, 200);
  task = (await db.select().from(tasks).where(eq(tasks.id, "old"))).at(0);
  assert.equal(task?.groupId ?? null, null, "deleting a group must ungroup its tasks");
  assert.equal(task?.updatedAt, seededAt, "deleting a group must not bump updatedAt");

  assert.equal(await updatedAtOf("bystander"), seededAt, "unrelated tasks must never be touched");

  // 对照组:真·活动照常推进,豁免只给「与活动正交」的那几类写入。
  response = await api.request("/tasks/old", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "改个名算活动" }),
  });
  assert.equal(response.status, 200);
  assert.notEqual(await updatedAtOf("old"), seededAt, "a real content change must bump updatedAt");

  console.log("task activity tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
