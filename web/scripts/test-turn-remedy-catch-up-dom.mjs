// 任务历史 + 那个人工救援入口的**失效协议**(第 1 轮审查 F5、F6)。
//
// `GET /tasks/:id/notices` 回的两样东西都会在「任务本身一个字段都没变」的情况下变化:
// 下面那串记录(新的挡回、巡检写下的诊断)和 `remedy` —— 那是服务端**此刻**算出来的,
// 回答「现在按那个开关有没有用」。原先这个 hook 的 effect 只认 task.id,外部唯一的刷新
// 路绑在「放开成功」那一下:
//   · F5:一直开着详情页的人看不到后来出现的救援入口,也看不到旧入口已经失效(按下去
//     只得到 409)—— 只有已经看见并点过那个开关的人才有刷新路,这正好是倒过来的;
//   · F6:首读失败被整个吞成「空列表 + 没有救援资格」,不重试也不说话,服务端恢复了也
//     不会自己回来(task.id 没变,effect 不再跑),效果是永久隐藏而不是一次暂态错误。
//
// 三条路分开验,因为它们是三套不同的保证:**事件**(服务端说变了)、**重试**(我没读到)、
// **重连**(断线期间的变化没人补发)。不用 page.route 伪造 SSE —— 那种一次性响应会让
// EventSource 立刻重连,于是测的永远是重连那一条;改成在 vite 里挂真中间件(挂在内部
// 中间件之前,盖得住 /api 代理),真流真事件。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { CATCH_UP_RETRY_MS } from "../src/lib/catchUp.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (n) => `2026-10-31T0${n}:00:00.000Z`;
const rejected = (n) => ({
  id: `n${n}`, action: "运行", outcome: "rejected",
  reason: `第 ${n} 次点运行被挡回:任务回合正在进行`, occurredAt: at(n),
});

/** 服务端这一侧的全部权威状态。`down` = 这个接口此刻读不出来。 */
const store = { notices: [], remedy: null, down: false, hits: 0 };
const streams = new Set();
const emit = (event) => {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const stream of streams) stream.write(line);
};

const server = await createServer({
  root, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "turn-remedy-catch-up-api",
    configureServer(dev) {
      dev.middlewares.use("/api/tasks", (request, response) => {
        if (!/\/notices(\?|$)/.test(request.url ?? "")) {
          response.writeHead(404).end("{}");
          return;
        }
        store.hits += 1;
        if (process.env.TRACE) console.log(`[${Date.now() % 100000}] GET notices #${store.hits} down=${store.down}`);
        if (store.down) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "任务通知暂时读不到" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ notices: store.notices, remedy: store.remedy }));
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
  const page = await browser.newPage({ viewport: { width: 760, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (process.env.TRACE) page.on("console", (message) => console.log(`[page ${Date.now() % 100000}]`, message.text()));

  const stage = page.locator('[data-stage="t-stale"]');
  const notices = stage.locator(".turn-remedy-notices li");
  const remedy = stage.locator(".task-turn-remedy");

  // ── ① 首读就失败:不是「没有被挡回过、也没有救援资格」,而是「还没读到」(F6)──────
  store.down = true;
  store.notices = [rejected(1)];
  store.remedy = "reclaim-turn";
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/turn-remedy.html?task=t-stale`);
  await page.waitForSelector('main[data-connected="true"]');
  assert.equal(await notices.count(), 0, "读不到就是读不到,不许凭空摆一条记录");
  assert.equal(await remedy.count(), 0, "还没读到时不摆那个开关 —— 摆一颗按下去 409 的按钮更糟");
  // 连上事件流自己就是一次追平,所以要等它之后再数:此后多出来的每一发都只能是重试。
  const afterConnect = store.hits;
  const deadline = Date.now() + CATCH_UP_RETRY_MS + 10_000;
  while (store.hits <= afterConnect && Date.now() < deadline) await page.waitForTimeout(200);
  assert(store.hits > afterConnect,
    `读失败要自己重试(间隔 ${CATCH_UP_RETRY_MS}ms),不是等用户点一下、也不是等任务换了 id`);
  store.down = false;
  // 没有人刷新、没有第二次事件、没有重连:它必须自己追上。
  await remedy.waitFor({ timeout: CATCH_UP_RETRY_MS + 10_000 });
  assert.equal(await notices.count(), 1, "追平回来的那一份要把历史补齐");
  assert.equal(await page.locator('main[data-connected="true"]').count(), 1,
    "全程没断线:这一轮追平是重试那条路带回来的,不是重连");

  // ── ② 开着页面不动:后来出现/消失的救援入口都要跟上(F5)────────────────────────
  // 反向那一半同样是缺陷:别处已经放开了,旧入口还摆着,按下去只得到 409。
  store.remedy = null;
  store.notices = [rejected(2), rejected(1)];
  emit({ type: "task.notices", taskId: "t-stale" });
  await remedy.waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(await notices.count(), 2, "同一发事件也把新记录带了进来");
  store.remedy = "reclaim-turn";
  emit({ type: "task.notices", taskId: "t-stale" });
  await remedy.waitFor({ timeout: 10_000 });

  // 别的任务的那一条不算:一个开着的详情页不该被整个实例的通知量牵着走。
  const quiet = store.hits;
  emit({ type: "task.notices", taskId: "t-somebody-else" });
  emit({ type: "task.monitors", taskId: "t-stale" });
  await page.waitForTimeout(600);
  assert.equal(store.hits, quiet, "不是这个任务的信号、不是这一族的信号,都不该换来一发 GET");

  // ── ③ 断线期间的变化没人补发:每次连上都重新对一遍账 ──────────────────────────
  store.notices = [rejected(3), rejected(2), rejected(1)];
  for (const stream of streams) stream.end();
  await page.waitForSelector('main[data-connected="false"]');
  // 注意:不 emit —— 这一刻连接都没了,事件无从送达,靠的正是重连那一下自己去对账。
  await page.waitForFunction(
    () => document.querySelectorAll('[data-stage="t-stale"] .turn-remedy-notices li').length === 3,
    undefined,
    { timeout: 20_000 },
  );
  assert.equal(await page.locator('main[data-connected="true"]').count(), 1, "重连应当已经建立");

  assert.deepEqual(errors, []);
  console.log("✓ 通知与救援入口的失效协议:事件带着变化、首读失败自己重试到读到、断线重连重新对账");
} finally {
  for (const stream of streams) stream.end();
  await browser?.close();
  await server.close();
}
