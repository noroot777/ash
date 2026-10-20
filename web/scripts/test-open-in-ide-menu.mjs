// 「用 IDE 打开这个文件夹」的交互回归（web/src/files/OpenInIdeMenu.tsx + FolderViewer 工具条）。
//
// 钉住的是第 2 轮审查打回来的三件事，全都只有真点一次才看得见：
//  · F2 的界面那一半：服务端回 `status:"launching"` 时**只是没看到失败**，页面不许说
//    「已用 X 打开」。以前服务端把超时当成功、界面照抄，于是启动失败的编辑器也会得到
//    一句「已打开」，用户盯着没动静的屏幕以为自己点漏了。
//  · N3：探测请求卡住（既不返回也不断开）时菜单不能锁死——加载中要有「重新探测」，
//    而且它得真能作废在途那次；自己的期限到了要落到可重试的错误态。
//  · N1：中间栏收到 420px 时，文件夹详情的标题和「关闭」不许被挤出面板。
//
// 跑：npm -w web run test:open-in-ide-menu
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const PROBE = {
  platform: "darwin",
  note: null,
  ides: [
    { id: "vscode", name: "Visual Studio Code", detail: "/Applications/Visual Studio Code.app" },
    { id: "cursor", name: "Cursor", detail: "/Applications/Cursor.app" },
  ],
};
const OVERVIEW = {
  root: { path: "/tmp/fixture", label: "fixture", kind: "repo" },
  target: { path: "src", name: "src", kind: "dir", size: 0, mtime: null, absPath: "/tmp/fixture/src", symlink: false },
  stats: { files: 12, dirs: 3, bytes: 4096, truncated: false },
  entries: [],
  git: { repo: true, tracked: 12, dirty: 1, untracked: 0, untrackedSamples: [], error: null },
  trash: { available: true, label: "废纸篓", reason: null },
  readOnly: null,
  busy: { running: false, reason: null },
};

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
  const page = await browser.newPage();

  // 探测：默认正常返回；`probeMode` 一改，同一个路由就变成「永远不回」。
  let probeMode = "ok";
  const probeCalls = [];
  await page.route("**/api/ides**", async (route) => {
    probeCalls.push(route.request().url());
    if (probeMode === "hang") return; // 既不 fulfill 也不 abort —— 就是卡住的那种
    await new Promise((done) => setTimeout(done, 60));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PROBE) });
  });
  await page.route("**/api/tasks/*/file/overview**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(OVERVIEW) }));

  let launchStatus = "opened";
  const launchCalls = [];
  await page.route("**/api/tasks/*/file/open-in-ide", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    launchCalls.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, absPath: "/tmp/fixture/src", name: "Cursor", status: launchStatus }),
    });
  });

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/open-in-ide-menu.html`);

  const menu = page.locator(".file-viewer").last();
  const trigger = menu.getByRole("button", { name: /用 IDE 打开/ });
  await trigger.waitFor();
  assert.equal(probeCalls.length, 0, "没点开之前不该发起探测");

  // ── ① 确认过的那一档：说「已用 X 打开」────────────────────────────────
  await trigger.click();
  const cursor = page.getByRole("menuitem", { name: /Cursor/ });
  await cursor.waitFor({ timeout: 5000 });
  assert.equal(probeCalls.length, 1, `点一次只该探一次，实际 ${probeCalls.length} 次`);
  await cursor.click();
  await page.waitForFunction(() => document.querySelector("[data-testid=toast]")?.textContent);
  assert.deepEqual(launchCalls, [{ path: "src", ideId: "cursor" }]);
  assert.equal(await page.getByTestId("toast").textContent(), "已用 Cursor 打开");

  // 成功那一次之后才有「上次选的」——而且它说的就是「选」，不是「打开成功了」。
  await trigger.click();
  await page.getByRole("menuitem", { name: /Cursor/ }).waitFor();
  assert.equal(await menu.getByText("上次选的").count(), 1, "成功过的那个要被标出来");
  assert.equal(await menu.getByText("上次用的").count(), 0, "措辞不许回到「上次用的」");

  // ── ② 没确认的那一档：绝不能说「已打开」────────────────────────────────
  launchStatus = "launching";
  await page.getByRole("menuitem", { name: /Visual Studio Code/ }).click();
  await page.waitForFunction(() =>
    document.querySelector("[data-testid=toast]")?.textContent?.includes("Visual Studio Code"));
  const text = await page.getByTestId("toast").textContent();
  assert.ok(!/已用 .* 打开/.test(text), `没拿到确认就说「已用…打开」了：${text}`);
  assert.ok(/没等到|回执/.test(text), `要讲清楚我们没拿到确认，实际是：${text}`);

  // ── ③ 探测卡住：加载中也有出路，且它真能作废在途那次（N3）──────────────
  probeMode = "hang";
  await trigger.click();
  await page.getByRole("menuitem", { name: /重新探测/ }).click(); // force：作废缓存，发出会卡住的那一次
  await page.getByText("正在看本机装了哪些 IDE…").waitFor({ timeout: 5000 });
  const stuckCalls = probeCalls.length;
  const retryWhileLoading = page.getByRole("menuitem", { name: /重新探测/ });
  assert.equal(await retryWhileLoading.count(), 1, "加载中必须留着出路，否则一次卡住的请求就把菜单锁死了");
  probeMode = "ok";
  await retryWhileLoading.click();
  await page.getByRole("menuitem", { name: /Cursor/ }).waitFor({ timeout: 5000 });
  assert.ok(probeCalls.length > stuckCalls, "加载中点重试要真的再发一次，不是空按钮");
  await page.keyboard.press("Escape");

  // ── ④ 窄中栏：标题和「关闭」都还在面板里（N1）──────────────────────────
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector("[data-testid=narrow-panel]");
    const bar = panel.querySelector(".file-viewer__bar");
    const close = panel.querySelector('[aria-label="关闭文件夹，回到会话"]');
    const title = panel.querySelector(".file-viewer__title b");
    const box = panel.getBoundingClientRect();
    return {
      panelRight: box.right,
      panelLeft: box.left,
      barScrollWidth: bar.scrollWidth,
      barClientWidth: bar.clientWidth,
      close: close.getBoundingClientRect(),
      titleWidth: title.getBoundingClientRect().width,
      titleText: title.textContent,
    };
  });
  assert.ok(
    geometry.close.right <= geometry.panelRight + 0.5,
    `「关闭」跑到面板外了：按钮右边 ${geometry.close.right.toFixed(1)}，面板右边 ${geometry.panelRight.toFixed(1)}`,
  );
  assert.ok(geometry.close.left >= geometry.panelLeft - 0.5, "「关闭」也不该从左边溢出");
  assert.ok(geometry.titleWidth > 0, `文件夹名被压成零宽了（${geometry.titleText}）`);
  assert.ok(
    geometry.barScrollWidth <= geometry.barClientWidth + 0.5,
    `工具条仍然在横向溢出：scrollWidth ${geometry.barScrollWidth} > clientWidth ${geometry.barClientWidth}`,
  );

  // 真能点到才算数。
  await page.locator('[data-testid=narrow-panel] [aria-label="关闭文件夹，回到会话"]').click();
  await page.waitForFunction(() => !document.querySelector("[data-testid=narrow-panel] .file-viewer__bar"));

  console.log("✓ open-in-ide 菜单：launching 不说「已打开」、探测卡住有出路、420px 下标题与关闭都点得到");
} finally {
  await browser?.close();
  await server.close();
}
