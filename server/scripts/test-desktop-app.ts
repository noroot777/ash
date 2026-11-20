// mac 版 Navi.app 放开「其他设备访问」之后（`NAVI_DESKTOP_APP=1`、不带 `NAVI_LOCAL_ONLY`）：
//   ① 实例模式仍固定自用：转多人 403、被拒的转换不落库；`auth/state` 报 desktopApp、不报 localOnly；
//   ② 远程访问回到普通自用实例的样子：本机看得到远程访问页和访问密钥；转进来的请求拿访问密钥认成机主，
//      不带凭证 401（不是本机模式那句拒绝）；
//   ③ 卡片深链：放开了网络（http 在每台电脑上都打得开）就不给 pc_url，按钮和整行可点的项都只有 default_url；
//      只听本机时才给 navi://，而且带着这份 Navi 的指纹和原来那条 http 地址（收到的 app 据此认是不是冲着
//      自己来的、对不上退回 http），认不出的 id 不拼；深链地址的说明（只听本机 / 回环地址）按开关组合给出；
//   ④ 换了链接策略（只听本机 ⇄ 放开网络、旧格式没带来源）之后，库里存着的卡不分种类按新策略重写：
//      还在等人的决策卡渲染指纹对不上（上一版算的指纹也对不上），对账会整张重渲染；已收尾的、只推标题那版、
//      还没发的、旧格式裸 navi:// 都被换掉，14 天内发出的排上改卡；超过 14 天的、已撤回的、发不出去的不动；
//      同一个策略只扫一次；
//   ⑤ 「库里改好了」不等于「飞书上改好了」：发出去的卡重写后逐张记着欠账（link_due），额度降级挡住只往后挪、
//      额度回来了接着改，改到了才销账；改卡放弃了（failed / skipped）下次起通道重新排上；过了 14 天销账不再改。
//      结果卡随回执带回去、没等到确认就退出了（acking）的，起通道时照约定当 result 当场补改；起通道放回队列之后，
//      每一种改卡状态都落在队列当场挑得到的样子（或销账），不许造出永远挑不到的行。
//      走真实的发件队列与额度判据，只把飞书 HTTP 换成计数的假响应。
//
// 本机模式（两个都带）那一侧由 test:local-only-auth 钉着。走真实 TCP：判据里「回环 socket + Host +
// 转发头」只有真连接测得出来。
//
// 跑法: npm -w server run test:desktop-app
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { Agent, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "navi-desktop-app-"));
process.env.NAVI_DB ||= join(stage, "desktop-app.db");
// local-only.js 在模块加载时读开关，所以得在 import 任何 server 模块之前设好。
process.env.NAVI_DESKTOP_APP = "1";
delete process.env.NAVI_LOCAL_ONLY;
requireTmpDb("test-desktop-app");

const { ensureSchema } = await import("../src/db/index.js");
const { Hono } = await import("hono");
const { serve } = await import("@hono/node-server");
const mode = await import("../src/auth/mode.js");
const { authGate } = await import("../src/auth/middleware.js");
const { mountAuthRoutes } = await import("../src/auth/routes.js");
const { ensureRemoteAccessKey } = await import("../src/auth/remote-access.js");
const { DESKTOP_APP, LOCAL_ONLY, SINGLE_ONLY } = await import("../src/local-only.js");
const { deepLinkWarning, desktopAppLink } = await import("../src/im/app-link.js");
const { renderCard, relinkCard } = await import("../src/im/feishu/cards.js");
const { linkPolicy } = await import("../src/im/app-link.js");
const { renderKeyOf } = await import("../src/im/reconcile.js");
const { relinkStoredCards, requeued } = await import("../src/im/relink.js");
const { PATCHING } = await import("../src/im/outbox.js");
const { readMeta } = await import("../src/im/meta.js");
const { db } = await import("../src/db/index.js");
const { imOutbox } = await import("../src/db/schema-im.js");
const { createHash } = await import("node:crypto");
const { eq } = await import("drizzle-orm");
const { Reconciler } = await import("../src/im/reconcile.js");
const { FeishuApi } = await import("../src/im/feishu/api.js");
const { purposeAllowed } = await import("../src/im/quota.js");

