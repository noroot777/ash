// 任务列表「静默追平」的恢复责任(C1)。
//
// 哨兵事件(task.monitors)是**只来一次**的通知:服务端不补发,SSE 也没有事件 id。所以
// 收到它之后那一发 GET /api/tasks 掉了,就必须自己重试 —— 静默追平按定义不翻 loading、
// 不换错误横幅,放弃就等于界面一直停在旧快照上(哨兵在跑的任务显示成没在跑),用户连
// 「它陈旧了」都看不出来。修复前这一条路直接 `void refetch({silent:true})` 把失败丢掉。
//
// 这里不用 page.route 伪造 SSE:那种一次性响应会让 EventSource 立刻重连,而「重连」自己
// 就是另一条追平触发路,测的就不是哨兵事件那一条了。改成在测试进程里用 vite 插件的
// configureServer 挂真中间件(插件里挂的跑在 vite 内部中间件之前,因此盖得住 /api 代理),
// 真流真事件,connected 全程为 true。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { CATCH_UP_RETRY_MS } from "../src/lib/catchUp.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const row = (overrides) => ({
  id: "t-1", projectId: "p1", title: "任务一", status: "running", parentId: null, archived: false,
  mode: "single", groupId: null, queueId: null, queuePosition: null, labels: [],
  updatedAt: "2026-10-31T00:00:00.000Z", starredAt: null, backgroundRevision: 0,
  acceptGateRunning: false, monitorRunning: false, ...overrides,
});

/** 服务端这一侧的全部状态:权威列表、要掉几次 GET、已经收到几次 GET。 */
const store = { list: [row({})], failures: 0, hits: 0 };
const streams = new Set();
const emit = (event) => {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const stream of streams) stream.write(line);
};

const server = await createServer({
  root, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "catch-up-fixture-api",
    configureServer(dev) {
      dev.middlewares.use("/api/tasks", (request, response) => {
        store.hits += 1;
        if (process.env.TRACE) console.log(`[${Date.now() % 100000}] GET /api/tasks #${store.hits} fail=${store.failures}`);
        if (store.failures > 0) {
          store.failures -= 1;
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "任务列表暂时读不到" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(store.list));
      });
      dev.middlewares.use("/api/events", (request, response) => {
        response.writeHead(200, {
          "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
        });
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
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (process.env.TRACE) page.on("console", (message) => console.log(`[page ${Date.now() % 100000}]`, message.text()));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/task-catch-up.html`);

  // ① 开局:列表读到了,SSE 连上了(连上本身也会触发一次追平)。
  await page.waitForSelector('[data-task="t-1"]');
  await page.waitForSelector('main[data-connected="true"]');
  await page.waitForFunction(() => document.querySelectorAll("li").length === 1);
  const hitsBefore = store.hits;

  // ② 哨兵起来了:服务端的权威列表变了(多一行、t-1 的哨兵在跑),事件送达 —— 但这一发
  //    GET 掉了。页面此刻必须还是旧的那一份(静默,不该有横幅、不该有报错)。
  store.list = [row({ monitorRunning: true }), row({ id: "t-2", title: "任务二" })];
  store.failures = 1;
  emit({ type: "task.monitors", taskId: "t-1" });
  await page.waitForFunction((expected) => Number(
    document.querySelector("ul")?.dataset.rows) === expected, 1, { timeout: 4000 }).catch(() => {});
  assert.equal(await page.locator("li").count(), 1, "GET 掉了,这一刻页面还是旧快照");
  assert.equal(store.hits, hitsBefore + 1, "事件应当只换来一发 GET");
  assert.equal(await page.locator('[data-task="t-1"]').getAttribute("data-monitor"), "false");

  // ③ **恢复责任**:没有第二次事件、没有重连、没有人点刷新,它必须自己再试一次并追平。
  await page.waitForSelector('[data-task="t-2"]', { timeout: CATCH_UP_RETRY_MS + 10_000 });
  assert.equal(await page.locator('[data-task="t-1"]').getAttribute("data-monitor"), "true",
    "追平回来的那份快照要如实写上「哨兵在跑」");
  assert.equal(store.hits, hitsBefore + 2, "重试只补一发,不是每秒一发");
  assert.equal(await page.locator("main").getAttribute("data-connected"), "true",
    "全程没断线:这一轮追平是哨兵事件那一条路带回来的,不是重连");

  // ④ 连着掉也要接着试,直到追上(这一次让它掉两发)。
  const hitsBeforeStreak = store.hits;
  store.list = [row({ monitorRunning: false }), row({ id: "t-2", title: "任务二" }), row({ id: "t-3", title: "任务三" })];
  store.failures = 2;
  emit({ type: "task.monitors", taskId: "t-1" });
  await page.waitForSelector('[data-task="t-3"]', { timeout: CATCH_UP_RETRY_MS * 2 + 15_000 });
  assert.equal(store.hits, hitsBeforeStreak + 3, "两次失败 + 一次成功");
  assert.deepEqual(errors, []);
  console.log(`✓ 哨兵事件带着恢复责任:GET 掉了自己重试到追平(重试间隔 ${CATCH_UP_RETRY_MS}ms,连掉两发也不放弃)`);
} finally {
  for (const stream of streams) stream.end();
  await browser?.close();
  await server.close();
}
