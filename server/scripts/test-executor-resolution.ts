// 执行器解析优先级回归测试:
//   executorId 命中 → 用该 profile
//   executorId 悬空 → 按 type 默认执行器降级
//   executorId 缺省 → 按 type 默认执行器
//
// 跑法:
//   ASH_DB=/tmp/test-executor-resolution-$RANDOM.db npx tsx server/scripts/test-executor-resolution.ts
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { requireTmpDb } from "./tmp-db.js";

requireTmpDb("test-executor-resolution");

const { db, ensureSchema } = await import("../src/db/index.js");
const { agents } = await import("../src/db/schema.js");
const { resolveExecutorFor } = await import("../src/executors/index.js");

await ensureSchema();
await db.delete(agents);

await db.insert(agents).values([
  {
    id: "codex-default",
    name: "codex@default",
    type: "codex",
    model: "gpt-default",
    extraArgs: "[]",
    reasoningEffort: null,
    speed: null,
    providerId: null,
    isDefault: true,
  },
  {
    id: "codex-custom",
    name: "codex@custom",
    type: "codex",
    model: "gpt-custom",
    extraArgs: "[]",
    reasoningEffort: null,
    speed: null,
    providerId: null,
    isDefault: false,
  },
]);

const specified = await resolveExecutorFor({ executorId: "codex-custom", type: "codex" });
if (specified.label !== "codex@custom" || specified.type !== "codex") {
  throw new Error(`executorId 命中应使用 codex@custom, got ${specified.label}/${specified.type}`);
}

await db.delete(agents).where(eq(agents.id, "codex-custom"));

const stale = await resolveExecutorFor({ executorId: "codex-custom", type: "codex" });
if (stale.label !== "codex@default" || stale.type !== "codex") {
  throw new Error(`executorId 悬空应降级 codex@default, got ${stale.label}/${stale.type}`);
}

const omitted = await resolveExecutorFor({ type: "codex" });
if (omitted.label !== "codex@default" || omitted.type !== "codex") {
  throw new Error(`executorId 缺省应使用 codex@default, got ${omitted.label}/${omitted.type}`);
}

await assert.rejects(
  () => resolveExecutorFor({ type: "codex", model: "gpt-5.5", reasoningEffort: "ultra" }),
  /gpt-5\.5 不支持思考强度 ultra.*low、medium、high、xhigh/,
  "所有执行入口最终都要在 spawn 前拦住已知非法的模型/强度组合",
);
const validModelEffort = await resolveExecutorFor({ type: "codex", model: "gpt-5.6-sol", reasoningEffort: "ultra" });
assert.equal(validModelEffort.type, "codex", "模型能力规则允许的组合应正常解析执行器");

// build() 必须把「检测命中的备用命令名」一路传给 GenericCliExecutor。死认 bins[0]
// 时,只装了备用名的机器会被 /agents/catalog 判为可用、派任务却稳定 ENOENT
// (cursor 的 cursor-agent → agent、antigravity 的 antigravity → agy)。
// 这里临时把某个 generic spec 的候选改成「主 bin 不存在 + 备用 bin 是 node」,
// 只改运行时值、跑完就还原,不碰任何 spec 文件(B 阶段有人在并行改它们)。
const { AGENT_TYPES } = await import("@ash/shared");
const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
const { cliHelpHasFlag } = await import("../src/executors/bin-probe.js");
assert.equal(cliHelpHasFlag("  --effort <level>", "--effort"), true, "help 里的完整 flag 应命中");
assert.equal(cliHelpHasFlag("  --effortless", "--effort"), false, "不能把更长的参数名前缀误认成目标 flag");

