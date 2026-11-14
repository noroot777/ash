// 消费了服务端「此刻能做什么」之后，表面不许再按本地状态另判一次（第 1 轮审查 F2）。夹具见
// scripts/fixtures/action-consumers.tsx。钉住：
// ① 停在检查点上、有待启动请求（回复不排队）、服务端说能停：空输入框的主段就是停止键，打了字旁边有
//    小停止键 —— 早先回复框拿「任务在不在跑」再滤一遍，这两颗都没了，命令面板却停得掉；
// ② 任务在跑（回复会排队）、服务端说没东西可停：不出停止键；
// ③ 本地 rounds 里有一轮在验、服务端说能派验证：两处派验证入口照出、点得动；服务端改口（灰着说原因）
//    之后两处都灰着说服务端那句，不是本地另写的「验证正在进行」。
// 跑：npm -w web run test:action-consumers
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchChrome, viteCacheDir } from "./dom-stage.mjs";
import { settlePage, waitUntil } from "./wait-until.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const IN_FLIGHT = "该任务已有一轮验证正在进行";
let seq = 0;
const hits = {};
const verdicts = { verify: { ok: true } };
const actions = (taskId) => ({
  taskId, boot: "b", seq: ++seq, primary: null, archive: { ok: false, reason: "-", hidden: true },
  requeue: { ok: false, reason: "-", hidden: true }, retryTurn: null,
  stop: taskId === "t-pending" ? { ok: true } : { ok: false, reason: "任务没有在运行的进程可停止", hidden: true },
  verify: taskId === "t-verify" ? verdicts.verify : { ok: false, reason: "-", hidden: true },
});
const json = (response, body, status = 200) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const streams = new Set();
const emit = (event) => { for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`); };
const server = await createServer({
  root, logLevel: "error",
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: () => true } },
  cacheDir: viteCacheDir("action-consumers"),
  plugins: [{
    name: "action-consumers-fixture-api",
    configureServer(dev) {
      dev.middlewares.use("/api", (request, response) => {
        const url = request.url ?? "";
        if (url.startsWith("/events")) {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          response.write(": ready\n\n");
          streams.add(response);
          request.on("close", () => streams.delete(response));
          return;
        }
        const hit = /^\/tasks\/([^/]+)\/actions$/.exec(url);
        if (hit) {
          const taskId = decodeURIComponent(hit[1]);
          hits[taskId] = (hits[taskId] ?? 0) + 1;
          return json(response, actions(taskId));
        }
        if (/^\/tasks\/[^/]+\/review$/.test(url)) {
          return json(response, { reviewRequested: false, rounds: [{ round: 1, where: "inline", reviewTaskId: null,
            reviewTaskStatus: "running", conclusion: null, reportMarkdown: "", screenshots: [] }] });
        }
        if (url.startsWith("/agents")) {
          return json(response, [{ id: "prof-1", type: "claude", label: "claude", isDefault: true }]);
        }
        json(response, { error: "not found" }, 404);
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
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/action-consumers.html`);
  await waitUntil(() => streams.size > 0, "事件流连上了");

  // ① 不排队、服务端说能停：空输入框主段是停止键，打了字旁边有小停止键
  await page.waitForSelector('[data-reply="paused-empty"] .send-key-main[aria-label="停止"]');
  assert.equal(await page.locator('[data-reply="paused-empty"] .send-key-main').getAttribute("aria-disabled"), null,
    "能停时停止键点得动");
  await page.waitForSelector('[data-reply="paused-typed"] .send-key-halt');
  assert.notEqual(await page.locator('[data-reply="paused-typed"] .send-key-main').getAttribute("aria-label"), "停止",
    "打了字主段是发送");

  // ② 回复会排队、服务端说没东西可停：不出停止键
  await waitUntil(() => hits["t-nostop"] > 0, "取到了这个任务的停止结论");
  await settlePage(page);
  assert.equal(await page.locator('[data-reply="running-unstoppable"] .send-key-halt').count(), 0);
  assert.notEqual(await page.locator('[data-reply="running-unstoppable"] .send-key-main').getAttribute("aria-label"), "停止");

  // ③ 本地有一轮在验、服务端说能派：两处都照出、点得动
  const dispatchButton = page.locator('[data-surface="dispatch"] .review-dispatch-heading button');
  await dispatchButton.waitFor();
  await waitUntil(async () => !(await dispatchButton.isDisabled()), "派验证面板的键点得动");
  assert.match(await dispatchButton.innerText(), /再验一轮/, "不另写「验证进行中」");
  const inspectorButton = page.locator('[data-surface="inspector"]').getByRole("button", { name: /验一轮/ });
  await inspectorButton.waitFor();
  assert.equal(await inspectorButton.getAttribute("aria-disabled"), null, "验证格的键照出、点得动");

  // 服务端改口：两处都灰着，说的是服务端那句
  verdicts.verify = { ok: false, reason: IN_FLIGHT };
  emit({ type: "task.actions.stale", taskId: "t-verify" });
  await waitUntil(() => dispatchButton.isDisabled(), "派验证面板的键灰了");
  assert.match(await page.locator('[data-surface="dispatch"] .review-dispatch-heading small').innerText(), new RegExp(IN_FLIGHT));
  await waitUntil(async () => (await inspectorButton.getAttribute("aria-disabled")) === "true", "验证格的键灰了");

  assert.deepEqual(errors, [], "页面没有报错");
  console.log("✓ action consumers: 停止键只看服务端停止结论、不看回复排不排队；派验证不再按本地轮次另判");
} finally {
  for (const stream of streams) stream.end();
  await browser?.close();
  await server.close();
}
