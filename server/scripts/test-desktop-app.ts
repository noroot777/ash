// mac 版 Navi.app 放开「其他设备访问」之后（`NAVI_DESKTOP_APP=1`、不带 `NAVI_LOCAL_ONLY`）：
//   ① 实例模式仍固定自用：转多人 403、被拒的转换不落库；`auth/state` 报 desktopApp、不报 localOnly；
//   ② 远程访问回到普通自用实例的样子：本机看得到远程访问页和访问密钥；转进来的请求拿访问密钥认成机主，
//      不带凭证 401（不是本机模式那句拒绝）；
//   ③ 卡片深链：任务链接在按钮和整行可点的项上都带一条 `navi://` 的 pc_url，手机走的 default_url 不变；
//      深链地址的说明（只听本机 / 回环地址）按开关组合给出。
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
const { renderCard } = await import("../src/im/feishu/cards.js");

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
  assert.equal(desktopAppLink(link), "navi://open?project=p_1&task=dZL_L1D4ZCAb");
  assert.equal(desktopAppLink(link, false), null, "不是 app 起的服务不给 navi://");
  assert.equal(desktopAppLink("http://x:4317/?task=t1"), null, "没有项目的不是任务链接");
  assert.equal(desktopAppLink("http://x:4317/?project=p&task=a%22b"), null, "认不出的 id 不拼进 navi://");
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
    assert.deepEqual(behavior, { type: "open_url", default_url: link, pc_url: "navi://open?project=p_1&task=dZL_L1D4ZCAb" });
  }

  const tail = "http://mbp.tail97f3a6.ts.net:4317";
  assert.match(deepLinkWarning(tail, { localOnly: true, desktopApp: true }) ?? "", /允许其他设备访问/);
  assert.match(deepLinkWarning(tail, { localOnly: true, desktopApp: false }) ?? "", /NAVI_LOCAL_ONLY/);
  assert.equal(deepLinkWarning(tail, { localOnly: false, desktopApp: true }), null, "放开之后这条地址没问题");
  assert.match(deepLinkWarning("http://127.0.0.1:4317", { localOnly: false, desktopApp: false }) ?? "", /只有这台电脑打得开/);
  assert.match(deepLinkWarning("http://localhost:4317", { localOnly: true, desktopApp: true }) ?? "", /只有这台电脑打得开/);
  assert.equal(deepLinkWarning(null, { localOnly: true, desktopApp: true }), null);
} finally {
  direct.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
console.log("test-desktop-app ok");
