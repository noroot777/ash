// 任务「此刻能做什么」的失效 → 重取（lib/useTaskActions.ts；服务端那一半见
// server/scripts/test-task-actions.ts）。
//
// 服务端只广播「这个任务的结论可能变了」（task.actions.stale），不推结论、不记谁在看谁，所以重取的
// 责任全在页面这一侧。这份回归盯（第 1 轮审查 F1/F3/N1）：
// ① 同一个任务挂着两个表面：共用一份 —— 开局是首读加「连上对一遍账」，不是每个表面各一套；
// ② 收到它的失效：重取一次，两个表面一起变；
// ③ 没开着的任务收到失效：一发都不取；再打开时取到的是新的那一份；
// ④ 重取那一发掉了（503）：没有第二条失效、没有重连，它自己隔一会儿再试到读到；
// ⑤ 「全部重取」：开着的都重取，没开着的不取；
// ⑥ 先取到过、后来服务端说 404（任务没了、看不见了）：手上那份作废，键不再出，也不再重试。
// 跑：npm -w web run test:task-actions-stale
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchChrome, viteCacheDir } from "./dom-stage.mjs";
import { CATCH_UP_RETRY_MS } from "../src/lib/catchUp.ts";
import { waitUntil } from "./wait-until.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const verdict = { ok: true };
let seq = 0;
const actions = (taskId, kind) => ({
  taskId, seq: ++seq, primary: { kind, ...verdict }, stop: { ok: false, reason: "没有在跑", hidden: true },
  archive: verdict, requeue: { ok: false, reason: "不在队列里", hidden: true }, retryTurn: null, verify: verdict,
});

/** 服务端这一侧：每个任务此刻的那一步、要掉几发、各收到几发 GET。 */
const store = { primary: { "t-1": "run", "t-2": "run" }, failures: 0, gone: new Set(), hits: { "t-1": 0, "t-2": 0 } };
const streams = new Set();
const emit = (event) => {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const stream of streams) stream.write(line);
};

const server = await createServer({
  root, logLevel: "error",
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: () => true } },
  cacheDir: viteCacheDir("task-actions-stale"),
  plugins: [{
    name: "task-actions-fixture-api",
    configureServer(dev) {
      dev.middlewares.use("/api/tasks", (request, response, next) => {
        const hit = /^\/([^/]+)\/actions$/.exec(request.url ?? "");
        if (!hit) return next();
        const taskId = decodeURIComponent(hit[1]);
        store.hits[taskId] = (store.hits[taskId] ?? 0) + 1;
        if (store.gone.has(taskId)) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (store.failures > 0) {
          store.failures -= 1;
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "暂时读不到" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(actions(taskId, store.primary[taskId])));
      });
      dev.middlewares.use("/api/events", (request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        response.write(": ready\n\n");
        streams.add(response);
        request.on("close", () => streams.delete(response));
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/task-actions-stale.html`);
  const primaryOf = (name) => page.locator(`[data-surface="${name}"]`).getAttribute("data-primary");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  // ① 开局
  await page.waitForSelector('[data-surface="t-1-head"][data-primary="run"]');
  await page.waitForSelector('[data-surface="t-2"][data-primary="run"]');
  await waitUntil(() => streams.size > 0, "事件流连上了");
  await settle();
  // 首读和事件流是并发的，连上那一刻对一遍账（连上之前的失效没人接）；两个表面各一套的话是四发。
  assert.ok(store.hits["t-1"] <= 2, `同一个任务挂两个表面共用一份，开局 ${store.hits["t-1"]} 发`);
  assert.equal(await primaryOf("t-1-info"), "run", "两个表面看见的是同一份");

  // ② 收到失效：重取一次，两个表面一起变
  const t1Start = store.hits["t-1"];
  store.primary["t-1"] = "retry";
  emit({ type: "task.actions.stale", taskId: "t-1" });
  await page.waitForSelector('[data-surface="t-1-head"][data-primary="retry"]');
  assert.equal(await primaryOf("t-1-info"), "retry");
  await settle();
  assert.equal(store.hits["t-1"], t1Start + 1, "一条失效只换来一发 GET");

  // ③ 没开着的任务：失效不换来请求；再打开时取到新的那一份
  await page.getByRole("button", { name: "toggle t-2" }).click();
  await page.waitForSelector('[data-surface="t-2"]', { state: "detached" });
  const t2Before = store.hits["t-2"];
  store.primary["t-2"] = "resume";
  emit({ type: "task.actions.stale", taskId: "t-2" });
  await settle();
  assert.equal(store.hits["t-2"], t2Before, "没开着的任务收到失效，一发都不取");
  await page.getByRole("button", { name: "toggle t-2" }).click();
  await page.waitForSelector('[data-surface="t-2"][data-primary="resume"]');

  // ④ 重取那一发掉了：自己再试到读到
  const t1Before = store.hits["t-1"];
  store.primary["t-1"] = "resume";
  store.failures = 1;
  emit({ type: "task.actions.stale", taskId: "t-1" });
  await waitUntil(() => store.hits["t-1"] === t1Before + 1 && store.failures === 0, "失效换来的那一发回了 503");
  await settle();
  assert.equal(await primaryOf("t-1-head"), "retry", "掉了的这一刻还是旧的那一份");
  await page.waitForSelector('[data-surface="t-1-head"][data-primary="resume"]', { timeout: CATCH_UP_RETRY_MS + 10_000 });
  assert.equal(store.hits["t-1"], t1Before + 2, "重试只补一发");

  // ⑤ 全部重取：开着的都重取，没开着的不取
  await page.getByRole("button", { name: "toggle t-2" }).click();
  await page.waitForSelector('[data-surface="t-2"]', { state: "detached" });
  const before = { ...store.hits };
  store.primary["t-1"] = "run";
  emit({ type: "task.actions.stale.all" });
  await page.waitForSelector('[data-surface="t-1-head"][data-primary="run"]');
  await settle();
  assert.equal(store.hits["t-1"], before["t-1"] + 1, "开着的任务重取一次");
  assert.equal(store.hits["t-2"], before["t-2"], "没开着的任务不取");

  // ⑥ 404：手上那份作废
  store.gone.add("t-1");
  emit({ type: "task.actions.stale", taskId: "t-1" });
  await page.waitForSelector('[data-surface="t-1-head"][data-primary="none"]');
  assert.equal(await primaryOf("t-1-info"), "none", "两个表面一起作废");
  const afterGone = store.hits["t-1"];
  await new Promise((resolve) => setTimeout(resolve, CATCH_UP_RETRY_MS + 1000));
  assert.equal(store.hits["t-1"], afterGone, "404 不重试");

  assert.deepEqual(errors, [], "页面没有报错");
  console.log("✓ task actions stale: 收到失效就重取、没开着的不取、读失败自己重试到读到、404 作废不重试");
} finally {
  for (const stream of streams) stream.end();
  await browser?.close();
  await server.close();
}