// 用 node 充当一份「存在、能报版本、但没有 --effort」的旧 Claude Code。解析阶段读
// --help 后应把执行器标成预检失败；run 只产出 failedChild 事件，不启动 node 去吃
// Claude 的参数，更不会把原始 unknown option 甩给用户。
const claudeSpec = CLI_SPEC_BY_KEY.claude;
const originalClaudeBins = claudeSpec.bins;
claudeSpec.bins = ["node"];
try {
  const oldClaude = await resolveExecutorFor({ type: "claude", reasoningEffort: "high" });
  const handle = oldClaude.run({ prompt: "不应送到真实进程", cwd: process.cwd() });
  const events = [];
  for await (const event of handle.events) events.push(event);
  const message = events.find((event) => event.kind === "error")?.message ?? "";
  assert.match(message, /当前 Claude Code \d+\.\d+\.\d+ 不支持 --effort/);
  assert.match(message, /claude update/);
  assert.match(message, /跟随执行器/);
  assert.doesNotMatch(message, /unknown option/i);
} finally {
  claudeSpec.bins = originalClaudeBins;
}

const genericType = AGENT_TYPES.find((t) => !CLI_SPEC_BY_KEY[t].factory);
if (!genericType) throw new Error("目录里没有一个走 GenericCliExecutor 的 spec,这条用例失去意义");
const spec = CLI_SPEC_BY_KEY[genericType];
const originalBins = spec.bins;
spec.bins = ["ash-missing-primary-bin", "node"];
try {
  const ex = await resolveExecutorFor({ type: genericType });
  const handle = ex.run({ prompt: "probe", cwd: process.cwd() });
  handle.kill();
  if (!handle.commandLine.startsWith("node ")) {
    throw new Error(`主 bin 缺失时应改用可用的备用名 node, got: ${handle.commandLine}`);
  }
} finally {
  spec.bins = originalBins;
}

// ── 环境指纹：「原样再跑一遍上一回合」的保真前提 ──────────────────────────────
// profile 是可编辑可删的：改一次模型就换了个脑子，改一次供应商就换了套账号。只存主键
// 时，重试会拿着旧 CLI 会话 id 去连一套从没跑过它的环境（第 1 轮审查 finding 2）。所以解析
// 时要顺带记下那一刻的环境指纹，重跑前对不上就让上层 409。
const { profileDrift, resolveExecutorWithProfile } = await import("../src/executors/index.js");
await db.insert(agents).values({
  id: "codex-fp", name: "codex@fp", type: "codex", model: "gpt-fp",
  extraArgs: "[]", reasoningEffort: null, speed: null, providerId: null, isDefault: false,
});
const stamped = await resolveExecutorWithProfile({ executorId: "codex-fp", type: "codex" });
assert.equal(stamped.profileId, "codex-fp", "解析要还回真正选中的 profile 主键");
assert.ok(stamped.profileFingerprint, "解析要顺带还回那一刻的环境指纹");
assert.equal(await profileDrift("codex-fp", stamped.profileFingerprint), null, "什么都没动 → 还是同一套环境");
// 展示名不进指纹：agents.name 非唯一、可随时改，改个名字不该把重试按钮堵死。
await db.update(agents).set({ name: "codex@renamed" }).where(eq(agents.id, "codex-fp"));
assert.equal(await profileDrift("codex-fp", stamped.profileFingerprint), null, "改展示名不算换执行环境");
await db.update(agents).set({ model: "gpt-elsewhere" }).where(eq(agents.id, "codex-fp"));
assert.equal(await profileDrift("codex-fp", stamped.profileFingerprint), "changed", "换了模型必须认出来");
await db.delete(agents).where(eq(agents.id, "codex-fp"));
assert.equal(await profileDrift("codex-fp", stamped.profileFingerprint), "missing", "profile 被删了必须认出来");
// 老会话行没有这两列：无从核对，按老行为放行（判据同 executorId 悬空时的降级）。
assert.equal(await profileDrift(null, stamped.profileFingerprint), null, "没记 profile 的老会话行照旧放行");
assert.equal(await profileDrift("codex-fp", null), null, "没记指纹的老会话行照旧放行");

