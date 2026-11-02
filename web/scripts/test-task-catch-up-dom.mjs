// 任务列表「静默追平」的恢复责任(C1)。
//
// 哨兵事件(task.monitors)是**只来一次**的通知:服务端不补发,SSE 也没有事件 id。所以
// 收到它之后那一发 GET /api/tasks 掉了,就必须自己重试 —— 静默追平按定义不翻 loading、
// 不换错误横幅,放弃就等于界面一直停在旧快照上(哨兵在跑的任务显示成没在跑),用户连
// 「它陈旧了」都看不出来。修复前这一条路直接 `void refetch({silent:true})` 把失败丢掉。
//
// 断线那一下还有第二条责任链(⑤,第 1 轮审查 F3):断线不会中止已经出门的那一发 GET,
// 而它回来时代次已经换过 —— 那一刻不许把「重连之后欠下的那一趟」一并清掉,否则页面就停在
// 断线前那一份快照上,connected 已经回到 true,也没有任何事件会再来纠正它。
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
/**
 * 把响应**扣在手里**的闸(⑤ 用)。`on` 期间新到的 GET 不立刻回,而是把「到达那一刻的
 * 快照」连同发送动作排进 `held`,由测试决定什么时候放 —— 这样才造得出「一发还在途中,
 * 世界已经变了」这件事本身,不必伪造它的内容。
 */
const gate = { on: false, held: [] };
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
        // 快照在**到达那一刻**定下来:放行得晚,带的也还是那时候的那一份。
        const body = JSON.stringify(store.list);
        const send = () => {
          // `no-store`:别让 Chrome 的 HTTP 缓存把同一个 URL 的响应留下来 —— 追平的判据
          // 是「服务端此刻怎么说」,从缓存里拿一份就什么都测不到了。
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(body);
        };
        if (gate.on) {
          gate.held.push(send);
          return;
        }
        send();
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

  // ⑤ **跨代次的恢复责任**(第 1 轮审查 F3):在途那一发还没落地就断线了,重连之后的追平
  //    不许被它清掉。
  //
  //    断线并不会中止已经出门的那一发 —— cancel 只断责任,没有中止传输这种能力。它回来
  //    时代次早已换过,如果那一刻把「新代次欠下的那一趟」一并清掉,就会落到这么一个局面:
  //    没有请求在途、没有重试在排、connected 已经回到 true,而页面停在断线前那一份快照上
  //    (哨兵在跑的任务显示成没在跑)—— SSE 不补发,此后没有任何事件会来纠正它,只有手动
  //    刷新才对得上。修复前这一幕是实测复现的(报告里的 reconnect-stale.png)。
  const hitsBeforeStale = store.hits;
  gate.on = true;
  emit({ type: "task.monitors", taskId: "t-1" }); // 这一发被扣在服务端,快照 = 此刻这三行
  const arrival = Date.now() + 10_000;
  while (store.hits < hitsBeforeStale + 1 && Date.now() < arrival) await page.waitForTimeout(50);
  assert.equal(store.hits, hitsBeforeStale + 1, "这一发应当已经到达并被扣住");
  // 断线:流关掉 —— connected 翻 false,useTasks 那个 effect 的 cleanup 随即 cancel。
  for (const stream of streams) stream.end();
  streams.clear();
  await page.waitForSelector('main[data-connected="false"]');
  // 断线窗口里权威列表变了。**不 emit** —— 这一刻连接都没了,事件无从送达,靠的正是重连
  // 那一下自己去对账。
  store.list = [
    row({ monitorRunning: true }), row({ id: "t-2", title: "任务二" }),
    row({ id: "t-3", title: "任务三" }), row({ id: "t-4", title: "任务四" }),
  ];
  gate.on = false;
  await page.waitForSelector('main[data-connected="true"]', { timeout: 20_000 });
  // 把扣住那一发放回去,它带的是断线之前那一份旧快照。放行放在断言之前:浏览器会把同一个
  // URL 的第二发锁在本地等第一发写完(第 2 轮审查实测),所以新代次那一发可能要等这里才
  // 真正出门 —— 要测的是**责任没丢**,不是「立刻出门」。
  gate.held.shift()();
  await page.waitForSelector('[data-task="t-4"]', { timeout: 20_000 });
  assert.equal(await page.locator('[data-task="t-1"]').getAttribute("data-monitor"), "true",
    "追平回来的那份快照要如实写上「哨兵在跑」");
  // 迟到的那一发旧快照落地也不许把追平的结果盖回去(它发起更早,消费方按发起序号丢掉它)。
  await page.waitForTimeout(800);
  assert.equal(await page.locator("li").count(), 4, "迟到的旧快照不许把追平的结果盖回去");
  assert.equal(await page.locator("main").getAttribute("data-connected"), "true");

  assert.deepEqual(errors, []);
  console.log(`✓ 哨兵事件带着恢复责任:GET 掉了自己重试到追平(重试间隔 ${CATCH_UP_RETRY_MS}ms,连掉两发也不放弃),断线前那一发回来也不许清掉重连后欠下的那一趟`);
} finally {
  for (const stream of streams) stream.end();
  await browser?.close();
  await server.close();
}
