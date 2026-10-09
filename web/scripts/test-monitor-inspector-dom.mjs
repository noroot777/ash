// 哨兵面板在真壳子里的两件事（第 1 轮审查逮到的 ② 和 ③）：
//
// ② 切任务的那一下。hook 挂在 InspectorHost 之外（跟 TaskDetail 一样，Host 自己按
//    contextKey 重挂、hook 不重挂），所以上一个任务在途的请求会原样回来盖在当前面板上
//    ——那张列表每行都带「停掉」按钮，点下去真停的是上一个任务的活。而 `stop`/`start`
//    收尾调的那发更隐蔽：它手里的 reload 是创建那一刻的闭包，带的是旧 taskId，比代号
//    比不出来（代号是它自己出门时取的），只能在出门前问一句「现在还是这个任务吗」。
//
// ③ 340px（Inspector 默认宽）下的布局。命令行和 cwd 都是不可断的长字符串，Grid 列不
//    写 `min-width: 0` 就会被内容顶宽，把「停掉」按钮挤出面板。**不能靠点一下按钮验证**
//    ——Playwright 点击会自动把元素滚进视野，挤出去了照样点得到。只认几何：按钮的盒子
//    必须落在面板里，面板不许出现横向滚动。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const LONG_CWD = "/Users/fjh/code/harness/.worktrees/S3Bp7iPC8wOe/server/scripts/fixtures/deeply/nested/working/directory";
const LONG_COMMAND = "tail -F /var/log/very-long-path/build-output-with-an-extremely-long-name.log | grep --line-buffered -E 'ERROR|FAILED|Traceback'";
const monitor = (id, taskId, over = {}) => ({
  id,
  taskId,
  command: LONG_COMMAND,
  description: `盯 ${taskId}`,
  cwd: LONG_CWD,
  status: "running",
  pid: 4242,
  events: 3,
  exitCode: null,
  startedAt: "2026-10-09T02:00:00.000Z",
  expiresAt: "2026-10-09T04:00:00.000Z",
  endedAt: null,
  endedReason: null,
  ...over,
});

