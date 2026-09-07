// 预览启动那一段（最长两分钟）不能是个黑箱。跑：npm -w web run test:preview-log-live
//
// 钉两条，缺一条这个坑就会原样回来：
//   ① 一按「打开预览」，「预览日志」入口**立刻**在（不等 POST 回来）—— 那份快照里
//      `hasLog` 还是 false，可日志文件从 spawn 之前就在长。
//   ② 弹窗在启动期就开轮询：文案说「日志每 2 秒自动续上」，那它就得真的续上。判据是
//      服务端的 `starting`，不是「preview.json 写了没有」。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/preview-log-live.html`);

  const open = page.getByRole("button", { name: "打开预览" });
  await open.waitFor();
  assert.equal(await page.getByTestId("preview-log-open").count(), 0, "还没起过预览就不该有日志入口");

  // ① 启动请求挂着不回（现场里它可以挂两分钟），入口必须已经在。
  await open.click();
  await page.getByTestId("preview-log-open").waitFor({ timeout: 3000 });
  assert.equal(await page.getByRole("button", { name: "处理中" }).count(), 1, "这一刻启动请求还挂着");

  // ② 弹窗开轮询：正文得自己变长。
  await page.getByTestId("preview-log-open").click();
  const state = page.getByTestId("preview-log-state");
  await state.waitFor();
  assert.match(await state.textContent() ?? "", /正在启动/, "启动期得说清楚它还在启动");
  const body = page.locator(".preview-log-body");
  await page.waitForFunction(
    () => document.querySelector(".preview-log-body")?.textContent?.includes("Downloading") ?? false,
    null,
    { timeout: 8000 },
  );
  await page.waitForFunction(
    () => document.querySelector(".preview-log-body")?.textContent?.includes("Compiling 42 source files") ?? false,
    null,
    { timeout: 8000 },
  );
  assert.match(await body.textContent() ?? "", /npm run dev/, "命令回显那一行也该在");

  if (process.env.PREVIEW_LOG_SHOT) await page.screenshot({ path: process.env.PREVIEW_LOG_SHOT });
  console.log("preview log live: ok");
} finally {
  await browser?.close();
  await server.close();
}
