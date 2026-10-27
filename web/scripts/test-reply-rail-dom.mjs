// 回复框上方那条 rail:**重渲染不许留下孤儿节点**。
//
// 出事那一幕（任务 z2lq7MAWeKx7，2026-10-26 实测）：rail 上的「在等 N 个哨兵」随页面开着
// 的时间一张张变多，攒到几十张，而 `GET /api/tasks/:id/monitors` 一直只有 1 条在跑、
// `setMonitors` 也是整份替换。真相在 React 这一侧 —— 两张 wait 卡是同一条 children 列表
// 里的兄弟、key 都是 `task.id`，而列表前面那一位是 `false`（在队列里的任务不给接力入口），
// 于是 React 退到按 key 查表那条路；查表那张图同 key 的后者盖前者，`monitorWait` 匹配到
// `gateWait` 的 fiber、类型不符只好新挂一份，**旧的那份没被登记成删除**，它的 DOM 节点就
// 永远留在 rail 上。生产构建里一声不响（重复 key 的警告只在开发构建出），console 全程干净。
//
// 这份测试为什么必须是真浏览器:被测的事就是「React 提交完之后真实 DOM 里还剩几个节点」。
// fiber 树里始终只有一张卡（当时的取证也是这么被绕过去的），组件返回值更是永远正确 ——
// 只有真的渲染-提交过程才看得见那些没人删的节点。
//
// 夹具把两张卡的 key 都给成裸 `task.id`（出事那一版的原样），所以这里钉的是 rail 自己那层
// 隔离：调用方怎么取 key 都不许漏节点。顺带把 React 的重复 key 警告也收进断言 —— 开发构建
// 里它是这类事故唯一的免费信号。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const gateRun = {
  id: "gate-run-1",
  taskId: "rail-task",
  command: "./kb.sh test full",
  cwd: "/repo/.worktrees/rail-task",
  status: "running",
  exitCode: null,
  failure: null,
  startedAt: new Date(Date.now() - 90_000).toISOString(),
  finishedAt: null,
  sourceCommit: "abc12345",
  targetBranch: "main",
  targetCommit: "def67890",
  fastForward: true,
  stale: false,
  logPath: "/runs/rail-task/accept-gate-run-1.log",
  logTail: "正在跑\n",
  handoff: null,
};

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors = [];
  const keyWarnings = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (/same key|unique "key"/i.test(text)) keyWarnings.push(text.slice(0, 200));
  });
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor(url) { this.url = url; this.closed = false; setTimeout(() => { if (!this.closed) this.onopen?.({}); }, 0); }
      close() { this.closed = true; }
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (/^\/api\/tasks\/[^/]+\/accept-gate$/.test(path)) {
      return route.fulfill({ json: { command: "./kb.sh test full", running: gateRun, latest: gateRun, basis: null } });
    }
    errors.push(`unexpected API request: ${path}`);
    return route.fulfill({ status: 500, json: { error: "unexpected request" } });
  });

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/reply-rail.html`);
  const rail = page.locator(".task-reply-rail");
  await rail.waitFor();
  // 两张卡都得先真的画出来,否则后面数到的 1 可能只是「它压根没出现」。
  await page.locator(".monitor-wait").waitFor();
  await page.locator(".accept-gate-wait").waitFor();

  const flush = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const cards = () => rail.evaluate((element) => ({
    monitor: element.querySelectorAll(".monitor-wait").length,
    gate: element.querySelectorAll(".accept-gate-wait").length,
    children: element.children.length,
  }));

  const first = await cards();
  assert.deepEqual(
    { monitor: first.monitor, gate: first.gate },
    { monitor: 1, gate: 1 },
    `首帧每张卡应各一份，实得 ${JSON.stringify(first)}`,
  );

  // 连按重渲染。泄漏版在这里是线性增长(按几次就多几张),所以次数要够多到一眼看出趋势。
  for (let round = 0; round < 12; round += 1) {
    await page.getByTestId("rerender").click();
  }
  await flush();
  const after = await cards();
  assert.deepEqual(
    { monitor: after.monitor, gate: after.gate },
    { monitor: 1, gate: 1 },
    `重渲染 12 次后仍应各一份(孤儿节点回归)，实得 ${JSON.stringify(after)}`,
  );
  assert.equal(
    after.children,
    first.children,
    `rail 的子节点总数不该随重渲染变化：${first.children} → ${after.children}`,
  );

  // 接力入口翻面:那一帧列表的形状变了(多出/少掉一位),两张卡要跟着挪位而不是各留一份。
  for (const expectedChildren of [first.children + 1, first.children]) {
    await page.getByTestId("toggle-handoff").click();
    await flush();
    const toggled = await cards();
    assert.deepEqual(
      { monitor: toggled.monitor, gate: toggled.gate, children: toggled.children },
      { monitor: 1, gate: 1, children: expectedChildren },
      `接力入口翻面后 rail 应只有该有的那几个节点，实得 ${JSON.stringify(toggled)}`,
    );
  }

  // 翻完再连按重渲染:泄漏最初就是在「前面那一位是 false」这条路径上发生的。
  for (let round = 0; round < 12; round += 1) {
    await page.getByTestId("rerender").click();
  }
  await flush();
  const settled = await cards();
  assert.deepEqual(
    { monitor: settled.monitor, gate: settled.gate, children: settled.children },
    { monitor: 1, gate: 1, children: first.children },
    `翻面后再重渲染仍应各一份，实得 ${JSON.stringify(settled)}`,
  );

  assert.deepEqual(keyWarnings, [], `React 报了重复 key：${keyWarnings.join(" | ")}`);
  assert.deepEqual(errors, [], `页面抛错：${errors.join(" | ")}`);
  console.log("reply rail dom ok");
} finally {
  await browser?.close();
  await server.close();
}
