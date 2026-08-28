// 首启转换与建用户的**失败半途**回归。判据只有一条,但它两处都栽了同一跤:
//
//   落库和建目录这两步之间一旦失败,不能留下一个「库里有、磁盘没有、谁也修不了」的状态。
//
//   ⓪ 前置的另一条:首启 `/auth/setup` 是**匿名写端点**,免登录不等于免 CSRF ——
//      跨站一发就能把未配置的实例锁进攻击者指定的多人模式(第 1 轮审查 P1)。
//   ① `POST /auth/setup`:目录建不出来时,实例已经翻成 multi、管理员行已落库却没有
//      key —— 而 `needsSetup:false` 把向导藏了起来,谁也进不去,只能手改库(第 1 轮
//      审查 P0)。两层都要挡:**目录先建**(失败时库里一个字没动),外加 needsSetup 把
//      「multi 却没人能登录」也算进首启,让向导能把管理员补出来。
//      —— 而这个「补做中」的状态本身**不是免鉴权状态**:出路只有免登录名单里的
//      `/auth/state`、`/auth/setup` 加 SPA 壳,别的路径一律 401(第 1 轮审查 P0)。
//   ② `POST /users`:同样的顺序问题。原来的写法留下一个没有邀请链接、也没有 key 的
//      用户,而它把姓名和目录名双双占死,管理员照原样重试直接 409(第 1 轮审查 P1)。
//   ③ 自带起手式的每人覆写:`(builtin_key, owner_user_id)` 是**每人一行**,按 key 查完
//      取第一行再判归属,会在别人的行排前面时把我自己的覆写当成不存在(第 1 轮审查 P2)。
//
// 跑法(不设 ASH_DB 时自己开一个临时库):
//   npm -w server run test:multi-user-setup
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-mu-setup-"));
process.env.ASH_DB ||= join(stage, "mu-setup.db");
requireTmpDb("test-multi-user-setup");

const { db, ensureSchema } = await import("../src/db/index.js");
const { users, userInvites, workflows } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const { authGate } = await import("../src/auth/middleware.js");
const { mountAuthRoutes } = await import("../src/auth/routes.js");
const { mountUserRoutes } = await import("../src/auth/user-routes.js");
const { findWorkflow, listWorkflows } = await import("../src/workflows.js");
const { now, id } = await import("../src/util.js");

await ensureSchema();

const api = new Hono();
mountAuthRoutes(api);
mountUserRoutes(api);
// 闸下的普通数据端点替身。测的是 `authGate` 本身「除了免登录名单一律拦」,不是某条
// 业务路由 —— 挂真的 task-routes 只会把一堆无关依赖拖进来,而闸对它们一视同仁。
api.get("/canary", (c) => c.json({ secret: "别人的任务标题" }));
api.post("/canary", (c) => c.json({ wrote: true }));
const app = new Hono();
app.use("*", authGate());
app.route("/api", api);

type Res = { status: number; body: Record<string, unknown>; cookie: string | null };
const call = async (
  path: string,
  method: string,
  key: string | null,
  body?: unknown,
  extra?: Record<string, string>,
): Promise<Res> => {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  // 领取那一步会发会话 cookie,而它正是 confirm 的凭据(见 ⑤)。
  const setCookie = res.headers.get("set-cookie");
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    cookie: setCookie ? setCookie.split(";")[0]! : null,
  };
};

const root = join(stage, "root");
mkdirSync(root, { recursive: true });

