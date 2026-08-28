// agent 回合凭证的**边界**:它代表的是那一条任务,不是任务 owner 的账号(§三,
// `docs/multi-user-plan.md:50`「有效回合凭证 → 任务归属项目」)。
//
// 第 2 轮审查 P1 实测过的越界(共享账号下,owner 同时是多个项目的成员):只带
// `x-ash-source-task-id` + `x-ash-turn-token` 的请求能
//   ① `GET /api/tasks` 读到 owner **另一个项目**里的任务;
//   ② `GET /api/tasks/:id` 直接取另一个项目的任务详情;
//   ③ `PATCH /api/users/:id` 改掉 owner 本人的 git 署名。
// 也就是说,任意一个正在跑的 agent 等于 owner 的完整账号。
//
// 收窄落在**两处判据**,这条测试两处都钉:
//   · 项目轴 —— `visibility.ts` 的 `agentScope`(可见集 = 源任务那一个项目);
//   · 账号面 —— `context.ts` 的 `isAccountHolder`(改资料 / 改个人 CLI 环境 / 导出导入
//     配置 / 退出项目一律不认回合凭证)。
// 同时钉住**别收过头**:agent 在自己项目里照常建任务、照常用得到 owner 的执行器 ——
// 那正是 MCP 派活这条主路(`mcp/src/index.ts` 给每个 HTTP 调用都附这两个头)。
//
// 一律走真 Request 打进 `authGate → resourceGate → 路由` 的完整栈;只有「实例管理员
// 名下的 agent」那一条是直接调判据函数(HTTP 侧构造不出这个身份,`agentActor` 恒填
// member —— 但判据的分支顺序不该依赖这个巧合)。
//
// 跑法(自带临时库):
//   npm -w server run test:multi-user-agent
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-multi-user-agent-"));
process.env.ASH_DB ||= join(stage, "multi-user-agent.db");
requireTmpDb("test-multi-user-agent");

const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, projects, tasks } = await import("../src/db/schema.js");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const visibility = await import("../src/auth/visibility.js");
const { Hono } = await import("hono");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
const { api } = await import("../src/routes.js");

await ensureSchema();

const root = join(stage, "root");
mkdirSync(join(root, "alice"), { recursive: true });
mkdirSync(join(root, "boss"), { recursive: true });
await mode.setInstanceMode("multi", root);

const alice = await store.createUser({
  name: "alice", role: "member", dirName: "alice", gitName: "Alice", gitEmail: "a@x", createdBy: null,
});
const boss = await store.createUser({
  name: "boss", role: "admin", dirName: "boss", gitName: "Boss", gitEmail: "b@x", createdBy: alice.id,
});
const aliceKey = await store.resetUserKey(alice.id);

const at = new Date().toISOString();
const sourceRepo = join(root, "alice", "source");
const secretRepo = join(root, "alice", "secret");
await db.insert(projects).values([
  { id: "p-source", name: "source", repoPath: sourceRepo, apiKeys: null, workflowId: null, createdAt: at, ownerUserId: alice.id },
  { id: "p-secret", name: "secret", repoPath: secretRepo, apiKeys: null, workflowId: null, createdAt: at, ownerUserId: alice.id },
] as never);
// alice 两个项目都是成员,而且在**另一个**项目里还是项目管理员 —— 越界一旦发生就不
// 只是「看得见」,还是「管得着」。
await visibility.addProjectMember({ projectId: "p-source", userId: alice.id, role: "member", addedBy: alice.id });
await visibility.addProjectMember({ projectId: "p-secret", userId: alice.id, role: "admin", addedBy: alice.id });

const task = (over: Record<string, unknown>) => ({
  id: "", projectId: "", title: "", body: "", status: "backlog",
  createdAt: at, updatedAt: at, ownerUserId: alice.id, ...over,
});
await db.insert(tasks).values([
  task({ id: "t-source", projectId: "p-source", title: "source task", status: "running", activeTurnToken: "turn-secret" }),
  task({ id: "t-secret", projectId: "p-secret", title: "OTHER PROJECT SECRET" }),
  task({ id: "t-boss", projectId: "p-source", title: "boss task", status: "running", activeTurnToken: "turn-boss", ownerUserId: boss.id }),
] as never);
// 个人面资源(§八):agent 派活时要用得到 owner 的执行器,收窄项目轴不该把这条一起掐了。
await db.insert(agents).values([
  { id: "ex-alice", name: "Alice Executor", type: "claude", extraArgs: "[]", configOverrides: "{}", isDefault: true, ownerUserId: alice.id },
] as never);

