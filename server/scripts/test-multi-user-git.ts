// 多人模式下**三条「不是网页登录态」的路**的回归。它们的共同点:请求要么来自另一台
// 机器,要么来自宿主机上的脚本,要么来自一个不该有写权限的普通成员 —— 三种都不是
// 「浏览器里登录着的项目管理员」,而第 1 轮审查的三条 P1 全在这上面:
//
//   ① 项目主仓的七条 Git 写路由只查「项目存在 + 不是预览实例」,普通成员能改所有人
//      共用的提交署名、SSH key、HTTPS 令牌,还能 checkout/fetch/pull/push 主仓。
//   ② `/api/restart-impact` 被通用登录闸挡住,`scripts/restart.mjs` 于是把「会被打断的
//      任务数」算成 0,不加 FORCE 的重启照样打断 queued 任务。
//   ③ `/api/handoff/projects/:id/refs` 和 `/api/handoff/identity` 同样被通用闸挡住,
//      多人↔多人的 Git 接力在协商第一步就 401,路由自己那三道更严的闸一条都到不了。
//   ④ 免登录名单上的**匿名写端点**(登录 / 首启 / 领取链接)不过 CSRF:攻击页一个
//      `text/plain` 简单请求就能免预检直达,而机器对机器那半张名单又不能被误伤。
//
// 三条都是**装配**问题而不是判据问题,所以这条测试一律走真 Request 打进
// `authGate → resourceGate → 路由` 的完整栈,不直接调判据函数。
//
// 跑法(自带临时库和临时 git 仓库):
//   npm -w server run test:multi-user-git
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-multi-user-git-"));
process.env.ASH_DB ||= join(stage, "multi-user-git.db");
requireTmpDb("test-multi-user-git");
// 全局 git 配置指到临时文件:scope 判定与提交署名才不受跑测试这台机器的影响。
const globalConfig = join(stage, "gitconfig-global");
writeFileSync(globalConfig, "[user]\n\tname = Global Person\n\temail = global@example.com\n");
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const visibility = await import("../src/auth/visibility.js");
const { readGitIdentity } = await import("../src/git-identity.js");
const { readProjectGitCredential } = await import("../src/git-credentials.js");
const { Hono } = await import("hono");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
// 整张 `api` 而不是逐个 mount:这三条路要么住在 routes.ts 自己身上(/restart-impact),
// 要么必须跟它的挂载顺序一致,拆着挂就成了第二份装配,测的不再是真的那份。
const { api } = await import("../src/routes.js");

await ensureSchema();

const root = join(stage, "root");
mkdirSync(root, { recursive: true });
const repo = join(root, "admin", "repo");
mkdirSync(join(root, "admin"), { recursive: true });
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://example.com/o/r.git"]);

await mode.setInstanceMode("multi", root);
const owner = await store.createUser({
  name: "owner", role: "member", dirName: "admin", gitName: "O", gitEmail: "o@x", createdBy: null,
});
const member = await store.createUser({
  name: "member", role: "member", dirName: "member", gitName: "M", gitEmail: "m@x", createdBy: owner.id,
});
const boss = await store.createUser({
  name: "boss", role: "admin", dirName: "boss", gitName: "B", gitEmail: "b@x", createdBy: owner.id,
});
const ownerKey = await store.resetUserKey(owner.id);
const memberKey = await store.resetUserKey(member.id);
const bossKey = await store.resetUserKey(boss.id);

const at = new Date().toISOString();
await db.insert(projects).values([
  { id: "p-shared", name: "shared", repoPath: repo, apiKeys: null, workflowId: null, createdAt: at, ownerUserId: owner.id },
] as never);
// 共享项目:owner 是项目管理员,member 只是普通成员(§十二 的共享轴)。
await visibility.addProjectMember({ projectId: "p-shared", userId: owner.id, role: "admin", addedBy: owner.id });
await visibility.addProjectMember({ projectId: "p-shared", userId: member.id, role: "member", addedBy: owner.id });

const app = new Hono();
app.use("*", authGate());
app.use("/api/*", resourceGate());
app.route("/api", api);

type Reply = { status: number; body: Record<string, unknown>; text: string };
const call = async (
  path: string,
  method: string,
  key: string | null,
  body?: unknown,
  extra?: Record<string, string>,
): Promise<Reply> => {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* 不是 JSON 就看 text */ }
  return { status: res.status, body: parsed, text };
};

