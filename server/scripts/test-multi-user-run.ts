// 「这一次起跑是谁点的」——多人模式下**真的起进程**那一段的回归。
//
// 与 test-multi-user.ts 的分工:那条测的是「存进去什么」(可见性、归属、写侧收窄),
// 这条测的是「跑起来是谁」。判据只有一条,但它三处表面各漏过一次:
//
//   共享项目里 B 手点跑 A 的任务,烧的必须是 **B 自己**的 key、落在 **B 自己**的
//   CLI 配置目录里、提交署 **B 自己**的名。
//
// 所以这里往 PATH 前面塞一个假的 `claude`,让它把自己看到的环境变量原样写进探针
// 文件,再走完整的 HTTP 路由 → resumeOrRunTask/runDuet → 执行器 → spawn 链路去读
// 那个文件 —— 只读代码断言不了「有没有真接上」(做法同 test-cli-overrides.ts)。
//
//   ① 单人任务 /retry:第 5 轮审查里这条路整个没传 actingUserId(P1)。
//   ② duet /run:同上,而且 duet 的发言回合**一个环境变量都没注**,那一轮直接跑在
//      宿主机的 ~/.claude 上(§八 要抹掉的正是它)。
//   ③ 动手之前的确认闸(§八「不静默替换」):`executor-preflight` 得把**每一格**会被
//      换掉的执行器都报出来 —— duet 两格、team 三格,顶层那一格是空的。
//   ④ duet 起跑前必须过派发闸:没挂供应商的执行器不许起跑 —— 单人任务一直在过,
//      duet 从来没过,于是换讨论这条路就能绕开。
//   ⑤ 定时消息的**全局 id 路由**(`/scheduled-messages/:mid` 与 `…/steer`)要进横切闸:
//      列表端点挂在 `/tasks/:id/…` 下、一直被挡着,这两条改写端点却整个漏在闸外。
//
// 跑法(不设 ASH_DB 时自己开一个临时库):
//   npm -w server run test:multi-user-run
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { IS_WINDOWS } from "../src/platform.js";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-mu-run-"));
process.env.ASH_DB ||= join(stage, "mu-run.db");
requireTmpDb("test-multi-user-run");
// 产物一律留在舞台里,别写进真实 data/runs(必须在 import paths.js 之前设)。
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
// spawn.ts 的隔离闸默认不许「真起执行器」。这条测试要的恰恰是真走完 spawn 链路 ——
// 但 PATH 上那个 `claude` 是下面亲手种的假货,起的从来不是真 CLI。
process.env.ASH_ALLOW_REAL_AGENT = "1";
// 故意让**测试进程自己**带一个别的任务的身份:子进程默认继承 server 环境,而 ash 从
// 一个 ash 任务里启动时这个变量真的有值。不在这里钉死,这条判据就只在「跑测试的人
// 恰好也在一个任务里」时才成立。
process.env.ASH_TASK_ID = "some-other-task";
mkdirSync(process.env.ASH_RUNS_DIR, { recursive: true });

// ── 假 claude:把它看到的环境写进探针目录,一次调用一份 ──────────────────────
const probes = join(stage, "probes");
mkdirSync(probes, { recursive: true });
const bin = join(stage, "bin");
mkdirSync(bin, { recursive: true });
const KEYS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "ASH_TASK_ID"];
// 探针本体写成独立的 .cjs 文件,壳只负责 `node <它>`。塞进 `node -e "…"` 里会被两层
// 引号绞碎(sh 一层、cmd 一层),而那种碎法的症状是「假 CLI 起来了但立刻 exit 1」,
// 排查成本远高于多写一个文件。
const probeJs = join(bin, "probe.cjs");
writeFileSync(
  probeJs,
  `const fs=require("fs"),path=require("path");\n`
  + `const keys=${JSON.stringify(KEYS)};\n`
  + `const out={};for(const k of keys)out[k]=process.env[k]??null;\n`
  + `fs.writeFileSync(path.join(process.env.ASH_TEST_PROBES,process.pid+"-"+process.hrtime.bigint()+".json"),JSON.stringify(out));\n`,
);
// 假 claude 按平台换壳:Windows 内核不认 `#!/bin/sh`,PATH 查找只认 PATHEXT 里的后缀。
const fakeBin = join(bin, IS_WINDOWS ? "claude.cmd" : "claude");
writeFileSync(fakeBin, IS_WINDOWS ? `@node "${probeJs}"\r\n` : `#!/bin/sh\nexec node "${probeJs}"\n`);
chmodSync(fakeBin, 0o755);
// 分隔符用 path.delimiter:Windows 是 `;`,写死 `:` 会把整条 PATH 粘成一个不存在的目录。
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
process.env.ASH_TEST_PROBES = probes;

