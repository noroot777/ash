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
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

export const SHARED_BROWSER_ENV = "NAVI_TEST_BROWSER_WS";
export const SHARED_WEB_ENV = "NAVI_TEST_WEB_ORIGIN";

const root = fileURLToPath(new URL("..", import.meta.url));

// 测试页的后端只有路由桩和各自起的假服务。web/vite.config.ts 默认把没打桩的 `/api` 代理到
// localhost:4317，每交出一份页面文档还会去那里取一份真人动作凭据（vite/page-token.ts）——那是用户
// 正在用的那套服务：漏一个桩，请求就真打到它身上（2026-11-16 实测整套跑一遍漏过去近两百发，
// 含 /api/events、/api/settings），测试页拿到的是用户的真设置和真事件流，结果跟着线上那台走。
//
// 所以没有显式指到别处时（test-page-token-delivery 指到自己的假后端），后端一律是下面这个
// 「什么都没有的 navi」：事件流连得上但永远安静，其余接口一律 404，页面文档上有一份占位凭据。
// 它要排在任何 vite 起来之前，所以放在模块顶上——起 vite 的测试都先引这个文件，它们各自 spawn 的
// 夹具进程、执行器起的叶子，环境是继承的，用的是同一个。unref：不替任何进程续命。
if (!process.env.NAVI_PROXY && !process.env.HARNESS_PROXY) {
  const emptyBackend = createHttpServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://navi.test").pathname;
    if (path === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(":\n\n");
    } else if (path.startsWith("/api/") || path.startsWith("/preview/")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "测试页没有后端：这条请求没有打桩" }));
    } else {
      // meta 名即 @navi/shared/human-action 的 HUMAN_ACTION_TOKEN_META；对不上只是少盖这一份。
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><meta name="navi-human-action-token" content="ash-test-page-token">');
    }
  });
  await new Promise((resolve, reject) => emptyBackend.once("error", reject).listen(0, "127.0.0.1", resolve));
  emptyBackend.unref();
  emptyBackend.on("connection", (socket) => socket.unref());
  process.env.NAVI_PROXY = `http://127.0.0.1:${emptyBackend.address().port}`;
}

/**
 * 测试里的 vite 各用一份预构建缓存目录，别跟默认的 node_modules/.vite 混用。
 *
 * vite 按配置算一个哈希（插件名、optimizeDeps 都算在内），对不上就把整个 deps 目录重建一遍。
 * 自带插件或依赖配置的那几条测试跟别人算出来的哈希不一样，以前串行跑轮流重建无伤大雅；并行
 * 时它一重建，同时在跑、共用那个目录的 vite 发给页面的依赖文件就没了，页面停在白屏上干等到
 * 超时（实测：它们一起跑，共用 vite 上的三条页面全部 30 秒等不到首屏）。
 */
export function viteCacheDir(name) {
  return join(root, "node_modules", ".vite-test", name);
}

// 不要 watcher、不要 HMR —— 测试页跑完就走；留着 watcher 收尾时会残留 FSEvent 句柄，进程
// 偶发退不出去。共用那份还多一层理由：任何一次文件变动触发的整页刷新会同时打断所有在跑的测试。
//
// 光写 `watch: null` 关不掉：这里会加载 web/vite.config.ts，而 vite 合并配置时跳过值为 null 的
// 项，解析出来是 undefined，watcher 照开（2026-11-06 实测）。于是同一检出里任何文件一变，
// tailwind 插件就给所有连着的页面推一次 full-reload，页面状态清零、测试在莫名其妙的地方超时。
// hmr: false 让 vite 不再往页面推任何东西，ignored 让 watcher 本身也不产生事件。
async function viteServer(extra = {}) {
  const server = await createServer({
    root,
    logLevel: "error",
    cacheDir: viteCacheDir("stage"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: { ignored: () => true } },
    ...extra,
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address !== "object") throw new Error("Vite test server did not expose a port");
    return { server, origin: `http://127.0.0.1:${address.port}` };
  } catch (error) {
    await server.close();
    throw error;
  }
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
  let browser;
  try {
    browser = await chromium.connect(server.wsEndpoint());
  } catch (error) {
    await server.kill();
    throw error;
  }
  const disconnect = browser.close.bind(browser);
  browser.close = async (options) => {
    try {
      await disconnect(options);
    } finally {
      await server.kill();
    }
  };
  return browser;
}

/**
 * 执行器在跑前端那一步之前调一次。vite 预先扫遍所有夹具页的依赖：共用的那份要是跑到一半才
 * 发现新依赖，重新预构建会让所有连着它的页面一起整页刷新。
 */
export async function startSharedStage() {
  const { server, origin } = await viteServer({ optimizeDeps: { entries: ["index.html", "scripts/fixtures/*.html"] } });
  let chrome;
  try {
    // 共用的这份归执行器管：Playwright 默认在执行器进程上装「收到信号就关浏览器然后
    // process.exit」，会抢在执行器收场之前把它带走。关掉，由执行器收尾时调 stop()。
    chrome = await chromium.launchServer({ ...await chromeLaunchOptions(), handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    env: { [SHARED_WEB_ENV]: origin, [SHARED_BROWSER_ENV]: chrome.wsEndpoint() },
    stop: async () => {
      try {
        await chrome.kill();
      } finally {
        await server.close();
      }
    },
  };
}
