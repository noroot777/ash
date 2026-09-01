import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object");
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 1300 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/system-notices.html`);

  const action = page.locator(".system-action-note.is-conflict");
  await action.waitFor();
  assert.equal(await action.count(), 1, "冲突流程只占一条系统旁注");
  assert.match(await action.innerText(), /验收遇到冲突.*目标分支未改动/s);
  assert.equal(await action.locator(".system-action-files").isHidden(), true, "冲突文件默认收进详情，不在会话里铺开");
  assert.equal(await page.locator(".task-message--user.is-system-authored:not(.system-action-wrap)").count(), 0, "不再保留旧系统消息块");
  const visual = await action.evaluate((el) => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow };
  });
  assert.equal(visual.background, "rgba(0, 0, 0, 0)", "系统指令不再使用卡片底色");
  assert.equal(visual.border, "0px", "系统指令不再使用卡片描边");
  assert.equal(visual.shadow, "none", "系统指令不再使用卡片阴影");
  await action.getByText("查看处理步骤", { exact: true }).click();
  assert.deepEqual(await action.locator(".system-action-files code").allInnerTexts(), ["server/package.json", "web/src/App.tsx"]);
  await action.getByText("流程记录 3 条", { exact: true }).click();
  assert.match(await action.innerText(), /开始验收.*验收未完成.*冲突交接/s, "原始流程记录仍可展开核对");

  assert.equal(await page.locator(".system-event-row.is-progress").count(), 1);
  assert.equal(await page.locator(".system-event-row.is-success").count(), 1);
  assert.equal(await page.locator(".system-event-row.is-error").count(), 1);
  assert.equal(await page.locator(".system-event-row.is-notice").count(), 1);
  assert.equal(await page.locator(".system-event-row.is-recovery").count(), 1);
  assert.equal(await page.locator(".system-boundary").count(), 1);
  assert.equal(await page.locator(".task-message--agent").count(), 2, "普通 agent 消息结构没有改");

  await page.setViewportSize({ width: 390, height: 900 });
  const geometry = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    actionWidth: Math.round(document.querySelector(".system-action-note").getBoundingClientRect().width),
  }));
  assert.equal(geometry.overflow, false, "窄屏不能横向溢出");
  assert.ok(geometry.actionWidth <= 370, "系统旁注应收进窄屏可用宽度");

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  console.log("system-notices-dom ok");
} finally {
  await browser?.close();
  await server.close();
}