const readProbes = () =>
  readdirSync(probes)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(probes, f), "utf8")) as Record<string, string | null>);
const clearProbes = () => {
  for (const f of readdirSync(probes)) {
    try { unlinkSync(join(probes, f)); } catch { /* 已被并发的下一轮覆盖,无所谓 */ }
  }
};

const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, llmProviders, projects, sessions, tasks } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const visibility = await import("../src/auth/visibility.js");
const { Hono } = await import("hono");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountTaskSteerRoutes } = await import("../src/task-steer.js");
const { now, id } = await import("../src/util.js");

await ensureSchema();
const root = join(stage, "root");
mkdirSync(root, { recursive: true });
await mode.setInstanceMode("multi", root);

const alice = await store.createUser({ name: "Alice", role: "admin", dirName: "alice", gitName: "Alice Git", gitEmail: "alice@example.test", createdBy: null });
const bob = await store.createUser({ name: "Bob", role: "member", dirName: "bob", gitName: "Bob Git", gitEmail: "bob@example.test", createdBy: alice.id });
const bobKey = await store.resetUserKey(bob.id);

const ts = now();
await db.insert(llmProviders).values([
  { id: "prov-alice", name: "alice", protocol: "anthropic", baseUrl: "https://alice-provider.example", apiKey: "alice-provider-key", ownerUserId: alice.id, createdAt: ts },
  { id: "prov-bob", name: "bob", protocol: "anthropic", baseUrl: "https://bob-provider.example", apiKey: "bob-provider-key", ownerUserId: bob.id, createdAt: ts },
]);
const agentRow = (over: Record<string, unknown>) => ({
  id: "", name: "", type: "claude", model: "", extraArgs: "[]", isDefault: true,
  providerId: null as string | null, ownerUserId: null as string | null, createdAt: ts, ...over,
});
await db.insert(agents).values([
  agentRow({ id: "ex-alice", name: "Alice Executor", providerId: "prov-alice", ownerUserId: alice.id }),
  agentRow({ id: "ex-bob", name: "Bob Executor", providerId: "prov-bob", ownerUserId: bob.id }),
]);

// 共享项目:alice 建的,bob 是成员 —— 「跨人手点」的前提。
const repo = join(stage, "repo");
mkdirSync(repo, { recursive: true });
await db.insert(projects).values({ id: "p-shared", name: "shared", repoPath: repo, ownerUserId: alice.id, createdAt: ts, updatedAt: ts });
await visibility.addProjectMember({ projectId: "p-shared", userId: bob.id, role: "member", addedBy: alice.id });

const api = new Hono();
mountTaskRunRoutes(api);
mountTaskRoutes(api); // executor-preflight 住在这边
mountTaskSteerRoutes(api); // /scheduled-messages/:mid/steer 与 DELETE 同一个 id 形状
const app = new Hono();
app.use("*", authGate());
app.use("/api/*", resourceGate());
app.route("/api", api);
const get = async (path: string, key: string) => {
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    headers: { authorization: `Bearer ${key}` },
  }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};
const del = async (path: string, key: string) => {
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${key}` },
  }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};
const post = async (path: string, key: string, body: unknown = {}) => {
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

const taskRow = (over: Record<string, unknown>) => ({
  id: "", projectId: "p-shared", title: "t", body: "做点什么", mode: "single", status: "failed",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
  useWorktree: false, worktreeBase: null as string | null, ownerUserId: alice.id,
  createdAt: ts, updatedAt: ts, ...over,
});

/** 等到条件成立(或超时):duet/单飞都是 fire-and-forget,202 之后才真的跑。 */
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await ok()) return;
    if (Date.now() > deadline) throw new Error(`等不到:${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const statusOf = async (taskId: string) =>
  (await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, taskId))).at(0)?.s;
const settled = (s?: string) => s === "done" || s === "failed" || s === "canceled";

