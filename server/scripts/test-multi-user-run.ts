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
//   ⑥ **请求体里带来的** groupId / appendToQueue / parentId / originTaskId:横切闸只看
//      URL 上的 id,这四个都得路由自己查归属 —— 猜中别人项目的 id 就能把任务挂进去、
//      串进去;parentId 更狠,归属会跟着它继承,造出一条「我的项目、别人 owner」的任务。
//   ⑦ 项目级的残留清理入口(`/projects/:id/workspaces/discard`)拿的也是**请求体里的
//      taskId**,而且它真的执行 `worktree remove --force` + `branch -D`:既要查归属,
//      也要复用任务运行态保护,否则 agent 脚下的目录能被别人当场抽走。
//   ⑧ 项目设置(改路径 / 默认起手式)只给项目管理员,而且写进去的 id 必须是**人人都解析
//      得出来的**:`/projects/resolve` 的「同名孤儿项目回填路径」是改路径的一条集合端点
//      绕行路;项目默认起手式既不能是别人的私有起手式(个人面资源,§八),也不能是自己的
//      —— 项目行是共享的,自建条目对别人解析不出来,他们会静默落回系统默认。项目列表还要
//      带上「我在这儿是什么角色」,否则前端只能把必然 403 的管理控件摆给所有人看。
//   ⑨ 检查点续跑(`resume_prompt`)是 `resumeOrRunTask` 里的**另一条岔路**:CAS 取走
//      指令后它自己另调一次 continueTask,那处的 actingUserId 与 ① 是对称参数。
//   ⑩ 「烧谁的 key、落谁的目录」对了还不够:**接着谁的会话**也得对。CLI 的 transcript
//      躺在开它的那个人的配置目录里,拿别人的会话 id 去 `--resume` 只会扑空。
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
const KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "ASH_TASK_ID"];
// 探针本体写成独立的 .cjs 文件,壳只负责 `node <它>`。塞进 `node -e "…"` 里会被两层
// 引号绞碎(sh 一层、cmd 一层),而那种碎法的症状是「假 CLI 起来了但立刻 exit 1」,
// 排查成本远高于多写一个文件。
const probeJs = join(bin, "probe.cjs");
writeFileSync(
  probeJs,
  `const fs=require("fs"),path=require("path");\n`
  + `const keys=${JSON.stringify(KEYS)};\n`
  + `const out={};for(const k of keys)out[k]=process.env[k]??null;\n`
  // 命令行也留一份:「有没有拿别人的会话 id 去 --resume」只有 argv 答得了(⑩)。
  + `out.ARGV=process.argv.slice(2).join(" ");\n`
  + `fs.writeFileSync(path.join(process.env.ASH_TEST_PROBES,process.pid+"-"+process.hrtime.bigint()+".json"),JSON.stringify(out));\n`,
);
// 假 claude 按平台换壳:Windows 内核不认 `#!/bin/sh`,PATH 查找只认 PATHEXT 里的后缀。
// 两边都要把参数原样转给探针(`%*` / `"$@"`)—— 少了它 argv 恒为空,⑩ 那条「有没有拿
// 别人的会话 id 去 --resume」的断言就永远为真,测了个寂寞。
const fakeBin = join(bin, IS_WINDOWS ? "claude.cmd" : "claude");
writeFileSync(fakeBin, IS_WINDOWS ? `@node "${probeJs}" %*\r\n` : `#!/bin/sh\nexec node "${probeJs}" "$@"\n`);
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
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountProjectRoutes } = await import("../src/project-routes.js");
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
mountProjectRoutes(api); // /projects/:id/workspaces/discard 住在这边
mountTaskSteerRoutes(api); // /scheduled-messages/:mid/steer 与 DELETE 同一个 id 形状
const app = new Hono();
app.use("*", authGate());
app.use("/api/*", resourceGate());
app.use("/api/*", personalWriteGate());
app.route("/api", api);
const get = async (path: string, key: string) => {
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    headers: { authorization: `Bearer ${key}` },
  }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};
const patch = async (path: string, key: string, body: unknown = {}) => {
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
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
  assert.equal(env.ANTHROPIC_API_KEY, null, `${where}:旧 API_KEY 必须从子进程删除`);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, null, `${where}:旧 OAuth token 必须从子进程删除`);
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

