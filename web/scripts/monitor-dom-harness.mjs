// 哨兵面板 DOM 回归**共用的台子**:真 Vite + 真 Chromium（headless）+ 真组件，API 全部用
// `page.route` 拦下来按用例答。
//
// 从 test-monitor-inspector-dom.mjs 拆出来的（全局约定:单文件不超过 700 行）。那边是面板/图标
// 条/切任务这一组用例，`test-monitor-composer-dom.mjs` 是「它什么时候算完」那一格 —— 两边起的
// 是同一份台子，所以台子只写一处:哪天 fixture 的 API 形状变了，不会只改对一半。
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { trackFetches, WAIT_TIMEOUT_MS } from "./wait-until.mjs";

export const LONG_CWD = "/Users/fjh/code/harness/.worktrees/S3Bp7iPC8wOe/server/scripts/fixtures/deeply/nested/working/directory";
export const LONG_COMMAND = "tail -F /var/log/very-long-path/build-output-with-an-extremely-long-name.log | grep --line-buffered -E 'ERROR|FAILED|Traceback'";
export const monitor = (id, taskId, over = {}) => ({
  id,
  taskId,
  command: LONG_COMMAND,
  description: `盯 ${taskId}`,
  cwd: LONG_CWD,
  status: "running",
  // 出身：缺了它卡片按只读投影渲染，后面找「输出」会直接超时。
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
 *
 * 页面上每一发 `/api/` 请求都由 `trackFetches` 记着（见 wait-until.mjs）：负向断言（「迟到的
 * 那发不许落地」）要等的正向信号就是「它已经被页面读完或掐掉」，Node 侧的桩只知道自己送出去了。
 * EventSource 是桩：`opened` 记下它已经替页面发过那次 open，用例据此知道「连上」这件事已经发生。
 */
export async function openHarness() {
  const web = await startWebServer();
  const browser = await launchChrome();
  const origin = web.origin;
  const failures = [];
  const open = async (handler, query = "") => {
    const page = await browser.newPage();
    // 条件等待的期限按满载给（门禁 8 路并行）：真坏了也只是晚几秒报，不会让慢机器闪红。
    page.setDefaultTimeout(WAIT_TIMEOUT_MS);
    page.on("pageerror", (error) => failures.push(error.message));
    await page.addInitScript(() => {
      window.localStorage.clear();
      window.__sources = [];
      window.EventSource = class {
        // setTimeout(0) 只是让 open 像真连接那样异步到达（订阅方先把 onopen 挂上），不是在等什么：
        // 用例要的是「已经连上」这个事实，看 `opened`，不看过了多久。
        constructor(url) { this.url = url; this.closed = false; this.opened = false; window.__sources.push(this); setTimeout(() => { if (!this.closed) { this.opened = true; this.onopen?.({}); } }, 0); }
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
    await trackFetches(page, "/api/");
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
    await web.close();
  };
  return { browser, origin, failures, open, idsOf, waitIds, close };
}