const expectBob = (env: Record<string, string | null>, where: string) => {
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "bob-provider-key", `${where}:烧的必须是点它的人的 key`);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://bob-provider.example", `${where}:供应商地址同上`);
  assert.ok(
    (env.CLAUDE_CONFIG_DIR ?? "").includes(bob.id),
    `${where}:必须落在本人的 CLI 配置目录里(§八 抹去宿主订阅),实际 ${env.CLAUDE_CONFIG_DIR}`,
  );
  assert.equal(env.GIT_AUTHOR_NAME, "Bob Git", `${where}:提交要署本人的名`);
  assert.equal(env.GIT_AUTHOR_EMAIL, "bob@example.test", `${where}:同上`);
};

// ── ① 单人任务 /retry:bob 重试 alice 的失败任务 ────────────────────────────
{
  const taskId = id();
  await db.insert(tasks).values(taskRow({ id: taskId, title: "alice single", executorId: "ex-alice" }));
  clearProbes();
  const r = await post(`/api/tasks/${taskId}/retry`, bobKey);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await until("单人重试起了进程", () => readProbes().length > 0);
  expectBob(readProbes()[0], "单人 /retry");
  await until("单人重试结算", async () => settled(await statusOf(taskId)));
  // 会话行上钉的执行器也得是 bob 的 —— 界面照着它显示「这一轮谁跑的」。
  const sess = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  assert.ok(sess.length > 0, "重试应留下会话行");
  assert.ok(
    sess.every((s) => s.executor?.includes("Bob")),
    `会话行该记 bob 的执行器,实际 ${sess.map((s) => s.executor).join(",")}`,
  );
}

// ── ② duet /run:bob 跑 alice 的讨论 ────────────────────────────────────────
{
  const taskId = id();
  await db.insert(tasks).values(taskRow({
    id: taskId, title: "alice duet", mode: "duet", status: "backlog",
    duet: JSON.stringify({ voiceA: "claude", voiceB: "claude", topic: "聊聊", maxRounds: 1, gateG1: "off", voiceAExecutorId: "ex-alice", voiceBExecutorId: "ex-alice" }),
  }));
  clearProbes();
  const r = await post(`/api/tasks/${taskId}/run`, bobKey);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await until("duet 两位讨论者都起了进程", () => readProbes().length >= 2);
  for (const env of readProbes()) {
    expectBob(env, "duet 发言回合");
    // 讨论者没有回合身份,而且不能从 server 自己的环境里**继承**一个别的任务的
    // (ash 从一个 ash 任务里启动时就会有值;借来的身份比没有身份更糟)。
    assert.equal(env.ASH_TASK_ID, null, `duet 发言回合不该带任务身份,实际 ${env.ASH_TASK_ID}`);
  }
  await until("duet 结算", async () => settled(await statusOf(taskId)));
  const sess = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  assert.ok(sess.length >= 2, "duet 应留下两条会话行");
  assert.ok(
    sess.every((s) => s.executor?.includes("Bob")),
    `duet 会话行该记 bob 的执行器,实际 ${sess.map((s) => s.executor).join(",")}`,
  );
}

// ── ③ 确认闸的数据源:每一格都要报出来 ──────────────────────────────────────
// 第 6 轮审查 P1:预检只读顶层 `tasks.executorId`,而 duet 把两位讨论者存在
// `tasks.duet` 里、team 把三个角色存在 `tasks.team` 里,顶层那格恒空 —— 于是这两种
// 任务永远被预检成「无需确认」,界面上一声不吭就换了人。
{
  const slotsOf = (body: Record<string, unknown>) =>
    (body.downgrades as { slot: string; fromOwner: string | null; toName: string | null }[]);

  // 单人任务:一格。
  const single = id();
  await db.insert(tasks).values(taskRow({ id: single, title: "preflight single", executorId: "ex-alice" }));
  const r1 = await get(`/api/tasks/${single}/executor-preflight`, bobKey);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual(slotsOf(r1.body).map((d) => d.slot), ["task"]);
  assert.equal(slotsOf(r1.body)[0].fromOwner, "Alice", "要说清原执行器是谁的");
  assert.equal(slotsOf(r1.body)[0].toName, "Bob Executor", "也要说清将改用我的哪一个");

  // 同一条任务,alice 自己看:不会换,不该弹。
  const aliceKey2 = await store.resetUserKey(alice.id);
  const r2 = await get(`/api/tasks/${single}/executor-preflight`, aliceKey2);
  assert.deepEqual(slotsOf(r2.body), [], "自己的执行器不会被换,别弹");

  // duet:两格都要报。
  const duetId = id();
  await db.insert(tasks).values(taskRow({
    id: duetId, title: "preflight duet", mode: "duet", status: "backlog",
    duet: JSON.stringify({ voiceA: "claude", voiceB: "claude", topic: "x", voiceAExecutorId: "ex-alice", voiceBExecutorId: "ex-alice" }),
  }));
  const r3 = await get(`/api/tasks/${duetId}/executor-preflight`, bobKey);
  assert.deepEqual(slotsOf(r3.body).map((d) => d.slot), ["voiceA", "voiceB"], "duet 两位讨论者各占一格");

  // team:三个角色同理(报告只报了 duet,这是同一个洞)。
  const teamId = id();
  await db.insert(tasks).values(taskRow({
    id: teamId, title: "preflight team", mode: "team", status: "backlog",
    team: JSON.stringify({ lead: "claude", worker: "claude", leadExecutorId: "ex-alice", reviewerExecutorId: "ex-alice" }),
  }));
  const r4 = await get(`/api/tasks/${teamId}/executor-preflight`, bobKey);
  assert.deepEqual(slotsOf(r4.body).map((d) => d.slot), ["lead", "reviewer"], "没钉执行器的那格不用问");
}

