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
//      同一个策略只扫一次。
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
const { relinkStoredCards } = await import("../src/im/relink.js");
const { readMeta } = await import("../src/im/meta.js");
const { db } = await import("../src/db/index.js");
const { imOutbox } = await import("../src/db/schema-im.js");
const { createHash } = await import("node:crypto");
const { eq } = await import("drizzle-orm");

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
  assert.equal(await readMeta("link_policy"), "2:http");
  await db.update(imOutbox).set({ content: stale(navi) }).where(eq(imOutbox.id, "current"));
  assert.equal(await relinkStoredCards(undefined, at), 0, "同一个策略只扫一次");
  assert.equal(await relinkStoredCards("2:navi:AB12-CD34", at), 1, "策略一换就再扫");
} finally {
  direct.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
console.log("test-desktop-app ok");
