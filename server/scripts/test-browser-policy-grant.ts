// 项目级浏览器登录态授权(projects.browser_cdp_domains)。
//
// 这颗开关的**全部意义**是让无人值守任务跑得起来：用户要的是「不必每次点名就能用我自己
// 的浏览器」。所以这里钉的不是「文案里有没有那几个词」，而是四件会让它退回原样的事：
//   1. 默认必须是拒绝 —— 新项目、老库升级、项目查不到，三条路都不许意外放行;
//   2. 授权**真的**改变注入文本,而且 full(新任务)和 reminder(续跑)两级都改;
//   3. 清空名单能收回授权 —— 撤销没有表达方式的话,用户只能靠删项目;
//   4. 每个注入点都**真的**把授权传进去了 —— 上一轮的教训正是「配置做了、prompt 没读」,
//      只测纯函数的话,少接一处线照样全绿。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createClient } from "../src/db/node-sqlite-client.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-browser-grant-"));
const dbFile = join(root, "ash.db");
process.env.ASH_DB = dbFile;
process.env.ASH_RUNS_DIR = join(root, "runs");

// 升级路径:摆一个**没有** browser_cdp_domains 这一列的老库,补列之后存量项目必须是
// 「不授权」。一个安全开关在升级当天意外变成开着,比它根本不存在更糟。
const legacy = createClient({ url: dbFile });
await legacy.executeMultiple(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
    accept_commit INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
  INSERT INTO projects VALUES ('legacy', '升级前就在的项目', '${join(root, "repo")}', 1, '2026-09-01T00:00:00.000Z');
`);
legacy.close();

const { ensureSchema, db } = await import("../src/db/index.js");
await ensureSchema();
const { projects } = await import("../src/db/schema.js");
const {
  browserGrantOf, withGlobalBrowserPolicy, browserVerificationPolicy, BROWSER_VERIFICATION_POLICY,
} = await import("../src/browser-verification-policy.js");
const { normalizeBrowserCdpDomains, browserCdpHostOf, browserCdpDomainAllowed } = await import("@ash/shared/project");

// ── 1. 归一化:宽进严出 ──────────────────────────────────────────────────────
assert.deepEqual(normalizeBrowserCdpDomains(["https://X.com/home?a=1", " api.x.com:8443 ", "x.com"]),
  ["x.com", "api.x.com"], "协议/路径/端口/大小写都要剥掉,且去重");
assert.deepEqual(normalizeBrowserCdpDomains("x.com, twitter.com、weibo.com"),
  ["x.com", "twitter.com", "weibo.com"], "一行文本按常见分隔符拆开(含中文顿号/逗号)");
assert.deepEqual(normalizeBrowserCdpDomains(["localhost", "", "...", "a b.com", 42, null]), [],
  "认不出形状的整条丢掉 —— 一条脏数据混进去就可能把别的站点带成已授权");
assert.deepEqual(normalizeBrowserCdpDomains(["10.0.0.1", "192.168.1.1:8080"]), [],
  "纯 IP 不收:登录态场景没有意义,却是最容易误放行的形状");
// 自己按顺序剥 @ / ? / # 会把查询串里的邮箱当成 URL 的用户信息,于是「我授权 x.com」
// 变成「我授权 weibo.com」。这类错误没有声音,必须由标准 URL 解析来挡(第 2 轮审查 P2)。
for (const tricky of [
  "https://x.com?contact=user@weibo.com",
  "https://x.com#@weibo.com",
  "https://x.com/?contact=user@weibo.com",
  "https://x.com:443/path?a=b@evil.net#frag",
  "X.COM?q=@evil.net",
]) {
  assert.deepEqual(normalizeBrowserCdpDomains([tricky]), ["x.com"],
    `URL 的真实 host 必须是 x.com,不能被查询串/锚点里的 @ 带偏：${tricky}`);
}
assert.equal(browserCdpHostOf("https://x.com?contact=user@weibo.com"), "x.com", "单条解析同样走 URL 语义");
assert.equal(browserCdpHostOf("localhost"), null, "单段主机名不收");
assert.equal(normalizeBrowserCdpDomains(Array.from({ length: 50 }, (_, i) => `h${i}.com`)).length, 20,
  "上限 20,防止一行文本粘成一份通行证");
assert.deepEqual(normalizeBrowserCdpDomains(undefined), [], "空输入 = 不授权");

// ── 2. 子域匹配:连带子域,但不连带「长得像」的邻居 ───────────────────────────
assert.ok(browserCdpDomainAllowed("api.x.com", ["x.com"]), "子域在授权内");
assert.ok(browserCdpDomainAllowed("X.com.", ["x.com"]), "大小写与根域点不影响判定");
assert.ok(!browserCdpDomainAllowed("notx.com", ["x.com"]), "后缀像但不是子域 —— 必须挡住");
assert.ok(!browserCdpDomainAllowed("x.com.evil.net", ["x.com"]), "把授权域塞进左边不算授权");

// ── 3. 默认拒绝:三条「拿不到授权」的路都要落到未授权文本 ─────────────────────
const legacyRow = (await db.select().from(projects).where(eq(projects.id, "legacy"))).at(0);
assert.ok(legacyRow, "升级后老项目还在");
assert.equal(browserGrantOf(legacyRow), null, "老库补列后必须是未授权");
assert.equal(browserGrantOf(null), null, "项目查不到 = 未授权(不是放行)");
assert.equal(browserGrantOf({ browserCdpDomains: [] }), null, "空名单归一成 null,未授权只有一种形状");

const ungranted = withGlobalBrowserPolicy("正文", "full");
assert.match(ungranted, /没有这种授权就停下来说明/, "未授权态要求停下来问");
assert.doesNotMatch(ungranted, /已由用户预先授权/, "未授权态不得出现授权措辞");
assert.equal(BROWSER_VERIFICATION_POLICY, browserVerificationPolicy(null),
  "历史常量必须等于未授权态 —— 审查/验证 prompt 直接拼它");

// ── 4. 授权态:full 与 reminder 两级都要改变,且带上具体域名 ───────────────────
const grant = browserGrantOf({ browserCdpDomains: ["x.com", "weibo.com"] });
assert.ok(grant, "非空名单要构造出授权");
for (const [level, text] of [
  ["full", withGlobalBrowserPolicy("新任务正文", "full", grant)],
  ["reminder", withGlobalBrowserPolicy("续聊", "reminder", grant)],
] as const) {
  assert.match(text, /x\.com/, `${level}:要写明授权了哪些站点,否则 agent 只能猜`);
  assert.match(text, /weibo\.com/, `${level}:名单要完整`);
  assert.doesNotMatch(text, /未经用户在本任务显式授权不得自行连 CDP/,
    `${level}:已授权就不该再要求逐任务点名 —— 那正是这颗开关要消灭的东西`);
  assert.match(text, /名单外|名单之外/, `${level}:范围之外仍要停下来问`);
  assert.match(text, /禁止 attach|attach 已有标签/, `${level}:授权不等于放开接管已有标签`);
  assert.match(text, /写操作/, `${level}:授权只读,写操作始终禁止`);
}

// ── 5. 撤销 + 持久化:走真实 HTTP 路由 ───────────────────────────────────────
const { mountProjectRoutes } = await import("../src/project-routes.js");
const api = new Hono();
mountProjectRoutes(api);
const patch = async (body: unknown) => {
  const res = await api.request("/projects/legacy", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `PATCH 应成功: ${await res.clone().text()}`);
  return (await res.json()) as { browserCdpDomains: string[] };
};
assert.deepEqual((await patch({ browserCdpDomains: "https://x.com/i/flow, API.X.COM" })).browserCdpDomains,
  ["x.com", "api.x.com"], "写侧也走同一套归一化");
const reread = (await db.select().from(projects).where(eq(projects.id, "legacy"))).at(0)!;
assert.deepEqual(browserGrantOf(reread)?.domains, ["x.com", "api.x.com"], "授权必须落库,重启后还在");
assert.match(withGlobalBrowserPolicy("x", "full", browserGrantOf(reread)), /x\.com/, "落库的授权能喂回 prompt");
assert.deepEqual((await patch({ browserCdpDomains: [] })).browserCdpDomains, [], "空数组 = 收回授权");
assert.equal(browserGrantOf((await db.select().from(projects).where(eq(projects.id, "legacy"))).at(0)), null,
  "撤销之后必须回到未授权 —— 否则用户只能靠删项目来收权");

// ── 6. 撤销要对**正在跑的任务**即时生效 ─────────────────────────────────────
// 回合启动时捕获一份 grant 快照、后续插话继续用它,等于「撤销对活动任务无效」:用户清空
// 名单、点了收回,再对同一个任务说「继续下一页」,它照样拿着旧授权(第 2 轮审查 P1)。
const { browserGrantForProject, browserGrantForTask } = await import("../src/browser-verification-policy.js");
await patch({ browserCdpDomains: ["x.com"] });
assert.deepEqual((await browserGrantForProject("legacy"))?.domains, ["x.com"], "现读拿得到刚存的授权");
await patch({ browserCdpDomains: [] });
assert.equal(await browserGrantForProject("legacy"), null, "撤销后**现读**必须立刻变成未授权");
assert.equal(await browserGrantForProject(null), null, "没有项目 = 未授权");
assert.equal(await browserGrantForTask("不存在的任务"), null, "查不到任务一律按未授权");

// ── 7. 注入点真的接了线 ────────────────────────────────────────────────────
// 上一轮就是栽在这:纯函数做对了,prompt 侧一处没接,整条功能等于不存在。
for (const [label, rel, expected] of [
  ["普通任务 fresh run + 插话", "../src/task-run.ts", 2],
  // 2 而不是 3:planning 分支原本自己调一次,第 3 轮审查后与普通分支合并成同一个调用
  // (正文先拼好、策略统一在起跑前贴),少一个调用点就少一处会漏贴的地方。
  ["续聊/召唤/计划回合", "../src/orchestrator.ts", 2],
  ["团队调度台开台", "../src/team/session.ts", 1],
  ["重启接管续跑", "../src/reattach.ts", 1],
  // 下面两条是第 2 轮审查补上的:duet 每轮都拿不到授权,团队常驻投递则在开台说了
  // 「已授权」之后又注入默认拒绝 —— 一对自相矛盾的指令比一致地不授权更糟。
  ["duet 每一轮发言", "../src/duet/turn.ts", 1],
  ["团队常驻消息投递", "../src/team/session-consumer.ts", 1],
] as const) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  const calls = [...src.matchAll(/withGlobalBrowserPolicy\(/g)];
  assert.equal(calls.length, expected, `${label}: 调用点数量变了,接线断言要同步更新`);
  for (const m of calls) {
    // 固定长度的窗口会被长参数体骗过去(orchestrator 那个调用正文就有几百字),
    // 所以按括号配平取出**完整**的实参列表再看。
    assert.match(callArgs(src, m.index!), /browserGrant/,
      `${label}: 有一处 withGlobalBrowserPolicy 没把项目授权传进去`);
  }
}

/** 从 `withGlobalBrowserPolicy` 这个词的位置起,按括号配平取出完整实参文本。 */
function callArgs(src: string, at: number): string {
  const from = src.indexOf("(", at);
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(from, i + 1);
  }
  return src.slice(from);
}

// 每一个 nativeSteer.prepare(= 用户插话的投递口)都必须**现读**。写成捕获上面那份
// browserGrant 快照的样子,单测照样全绿,但撤销对活动任务就是无效的。
for (const [label, rel] of [
  ["普通任务插话", "../src/task-run.ts"],
  ["续聊插话", "../src/orchestrator.ts"],
  ["重启接管插话", "../src/reattach.ts"],
] as const) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  const at = src.indexOf("prepare:");
  assert.ok(at > 0, `${label}: 没找到 nativeSteer.prepare`);
  const body = callArgs(src, src.indexOf("withGlobalBrowserPolicy", at));
  assert.match(body, /await browserGrantForProject\(/,
    `${label}: prepare 必须在投递时现读授权,不能用回合启动时捕获的快照`);
}

rmSync(root, { recursive: true, force: true });
releaseTmpDb();
console.log("browser policy grant tests passed");

