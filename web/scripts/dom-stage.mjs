// DOM 回归拿浏览器和 vite 的统一入口。
//
// 浏览器为什么不是 `chromium.launch()` + `browser.close()`：本机装的品牌版 Google Chrome
// （2026-11 实测 156）在优雅退出里会干等 7～8 秒——子进程早已退光，主进程卡在一次 mach_msg
// 上，verbose 日志那段时间一片空白；Chrome for Testing 和 headless shell 同样的流程几十毫秒。
// 每条 DOM 回归都要起关一次，光这一项就让前端全量回归多出十几分钟。测试用的是一次性临时
// profile，没有任何东西值得优雅关闭，所以改成 launchServer 起、关的时候直接杀。
//
// 并行执行器（scripts/test-runner.mjs）跑前端回归时先起一份共用的 Chrome 和 vite，用下面两个
// 环境变量交给每条测试：每条测试照旧开自己的 context/page，彼此不共享任何页面状态，只省掉
// 一百多次起停和 vite 的冷编译。单独跑某条测试时这两个变量不存在，各起各的。
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

export const SHARED_BROWSER_ENV = "ASH_TEST_BROWSER_WS";
export const SHARED_WEB_ENV = "ASH_TEST_WEB_ORIGIN";

const root = fileURLToPath(new URL("..", import.meta.url));

// watch: null —— 测试页跑完就走，不需要 HMR；留着 watcher 收尾时会残留 FSEvent 句柄，进程
// 偶发退不出去。共用那份还多一层理由：任何一次文件变动触发的整页刷新会同时打断所有在跑的测试。
async function viteServer(extra = {}) {
  const server = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null },
    ...extra,
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address !== "object") throw new Error("Vite test server did not expose a port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

/** 本条测试用的 vite：`origin` 拼页面地址，`close()` 收尾（共用那份由执行器收，这里是空操作）。 */
export async function startWebServer() {
  const shared = process.env[SHARED_WEB_ENV];
  if (shared) return { origin: shared, close: async () => {} };
  const { server, origin } = await viteServer();
  return { origin, close: () => server.close() };
}

/** 本条测试用的浏览器。用法同 `chromium.launch()` 的返回值，`close()` 之后进程已经不在了。 */
export async function launchChrome() {
  const shared = process.env[SHARED_BROWSER_ENV];
  if (shared) return chromium.connect(shared);
  const server = await chromium.launchServer(await chromeLaunchOptions());
  const browser = await chromium.connect(server.wsEndpoint());
  const disconnect = browser.close.bind(browser);
  browser.close = async (options) => {
    await disconnect(options);
    await server.kill();
  };
  return browser;
}

/**
 * 执行器在跑前端那一步之前调一次。vite 预先扫遍所有夹具页的依赖：共用的那份要是跑到一半才
 * 发现新依赖，重新预构建会让所有连着它的页面一起整页刷新。
 */
export async function startSharedStage() {
  const { server, origin } = await viteServer({ optimizeDeps: { entries: ["index.html", "scripts/fixtures/*.html"] } });
  const chrome = await chromium.launchServer(await chromeLaunchOptions());
  return {
    env: { [SHARED_WEB_ENV]: origin, [SHARED_BROWSER_ENV]: chrome.wsEndpoint() },
    stop: async () => {
      await chrome.kill();
      await server.close();
    },
  };
}
