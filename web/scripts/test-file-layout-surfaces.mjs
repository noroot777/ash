import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// **平铺/目录树在另外两处清单上：Git 工作台「更改」、审查页「改动文件」轨。**
//
// 任务面板那一处由 test-scm-file-layout.mjs 钉。这里钉的是另外两处，以及**三处共用同一份
// 偏好**这件事——偏好写在一个 localStorage 键上，谁读错键，用户就会看到「在这边切了，翻到
// 那边又变回去」。
//
// 各自要守的点：
//   ① 工作台：目录行的批量操作只作用于这个目录下的文件，且**嵌套仓不算在内**（后端下不了
//      手，算进去就是承诺 N 个、实际动 N-1 个）；点文件仍然选中它去看 diff；
//   ② 审查页：选中态是按 sections 下标记的，摆成树之后下标不能错位——错了就是「点 A 开 B」；
//   ③ localStorage 用不了时，切换仍然当场生效（只是记不住），见文件末尾那一节。

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
  const base = `http://127.0.0.1:${address.port}/scripts/fixtures`;

  browser = await chromium.launch(await chromeLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // ── ① Git 工作台「更改」 ────────────────────────────────────────────────
  const gwb = await context.newPage();
  await gwb.goto(`${base}/change-file-list.html`);
  const gwbToggle = gwb.locator(".gwb-file-tools .file-layout-toggle");
  await gwbToggle.waitFor();

  assert.equal(await gwb.locator(".gwb-dir-row").count(), 0, "默认仍是平铺");
  assert.equal(
    await gwb.locator(".gwb-file-row", { hasText: "service.ts" }).locator(".file-dir").innerText(),
    "server/src/chat/",
    "平铺模式下所在目录写在行里",
  );

  await gwbToggle.click();
  await gwb.locator(".gwb-dir-row").first().waitFor();
  assert.deepEqual(
    // innerText 在这套 flex 行里会把目录名和「N 个文件」断成两行，只看内容不看断行。
    (await gwb.locator(".gwb-dir-row .file-name").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()),
    ["server 3 个文件", "scripts 1 个文件", "src/chat 2 个文件", "web/src/scm 1 个文件"],
    "单链目录压成一行；未暂存与未跟踪两组各自成树",
  );

  // 目录行的批量操作只送这个目录下的文件。（跟文件行一样，按钮指上去才浮出来。）
  const chatDir = gwb.locator(".gwb-dir-row", { hasText: "src/chat" });
  await chatDir.hover();
  await chatDir.getByRole("button", { name: "暂存 src/chat 下的 2 个文件" }).click();
  assert.equal(
    await gwb.locator("#action").innerText(),
    "stage:unstaged:server/src/chat/context.ts,server/src/chat/service.ts",
    "只动这个目录下的两个（按树里的显示顺序），同组里 scripts/ 和 README.md 一个都不许跟着走",
  );

  // 点文件仍然是「选中它去看 diff」，跟平铺时一样。
  await gwb.getByRole("button", { name: "server/src/chat/context.ts", exact: true }).click();
  assert.equal(await gwb.locator("#selection").innerText(), "unstaged:server/src/chat/context.ts");

  // 折叠：收起来的那棵子树整个消失，同级的不受影响。
  await gwb.getByRole("button", { name: "server（3 个文件）" }).click();
  assert.equal(await gwb.locator(".gwb-file-row", { hasText: "service.ts" }).count(), 0, "折叠后子树不再渲染");
  assert.equal(await gwb.locator(".gwb-file-row", { hasText: "README.md" }).count(), 1, "根上的文件跟它没关系");

  // ── ② 审查页「改动文件」轨 ──────────────────────────────────────────────
  const review = await context.newPage();
  await review.goto(`${base}/review-file-rail.html`);
  const rail = review.locator(".single-review-files");
  await rail.waitFor();

  // 偏好是三处共用的一份：工作台那边切成了树，这边打开就该已经是树。
  await rail.locator(".single-review-dir").first().waitFor();
  assert.deepEqual(
    await rail.locator(".single-review-dir code").allInnerTexts(),
    ["server", "scripts", "src/chat"],
    "同一份偏好跨面板生效，且单链目录照样压成一行",
  );
  assert.equal(
    await rail.locator(".single-review-dir", { hasText: "server" }).first().locator("span").innerText(),
    "+15\n−9",
    "目录行的加减是它底下所有文件的合计",
  );

  // 选中态按 sections 下标记：点树里那个文件，右边 diff 的标题必须是它。
  await rail.getByRole("button", { name: /^service\.ts/ }).click();
  assert.equal(
    await review.locator(".single-review-diff > header b").innerText(),
    "server/src/chat/service.ts",
    "摆成树之后下标不能错位——错了就是「点 A 开 B」",
  );

  // 切回平铺：行上重新写整条路径，选中的那一条不能丢。
  await review.locator(".single-review-layout").click();
  await review.waitForFunction(() => document.querySelectorAll(".single-review-dir").length === 0);
  assert.equal(
    await rail.locator("button.is-selected code").innerText(),
    "server/src/chat/service.ts",
    "切回平铺不该丢掉选中的那一条",
  );

  // 这一处切了，工作台那边刷新后也得跟着回到平铺。
  await gwb.reload();
  await gwb.locator(".gwb-file-tools .file-layout-toggle").waitFor();
  assert.equal(await gwb.locator(".gwb-dir-row").count(), 0, "偏好是共用的一份，谁改了另一处都得认");

  // ── ③ localStorage 用不了的环境（隐私模式、被策略禁掉、配额满）────────────────
  //
  // 存储是「记住下次」的手段，不该变成「这一次切不切得动」的前提。第 1 轮审查复现过：
  // 写失败时仍广播一个「去重新读存储」的同步事件，本页监听器立刻把刚切的树读回平铺，
  // 按钮按下去什么都不发生。
  const blocked = await browser.newContext({ viewport: { width: 520, height: 700 } });
  await blocked.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new Error("localStorage is blocked"); },
    });
  });
  const offline = await blocked.newPage();
  await offline.goto(`${base}/change-file-list.html`);
  const offlineToggle = offline.locator(".gwb-file-tools .file-layout-toggle");
  await offlineToggle.waitFor();
  assert.equal(await offlineToggle.getAttribute("aria-label"), "按目录树展示文件", "读不到存储就用默认的平铺");
  await offlineToggle.click();
  await offline.locator(".gwb-dir-row").first().waitFor();
  assert.equal(await offlineToggle.getAttribute("aria-label"), "按平铺列表展示文件",
    "存不下只意味着「下次打开还是默认那种」，不该让这一次切换按不动");
  await blocked.close();

  await context.close();
  console.log("file layout surfaces test passed");
} finally {
  await browser?.close();
  await server.close();
}