await ensureSchema();
assert.deepEqual({ DESKTOP_APP, LOCAL_ONLY, SINGLE_ONLY }, { DESKTOP_APP: true, LOCAL_ONLY: false, SINGLE_ONLY: true }, "前提:开关读到了");
assert.equal(process.env.NAVI_DESKTOP_APP, undefined, "读完就从环境里拿掉,agent 继承不到");
await mode.setInstanceMode("single", "");
const key = ensureRemoteAccessKey();

const api = new Hono();
mountAuthRoutes(api);
api.get("/canary", (c) => c.json({ secret: "任务标题" }));
const app = new Hono();
app.use("*", authGate());
app.route("/api", api);

const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
const port = (server.address() as { port: number }).port;
const direct = new Agent();

type Res = { status: number; body: Record<string, unknown>; text: string };
function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port, path, method: opts.method ?? "GET", agent: direct,
      headers: {
        ...(payload === null ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
        ...opts.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* 纯文本应答 */ }
        resolve({ status: res.statusCode ?? 0, body, text });
      });
    });
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

try {
  // ① 模式固定自用
  const local = await call("/api/auth/state");
  assert.equal(local.body.localOnly, false);
  assert.equal(local.body.desktopApp, true);
  const multi = await call("/api/auth/setup", { method: "POST", body: { mode: "multi", adminName: "x", rootDir: join(stage, "root") } });
  assert.equal(multi.status, 403, `转多人:${multi.text}`);
  assert.match(String(multi.body.error), /Navi\.app 的个人自用版/, "放开网络之后拒绝转多人不该再说「只接受本机直连」");
  mode.invalidateInstanceConfig();
  assert.equal((await mode.instanceConfig()).mode, "single", "被拒的转换不许落任何东西");

  // ② 远程访问可用
  const view = await call("/api/remote-access");
  assert.equal(view.status, 200, `本机看远程访问:${view.text}`);
  assert.equal(view.body.key, key, "本机拿得到访问密钥");
  const relayed = { "x-forwarded-for": "100.92.165.9", host: "mbp.tail97f3a6.ts.net:4317" };
  const none = await call("/api/canary", { headers: relayed });
  assert.equal(none.status, 401);
  assert.doesNotMatch(String(none.body.error), /只接受本机直连/, "不是本机模式了,别再这么说");
  const withKey = await call("/api/canary", { headers: { ...relayed, authorization: `Bearer ${key}` } });
  assert.equal(withKey.status, 200, `转进来带访问密钥:${withKey.text}`);

  // ③ 卡片深链
  const link = "http://mbp.tail97f3a6.ts.net:4317/?project=p_1&task=dZL_L1D4ZCAb";
  const closed = { localOnly: true, desktopApp: true };
  const tag = () => "AB12-CD34";
  const app = desktopAppLink(link, closed, tag);
  assert.ok(app, "只听本机的 app 服务给 navi://");
  const parsed = new URL(app);
  assert.equal(parsed.protocol, "navi:");
  assert.equal(parsed.host, "open");
  assert.deepEqual(Object.fromEntries(parsed.searchParams),
    { project: "p_1", task: "dZL_L1D4ZCAb", instance: "AB12-CD34", fallback: link }, "带着来源：指纹和原来那条 http 地址");
  const other = new URL(desktopAppLink("http://another-mac.tailnet.ts.net:4317/?project=p_1&task=dZL_L1D4ZCAb", closed, tag)!);
  assert.notEqual(other.searchParams.get("fallback"), parsed.searchParams.get("fallback"), "两个来源不会变成同一条链接");
  assert.equal(desktopAppLink(link), null, "这份服务放开了网络：http 每台电脑都打得开，不给 navi://");
  assert.equal(desktopAppLink(link, { localOnly: true, desktopApp: false }, tag), null, "不是 app 起的服务不给 navi://");
  assert.equal(desktopAppLink("http://x:4317/?task=t1", closed, tag), null, "没有项目的不是任务链接");
  assert.equal(desktopAppLink("http://x:4317/?project=p&task=a%22b", closed, tag), null, "认不出的 id 不拼进 navi://");
  const card = JSON.stringify(renderCard({
    title: "t", tone: "green",
    blocks: [
      { type: "buttons", buttons: [{ text: "在 Navi 中打开", url: link }] },
      { type: "links", items: [{ text: "任务", url: link }] },
    ],
  }));
  const behaviors = [...card.matchAll(/"behaviors":\[(\{[^\]]*\})\]/g)].map((m) => JSON.parse(m[1]!) as Record<string, string>);
  assert.equal(behaviors.length, 2);
  for (const behavior of behaviors) {
    assert.deepEqual(behavior, { type: "open_url", default_url: link }, "放开了网络的服务：桌面端也走 http");
  }

  const tail = "http://mbp.tail97f3a6.ts.net:4317";
  assert.match(deepLinkWarning(tail, { localOnly: true, desktopApp: true }) ?? "", /允许其他设备访问/);
  assert.match(deepLinkWarning(tail, { localOnly: true, desktopApp: false }) ?? "", /NAVI_LOCAL_ONLY/);
  assert.equal(deepLinkWarning(tail, { localOnly: false, desktopApp: true }), null, "放开之后这条地址没问题");
  assert.match(deepLinkWarning("http://127.0.0.1:4317", { localOnly: false, desktopApp: false }) ?? "", /只有这台电脑打得开/);
  assert.match(deepLinkWarning("http://localhost:4317", { localOnly: true, desktopApp: true }) ?? "", /只有这台电脑打得开/);
  assert.equal(deepLinkWarning(null, { localOnly: true, desktopApp: true }), null);

  // ④ 存着的卡按新策略重写
  assert.equal(linkPolicy(), "2:http");
  assert.equal(linkPolicy(closed, tag), "2:navi:AB12-CD34");
  assert.notEqual(linkPolicy(closed, tag), linkPolicy(closed, () => "FFFF-0000"), "换了指纹（库搬到别的机器）也算换了策略");
  const turnView = { task: { id: "t1", projectId: "p_1", title: "任务" }, projectName: "项目", turn: { kind: "failed", generation: "g1" } };
  const dest = { receiveType: "open_id" as const, receiveId: "ou_1", recipientOpenId: "ou_1" };
  const legacyKey = createHash("sha256").update(JSON.stringify(["任务", "项目", turnView.turn, "open_id", link, false])).digest("hex").slice(0, 16);
  assert.notEqual(renderKeyOf(turnView as never, dest, "http://mbp.tail97f3a6.ts.net:4317", []), legacyKey,
    "上一版算的指纹没带链接策略：对上了就会把带旧 pc_url 的决策卡当成不用改");

  const navi = desktopAppLink(link, closed, tag)!;
  const bare = "navi://open?project=p_1&task=dZL_L1D4ZCAb";
  const stale = (pc: string) => JSON.stringify({
    header: { title: { tag: "plain_text", content: "任务" } },
    body: { elements: [
      { tag: "button", behaviors: [{ type: "open_url", default_url: link, pc_url: pc }] },
      { tag: "interactive_container", behaviors: [{ type: "open_url", default_url: link, pc_url: pc }], elements: [] },
    ] },
  });
  const fresh = JSON.stringify(JSON.parse(stale(navi)), (k, v) => (k === "pc_url" ? undefined : v));
  assert.equal(relinkCard(stale(navi)), fresh, "按钮和整行可点的项都按现在的策略重出");
  assert.equal(relinkCard(fresh), fresh, "已经是现在这样的原样返回");
  assert.equal(relinkCard("{坏的"), "{坏的");

  const at = Date.now();
  const ago = (days: number) => new Date(at - days * 24 * 3600_000).toISOString();
  const base = { channel: "feishu", appId: "cli_x", receiveType: "open_id", receiveId: "ou_1", recipientOpenId: "ou_1",
    taskId: "dZL_L1D4ZCAb", subject: "g1", msgType: "interactive", createdAt: ago(1), updatedAt: ago(1) };
  const rows = {
    open: { kind: "failed", state: "sent", messageId: "om_1", sentAt: ago(1), patchState: "done", content: stale(navi) },
    resolved: { kind: "accept", state: "resolved", messageId: "om_2", sentAt: ago(2), patchState: "result", content: stale(navi) },
    briefOnly: { kind: "question", state: "resolved", messageId: "om_3", sentAt: ago(1), patchState: null, content: fresh, brief: stale(navi) },
    unsent: { kind: "notice", state: "held", messageId: null, sentAt: null, patchState: null, content: stale(navi) },
    legacy: { kind: "accept", state: "sent", messageId: "om_4", sentAt: ago(1), patchState: "failed", content: stale(bare) },
    recall: { kind: "question", state: "resolved", messageId: "om_5", sentAt: ago(1), patchState: "recall", content: stale(navi) },
    old: { kind: "accept", state: "resolved", messageId: "om_6", sentAt: ago(15), patchState: "done", content: stale(navi) },
    recalled: { kind: "question", state: "resolved", messageId: "om_7", sentAt: ago(1), patchState: "recalled", content: stale(navi) },
    dead: { kind: "notice", state: "dead", messageId: null, sentAt: null, patchState: null, content: stale(navi) },
    current: { kind: "accept", state: "sent", messageId: "om_8", sentAt: ago(1), patchState: "done", content: fresh },
  };
  for (const [id, row] of Object.entries(rows)) await db.insert(imOutbox).values({ ...base, id, subject: id, ...row });
  assert.equal(await relinkStoredCards(undefined, at), 6, "open/resolved/briefOnly/unsent/legacy/recall 六行要换");
  const read = async (id: string) => (await db.select().from(imOutbox).where(eq(imOutbox.id, id)))[0]!;
  for (const id of ["open", "resolved", "unsent", "legacy", "recall"]) {
    assert.equal((await read(id)).content, fresh, `${id}：换成现在的链接`);
  }
  assert.equal((await read("briefOnly")).brief, fresh, "只推标题时换上的那版也换");
  assert.equal((await read("open")).patchState, "pending", "发出去的排上改卡");
  assert.equal((await read("legacy")).patchState, "pending", "上次改卡失败的也重新排上");
  assert.equal((await read("resolved")).patchState, "result", "排着回写结果的不降级");
  assert.equal((await read("briefOnly")).patchState, "pending");
  assert.equal((await read("unsent")).patchState, null, "没发出去的不用改卡，发出去就是新的");
  assert.equal((await read("recall")).patchState, "recall", "排着撤回的照旧撤回，撤不回时改成这份");
  for (const id of ["old", "recalled", "dead"]) assert.equal((await read(id)).content, stale(navi), `${id}：飞书上改不了 / 没有它，不动`);
  assert.equal((await read("old")).patchState, "done");
  assert.equal((await read("current")).patchState, "done", "本来就对的不改卡");
  for (const id of ["open", "resolved", "briefOnly", "legacy", "recall"]) assert.equal((await read(id)).linkDue, "2:http", `${id}：记着飞书上还欠新链接`);
  for (const id of ["unsent", "old", "current"]) assert.equal((await read(id)).linkDue, null, `${id}：不欠（没发 / 改不了 / 本来就对）`);
  assert.equal(await readMeta("link_policy"), "2:http");
  await db.update(imOutbox).set({ content: stale(navi) }).where(eq(imOutbox.id, "current"));
  assert.equal(await relinkStoredCards(undefined, at), 0, "同一个策略只扫一次");
  assert.equal(await relinkStoredCards("2:navi:AB12-CD34", at), 1, "策略一换就再扫");

  // ⑤ 欠账要送到飞书才算完
  let level: Parameters<typeof purposeAllowed>[0] = "essential";
  let clock = Date.now();
  let patches = 0;
  const feishu = new FeishuApi({
    appId: "review", appSecret: "x", domain: "https://invalid.example",
    beforeCall: (_kind, purpose) => purposeAllowed(level, purpose),
    deps: { fetch: (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "t", expire: 7200 });
      if (init?.method === "PATCH") { patches++; return Response.json({ code: 0 }); }
      throw new Error(`没想到的调用 ${init?.method} ${url}`);
    }) as typeof fetch },
  });
  const reconciler = new Reconciler("review", feishu, { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
  const stamp = new Date(clock - 60_000).toISOString();
  const owed = { ...base, appId: "review", taskId: null, kind: "notice", state: "resolved", messageId: "om_q", sentAt: stamp,
    patchState: "done", scope: JSON.stringify({ kind: "system" }), createdAt: stamp, updatedAt: stamp };
  await db.insert(imOutbox).values({ ...owed, id: "quota", subject: "quota", content: stale(bare) });
  await relinkStoredCards(undefined, clock);
  assert.deepEqual({ linkDue: (await read("quota")).linkDue, patchState: (await read("quota")).patchState }, { linkDue: "2:http", patchState: "pending" });
  await reconciler.sender.drainNow();
  let row = await read("quota");
  assert.equal(patches, 0, "额度降级到只保底：已收尾的卡不改");
  assert.equal(row.patchState, "pending", "挡住只往后挪，不记成 skipped");
  assert.equal(row.linkDue, "2:http");
  assert.ok(row.nextAt && Date.parse(row.nextAt) > clock, "过一阵再试");
  level = "normal";
  await reconciler.sender.drainNow();
  assert.equal(patches, 0, "没到点不提前撞");
  clock = Date.parse(row.nextAt!) + 1;
  await reconciler.sender.drainNow();
  row = await read("quota");
  assert.equal(patches, 1, "额度回来了接着改");
  assert.deepEqual({ patchState: row.patchState, linkDue: row.linkDue }, { patchState: "done", linkDue: null }, "送到了才销账");

  // 额度挡住之后调高额度、重启：起通道时往后挪着的当场就试，不再干等一轮
  await db.update(imOutbox).set({ linkDue: "2:http", patchState: "pending", nextAt: new Date(clock + 30 * 60_000).toISOString() })
    .where(eq(imOutbox.id, "quota"));
  await relinkStoredCards(undefined, clock);
  assert.equal((await read("quota")).nextAt, null);
  await reconciler.sender.drainNow();
  row = await read("quota");
  assert.equal(patches, 2, "重启之后马上改");
  assert.deepEqual({ patchState: row.patchState, linkDue: row.linkDue }, { patchState: "done", linkDue: null }, "送到了才销账");

  await db.update(imOutbox).set({ linkDue: "2:http", patchState: "failed", attempts: 7 }).where(eq(imOutbox.id, "quota"));
  await db.insert(imOutbox).values({ ...owed, id: "expired", subject: "expired", content: fresh, linkDue: "2:http", patchState: "skipped",
    sentAt: new Date(clock - 15 * 24 * 3600_000).toISOString() });
  assert.equal(await relinkStoredCards(undefined, clock), 0, "策略没变：不再重写全表");
  row = await read("quota");
  assert.deepEqual({ patchState: row.patchState, attempts: row.attempts, linkDue: row.linkDue }, { patchState: "pending", attempts: 0, linkDue: "2:http" },
    "改卡放弃了的欠账，起通道时重新排上");
  assert.deepEqual({ patchState: (await read("expired")).patchState, linkDue: (await read("expired")).linkDue }, { patchState: "skipped", linkDue: null },
    "过了 14 天飞书不让改：销账，不再排");
  await reconciler.sender.drainNow();
  assert.equal(patches, 3);
  assert.equal((await read("quota")).linkDue, null);

  // 欠着链接时点了卡上的按钮、结果卡随回执带回去（acking），没等到确认就退出：起通道当场补改一次
  await db.update(imOutbox).set({ linkDue: "2:http", patchState: "acking", nextAt: new Date(clock + 6_000).toISOString() })
    .where(eq(imOutbox.id, "quota"));
  await relinkStoredCards(undefined, clock);
  row = await read("quota");
  assert.deepEqual({ patchState: row.patchState, nextAt: row.nextAt }, { patchState: "result", nextAt: null }, "没确认的回执当 result，不留空期限的 acking");
  await reconciler.sender.drainNow();
  assert.equal(patches, 4, "当场补改");
  assert.deepEqual({ patchState: (await read("quota")).patchState, linkDue: (await read("quota")).linkDue }, { patchState: "done", linkDue: null });
  for (const state of [null, "pending", "result", "recall", "acking", "done", "skipped", "failed", "recalled", "以后新加的"]) {
    const next = requeued(state);
    const after = next.patchState === undefined ? state : next.patchState;
    assert.ok(next.linkDue === null || (PATCHING.includes(String(after)) && next.nextAt === null),
      `${state}：放回队列后要么销账，要么当场挑得到（${JSON.stringify(next)}）`);
  }
  reconciler.stop();
  reconciler.sender.stop();
} finally {
  direct.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
console.log("test-desktop-app ok");
