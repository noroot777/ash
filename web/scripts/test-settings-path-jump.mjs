// 文案里的「设置 → 项目设置 → 预览 → 自定义脚本」是一条**能点着走过去的路**。
// 跑：npm -w web run test:settings-path-jump
//
// 钉四条：
//   ① 那段路径渲染成一颗能点的链接，且**一个字都没改**——这段话本身还要拿来照抄。
//   ② 点一下就进项目设置那一节。
//   ③ 而且停在**预览那张卡**上（滚进视口 + 点一下它），不是把人扔在页首自己找。
//   ④ 认不出去处的路径（设置里没有那一节）照旧是普通文字，不给一颗点了去错地方的链接。
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/settings-path-jump.html`);

  // ① 报一句「预览起不来」，那条路成了链接，原话没被改动。
  await page.getByTestId("raise-ambiguous").click();
  const link = page.getByRole("button", { name: "「设置 → 项目设置 → 预览 → 选择服务」" });
  await link.waitFor({ timeout: 5000 });
  const expected = await page.evaluate(() => window.__ambiguous);
  assert.equal(
    await page.evaluate(() => document.querySelector(".workspace-toast.is-sticky .workspace-toast-text")?.textContent),
    expected, "加了链接之后报错原文被改动了",
  );

  // ② + ③ 点它：进项目设置，并停在预览那张卡上。
  await link.click();
  await page.locator(".settings-shell").waitFor({ timeout: 5000 });
  const anchored = page.locator('[data-settings-anchor="preview"]');
  await anchored.waitFor({ timeout: 5000 });
  // 「就是这张」那一下（is-anchor-flash）证明落点找着了；类名 1.6s 后自己掉，所以先等它。
  await page.waitForFunction(
    () => document.querySelector('[data-settings-anchor="preview"]')?.classList.contains("is-anchor-flash") ?? false,
    undefined, { timeout: 5000 },
  );
  // 平滑滚动要几帧才停，等它真进视口再断言 —— 只看类名的话，选择器写错高度也发现不了。
  await page.waitForFunction(() => {
    const rect = document.querySelector('[data-settings-anchor="preview"]')?.getBoundingClientRect();
    return !!rect && rect.top >= -2 && rect.top < window.innerHeight * 0.5;
  }, undefined, { timeout: 5000 });

  // ④ 指向不存在的一节：只当普通文字，不长链接。
  await page.getByTestId("raise-unknown").click();
  const unknown = await page.evaluate(() => window.__unknownPath);
  await page.waitForFunction(
    (text) => document.querySelector(".workspace-toast.is-sticky .workspace-toast-text")?.textContent === text,
    unknown, { timeout: 5000 },
  );
  assert.equal(
    await page.evaluate(() => document.querySelectorAll(".workspace-toast .settings-path-link").length), 0,
    "认不出去处的路径也被画成了链接",
  );

  console.log("settings path jump: ok");
} finally {
  await browser?.close();
  await server.close();
}