// ── ④ duet 起跑前要过派发闸:没挂供应商的执行器不许起跑 ─────────────────────
{
  // bob 换成一个没挂供应商的默认执行器 —— 单人任务在这种情况下会被闸拦下,
  // duet 以前直接放行(第 5 轮审查 P1 场景 1)。
  await db.update(agents).set({ isDefault: false }).where(eq(agents.id, "ex-bob"));
  await db.insert(agents).values(agentRow({ id: "ex-bob-bare", name: "Bob No Provider", providerId: null, ownerUserId: bob.id }));
  const taskId = id();
  await db.insert(tasks).values(taskRow({
    id: taskId, title: "no provider duet", mode: "duet", status: "backlog",
    duet: JSON.stringify({ voiceA: "claude", voiceB: "claude", topic: "聊聊", maxRounds: 1, gateG1: "off" }),
  }));
  clearProbes();
  const r = await post(`/api/tasks/${taskId}/run`, bobKey);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await until("闸拦下后结算", async () => settled(await statusOf(taskId)));
  assert.equal(await statusOf(taskId), "failed", "没挂供应商的执行器不该跑成功");
  assert.equal(readProbes().length, 0, "被闸拦下就一个进程都不该起 —— 起了就是绕过去了");
}

// ── ⑤ 定时消息的全局 id 路由要进横切闸 ─────────────────────────────────────
{
  const { scheduledMessages } = await import("../src/db/schema.js");
  // bob **不是**成员的项目 —— 前面那个 p-shared 他看得见,证不了越权。
  await db.insert(projects).values({ id: "p-private", name: "private", repoPath: repo, ownerUserId: alice.id, createdAt: ts, updatedAt: ts });
  const hidden = id();
  await db.insert(tasks).values(taskRow({ id: hidden, projectId: "p-private", title: "别人的任务" }));
  const mid = id();
  await db.insert(scheduledMessages).values({
    id: mid, taskId: hidden, text: "待发的原话",
    sendAt: new Date(Date.parse(ts) + 3_600_000).toISOString(),
    status: "pending", ownerUserId: alice.id, createdAt: ts,
  });

  // 任务级列表一直是挡着的 —— 对照组,证明漏的只是全局 id 那两条。
  const list = await get(`/api/tasks/${hidden}/scheduled-messages`, bobKey);
  assert.equal(list.status, 404, "看不见的项目,任务级列表本来就该 404");

  const canceled = await del(`/api/scheduled-messages/${mid}`, bobKey);
  assert.equal(canceled.status, 404, `拿到 mid 就能取消别人项目的待发消息:${JSON.stringify(canceled.body)}`);
  const steered = await post(`/api/scheduled-messages/${mid}/steer`, bobKey);
  assert.equal(steered.status, 404, "同一个 id 形状的 steer 也一样");
  const after = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, mid))).at(0);
  assert.equal(after?.status, "pending", "被挡下就一个字都不该改");

  // 看得见的人照常能取消 —— 闸不能把正常路一起堵了。
  const aliceKey3 = await store.resetUserKey(alice.id);
  const ok = await del(`/api/scheduled-messages/${mid}`, aliceKey3);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
}

await releaseTmpDb();
console.log("test-multi-user-run ok");