// ── 「没指定执行器」必须继承默认执行器,而不是被当成「显式清空」──────────────
// 2026-09-02 事故:团队配了 codex@cpa + gpt-5.6-sol(xhigh),dispatch 出来的执行者
// 却落到 codex@local + gpt-5.5。根因不在解析层,而在写入层 —— `ExecutorScope.keep()`
// 把 undefined(没给)和 null(显式清空)一起压成 null,下游 pickExecutor 靠
// `executorId !== undefined` 分辨这两件事,于是被骗进「显式给了 null」的分支:团队
// 默认执行者丢掉,连锁地 sameExecutor 判成换了执行器,model/effort 也一起落 null。
//
// 纯逻辑那一侧钉在 test-executor-overrides;这里钉的是**真的建出来的任务行**,
// 因为 keep() 那一层只有走真实写入路径才经过。两条写入路径各钉一次。
{
  const { tasks: taskRows, projects, groups } = await import("../src/db/schema.js");
  const { dispatchWorkers } = await import("../src/team/dispatch.js");

  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p-team", name: "team", repoPath: "/tmp/ash-not-a-repo", createdAt: at });
  await db.insert(agents).values({
    id: "codex-cpa", name: "codex@cpa", type: "codex", model: "gpt-5.6-sol",
    extraArgs: "[]", reasoningEffort: null, speed: null, providerId: null, isDefault: false,
  });
  const teamConfig = {
    lead: "claude", worker: "codex",
    workerExecutorId: "codex-cpa", workerModel: "gpt-5.6-sol", workerReasoningEffort: "xhigh",
  };
  await db.insert(taskRows).values([{
    id: "lead-team", projectId: "p-team", title: "lead", body: "", mode: "team",
    status: "idle", createdAt: at, updatedAt: at, team: JSON.stringify(teamConfig),
  }] as never);

  // 事故本体:spec 不带 executorId / agentType / model / reasoningEffort。
  const dispatched = await dispatchWorkers("lead-team", [{ body: "干活" }], { run: false });
  const worker = (await db.select().from(taskRows).where(eq(taskRows.id, dispatched.tasks[0]!.id))).at(0)!;
  assert.equal(worker.executorId, "codex-cpa", "dispatch 没指定执行器 → 必须继承团队默认执行者");
  assert.equal(worker.agentType, "codex", "类型跟着继承来的 profile 走");
  assert.equal(worker.model, "gpt-5.6-sol", "同一个执行器 → 团队 workerModel 要继承下来");
  assert.equal(worker.reasoningEffort, "xhigh", "同一个执行器 → 团队 workerReasoningEffort 要继承下来");

  // 对照:显式传 null 才是「清空」,这条口径不能被上面那条修复顺手抹掉。
  const cleared = await dispatchWorkers("lead-team", [{ body: "干活", executorId: null }], { run: false });
  const clearedWorker = (await db.select().from(taskRows).where(eq(taskRows.id, cleared.tasks[0]!.id))).at(0)!;
  assert.equal(clearedWorker.executorId, null, "显式 executorId:null 仍然是清空,按类型默认执行器降级");
  assert.equal(clearedWorker.model, null, "换了执行器 → 团队 model 不再套上去");

  // 另一条写入路径:批量建任务的 defaults 继承(group-routes),同一个 keep() 中招。
  const { Hono } = await import("hono");
  const { mountGroupRoutes } = await import("../src/group-routes.js");
  const api = new Hono();
  mountGroupRoutes(api);
  const app = new Hono();
  app.route("/api", api);
  await db.insert(groups).values({ id: "g-batch", projectId: "p-team", name: "batch", mode: "parallel", createdAt: at });
  const res = await app.fetch(new Request("http://127.0.0.1:4317/api/groups/g-batch/tasks/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tasks: [{ body: "干活" }],
      defaults: { executorId: "codex-cpa", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    }),
  }));
  const created = await res.json() as { tasks?: Array<{ id: string }> };
  assert.equal(res.status, 201, `批量建任务应成功:${JSON.stringify(created)}`);
  const batched = (await db.select().from(taskRows).where(eq(taskRows.id, created.tasks![0]!.id))).at(0)!;
  assert.equal(batched.executorId, "codex-cpa", "批量建任务没指定执行器 → 必须继承 defaults.executorId");
  assert.equal(batched.agentType, "codex", "类型跟着继承来的 profile 走");
  assert.equal(batched.model, "gpt-5.6-sol", "同一个执行器 → defaults.model 要继承下来");
  assert.equal(batched.reasoningEffort, "xhigh", "同一个执行器 → defaults.reasoningEffort 要继承下来");
}

console.log("executor resolution tests passed");