// ── ⓪ 首启 setup 是**匿名写端点**,必须过 CSRF ─────────────────────────────
// 免登录名单里有一半是浏览器会打的写端点,而 Hono 的 `req.json()` 不看 content-type
// (middleware.ts 顶部),所以攻击页一个 `text/plain` 简单请求就能免预检直达。这条端点
// 尤其致命:它把**未配置**的实例一次性锁进攻击者指定的多人模式,连管理员名字和根目录
// 都是他起的;真正的用户刷新后只剩一张登录页,没拿到 key 就只能走宿主机逃生门
// (第 1 轮审查 P1)。
//
// 这一组必须排在所有会真的写库的组**之前**:它验的正是「跨站那一发什么都没改成」。
{
  const evil = { mode: "multi", adminName: "Hijacked", rootDir: root, dirName: "hijacked" };
  // 现代浏览器:Sec-Fetch-Site 是浏览器自己盖的章,页面伪造不了。
  const secFetch = await call("/api/auth/setup", "POST", null, evil, { "sec-fetch-site": "cross-site" });
  assert.equal(secFetch.status, 403, `跨站 setup 必须拒:${JSON.stringify(secFetch.body)}`);
  assert.match(String(secFetch.body.error), /跨站请求已被拒绝/);
  // 老浏览器没有 Sec-Fetch-*,退到比对 Origin。
  const byOrigin = await call("/api/auth/setup", "POST", null, evil, { origin: "https://evil.example" });
  assert.equal(byOrigin.status, 403, `Origin 对不上也必须拒:${JSON.stringify(byOrigin.body)}`);

  // 只看状态码不够:一个「403 但已经翻了模式」的实现照样过。
  mode.invalidateInstanceConfig();
  assert.equal((await mode.instanceConfig()).mode, "", "被拒的 setup 不许把实例翻成 multi");
  assert.equal(await store.countUsers(), 0, "被拒的 setup 不许留下管理员行");

  // 反过来:同源那一发得照常放行,别把向导自己锁死。
  const sameOrigin = await call("/api/auth/setup", "POST", null, { mode: "multi" }, { "sec-fetch-site": "same-origin" });
  assert.equal(sameOrigin.status, 400, `同源请求该走到业务校验(缺 adminName):${JSON.stringify(sameOrigin.body)}`);
  assert.match(String(sameOrigin.body.error), /管理员姓名必填/);
  // 非浏览器调用方(curl / 手机端 / 这份测试)两个头都不带 —— 同样放行。
  const headless = await call("/api/auth/setup", "POST", null, { mode: "multi" });
  assert.equal(headless.status, 400, `不带来源头的调用方不该被 CSRF 挡:${JSON.stringify(headless.body)}`);
  // 注意这一刻实例模式还是 ""(未配置),`authGate` 整条穿透 —— 上面这四发全靠
  // `/auth/setup` **自己**那道判据挡住的。闸那一层的同一道判据(匿名打免登录名单的写
  // 请求)在多人模式下才生效,钉在 `test:multi-user-git` 里。
}