// ── ① 项目主仓的 Git 写路由:普通成员一条都不许 ────────────────────────────
// 七条全列。这一屏改的是**所有任务共用**的东西(主仓 .git/config、主仓 HEAD、项目级
// HTTPS 令牌),按权限表(§四「项目设置」那一行)只给项目管理员和实例管理员。
const WRITE_ROUTES: { path: string; method: string; body?: unknown; what: string }[] = [
  { path: "/api/projects/p-shared/git/checkout", method: "POST", body: { branch: "nope" }, what: "切主仓分支" },
  { path: "/api/projects/p-shared/git/fetch", method: "POST", body: {}, what: "更新远端信息" },
  { path: "/api/projects/p-shared/git/pull", method: "POST", body: { strategy: "ff-only" }, what: "拉取主仓" },
  { path: "/api/projects/p-shared/git/push", method: "POST", body: {}, what: "推送主仓" },
  { path: "/api/projects/p-shared/git-config", method: "PUT", body: { userName: "Member Overwrite", userEmail: "member@example.com" }, what: "改提交署名" },
  { path: "/api/projects/p-shared/git-credential", method: "PUT", body: { username: "member-overwrite", secret: "s3cret" }, what: "覆盖 HTTPS 凭证" },
  { path: "/api/projects/p-shared/git-credential", method: "DELETE", what: "清除 HTTPS 凭证" },
];
{
  for (const route of WRITE_ROUTES) {
    const denied = await call(route.path, route.method, memberKey, route.body);
    assert.equal(
      denied.status, 403,
      `普通成员${route.what}必须 403(${route.method} ${route.path} 回了 ${denied.status}:${denied.text})`,
    );
    assert.match(String(denied.body.error ?? ""), /项目管理员/, `拒绝理由要说清是谁能做:${denied.text}`);
  }

  // 磁盘和库两边都确认没被改动 —— 只看状态码的话,一个「403 但已经写进去了」的实现
  // 会照样过。
  const identity = await readGitIdentity(repo);
  assert.equal(identity.userName.scope, "inherited", "被拒的写入不许落进 .git/config");
  assert.notEqual(identity.userName.value, "Member Overwrite");
  assert.equal(await readProjectGitCredential("p-shared"), null, "被拒的凭证不许落库");
}

// ── ② 同样七条,项目管理员与实例管理员必须过得去 ──────────────────────────
// 收紧的闸最容易一收收过头。这一组证明拦的是角色而不是路由本身。
{
  const saved = await call("/api/projects/p-shared/git-config", "PUT", ownerKey, {
    userName: "Owner Person", userEmail: "owner@example.com",
  });
  assert.equal(saved.status, 200, `项目管理员改署名要过:${saved.text}`);
  assert.equal((await readGitIdentity(repo)).userName.value, "Owner Person");

  const cred = await call("/api/projects/p-shared/git-credential", "PUT", bossKey, {
    username: "octocat", secret: "s3cret",
  });
  assert.equal(cred.status, 200, `实例管理员是隐式项目管理员,也该过:${cred.text}`);
  assert.equal(cred.text.includes("s3cret"), false, "回包里不许带令牌");
  assert.equal((await readProjectGitCredential("p-shared"))?.username, "octocat");

  // 网络型的四条不真跑 git(没有可达远端),但要证明它们**穿过了角色闸**:回的是 git
  // 自己的失败而不是 403。
  const checkout = await call("/api/projects/p-shared/git/checkout", "POST", ownerKey, { branch: "no-such-branch" });
  assert.notEqual(checkout.status, 403, `项目管理员切分支不该被角色闸拦:${checkout.text}`);
  assert.ok(!/项目管理员/.test(checkout.text), checkout.text);

  const del = await call("/api/projects/p-shared/git-credential", "DELETE", ownerKey);
  assert.equal(del.status, 200, del.text);
  assert.equal(await readProjectGitCredential("p-shared"), null);
}

// ── ③ 读侧不跟着收:成员看得见仓库状态 ────────────────────────────────────
// 「能不能看」和「能不能改」是两件事(审查报告明确允许分开)。凭证读侧本来就只回
// 用户名,令牌只写不读。
{
  const state = await call("/api/projects/p-shared/git", "GET", memberKey);
  assert.equal(state.status, 200, `成员该看得见主仓状态:${state.text}`);
  const config = await call("/api/projects/p-shared/git-config", "GET", memberKey);
  assert.equal(config.status, 200, `成员该看得见 Git 配置:${config.text}`);
  assert.equal(config.text.includes("s3cret"), false, "读侧永远不许把令牌交出去");
}

