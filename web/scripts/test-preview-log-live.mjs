// 预览启动那一段（最长两分钟）不能是个黑箱。跑：npm -w web run test:preview-log-live
//
// 钉三条，缺一条这个坑就会原样回来：
//   ① 一按「打开预览」，「预览日志」入口**立刻**在（不等 POST 回来）—— 那份快照里
//      `hasLog` 还是 false，可日志文件从 spawn 之前就在长。
//   ② 弹窗在启动期就开轮询：文案说「日志每 2 秒自动续上」，那它就得真的续上。而且
//      **第一次 GET 报「没在跑」也得接着看**：后端的 starting 是 startPreview 真开跑
//      之后才有的，按钮却在 POST 发出那一刻就亮了，手快的用户正好落在那个窗口里。
//   ③ 反过来，spawn **之前**就失败的那条路（多候选 409，盘上根本没有日志文件），那颗
//      乐观按钮必须收回去——否则界面上永久留着一颗点开只会说「还没有预览日志」的按钮。
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
  const base = `http://127.0.0.1:${address.port}/scripts/fixtures/preview-log-live.html`;

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto(base);

  const open = page.getByRole("button", { name: "打开预览" });
  await open.waitFor();
  assert.equal(await page.getByTestId("preview-log-open").count(), 0, "还没起过预览就不该有日志入口");

  // ① 启动请求挂着不回（现场里它可以挂两分钟），入口必须已经在。
  await open.click();
  await page.getByTestId("preview-log-open").waitFor({ timeout: 3000 });
  // 启动请求还挂着 —— 而这一段（装依赖 6 分钟 + 等就绪 2 分钟）必须有一颗**能点的取消**，
  // 不是一颗灰着的「处理中」：后端此刻确实收得掉（记录、pid、正在装依赖的进程都在盘上），
  // 界面点不到就等于那套取消不存在。
  const cancel = page.getByRole("button", { name: "启动中·点此取消" });
  assert.equal(await cancel.count(), 1, "这一刻启动请求还挂着");
  assert.equal(await cancel.isDisabled(), false, "启动中那颗必须是能点的");

  // ② 弹窗开轮询：第一次 GET 报的是「没在跑」（后端还没走到 startPreview），
  //    它仍然要接着看下去，正文得自己变长。
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

  // ②b 点下去要真的发 DELETE，并且启动那一路随之收场：界面回到「打开预览」。
  await page.getByRole("button", { name: "关闭预览日志" }).click();
  await cancel.click();
  await page.waitForFunction(
    () => document.querySelector("[data-testid=notices]")?.textContent?.includes("已取消启动预览") ?? false,
    null,
    { timeout: 8000 },
  );
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("打开预览")),
    null,
    { timeout: 8000 },
  );

  // ②c 反过来那一半：关一个**已经起来的**预览时，按钮不能说自己「正在启动」。
  //     previewBusy 同时盖着「开」和「关」两件事，直接拿它推「正在启动」，用户点下
  //     「关闭预览」之后就会看到一颗「启动中·点此取消」，而且还能再点一次、再发一个
  //     DELETE，提示还是「已取消启动预览」——三处都是错的。
  const closing = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await closing.goto(`${base}?mode=ready-close`);
  const closeButton = closing.getByRole("button", { name: "关闭预览" });
  await closeButton.waitFor();
  await closeButton.click();
  const closingButton = closing.getByRole("button", { name: "关闭中" });
  await closingButton.waitFor({ timeout: 5000 });
  assert.equal(await closingButton.isDisabled(), true, "关闭请求还挂着，这颗不该还能再点");
  assert.equal(
    await closing.getByRole("button", { name: "启动中·点此取消" }).count(), 0,
    "关一个已就绪的预览，按钮却说它正在启动",
  );
  await closing.close();

  // ③ spawn 之前就 409：多候选时 resolvePreviewCommand 直接抛，一条命令都没跑过，
  //    盘上没有日志文件。那颗乐观按钮必须跟着收回去。
  const race = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await race.goto(`${base}?mode=pre-spawn`);
  const preOpen = race.getByRole("button", { name: "打开预览" });
  await preOpen.waitFor();
  await preOpen.click();
  // 等这一轮结束（按钮从「处理中」变回「打开预览」）。
  await race.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("打开预览")),
    null,
    { timeout: 8000 },
  );
  assert.match(await race.getByTestId("notices").textContent() ?? "", /认出了 3 个/, "409 的原因得如实说出来");
  assert.equal(
    await race.getByTestId("preview-log-open").count(),
    0,
    "spawn 之前就失败时不该留下日志入口——点开只会说「还没有预览日志」",
  );

  console.log("preview log live: ok");
} finally {
  await browser?.close();
  await server.close();
}