// ── ① 首启转换:目录建不出来 → 库里一个字都不许动,而且要能重来 ────────────
{
  // 「admin」这个路径被一个**文件**占着 —— 报告里用的就是这一手。
  writeFileSync(join(root, "admin"), "占位");

  const blocked = await call("/api/auth/setup", "POST", null, {
    mode: "multi", adminName: "Admin", rootDir: root, dirName: "admin",
  });
  assert.equal(blocked.status, 409, `路径被占该当场拒绝:${JSON.stringify(blocked.body)}`);
  assert.match(String(blocked.body.error), /被一个文件占着/);

  // 关键的一条:**失败没有留下任何半成品**。
  mode.invalidateInstanceConfig();
  assert.equal((await mode.instanceConfig()).mode, "", "失败的转换不该把实例翻成 multi");
  assert.equal(await store.countUsers(), 0, "失败的转换不该留下用户行");
  assert.equal(await mode.needsSetup(), true, "向导必须还在");

  // 腾开路径,原样重试 —— 不需要任何手工修补。
  const { rmSync } = await import("node:fs");
  rmSync(join(root, "admin"));
  const ok = await call("/api/auth/setup", "POST", null, {
    mode: "multi", adminName: "Admin", rootDir: root, dirName: "admin",
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(String(ok.body.key ?? "").length > 0, "该发一把能登录的 key");
  mode.invalidateInstanceConfig();
  assert.equal(await mode.needsSetup(), false, "建完了,向导该收起来");
}

// ── ② 「multi 却没人能登录」= 首启没走完,向导要能把管理员补出来 ────────────
{
  // 手工造出崩在半路的样子:模式已落、把唯一的管理员的 key 抹掉(等价于崩在
  // createUser 与 resetUserKey 之间)。这是 needsSetup 的第二种情形。
  const admin = (await db.select().from(users)).at(0)!;
  await db.update(users).set({ keyHash: null, status: "invited" }).where(eq(users.id, admin.id));
  mode.invalidateInstanceConfig();
  assert.equal(await mode.needsSetup(), true, "一个能登录的人都没有 = 实例锁死,向导必须回来");

  // 匿名(没有 key,本来也拿不到)重走一遍向导 —— 这正是被锁死时唯一的出路。
  const state = await call("/api/auth/state", "GET", null);
  assert.equal(state.body.needsSetup, true);
  assert.equal(state.body.rootDir, root, "根目录锁死了,得交给表单预填,否则只能靠用户记");

  // **补做期间不许开后门。** 这一刻库里已经装着真实的项目和任务:`authGate` 曾经在
  // 「multi 却没人能登录」时 `setActor(SINGLE_ACTOR)` + `next()` 放行**全部路径**,
  // 于是未登录访客拿到实例管理员的全部读写权(第 1 轮审查 P0:实测 `GET /api/tasks`
  // 200 回出别人的任务)。出路只有免登录名单那两条 + SPA 壳,别的一律 401。
  const canary = await call("/api/canary", "GET", null);
  assert.equal(canary.status, 401, `锁死状态下的数据端点必须挡住:${JSON.stringify(canary.body)}`);
  assert.equal(canary.body.needsAuth, true, "401 要带 needsAuth,前端据它决定去登录页还是向导");
  assert.equal(canary.body.secret, undefined, "一个字节的业务数据都不许漏出去");
  const canaryWrite = await call("/api/canary", "POST", null, { x: 1 });
  assert.equal(canaryWrite.status, 401, `写端点同在闸内 —— 放行是在资源闸之前发生的:${JSON.stringify(canaryWrite.body)}`);
  // 壳照常开(向导页要渲染):这里没挂静态资源,所以它落到 404 —— 只要不是 401 就说明闸放了行。
  const shell = await app.fetch(new Request("http://127.0.0.1:4317/setup"));
  assert.notEqual(shell.status, 401, "SPA 壳必须打得开,否则向导本身都进不去");

  // 补做中也不能倒回自用(§二),而且要说人话,不能抛个 500。
  const backWhileBroken = await call("/api/auth/setup", "POST", null, { mode: "single" });
  assert.equal(backWhileBroken.status, 409, JSON.stringify(backWhileBroken.body));
  assert.match(String(backWhileBroken.body.error), /只能把管理员补建出来/);

  const resumed = await call("/api/auth/setup", "POST", null, {
    mode: "multi", adminName: "Admin", rootDir: root, dirName: "admin",
  });
  assert.equal(resumed.status, 200, `补做必须放行,不能回「已经是多人模式了」:${JSON.stringify(resumed.body)}`);
  assert.ok(String(resumed.body.key ?? "").length > 0);
  assert.equal(await store.countUsers(), 1, "补做要认领那半个管理员,不是再插一行");
  assert.equal((await db.select().from(users)).at(0)!.id, admin.id, "认领的必须是原来那一行(存量数据都记在它名下)");

  mode.invalidateInstanceConfig();
  assert.equal(await mode.needsSetup(), false);
  // 补完之后这条门重新关上:再来一次就是普通的「已经是多人模式了」。
  const again = await call("/api/auth/setup", "POST", String(resumed.body.key), { mode: "multi", adminName: "X", rootDir: root, dirName: "x" });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.match(String(again.body.error), /已经是多人模式了/);
}

const adminRow = (await db.select().from(users)).at(0)!;
const adminKey = await store.resetUserKey(adminRow.id);

// ── ③ 建用户:目录建不出来 → 姓名和目录名都不许被占死 ──────────────────────
{
  writeFileSync(join(root, "bob"), "占位");
  const failed = await call("/api/users", "POST", adminKey, { name: "Bob", dirName: "bob" });
  assert.equal(failed.status, 409, `路径被占该当场拒绝:${JSON.stringify(failed.body)}`);
  assert.equal(await store.nameTaken("Bob"), false, "建失败不该把姓名占死");
  assert.equal(await store.dirNameTaken("bob"), false, "也不该把目录名占死");

  const { rmSync } = await import("node:fs");
  rmSync(join(root, "bob"));
  // 原样重试:管理员不必先去删一个看不见的残行。
  const ok = await call("/api/users", "POST", adminKey, { name: "Bob", dirName: "bob" });
  assert.equal(ok.status, 201, `腾开路径后原样重试就该成:${JSON.stringify(ok.body)}`);
  assert.ok(String(ok.body.inviteUrl ?? "").startsWith("/claim/"), "建成了就该有邀请链接");
}

// ── ④ 自带起手式的覆写按人取,不是按第一行取 ────────────────────────────────
{
  const ts = now();
  const bob = (await db.select().from(users)).find((u) => u.name === "Bob")!;
  // 两个人各改了同一条自带起手式。故意让**别人**那行排在前面(按 id 升序插入)。
  await db.insert(workflows).values([
    { id: "aaa-row", builtinKey: "standard", ownerUserId: adminRow.id, name: "A 标准", description: "", def: "{}", disabled: false, createdAt: ts, updatedAt: ts },
    { id: "zzz-row", builtinKey: "standard", ownerUserId: bob.id, name: "Z 标准", description: "", def: "{}", disabled: true, createdAt: ts, updatedAt: ts },
  ] as never);

  const detail = await findWorkflow("standard", bob.id);
  assert.equal(detail!.name, "Z 标准", "详情要给我自己的那份覆写,不是排在前面的别人那份");
  assert.equal(detail!.modified, true);
  assert.equal(detail!.disabled, true, "停用状态也得是我的");

  // 列表与详情对同一个人必须口径一致 —— 报告里它们是矛盾的。
  const fromList = (await listWorkflows(bob.id)).find((w) => w.id === "standard")!;
  assert.equal(fromList.name, detail!.name, "列表和详情不能对同一个人给出两种答案");
  assert.equal(fromList.disabled, detail!.disabled);

  // 另一个人看到的仍是他自己那份。
  assert.equal((await findWorkflow("standard", adminRow.id))!.name, "A 标准");
  // 谁的行都不是 → 出厂那份(自带条目永远在)。
  assert.equal((await findWorkflow("standard", id()))!.modified, false);
}

// ── ⑤ 专属邀请链接:没领到 key 之前,谁也不许把它作废 ───────────────────────
// 三步是「说明 → 领取生成 key → 点『我已保存』作废」,而作废那一步原来只要 token 存在
// 就 consume。于是任何拿到链接的人(或者前端一次误调)都能把它烧掉:用户仍是 invited、
// 仍然没有 key,链接却已经作废 —— 正是 §五 要避免的那条「未保存就锁死」(第 2 轮审查 P2)。
{
  const created = await call("/api/users", "POST", adminKey, { name: "Carol", dirName: "carol" });
  assert.equal(created.status, 201, `建 Carol 该成:${JSON.stringify(created.body)}`);
  const token = String(created.body.inviteUrl ?? "").slice("/claim/".length);
  const carolId = (created.body.user as { id: string }).id;
  assert.ok(token, "建完就该有邀请链接");

  // 直接 confirm(拿到链接的任何人都发得出这一下):必须被拒。
  const early = await call(`/api/auth/claim/${token}/confirm`, "POST", null);
  assert.equal(early.status, 409, `没领过 key 就 confirm 必须拒:${JSON.stringify(early.body)}`);
  // 只看状态码不够:一个「409 但已经 consume 了」的实现照样过。
  const stillOpen = await call(`/api/auth/claim/${token}`, "GET", null);
  assert.equal(stillOpen.body.invalid, undefined, `被拒的 confirm 不许把链接烧掉:${JSON.stringify(stillOpen.body)}`);
  const before = await store.getUser(carolId);
  assert.equal(!!before?.keyHash, false, "更不许在一个 key 都没发出去的情况下走完流程");

  // 换成**别人**的会话也不行:凭据必须是这条邀请的本人。
  const adminLogin = await call("/api/auth/login", "POST", null, { key: adminKey });
  assert.equal(adminLogin.status, 200, `管理员登录该成:${JSON.stringify(adminLogin.body)}`);
  assert.ok(adminLogin.cookie, "登录要发会话 cookie");
  const wrongSession = await call(
    `/api/auth/claim/${token}/confirm`, "POST", null, undefined, { cookie: adminLogin.cookie! },
  );
  assert.equal(wrongSession.status, 409, `别人的会话不能替 Carol 作废:${JSON.stringify(wrongSession.body)}`);
  assert.equal((await call(`/api/auth/claim/${token}`, "GET", null)).body.invalid, undefined, "同样不许烧掉");

  // 正常三步:领取拿到 key 和会话 → 再 confirm 才作废。
  const claimed = await call(`/api/auth/claim/${token}`, "POST", null);
  assert.equal(claimed.status, 200, `领取该成:${JSON.stringify(claimed.body)}`);
  assert.ok(String(claimed.body.key ?? "").length > 8, "领取要吐出 key");
  assert.ok(claimed.cookie, "领取那一步必须发会话 cookie —— confirm 的凭据就是它");
  assert.equal(
    (await call(`/api/auth/claim/${token}`, "GET", null)).body.invalid, undefined,
    "领取本身不作废链接(手滑点开就锁死是 §五 明确要避免的)",
  );

  const done = await call(`/api/auth/claim/${token}/confirm`, "POST", null, undefined, { cookie: claimed.cookie! });
  assert.equal(done.status, 200, `领过之后 confirm 该成:${JSON.stringify(done.body)}`);
  assert.ok((await store.getUser(carolId))?.keyHash, "走完流程的人手上必须有 key");
  assert.equal(
    (await call(`/api/auth/claim/${token}`, "GET", null)).body.invalid, "这条邀请链接已经被领取过了",
    "点过「我已保存」之后链接才作废",
  );

  // 双击 / 刷新不该在一条本来走通了的流程末尾报假错。
  const again = await call(`/api/auth/claim/${token}/confirm`, "POST", null, undefined, { cookie: claimed.cookie! });
  assert.equal(again.status, 200, `重复 confirm 要幂等:${JSON.stringify(again.body)}`);
}

// ── ⑥ 「最后一个管理员」按**登录得进来**算;重置 key 不兼职恢复用户 ─────────
// 上面 ② 验的是「实例已经锁死了要能救回来」,这一组验的是**别把它锁死**:两处问的都是
// 「还有人进得来吗」,判据也就必须是同一份(store.ts `canSignIn`)。
// 原来的 `activeAdminCount` 只排除 suspended,于是一个刚建出来、key 还没领的管理员也
// 算「可用」,顶住了最后管理员保护 —— 唯一那个真管理员因此能把自己降成成员,实例落进
// 「有人能登录,却没人管得了用户和实例设置」,只剩宿主机逃生门(第 3 轮审查 P1)。
{
  const bob = (await db.select().from(users)).find((u) => u.name === "Bob")!;
  assert.equal(bob.keyHash, null, "Bob 该还是那个建出来、key 一次没领过的账号");

  // 把 Bob 升成管理员:名单上从此有两个管理员,但他一次也登录不进来。
  assert.equal((await call(`/api/users/${bob.id}`, "PATCH", adminKey, { role: "admin" })).status, 200);
  assert.equal((await store.getUser(bob.id))!.keyHash, null, "升管理员不该顺手给他发 key");

  // 报告里的那一发:唯一能登录的管理员把自己降成成员。
  const demote = await call(`/api/users/${adminRow.id}`, "PATCH", adminKey, { role: "member" });
  assert.equal(demote.status, 409, `降掉最后一个能登录的管理员必须拒:${JSON.stringify(demote.body)}`);
  assert.match(String(demote.body.error), /能登录进来的管理员/);
  // 只看状态码不够:一个「409 但角色已经写下去了」的实现照样过。
  assert.equal((await store.getUser(adminRow.id))!.role, "admin", "被拒的降级不许落库");
  assert.equal(await store.loginableAdminCount(), 1, "任何时候都得留着一个登录得进来的管理员");

  // 反过来也得让开:这条不是「永远不许降级」。Bob 一领 key 就该放行。
  const bobKey = await store.resetUserKey(bob.id);
  const allowed = await call(`/api/users/${adminRow.id}`, "PATCH", adminKey, { role: "member" });
  assert.equal(allowed.status, 200, `另一个管理员真能登录时降级要放行:${JSON.stringify(allowed.body)}`);
  assert.equal(
    (await call(`/api/users/${adminRow.id}`, "PATCH", bobKey, { role: "admin" })).status, 200,
    "复原:后面几步还要用 adminKey 干管理员的活",
  );

  // 判据的另一半:被停用的管理员同样顶不上这个位置。
  assert.equal(
    (await call(`/api/users/${bob.id}/suspend`, "POST", adminKey)).status, 200,
    "还有别的管理员能登录时,停用一个管理员要成",
  );
  const demoteAgain = await call(`/api/users/${adminRow.id}`, "PATCH", adminKey, { role: "member" });
  assert.equal(demoteAgain.status, 409, `另一个管理员被停用了,同样不能降:${JSON.stringify(demoteAgain.body)}`);

  // 「重置 key」不是「恢复用户」:对停用账号必须拒,而且库里一个字都不许动
  // —— revokeUserKey 原来无条件写 invited,等于顺手把人放了出来(第 3 轮审查 P2)。
  const invitesOf = async (userId: string) =>
    (await db.select().from(userInvites)).filter((r) => r.userId === userId).length;
  const before = { row: (await store.getUser(bob.id))!, invites: await invitesOf(bob.id) };
  assert.equal(before.row.status, "suspended");
  const reset = await call(`/api/users/${bob.id}/reset-key`, "POST", adminKey);
  assert.equal(reset.status, 409, `对停用账号重置 key 必须拒:${JSON.stringify(reset.body)}`);
  const after = (await store.getUser(bob.id))!;
  assert.equal(after.status, "suspended", "被拒的重置不许把人从停用里放出来");
  assert.equal(after.keyHash, before.row.keyHash, "更不许顺手把他手上那把 key 抹掉");
  assert.equal(await invitesOf(bob.id), before.invites, "也不许留下一条能把他领回来的新链接");

  // 正常那条路照旧:先恢复,再重置。
  assert.equal((await call(`/api/users/${bob.id}/resume`, "POST", adminKey)).status, 200);
  const reset2 = await call(`/api/users/${bob.id}/reset-key`, "POST", adminKey);
  assert.equal(reset2.status, 200, `恢复之后重置 key 要成:${JSON.stringify(reset2.body)}`);
  assert.ok(String(reset2.body.inviteUrl ?? "").startsWith("/claim/"), "重置得给出重领链接");
  const done = (await store.getUser(bob.id))!;
  assert.equal(done.keyHash, null, "重置就该把旧 key 抹掉");
  assert.equal(done.status, "invited", "没被停用的人重置后退回 invited,等他重领");
}

await releaseTmpDb();
console.log("test-multi-user-setup ok");
