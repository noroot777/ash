// 会话流里那几颗复制按钮点完必须有**就地反馈**：气泡头部的图标、续写段尾栏的
// 「复制这条回复」、尾栏的会话 id 与 resume 命令胶囊。它们拿不到全局 toast，反馈全靠
// 按钮自己变（components/CopyButton.tsx）——没有反馈时「点了没生效」和「点了已生效」
// 长得一模一样，用户只能反复点。设 SHOT=<路径> 可以顺带截一张图自查版式。
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
  const context = await browser.newContext({ viewport: { width: 1000, height: 1100 }, timezoneId: "Asia/Shanghai" });
  const origin = `http://127.0.0.1:${address.port}`;
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  await page.goto(`${origin}/scripts/fixtures/copy-feedback.html`);
  await page.locator(".task-message--agent").first().waitFor();

  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

  // ① 气泡头部那颗图标：反馈只换图标，不塞文字（22×22 是写死的，塞字会把头部撑开），
  //    而且必须自己现形 —— 平时 opacity:0 靠悬停露脸，点完鼠标一移开就什么都看不见了。
  const header = page.locator(".task-message--agent header").filter({ has: page.locator("button.copy-button") }).first();
  const headerCopy = header.locator("button.copy-button").first();
  await header.hover();
  const sizeBefore = await headerCopy.boundingBox();
  await headerCopy.click();
  await page.waitForTimeout(120);
  assert.match(await headerCopy.getAttribute("class"), /is-copied/, "头部复制图标点完要进入已复制态");
  assert.equal((await headerCopy.innerText()).trim(), "", "只有图标的按钮不能因为反馈多出文字");
  assert.equal(await headerCopy.getAttribute("aria-label"), "已复制", "读屏用户的反馈只能来自 aria-label");
  const sizeAfter = await headerCopy.boundingBox();
  assert.equal(sizeBefore.width, sizeAfter.width, "反馈不能改变按钮宽度");
  assert.equal(sizeBefore.height, sizeAfter.height, "反馈不能改变按钮高度");
  assert.match(await clipboard(), /先探索一下现有结构/, "复制的是这条回复的 markdown");
  await page.mouse.move(2, 2);
  await page.waitForTimeout(60);
  assert.equal(
    await headerCopy.evaluate((node) => getComputedStyle(node).opacity),
    "1",
    "鼠标移开后反馈仍要看得见，否则等于没有反馈",
  );

  // ② 审查卡内首条发言的尾栏按钮：头部被卡头顶替，复制入口只剩这一颗，它有文字，
  //    反馈换成「已复制」。
  const action = page.locator("button.task-message-copy-action").first();
  await action.scrollIntoViewIfNeeded();
  await action.click();
  await page.waitForTimeout(120);
  assert.match((await action.innerText()).trim(), /已复制/, "「复制这条回复」点完要变成已复制");
  assert.match(await clipboard(), /审查结论/, "复制的是这条审查发言");

  // ③④ 尾栏的会话 id 与 resume 命令：两颗都要说清自己复制了什么，别只给一句「已复制」。
  const footer = page.locator(".task-message-footer").filter({ has: page.locator("button", { hasText: "resume" }) }).first();
  const sessionChip = footer.locator("button", { hasText: "会话 " }).first();
  await sessionChip.click();
  await page.waitForTimeout(120);
  assert.match((await sessionChip.innerText()).trim(), /已复制会话 id/);
  assert.equal(await clipboard(), "f753c251-1839-4d0e-9d2a-3b71c0c5e412");

  const resumeChip = footer.locator("button", { hasText: "resume" }).first();
  await resumeChip.click();
  await page.waitForTimeout(120);
  assert.match((await resumeChip.innerText()).trim(), /已复制 resume 命令/);
  assert.match(await clipboard(), /claude --resume f753c251/);

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  // 用户气泡那颗图标同源同款，一起钉住，免得下次只改一半。
  const userBubble = page.locator(".task-user-bubble header").first();
  await userBubble.hover();
  const userCopy = userBubble.locator("button.copy-button").first();
  await userCopy.click();
  await page.waitForTimeout(120);
  assert.match(await userCopy.getAttribute("class"), /is-copied/, "用户气泡的复制图标同样要有反馈");
  assert.equal(await clipboard(), "这块再改一下，右边留白太挤了");

  // 反馈是暂时的：一秒多之后按钮要自己回到常态，不能永远停在「已复制」。
  await page.waitForTimeout(1_800);
  assert.equal((await resumeChip.innerText()).trim(), "复制 resume 命令", "反馈过后要自己退回常态");
  assert.doesNotMatch(await resumeChip.getAttribute("class"), /is-copied/);

  console.log("copy feedback: 头部图标、续写段尾栏、会话 id、resume 命令四处点完都有就地反馈 ✔");
} finally {
  await browser?.close();
  await server.close();
}