const app = new Hono();
app.use("*", authGate());
app.use("/api/*", resourceGate());
app.use("/api/*", personalWriteGate());
app.route("/api", api);

type Reply = { status: number; body: Record<string, unknown>; list: Record<string, unknown>[]; text: string };
const call = async (
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> => {
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let parsed: unknown = {};
  try { parsed = JSON.parse(text); } catch { /* 不是 JSON 就看 text */ }
  return {
    status: res.status,
    body: Array.isArray(parsed) ? {} : (parsed as Record<string, unknown>),
    list: Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [],
    text,
  };
};

/** MCP 给每个 HTTP 调用附的那两个头(mcp/src/index.ts)。 */
const AS_AGENT = { "x-ash-source-task-id": "t-source", "x-ash-turn-token": "turn-secret" };
const AS_ALICE = { authorization: `Bearer ${aliceKey}` };

// ── ① 项目轴:agent 只看得见源任务那一个项目 ──────────────────────────────
{
  const list = await call("/api/tasks", "GET", AS_AGENT);
  assert.equal(list.status, 200, `agent 该读得到自己项目的任务列表:${list.text}`);
  const titles = list.list.map((t) => String(t.title));
  assert.ok(titles.includes("source task"), `源任务必须还在:${list.text}`);
  assert.equal(
    titles.includes("OTHER PROJECT SECRET"), false,
    `回合凭证不该列出 owner 另一个项目的任务:${list.text}`,
  );

  const detail = await call("/api/tasks/t-secret", "GET", AS_AGENT);
  assert.equal(detail.status, 404, `另一个项目的任务详情必须 404:${detail.text}`);
  assert.equal(detail.text.includes("OTHER PROJECT SECRET"), false, "拒了就一个字都不许漏");

  const projectList = await call("/api/projects", "GET", AS_AGENT);
  const ids = projectList.list.map((p) => String(p.id));
  assert.deepEqual(ids, ["p-source"], `项目清单只该有源任务那一个:${projectList.text}`);

  // 同一个人登录着的话,两个项目照常都在 —— 拦的是凭证种类,不是这个账号。
  const asUser = await call("/api/projects", "GET", AS_ALICE);
  assert.deepEqual(
    asUser.list.map((p) => String(p.id)).sort(), ["p-secret", "p-source"],
    `alice 本人登录时两个项目都该在:${asUser.text}`,
  );
}

// ── ② 角色也跟着收:另一个项目里的项目管理员权限不许被凭证带过去 ──────────
// 光收窄可见集是不够的:`POST /projects/resolve` 的路径回填分支只查角色,URL 上没有
// project id 给横切闸看。
{
  const agentActor = { kind: "agent", userId: alice.id, role: "member", taskId: "t-source", name: "t" } as const;
  assert.equal(
    await visibility.projectRoleOf(agentActor, "p-secret"), null,
    "alice 在 p-secret 是项目管理员,但她那条任务的凭证在那儿什么都不是",
  );
  assert.equal(
    await visibility.projectRoleOf(agentActor, "p-source"), "member",
    "源任务项目里的角色照常生效",
  );

  // 按路径找回 = 探测器:另一个项目的路径不许被认出来。
  const resolved = await call("/api/projects/resolve", "POST", AS_AGENT, { repoPath: secretRepo });
  assert.notEqual(
    String(resolved.body.id ?? ""), "p-secret",
    `看不见的项目对这个凭证等于不存在,不许按路径认回来:${resolved.text}`,
  );
}

// ── ③ 实例管理员名下的 agent 同样只有那一个项目 ──────────────────────────
// `agentActor` 现在恒填 member,所以 HTTP 侧构造不出这个身份。但判据里 agent 分支排在
// 管理员分支**前面**这件事不该靠那个巧合 —— 哪天回合凭证改成继承 owner 的实例角色,
// 顺序写反就是「一条任务的凭证变成万能钥匙」。
{
  const bossAgent = { kind: "agent", userId: boss.id, role: "admin", taskId: "t-boss", name: "t" } as const;
  const visible = await visibility.visibleProjectIds(bossAgent);
  assert.deepEqual([...(visible ?? [])], ["p-source"], "管理员名下的 agent 也只有源任务那一个项目");

  // 凭证悬空(任务行已删)→ 空集,不是「不设限」。
  const orphan = { kind: "agent", userId: alice.id, role: "member", taskId: "t-gone", name: "t" } as const;
  assert.deepEqual([...(await visibility.visibleProjectIds(orphan) ?? [])], [], "悬空凭证什么都不该看见");
}

// ── ④ 账号面:回合凭证不是「本人」 ───────────────────────────────────────
{
  const patched = await call(`/api/users/${alice.id}`, "PATCH", AS_AGENT, { gitName: "CHANGED BY AGENT" });
  assert.notEqual(patched.status, 200, `agent 不许改 owner 的用户资料:${patched.text}`);
  assert.equal(
    (await store.getUser(alice.id))?.gitName, "Alice",
    "被拒的写入不许落库(只看状态码的话,「403 但已经写进去了」会照样过)",
  );

  // 个人 CLI 环境 = 下一次派任务喂给所有 CLI 的东西,一条任务不该能改写它。
  for (const [path, method, body] of [
    ["/api/me/cli-env", "GET", undefined],
    ["/api/me/cli-env/claude/memory", "PUT", { body: "# 被 agent 改写" }],
    ["/api/me/cli-env/claude/skills/x", "PUT", { body: "# skill" }],
    ["/api/me/config/export", "POST", {}],
    ["/api/me/config/import", "POST", { version: 1, items: {} }],
  ] as const) {
    const denied = await call(path, method, AS_AGENT, body);
    assert.equal(denied.status, 403, `${method} ${path} 对回合凭证必须 403:${denied.text}`);
    assert.match(String(denied.body.error ?? ""), /账号本人/, denied.text);
  }

  // 「自行退出项目」也只认真人:这条分支只查可见性,而 agent 对源任务项目恰好有。
  const left = await call(`/api/projects/p-source/members/${alice.id}`, "DELETE", AS_AGENT);
  assert.notEqual(left.status, 200, `agent 不许把 owner 退出项目:${left.text}`);
  assert.ok(
    (await visibility.listProjectMembers("p-source")).some((m) => m.userId === alice.id && !m.implicit),
    "alice 必须还在 p-source 的成员表里",
  );

  // 本人登录时这些照常能用 —— 拦的是凭证种类。
  const asUser = await call(`/api/users/${alice.id}`, "PATCH", AS_ALICE, { gitName: "Alice Renamed" });
  assert.equal(asUser.status, 200, `alice 本人改自己的署名要过:${asUser.text}`);
  assert.equal((await store.getUser(alice.id))?.gitName, "Alice Renamed");
}

// ── ⑤ 别收过头:MCP 派活这条主路必须原样走得通 ────────────────────────────
{
  const own = await call("/api/tasks/t-source", "GET", AS_AGENT);
  assert.equal(own.status, 200, `agent 读自己那条任务必须过:${own.text}`);

  const created = await call("/api/tasks", "POST", AS_AGENT, {
    projectId: "p-source", title: "agent 建的任务", body: "x",
  });
  assert.equal(created.status, 201, `agent 在自己项目里建任务是 MCP 主路,必须过:${created.text}`);

  // 执行器是**个人面**资源(§八),按 owner 的 scope 走 —— 派活要挑执行器,这条不能被
  // 项目轴的收窄误伤。
  const executors = await call("/api/agents", "GET", AS_AGENT);
  assert.equal(executors.status, 200, executors.text);
  assert.ok(
    executors.list.some((a) => a.id === "ex-alice"),
    `agent 该用得到 owner 的执行器:${executors.text}`,
  );

  // 凭证本身仍然要对得上:token 不对就退回匿名。
  const wrong = await call("/api/tasks", "GET", { ...AS_AGENT, "x-ash-turn-token": "nope" });
  assert.equal(wrong.status, 401, `token 不对必须回未登录:${wrong.text}`);
}

// ── ⑥ 个人面资源的**写侧**:回合凭证一条都不许改 ──────────────────────────
// 读侧是敞开的(上一组:派活要挑执行器),但写侧不是 —— 这几张表装的是**后续任务会
// 继承的配置**:默认执行器、默认供应商(带 baseUrl 和 key)、审查者、团队预设、个人
// 接力目标机。一条任务的凭证改得动它们,就等于一条任务能改写这个账号往后的运行方式
// (第 1 轮审查 P1 实测:`POST /api/llm-providers` 201,在 alice 名下建出了供应商)。
{
  const { llmProviders, reviewerProfiles, teamPresets, workflows } = await import("../src/db/schema.js");
  const WRITES: { path: string; method: string; body?: unknown; what: string }[] = [
    { path: "/api/llm-providers", method: "POST", body: { name: "agent-added", protocol: "openai", baseUrl: "https://evil.example.com", apiKey: "secret" }, what: "建供应商" },
    { path: "/api/agents", method: "POST", body: { name: "agent-added-executor", type: "claude" }, what: "建执行器" },
    { path: "/api/workflows", method: "POST", body: { name: "agent-added-flow", def: { steps: [{ kind: "run" }] } }, what: "建起手式" },
    { path: "/api/reviewer-profiles", method: "POST", body: { name: "agent-added-reviewer", agentType: "claude" }, what: "建审查者" },
    { path: "/api/team-presets", method: "POST", body: { name: "agent-added-preset", config: { lead: "claude", worker: "claude" } }, what: "建团队预设" },
    // 个人键(§八):改掉它,owner 往后所有新任务的默认就变了。
    { path: "/api/settings", method: "PATCH", body: { worktreeDefault: false }, what: "改个人设置" },
    { path: "/api/handoff/targets", method: "POST", body: { name: "agent-added-peer", url: "https://evil.example.com", peerKey: "k" }, what: "加接力目标机" },
    { path: "/api/notes", method: "POST", body: { projectId: "p-source", body: "agent 写的随手记" }, what: "写随手记" },
    { path: `/api/agents/ex-alice`, method: "PATCH", body: { name: "HIJACKED" }, what: "改 owner 的执行器" },
    { path: `/api/agents/ex-alice`, method: "DELETE", what: "删 owner 的执行器" },
  ];
  for (const w of WRITES) {
    const denied = await call(w.path, w.method, AS_AGENT, w.body);
    assert.equal(denied.status, 403, `agent ${w.what} 必须 403(${w.method} ${w.path} 回了 ${denied.status}:${denied.text})`);
    assert.match(String(denied.body.error ?? ""), /账号本人/, denied.text);
  }
  // 库里一行都不许多、一行都不许变 —— 只看状态码的话,「403 但已经写进去了」照样过。
  assert.equal((await db.select().from(llmProviders)).length, 0, "被拒的供应商不许落库");
  assert.equal((await db.select().from(workflows)).length, 0, "被拒的起手式不许落库");
  assert.equal((await db.select().from(reviewerProfiles)).length, 0, "被拒的审查者不许落库");
  assert.equal((await db.select().from(teamPresets)).length, 0, "被拒的团队预设不许落库");
  const executors = await db.select().from(agents);
  assert.equal(executors.length, 1, "执行器既不许多出来,也不许被删");
  assert.equal(executors[0].name, "Alice Executor", "owner 的执行器不许被改名");

  // 本人登录时照常能写 —— 拦的是凭证种类,不是这几条端点本身。
  const mine = await call("/api/llm-providers", "POST", AS_ALICE, {
    name: "alice-own", protocol: "openai", baseUrl: "https://api.example.com", apiKey: "k",
  });
  assert.equal(mine.status, 201, `alice 本人建供应商要过:${mine.text}`);

  // 读侧不跟着收:派活要挑执行器/供应商,而读端点一条都不回显 key(只报 hasKey)。
  const providers = await call("/api/llm-providers", "GET", AS_AGENT);
  assert.equal(providers.status, 200, `agent 读得到 owner 的供应商清单:${providers.text}`);
  assert.equal(providers.text.includes("\"k\""), false, `读侧永远不许把 key 交出去:${providers.text}`);
}

console.log("multi-user agent turn-token scope ok");
await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