// ── ④ /api/restart-impact:宿主机凭证走得通,别人一律拒 ────────────────────
// 脚本跑在宿主机上,手里没有任何网页登录态。凭证是单实例锁文件里那串 token
// (文件 0600)。响应里带任务标题,所以豁口只放**路径形状**,凭证在路由内校验。
{
  await db.insert(tasks).values([
    { id: "t-queued", projectId: "p-shared", title: "会被重启打断的排队任务", body: "", status: "queued", createdAt: at, updatedAt: at, ownerUserId: owner.id },
  ] as never);

  const anonymous = await call("/api/restart-impact", "GET", null);
  assert.equal(anonymous.status, 401, `没凭证必须拒:${anonymous.text}`);
  assert.equal(anonymous.text.includes("会被重启打断的排队任务"), false, "拒了就一个字都不许漏");

  const wrong = await call("/api/restart-impact", "GET", null, undefined, { "x-ash-host-token": "not-the-token" });
  assert.equal(wrong.status, 401, `token 不对必须拒:${wrong.text}`);

  // 这条测试没走 index.ts,没人拿过单实例锁 —— `liveLockToken()` 是 null。空串对空串
  // 不许放行,这正是「没拿到锁时凭证不存在」那一档。
  const { liveLockToken } = await import("../src/singleton.js");
  assert.equal(liveLockToken(), null, "没起过 server 就不该有锁 token");
  const emptyToken = await call("/api/restart-impact", "GET", null, undefined, { "x-ash-host-token": "" });
  assert.equal(emptyToken.status, 401, "锁 token 不存在时,空串不能被当成匹配");

  // 拿得到锁就拿得到凭证:真起一次锁,再打同一条端点。
  const { acquireDbSingletonLock } = await import("../src/singleton.js");
  const lock = acquireDbSingletonLock({ port: 4317 });
  assert.ok(lock, "临时库上应该拿得到单实例锁");
  try {
    const token = liveLockToken();
    assert.ok(token, "拿到锁之后必须有 token");
    const ok = await call("/api/restart-impact", "GET", null, undefined, { "x-ash-host-token": token! });
    assert.equal(ok.status, 200, `宿主机凭证要过:${ok.text}`);
    const impact = ok.body as { interrupted?: { id: string }[] };
    assert.ok(
      impact.interrupted?.some((row) => row.id === "t-queued"),
      `queued 任务必须被算进「会被打断」里,否则 restart.mjs 的闸等于没有:${ok.text}`,
    );
  } finally {
    lock!.release();
  }

  // 登录用户照常能打:前端也用这条。
  const asUser = await call("/api/restart-impact", "GET", memberKey);
  assert.equal(asUser.status, 200, `登录用户不该被这道凭证挡住:${asUser.text}`);
}

// ── ⑤ 接力协商:未登录也要到得了路由自己的签名闸 ──────────────────────────
// 打这两条的是**对端的 ash 服务端**,只带机器 ed25519 签名和 §十一 的 peer user key,
// 不可能有本机 cookie。被通用闸拦住 = 多人↔多人 Git 接力在第一步就死。
{
  const refs = await call("/api/handoff/projects/p-shared/refs", "GET", null);
  assert.notEqual(refs.status, 200, "没签名当然不该真给出 refs");
  assert.equal(
    refs.body.needsAuth, undefined,
    `refs 该被路由自己的签名闸拒,而不是被 authGate 拦成「请先登录」:${refs.text}`,
  );
  assert.ok(!/请先登录/.test(refs.text), refs.text);

  const identity = await call("/api/handoff/identity", "GET", null);
  assert.equal(identity.status, 200, `公开身份要匿名读得到,否则对端探不出指纹:${identity.text}`);
  assert.ok(identity.body.fingerprint, `身份里必须有指纹:${identity.text}`);

  // 豁口必须窄:同一族路径下的本机设置面仍要登录。
  for (const path of ["/api/handoff/peers", "/api/handoff/targets"]) {
    const settings = await call(path, "GET", null);
    assert.equal(settings.status, 401, `${path} 是本机设置面,必须先登录:${settings.text}`);
    assert.equal(settings.body.needsAuth, true, settings.text);
  }
}

// ── ⑥ 免登录名单上的写请求同样要过 CSRF ──────────────────────────────────
// 名单里有一半是**浏览器**会打的写端点(登录、首启 setup、领取链接),而 Hono 的
// `req.json()` 不看 content-type,攻击页一个 `text/plain` 简单请求就能免预检直达。
// 另一半是机器对机器,它们既没有 Origin 也没有 Sec-Fetch-*,按同一份判据天然放行 ——
// 收窄这道闸时最容易顺手把它们一起误伤(第 1 轮审查 P1)。
{
  const cross = { "sec-fetch-site": "cross-site" };
  const login = await call("/api/auth/login", "POST", null, { key: "x" }, cross);
  assert.equal(login.status, 403, `跨站打登录必须拒:${login.text}`);
  assert.match(String(login.body.error ?? ""), /跨站请求已被拒绝/);

  const setup = await call("/api/auth/setup", "POST", null, { mode: "single" }, cross);
  assert.equal(setup.status, 403, `跨站打首启必须拒:${setup.text}`);

  const claim = await call("/api/auth/claim/whatever", "POST", null, {}, cross);
  assert.equal(claim.status, 403, `领取链接同属匿名写端点:${claim.text}`);

  // 同源放行:别把自家向导和登录页一起锁死。
  const same = await call("/api/auth/login", "POST", null, { key: "x" }, { "sec-fetch-site": "same-origin" });
  assert.equal(same.status, 401, `同源登录该走到 key 校验:${same.text}`);

  // 机器对机器:两个来源头都不带,必须被闸放行,由路由自己那道签名闸判。
  const ping = await call("/api/handoff/ping", "POST", null, {});
  assert.notEqual(ping.status, 403, `机器对端点不带 Origin,不该被 CSRF 判据误伤:${ping.status} ${ping.text}`);
  assert.ok(!/跨站请求/.test(ping.text), ping.text);
}

console.log("multi-user git/host/handoff gates ok");
await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
