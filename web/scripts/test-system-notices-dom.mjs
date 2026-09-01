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
  const fixture = `http://127.0.0.1:${address.port}/scripts/fixtures/system-notices.html`;
  await page.goto(`${fixture}?systemNotices=footnote`);

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

  const digest = page.locator(".system-event-digest.is-footnote");
  assert.equal(await digest.count(), 1, "连续系统事件应合成一条会话脚注");
  assert.match(await digest.innerText(), /冲突交接失败.*5 条记录/s);
  const marker = await digest.evaluate((el) => {
    const style = getComputedStyle(el, "::before");
    return { width: style.width, height: style.height, radius: style.borderRadius, content: style.content };
  });
  assert.deepEqual(marker, { width: "4px", height: "4px", radius: "50%", content: '""' }, "脚注使用无方向性的 4px 圆点，不再显示弯箭头");
  const compactLine = await digest.locator("summary").evaluate((el) => {
    const text = el.querySelector(":scope > span").getBoundingClientRect();
    const time = el.querySelector(":scope > time").getBoundingClientRect();
    return {
      gap: Math.round(time.left - text.right),
      lineWidth: Math.round(el.getBoundingClientRect().width),
      containerWidth: Math.round(el.parentElement.getBoundingClientRect().width),
    };
  });
  assert.ok(compactLine.gap <= 80, "记录数可占一格，但时间不能被推到内容区最右侧");
  assert.equal(compactLine.lineWidth, compactLine.containerWidth, "系统提示应按内容收缩，不铺成整行");
  assert.ok(compactLine.containerWidth < 500, "短系统提示不应占满会话内容宽度");
  await digest.locator("summary").click();
  assert.match(await digest.innerText(), /已预约完成后审查.*验收阶段更新.*本回合没有交卷.*工作区已恢复/s);
  assert.equal(await page.locator(".system-event-row").count(), 0, "任务会话不再逐条铺系统事件");
  assert.equal(await page.locator(".system-boundary").count(), 1);
  assert.equal(await page.locator(".task-message--agent").count(), 2, "普通 agent 消息结构没有改");
  assert.equal(await page.locator(".system-notice-mode-switch a").count(), 3, "带模式参数时显示三版切换入口");

  await page.goto(`${fixture}?systemNotices=collapsed`);
  const collapsed = page.locator(".system-event-digest.is-collapsed");
  await collapsed.waitFor();
  assert.match(await collapsed.locator("summary").innerText(), /系统记录 · 冲突交接失败/);
  assert.equal(await page.locator('.system-notice-mode-switch a[aria-current="page"]').innerText(), "系统记录折叠");

  await page.goto(`${fixture}?systemNotices=attached`);
  const attached = page.locator(".system-event-digest.is-attached");
  await attached.waitFor();
  const attachedStyle = await attached.evaluate((el) => {
    const style = getComputedStyle(el);
    const line = el.querySelector("summary");
    const text = line.querySelector(":scope > span").getBoundingClientRect();
    const time = line.querySelector(":scope > time").getBoundingClientRect();
    return {
      marginTop: Number.parseFloat(style.marginTop),
      border: getComputedStyle(line).borderTopWidth,
      timeGap: Math.round(time.left - text.right),
    };
  });
  assert.ok(attachedStyle.marginTop < 0, "消息尾注应贴近上一段会话");
  assert.notEqual(attachedStyle.border, "0px", "消息尾注用细线表达它属于上一段消息");
  assert.ok(attachedStyle.timeGap <= 80, "消息尾注的时间同样应紧跟内容");
  assert.equal(await page.locator('.system-notice-mode-switch a[aria-current="page"]').innerText(), "消息尾注");

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