// ── ⑥ 请求体里的 groupId / appendToQueue 必须查归属 ────────────────────────
{
  const { groups, queueItems } = await import("../src/db/schema.js");
  // p-private 是 bob 看不见的项目(⑤ 里建的)。在里面放一个分组和一条队列。
  await db.insert(groups).values({ id: "g-private", projectId: "p-private", name: "别人的分组", mode: "serial", paused: false, createdAt: ts });
  // 队头**不设分组**:两边 groupId 都是 null 时,老的「跨 group 不允许」比出来是「同组」,
  // 于是只剩「同项目」这一条能拦住它 —— 用带分组的队头会被旧检查顺手挡下,证不到真正的洞。
  const head = id();
  await db.insert(tasks).values(taskRow({ id: head, projectId: "p-private", title: "队头" }));
  await db.insert(queueItems).values({ taskId: head, queueId: "q-private", position: 0, createdAt: ts });

  // 对照组:直接打队列那条路一直是挡着的,证明漏的只是请求体这一层。
  assert.equal((await get("/api/queues/q-private", bobKey)).status, 404, "直接查别人的队列本来就该 404");

  // 建任务时把别人的 groupId 塞进请求体。
  const intoGroup = await post("/api/tasks", bobKey, { projectId: "p-shared", title: "混进分组", groupId: "g-private" });
  assert.equal(intoGroup.status, 404, `别人项目的 groupId 不该收:${JSON.stringify(intoGroup.body)}`);

  // 建任务时把别人的 queueId 塞进请求体。
  const intoQueue = await post("/api/tasks", bobKey, { projectId: "p-shared", title: "混进队列", appendToQueue: "q-private" });
  assert.ok(intoQueue.status >= 400, `别人项目的 queueId 不该收:${JSON.stringify(intoQueue.body)}`);
  const items = await db.select().from(queueItems).where(eq(queueItems.queueId, "q-private"));
  assert.equal(items.length, 1, "被拒之后队列里一条都不该多出来");

  // PATCH 同一个洞:一条我看得见的任务,不能被改挂到别人项目的分组上。
  const mine = id();
  await db.insert(tasks).values(taskRow({ id: mine, title: "我的任务", ownerUserId: bob.id }));
  const patched = await patch(`/api/tasks/${mine}`, bobKey, { groupId: "g-private" });
  assert.equal(patched.status, 404, `PATCH 也不该收:${JSON.stringify(patched.body)}`);
  const after = (await db.select({ g: tasks.groupId }).from(tasks).where(eq(tasks.id, mine))).at(0);
  assert.equal(after?.g, null, "被拒之后库里一个字都不该改");

  // 正向对照:同项目的分组照常挂得上 —— 别把正常路一起堵了。
  await db.insert(groups).values({ id: "g-shared", projectId: "p-shared", name: "自己的分组", mode: "parallel", paused: false, createdAt: ts });
  const ok = await patch(`/api/tasks/${mine}`, bobKey, { groupId: "g-shared" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const okRow = (await db.select({ g: tasks.groupId }).from(tasks).where(eq(tasks.id, mine))).at(0);
  assert.equal(okRow?.g, "g-shared");

  // parentId:同一条路由里第三个请求体 id,而且它比前两个更要紧 —— 归属跟着父任务继承。
  // 在 bob 看不见的 p-private 里放一条 alice 的任务当父:bob 直接读它是 404(对照组),
  // 但以前能在 p-shared 里建一条指着它的子任务,并把 ownerUserId 继承成 alice。
  const hidden = id();
  await db.insert(tasks).values(taskRow({ id: hidden, projectId: "p-private", title: "alice 的隐藏父任务" }));
  assert.equal((await get(`/api/tasks/${hidden}`, bobKey)).status, 404, "隐藏任务直接读本来就该 404");
  const child = await post("/api/tasks", bobKey, { projectId: "p-shared", title: "认了别人当爹", parentId: hidden });
  assert.equal(child.status, 404, `别人项目的 parentId 不该收:${JSON.stringify(child.body)}`);
  const leaked = (await db.select({ o: tasks.ownerUserId }).from(tasks).where(eq(tasks.parentId, hidden)));
  assert.equal(leaked.length, 0, "被拒之后不该留下任何认了别人当爹的任务");

  // originTaskId 同理(派生自哪条),同一路由、同一类,别只补被点名的那个。
  const derived = await post("/api/tasks", bobKey, { projectId: "p-shared", title: "派生自别人", originTaskId: hidden });
  assert.equal(derived.status, 404, `别人项目的 originTaskId 不该收:${JSON.stringify(derived.body)}`);

  // 正向对照:同项目的父任务照常认得,归属跟着父走(§八 要的就是这个)。
  const parentOk = await post("/api/tasks", bobKey, { projectId: "p-shared", title: "同项目的爹" });
  assert.equal(parentOk.status, 201, JSON.stringify(parentOk.body));
  const kid = await post("/api/tasks", bobKey, { projectId: "p-shared", title: "亲儿子", parentId: String(parentOk.body.id) });
  assert.equal(kid.status, 201, JSON.stringify(kid.body));
  const kidRow = (await db.select({ o: tasks.ownerUserId, p: tasks.parentId }).from(tasks).where(eq(tasks.id, String(kid.body.id)))).at(0);
  assert.equal(kidRow?.p, String(parentOk.body.id));
  assert.equal(kidRow?.o, bob.id, "同项目继承照常:父任务是 bob 建的,儿子也归 bob");
}

// ── ⑦ 项目级残留清理入口不能绕过任务运行态保护 ────────────────────────────
{
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  // 这一格要真删到东西才算数,所以另起一个**真的 git 仓库**(前面那个 repo 是空目录)。
  const gitRepo = join(stage, "git-repo");
  mkdirSync(gitRepo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", gitRepo]);
  execFileSync("git", ["-C", gitRepo, "config", "user.name", "Ash Test"]);
  execFileSync("git", ["-C", gitRepo, "config", "user.email", "ash@example.test"]);
  writeFileSync(join(gitRepo, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", gitRepo, "add", "-A"]);
  execFileSync("git", ["-C", gitRepo, "commit", "-m", "seed"]);
  const branchAlive = (name: string) => {
    try {
      execFileSync("git", ["-C", gitRepo, "show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
      return true;
    } catch { return false; }
  };
  await db.insert(projects).values({ id: "p-git", name: "git", repoPath: gitRepo, ownerUserId: alice.id, createdAt: ts, updatedAt: ts });
  await visibility.addProjectMember({ projectId: "p-git", userId: bob.id, role: "member", addedBy: alice.id });

  // alice 的任务**正在跑**,worktree 是真的,分支也是真的。
  const victim = id();
  await db.insert(tasks).values(taskRow({ id: victim, projectId: "p-git", title: "alice 在跑", status: "running", useWorktree: true }));
  const ws = await prepareWorktree(gitRepo, victim, "main");
  const branch = worktreeBranchName(victim);
  assert.equal(existsSync(ws.path), true);
  assert.equal(branchAlive(branch), true);

  // 洞:bob 是 p-git 的成员,路径上的 project 他看得见 —— 以前这就够了,带上 force
  // 就能把还在跑的任务脚下的目录连同未提交改动一起抽掉,任务行还停在 running。
  const forced = await post("/api/projects/p-git/workspaces/discard", bobKey, { taskId: victim, force: true });
  assert.equal(forced.status, 409, `在跑的任务不该被清:${JSON.stringify(forced.body)}`);
  assert.equal(existsSync(ws.path), true, "被拒之后 worktree 必须原样在");
  assert.equal(branchAlive(branch), true, "分支同样必须还在");
  // 任务自己的主人点也一样 —— 这是运行态保护,不是权限。
  const byOwner = await post("/api/projects/p-git/workspaces/discard", await store.resetUserKey(alice.id), { taskId: victim, force: true });
  assert.equal(byOwner.status, 409, `主人也不能清自己在跑的任务:${JSON.stringify(byOwner.body)}`);

  // 归属:taskId 是请求体里带来的资源 id(同 ⑥)。p-private 里那条 bob 看不见的任务,
  // 不能从他看得见的 p-git 借道发起清理。
  const outsider = id();
  await db.insert(tasks).values(taskRow({ id: outsider, projectId: "p-private", title: "别人项目的任务", status: "failed" }));
  const crossed = await post("/api/projects/p-git/workspaces/discard", bobKey, { taskId: outsider, force: true });
  assert.equal(crossed.status, 404, `别的项目的 taskId 不该收:${JSON.stringify(crossed.body)}`);

  // 停了就能清 —— 别把正常路一起堵了。
  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, victim));
  const ok = await post("/api/projects/p-git/workspaces/discard", bobKey, { taskId: victim, force: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.worktreeRemoved, true, JSON.stringify(ok.body));
  assert.equal(existsSync(ws.path), false);
  assert.equal(branchAlive(branch), false);

  // 这条入口的**本职**:任务行早就删了、git 里还剩东西,照样收拾得掉。
  const ghost = id();
  const ghostWs = await prepareWorktree(gitRepo, ghost, "main");
  const ghostBranch = worktreeBranchName(ghost);
  const swept = await post("/api/projects/p-git/workspaces/discard", bobKey, { taskId: ghost });
  assert.equal(swept.status, 200, `查无此行的残留必须还能清:${JSON.stringify(swept.body)}`);
  assert.equal(swept.body.worktreeRemoved, true, JSON.stringify(swept.body));
  assert.equal(existsSync(ghostWs.path), false);
  assert.equal(branchAlive(ghostBranch), false);
}

// ── ⑧ 项目设置的两个绕行路:resolve 回填路径、项目默认起手式 ────────────────
{
  const { workflows } = await import("../src/db/schema.js");
  // 普通成员的路径必须落在自己的目录里(§七),所以先把它建出来 —— realpath 钳制要求
  // 父目录真的在磁盘上。
  const bobHome = join(root, "bob");
  const bobPath = join(bobHome, "抢来的仓库");
  mkdirSync(bobPath, { recursive: true });

  // P1:同名且未设路径的项目会被 resolve「认领」并回填 repoPath —— 那就是改项目路径,
  // 只能给项目管理员。bob 只是成员。
  await db.insert(projects).values({ id: "p-orphan-a", name: "孤儿甲", repoPath: "", ownerUserId: alice.id, createdAt: ts, updatedAt: ts });
  await visibility.addProjectMember({ projectId: "p-orphan-a", userId: bob.id, role: "member", addedBy: alice.id });
  // 对照组:直接改路径一直是挡着的,证明漏的只是 resolve 这条集合端点。
  const direct = await patch("/api/projects/p-orphan-a", bobKey, { repoPath: bobPath });
  assert.equal(direct.status, 403, `成员直接改路径本来就该 403:${JSON.stringify(direct.body)}`);
  const adopted = await post("/api/projects/resolve", bobKey, { name: "孤儿甲", repoPath: bobPath });
  assert.equal(adopted.status, 403, `成员不该借 resolve 把项目目录挪走:${JSON.stringify(adopted.body)}`);
  const orphanRow = (await db.select({ p: projects.repoPath }).from(projects).where(eq(projects.id, "p-orphan-a"))).at(0);
  assert.equal(orphanRow?.p, "", "被拒之后路径一个字都不该改");

  // 正向对照:项目管理员照常认领得了 —— 别把正常路一起堵了。
  await db.insert(projects).values({ id: "p-orphan-b", name: "孤儿乙", repoPath: "", ownerUserId: alice.id, createdAt: ts, updatedAt: ts });
  await visibility.addProjectMember({ projectId: "p-orphan-b", userId: bob.id, role: "admin", addedBy: alice.id });
  const okAdopt = await post("/api/projects/resolve", bobKey, { name: "孤儿乙", repoPath: bobPath });
  assert.equal(okAdopt.status, 200, JSON.stringify(okAdopt.body));
  const adoptedRow = (await db.select({ p: projects.repoPath }).from(projects).where(eq(projects.id, "p-orphan-b"))).at(0);
  assert.equal(adoptedRow?.p, bobPath, "项目管理员认领后路径要真的落库");

  // P2:起手式是个人面资源。alice 的私有起手式 bob 读都读不到,更不该能把它写进项目行。
  const aliceWf = id();
  await db.insert(workflows).values({
    id: aliceWf, builtinKey: null, name: "alice 的私有起手式", description: "",
    def: JSON.stringify({ steps: [] }), disabled: false, ownerUserId: alice.id, createdAt: ts, updatedAt: ts,
  });
  // bob 得先是某个项目的管理员,否则 PATCH 会先被 requireProjectAdmin 挡下,证不到起手式那一层。
  await db.insert(projects).values({ id: "p-bob", name: "bob 自己的项目", repoPath: bobPath, ownerUserId: bob.id, createdAt: ts, updatedAt: ts });
  await visibility.addProjectMember({ projectId: "p-bob", userId: bob.id, role: "admin", addedBy: bob.id });
  const stolen = await patch("/api/projects/p-bob", bobKey, { workflowId: aliceWf });
  assert.equal(stolen.status, 400, `别人的私有起手式不该写得进项目行:${JSON.stringify(stolen.body)}`);
  // 文案要能区分两条规矩:这一条必须是「不存在」——跟没权限回同一句话,否则挨个 id 试
  // 一遍就能问出「这个 id 存在但不是我的」。下面那条自建起手式走的才是另一句。
  assert.equal(stolen.body.error, "起手式不存在", `别人的 id 只能回「不存在」:${JSON.stringify(stolen.body)}`);
  const wfRow = (await db.select({ w: projects.workflowId }).from(projects).where(eq(projects.id, "p-bob"))).at(0);
  assert.equal(wfRow?.w, null, "被拒之后项目默认起手式不该被写上");

  // 正向对照:系统自带那几条**人人都有**(按 key,各自可以有自己的覆写),所以它们才是
  // 共享项目默认唯一说得通的选项。
  const builtinOk = await patch("/api/projects/p-bob", bobKey, { workflowId: "standard" });
  assert.equal(builtinOk.status, 200, JSON.stringify(builtinOk.body));
  const builtinRow = (await db.select({ w: projects.workflowId }).from(projects).where(eq(projects.id, "p-bob"))).at(0);
  assert.equal(builtinRow?.w, "standard");

  // 连**自己的**自建起手式也不行:项目行是共享的,别人看不见它,设上去只会让他们的新任务
  // 静默落回系统默认 —— 界面上却写着「跟随本项目」(第 6 轮审查 P1)。
  const bobWf = id();
  await db.insert(workflows).values({
    id: bobWf, builtinKey: null, name: "bob 自己的起手式", description: "",
    def: JSON.stringify({ steps: [] }), disabled: false, ownerUserId: bob.id, createdAt: ts, updatedAt: ts,
  });
  const mine = await patch("/api/projects/p-bob", bobKey, { workflowId: bobWf });
  assert.equal(mine.status, 400, `自建起手式也当不了共享项目的默认:${JSON.stringify(mine.body)}`);
  assert.ok(
    String(mine.body.error).includes("系统自带"),
    `这条要走「只能选系统自带」那句,不能跟「不存在」混成一句:${JSON.stringify(mine.body)}`,
  );
  const mineRow = (await db.select({ w: projects.workflowId }).from(projects).where(eq(projects.id, "p-bob"))).at(0);
  assert.equal(mineRow?.w, "standard", "被拒之后原来那条默认不该被动过");

  // 角色要随项目列表一起发出去,前端据它决定管理控件给不给看(第 6 轮审查 P3)。
  const listed = await get("/api/projects", bobKey);
  const seen = new Map((listed.body as unknown as { id: string; myRole: string }[]).map((p) => [p.id, p.myRole]));
  assert.equal(seen.get("p-bob"), "admin", "自己建的项目里是管理员");
  assert.equal(seen.get("p-shared"), "member", "别人的共享项目里是成员");
  assert.equal(seen.get("p-orphan-a"), "member");
  assert.equal(seen.has("p-private"), false, "看不见的项目本来就不该出现在列表里");
  const asAdmin = await get("/api/projects", await store.resetUserKey(alice.id));
  assert.ok(
    (asAdmin.body as unknown as { myRole: string }[]).every((p) => p.myRole === "admin"),
    "实例管理员进任意项目权限等同项目管理员(§四)",
  );
}

// ── ⑨ 检查点续跑(`resume_prompt`)那条岔路也要带上「谁点的」──────────────────
// 它跟 ① 走的不是同一段代码:①(retry/无 checkpoint)落到 `runTask`,这一条在
// `resumeOrRunTask` 里就被 `takeResumePrompt` 的 CAS 岔走,自己另调一次 continueTask。
// 两处 `actingUserId` 是**对称参数**,只改一处靠通读发现不了(server/CLAUDE.md
// 「对称端点只改了一个」);合并 main 时这一行正好落在冲突块里,更该有根钉子。
{
  // ④ 故意把 bob 的默认执行器换成没挂供应商的那条(它要的就是被闸拦下),之后没还原。
  // 这一组要真起进程,先把 bob 的默认换回接了供应商的 ex-bob。
  await db.update(agents).set({ isDefault: false }).where(eq(agents.id, "ex-bob-bare"));
  await db.update(agents).set({ isDefault: true }).where(eq(agents.id, "ex-bob"));
  const taskId = id();
  await db.insert(tasks).values(taskRow({
    id: taskId, title: "alice 挂了检查点", executorId: "ex-alice",
    status: "paused", resumePrompt: "继续:把 tts 那一段做完",
  }));
  clearProbes();
  const r = await post(`/api/tasks/${taskId}/run`, bobKey);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await until("检查点续跑起了进程", () => readProbes().length > 0);
  expectBob(readProbes()[0], "检查点续跑 /run");
  await until("检查点续跑结算", async () => settled(await statusOf(taskId)));
  // 顺带钉住 main 那侧的语义:指令送出去了就该被取走,不能留在原位下次再投一遍。
  const left = (await db.select({ rp: tasks.resumePrompt }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  assert.equal(left?.rp, null, "送出去的 checkpoint 指令要被取走,否则下次触发会重投");
}

// ── ⑩ 跨人续聊不许拿**别人的** CLI 会话 id 去 --resume ──────────────────────
// 共享项目里 alice 的任务已经跑过一轮、留下了她自己的 claude 会话。bob 点「运行」时
// runOwner 是 bob,注入的是 **bob 的** CLAUDE_CONFIG_DIR —— 而那条 transcript 躺在
// alice 的目录里(多人模式一人一份,CLAUDE_CONFIG_DIR **整个取代** ~/.claude,不回落)。
// 老逻辑按 agentType+role 挑最新一行,于是把 alice 的 id 交给 bob 的 CLI:当场
// "No conversation found with session ID",回合空转、按未完成记 failed —— 与 2026-08-29
// 那次接力事故同一堵墙,只是触发口从「搬机器」换成了「换个人点一下」。
{
  const taskId = id();
  const aliceCli = "5c1d3f80-7ab2-4d19-9e64-2f0a8c37bb41";
  await db.insert(tasks).values(taskRow({ id: taskId, title: "alice 跑过一轮的任务", executorId: "ex-alice" }));
  await db.insert(sessions).values({
    id: "sess-alice-run", taskId, role: "single", agentType: "claude", executor: "Alice Executor",
    cliSessionId: aliceCli, runOwnerUserId: alice.id, startedAt: ts, turnStartedAt: ts,
  });
  clearProbes();
  const r = await post(`/api/tasks/${taskId}/run`, bobKey);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await until("跨人续聊起了进程", () => readProbes().length > 0);
  const probe = readProbes()[0];
  expectBob(probe, "跨人续聊");
  assert.ok(
    !(probe.ARGV ?? "").includes(aliceCli),
    `不许把别人的会话 id 交给这一轮的 CLI(它在对方的配置目录里,只会扑空):${probe.ARGV}`,
  );
  await until("跨人续聊结算", async () => settled(await statusOf(taskId)));
  // alice 那条原样留着 —— 那条会话对她完全健康,她再回来还能接着跑。
  const kept = (await db.select().from(sessions).where(eq(sessions.id, "sess-alice-run"))).at(0)!;
  assert.equal(kept.cliSessionId, aliceCli, "别人那条会话的 id 不许被这一轮改写");
  assert.equal(kept.runOwnerUserId, alice.id, "归属人同样不许被改写");
  // bob 这一轮另开一条,记在他自己名下(接力搬会话文件按这一列找,见 handoff-collect.ts)。
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  assert.equal(rows.length, 2, `跨人续聊该另开一条会话行,实际 ${rows.length} 条`);
  const fresh = rows.find((s) => s.id !== "sess-alice-run")!;
  assert.equal(fresh.runOwnerUserId, bob.id, "新开的这条要记在接手人名下");
}

await releaseTmpDb();
console.log("test-multi-user-run ok");
