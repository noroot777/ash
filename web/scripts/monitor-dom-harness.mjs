// 哨兵面板 DOM 回归**共用的台子**:真 Vite + 真 Chromium（headless）+ 真组件，API 全部用
// `page.route` 拦下来按用例答。
//
// 从 test-monitor-inspector-dom.mjs 拆出来的（全局约定:单文件不超过 700 行）。那边是面板/图标
// 条/切任务这一组用例，`test-monitor-composer-dom.mjs` 是「它什么时候算完」那一格 —— 两边起的
// 是同一份台子，所以台子只写一处:哪天 fixture 的 API 形状变了，不会只改对一半。
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

export const LONG_CWD = "/Users/fjh/code/harness/.worktrees/S3Bp7iPC8wOe/server/scripts/fixtures/deeply/nested/working/directory";
export const LONG_COMMAND = "tail -F /var/log/very-long-path/build-output-with-an-extremely-long-name.log | grep --line-buffered -E 'ERROR|FAILED|Traceback'";
export const monitor = (id, taskId, over = {}) => ({
  id,
  taskId,
  command: LONG_COMMAND,
  description: `盯 ${taskId}`,
  cwd: LONG_CWD,
  status: "running",
  // 出身：缺了它卡片按只读投影渲染，后面找「看它的输出」会直接超时。
  kind: "ash",
  nativeId: null,
  lifetime: "bounded",
  pid: 4242,
  events: 3,
  exitCode: null,
  startedAt: "2026-10-09T02:00:00.000Z",
  // 起点作数（服务端的可信性那一列）。缺了它卡片只会说「挂上的时刻不确定」。
  startedAtExact: true,
  expiresAt: "2026-10-09T04:00:00.000Z",
  endedAt: null,
  endedReason: null,
  ...over,
});

/**
 * 起一份台子:`{ open, idsOf, waitIds, failures, close }`。
 *
 * `open(handler, query)` 开一个新页面并把 `/api/**` 全拦下来 —— `handler` 答得出的那几条按它
 * 的，剩下的落到这里的兜底（列表、恢复状态、日志）。页面里的 `pageerror` 一律记进 `failures`:
 * 判据在**每次渲染**里同步跑,它一抛整棵树就卸载 —— 那种事只有真壳子看得见。
 */
export async function openHarness() {
const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
  await server.listen();
  const browser = await chromium.launch(await chromeLaunchOptions());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const failures = [];
  const open = async (handler, query = "") => {
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
      // 恢复状态是单独一条端点（见 server/src/monitor-routes.ts：不动列表的响应形状，
      // 否则旧 dist 配新 server 会整格崩）。这里一律答「没有待恢复的」。
      if (/^\/api\/tasks\/[^/]+\/monitors\/recovery$/.test(path)) {
        return route.fulfill({ json: { pending: false, reasons: [], attempts: 0, exhausted: false } });
      }
      const log = /^\/api\/monitors\/([^/]+)\/log$/.exec(path);
      if (log) return route.fulfill({ json: { lines: [`${"x".repeat(400)}`, "第二行"], truncated: false } });
      failures.push(`unexpected API request: ${path}`);
      await route.fulfill({ status: 500, json: { error: "unexpected request" } });
    });
    await page.goto(`${origin}/scripts/fixtures/monitor-inspector.html${query}`);
    return page;
  };
  const idsOf = (page) => page.getByTestId("ids").textContent();
  const waitIds = (page, value) => page.waitForFunction(
    (want) => document.querySelector('[data-testid="ids"]')?.textContent === want,
    value,
  );
  const close = async () => {
    await browser.close();
    await server.close();
  };
  return { server, browser, origin, failures, open, idsOf, waitIds, close };
}