const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
const pending = [];
try {
  await server.listen();
  browser = await chromium.launch(await chromeLaunchOptions());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const failures = [];

  const open = async (handler) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => failures.push(error.message));
    await page.addInitScript(() => {
      window.localStorage.clear();
      window.__sources = [];
      window.EventSource = class {
        constructor(url) { this.url = url; this.closed = false; window.__sources.push(this); setTimeout(() => { if (!this.closed) this.onopen?.({}); }, 0); }
        close() { this.closed = true; }
      };
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (handler && await handler(route, path)) return;
      const list = /^\/api\/tasks\/([^/]+)\/monitors$/.exec(path);
      if (list) return route.fulfill({ json: [monitor(`m-${list[1]}`, list[1])] });
      const log = /^\/api\/monitors\/([^/]+)\/log$/.exec(path);
      if (log) return route.fulfill({ json: { lines: [`${"x".repeat(400)}`, "第二行"], truncated: false } });
      failures.push(`unexpected API request: ${path}`);
      await route.fulfill({ status: 500, json: { error: "unexpected request" } });
    });
    await page.goto(`${origin}/scripts/fixtures/monitor-inspector.html`);
    return page;
  };
  const idsOf = (page) => page.getByTestId("ids").textContent();
  const waitIds = (page, value) => page.waitForFunction(
    (want) => document.querySelector('[data-testid="ids"]')?.textContent === want,
    value,
  );

  // ── ③ 340px 下按钮不许被挤出面板 ───────────────────────────────────────────
  {
    const page = await open();
    await page.setViewportSize({ width: 1280, height: 800 });
    await waitIds(page, "m-task-a");
    // 日志也展开：那一段是整页里最长的不可断内容。
    await page.getByRole("button", { name: "看它的输出" }).click();
    await page.locator(".monitor-card__log pre").waitFor();

    const geometry = await page.evaluate(() => {
      const host = document.querySelector(".inspector-host");
      const content = document.querySelector(".inspector-host__content");
      const stop = document.querySelector(".monitor-card__stop");
      const card = document.querySelector(".monitor-card");
      const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
      return {
        host: box(host),
        content: box(content),
        stop: box(stop),
        card: box(card),
        contentOverflow: content.scrollWidth - content.clientWidth,
        cardOverflow: card.scrollWidth - card.clientWidth,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert.equal(Math.round(geometry.host.width), 340, "这一段测的就是默认宽度，不能靠加宽 Inspector 蒙过去");
    assert.ok(
      geometry.stop.right <= geometry.content.right + 0.5 && geometry.stop.left >= geometry.content.left - 0.5,
      `「停掉」按钮被挤出面板了：按钮 ${JSON.stringify(geometry.stop)}，面板 ${JSON.stringify(geometry.content)}`,
    );
    assert.ok(geometry.contentOverflow <= 1, `面板出现横向滚动（溢出 ${geometry.contentOverflow}px）`);
    assert.ok(geometry.cardOverflow <= 1, `卡片自己被内容顶宽了（溢出 ${geometry.cardOverflow}px）`);
    assert.ok(geometry.docOverflow <= 1, `整页被顶出横向滚动（溢出 ${geometry.docOverflow}px）`);
    assert.ok(geometry.card.width <= geometry.content.width + 0.5, "卡片不该比面板还宽");
    await page.close();
  }

  // ── ② 初次读取在途时切走：它回来不许盖到当前任务上 ─────────────────────────
  {
    let releaseA;
    const held = new Promise((resolve) => { releaseA = resolve; });
    pending.push(() => releaseA());
    let aCalls = 0;
    const page = await open(async (route, path) => {
      if (path !== "/api/tasks/task-a/monitors") return false;
      aCalls += 1;
      await held;
      await route.fulfill({ json: [monitor("m-task-a", "task-a")] }).catch(() => undefined);
      return true;
    });
    const armed = Date.now() + 5000;
    while (aCalls < 1 && Date.now() < armed) await page.waitForTimeout(20);
    assert.ok(aCalls >= 1, "任务 A 的读取确实出门并卡住了");

    await page.getByRole("button", { name: "切换任务" }).click();
    await waitIds(page, "m-task-b");
    releaseA();
    await page.waitForTimeout(300);
    assert.equal(await idsOf(page), "m-task-b", "切走之后才回来的那发不许盖到当前任务的面板上");
    assert.match(await page.locator(".monitor-card b").innerText(), /task-b/);
    await page.close();
  }

  // ── ② 「停掉」的收尾那一发：闭包里带的是旧 taskId，出门前就得拦住 ───────────
  {
    let releaseStop;
    const held = new Promise((resolve) => { releaseStop = resolve; });
    pending.push(() => releaseStop());
    let stopCalls = 0;
    let aListCalls = 0;
    const page = await open(async (route, path) => {
      if (path === "/api/monitors/m-task-a/stop") {
        stopCalls += 1;
        await held;
        await route.fulfill({ json: { monitor: monitor("m-task-a", "task-a", { status: "stopped", endedAt: "2026-10-09T03:00:00.000Z" }) } }).catch(() => undefined);
        return true;
      }
      if (path === "/api/tasks/task-a/monitors") {
        aListCalls += 1;
        return false; // 走默认实现，只是数一下它被读了几次
      }
      return false;
    });
    await waitIds(page, "m-task-a");
    await page.getByRole("button", { name: /^停掉哨兵/ }).click();
    const armed = Date.now() + 5000;
    while (stopCalls < 1 && Date.now() < armed) await page.waitForTimeout(20);
    assert.equal(stopCalls, 1, "停止请求已经出门并卡住");

    const listedBefore = aListCalls;
    await page.getByRole("button", { name: "切换任务" }).click();
    await waitIds(page, "m-task-b");
    releaseStop();
    await page.waitForTimeout(300);
    assert.equal(
      aListCalls,
      listedBefore,
      "停止收尾的 reload 带的是旧 taskId：切走之后它一发都不该出门（它的结果会直接写进当前面板）",
    );
    assert.equal(await idsOf(page), "m-task-b", "当前面板上还是当前任务的哨兵");
    await page.close();
  }

  // ── ② 停止失败的那句报错同理：说的是上一个任务的事，不往新面板上贴 ───────────
  {
    let releaseStop;
    const held = new Promise((resolve) => { releaseStop = resolve; });
    pending.push(() => releaseStop());
    let stopCalls = 0;
    const page = await open(async (route, path) => {
      if (path !== "/api/monitors/m-task-a/stop") return false;
      stopCalls += 1;
      await held;
      await route.fulfill({ status: 500, json: { error: "上一个任务的停止失败了" } }).catch(() => undefined);
      return true;
    });
    await waitIds(page, "m-task-a");
    await page.getByRole("button", { name: /^停掉哨兵/ }).click();
    const armed = Date.now() + 5000;
    while (stopCalls < 1 && Date.now() < armed) await page.waitForTimeout(20);

    await page.getByRole("button", { name: "切换任务" }).click();
    await waitIds(page, "m-task-b");
    releaseStop();
    await page.waitForTimeout(300);
    assert.equal(await page.getByTestId("error").textContent(), "", "切走之后才回来的失败不该贴在新任务的面板上");
    assert.equal(await page.locator(".monitor-inspector__error").count(), 0);
    await page.close();
  }

  // ── 同一个任务内：乱序回来的旧响应不许顶掉新的 ─────────────────────────────
  {
    let releaseFirst;
    const held = new Promise((resolve) => { releaseFirst = resolve; });
    pending.push(() => releaseFirst());
    let calls = 0;
    const page = await open(async (route, path) => {
      if (path !== "/api/tasks/task-a/monitors") return false;
      calls += 1;
      if (calls === 1) {
        await held;
        // 读得更早、落地更晚的那份：它看到的还是「3 条事件」。
        await route.fulfill({ json: [monitor("m-task-a", "task-a", { events: 3 })] }).catch(() => undefined);
        return true;
      }
      await route.fulfill({ json: [monitor("m-task-a", "task-a", { events: 11 })] });
      return true;
    });
    const armed = Date.now() + 5000;
    while (calls < 1 && Date.now() < armed) await page.waitForTimeout(20);
    // 直播事件补刷一发，它带回更新的计数。
    await page.evaluate(() => {
      for (const source of window.__sources.filter((item) => !item.closed)) {
        source.onmessage?.({ data: JSON.stringify({ type: "task.monitors", taskId: "task-a" }) });
      }
    });
    await page.locator(".monitor-card__meta").filter({ hasText: "11 条事件" }).waitFor();

    releaseFirst();
    await page.waitForTimeout(300);
    assert.match(
      await page.locator(".monitor-card__meta").first().innerText(),
      /11 条事件/,
      "先出门、后落地的那份读到的是旧计数，不许把已经写进去的新计数顶回去",
    );
    await page.close();
  }

  assert.deepEqual(failures, []);
  console.log("monitor inspector dom: stop button stays inside the 340px panel, stale task reads/stops never land");
} finally {
  pending.forEach((release) => release());
  await browser?.close();
  await server.close();
}
