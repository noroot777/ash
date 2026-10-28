import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = fileURLToPath(new URL("../../output/playwright/", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
const message = (index) => {
  const kind = index % 5;
  const time = new Date(Date.UTC(2026, 9, 24, 10, 0, index)).toISOString();
  return {
    id: `msg-${index}`, taskId: "task-a", text: kind === 0 || kind === 4
      ? `【哨兵事件】检查-${index}（monitorId=monitor-${index}）\nREGRESSION_FINISHED exitCode=${kind === 4 ? 1 : 0} monitor=${index}`
      : `输入-${index}\n${"保留完整的正文与排队顺序。".repeat(8)}<img src=x onerror=alert(1)>`,
    attachments: kind === 1 ? ["/tmp/brief.txt"] : [], agent: "codex", executorId: null, model: null, reasoningEffort: null,
    sessionRole: kind === 2 ? "reviewer" : null, origin: kind === 0 || kind === 4 ? `monitor:${index}` : null,
    mode: kind === 3 ? "timed" : "queued", sendAt: time, status: "pending", createdAt: time, sentAt: null,
  };
};
let pending = Array.from({ length: 10 }, (_, index) => message(index));
let failCancel = false;
let releaseCancel;
const deleted = [];
const steered = [];
let browser;
try {
  await mkdir(artifacts, { recursive: true });
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (/\/tasks\/[^/]+\/scheduled-messages$/.test(path)) {
      await route.fulfill({ json: pending });
    } else if (/\/scheduled-messages\/[^/]+\/steer$/.test(path)) {
      const messageId = path.split("/").at(-2);
      steered.push(messageId);
      pending = pending.filter((item) => item.id !== messageId);
      await route.fulfill({ json: {} });
    } else if (/\/scheduled-messages\/[^/]+$/.test(path) && route.request().method() === "DELETE") {
      const messageId = path.split("/").at(-1);
      deleted.push(messageId);
      if (failCancel) {
        await route.fulfill({ status: 409, json: { error: "取消失败，输入继续排队" } });
      } else {
        await new Promise((resolve) => { releaseCancel = resolve; });
        pending = pending.filter((item) => item.id !== messageId);
        await route.fulfill({ json: {} });
      }
    } else await route.fulfill({ json: [] });
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/scheduled-message-tray.html`);
  const card = page.locator(".scheduled-message-card");
  const list = page.getByRole("region", { name: "排队输入完整列表" });
  const draft = page.getByRole("textbox", { name: "回复草稿" });
  const filter = (name) => page.getByRole("group", { name: "筛选待发送消息" }).getByRole("button", { name: new RegExp(`^${name}`) });
  const reload = async (messages) => {
    pending = messages;
    await page.getByRole("button", { name: "重新载入", exact: true }).click();
    await page.waitForFunction((count) => count === 0 ? !document.querySelector(".scheduled-message-tray")
      : document.querySelector(".scheduled-message-announcement")?.textContent?.startsWith(`${count} 条待发送消息`), messages.length);
  };
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = () => page.evaluate(() => {
    const rect = (selector) => { const box = document.querySelector(selector).getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height }; };
    return { card: rect(".scheduled-message-card"), draft: rect("textarea"), conversation: rect(".conversation-scroll-region") };
  });
  const expand = async () => { await page.getByRole("button", { name: /^展开全部/ }).click(); await list.waitFor(); await settle(); };
  await page.getByRole("button", { name: "展开全部 10 条" }).waitFor();
  assert.equal(await card.count(), 1);
  assert.equal(await card.locator(".scheduled-message-row").count(), 5);
  assert.equal(await card.locator(".scheduled-message-withdraw").count(), 4, "哨兵不应挡住后面的用户消息操作");
  assert.doesNotMatch(await card.locator(".scheduled-message-previews").innerText(), /monitorId=|REGRESSION_FINISHED|@codex/);
  assert.match(await card.innerText(), /我的消息 4 · 哨兵 4 · 审查答复 2 · 含 2 条定时/);
  const collapsed = await geometry();
  await expand();
  const expanded = await geometry();
  assert.ok(expanded.card.top < collapsed.card.top - 50, "原卡片必须向上长，而非另开浮层");
  assert.ok(Math.abs(expanded.card.bottom - collapsed.card.bottom) < 1, "卡片底边保持锚定");
  assert.ok(Math.abs(expanded.draft.top - collapsed.draft.top) < 1, "输入框不被挤走");
  assert.ok(expanded.conversation.height >= 99, "展开保留会话阅读空间");
  assert.equal(await card.count(), 1);
  assert.equal(await card.locator(".scheduled-message-previews").count(), 0);
  assert.equal(await card.locator(".scheduled-message-item").count(), 10);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await list.evaluate((element) => element.scrollHeight > element.clientHeight), true);
  await page.getByRole("button", { name: "会话区域按钮" }).click();
  assert.equal(await list.isVisible(), true, "点会话区域不收起内联卡片");
  await filter("哨兵").click();
  assert.deepEqual(await list.locator(".scheduled-message-item-meta > span:first-child").allTextContents(), ["#1", "#5", "#6", "#10"]);
  assert.equal(await list.getByRole("button", { name: /引导会话|撤回/ }).count(), 0);
  const filtered = await geometry();
  assert.equal(filtered.card.height, expanded.card.height, "筛选不引起卡片高度跳动");
  await filter("我的消息").click();
  assert.equal(await list.getByRole("button", { name: /引导会话/ }).count(), 1);
  assert.match(await list.getByRole("button", { name: /引导会话/ }).getAttribute("aria-label"), /输入-1/);
  await filter("审查答复").click();
  assert.equal(await list.getByRole("button").count(), 0, "审查链答复保持只读");
  await filter("需留意").click();
  assert.deepEqual(await list.locator(".scheduled-message-item-meta > span:first-child").allTextContents(), ["#5", "#10"]);
  await filter("全部").click();
  const details = list.locator('details[data-message-id="msg-1"]');
  await details.locator("summary").click();
  assert.equal(await details.locator(".scheduled-message-body img").count(), 0, "消息文本不得作为 HTML 执行");
  assert.match(await details.innerText(), /brief.txt/);
  await list.evaluate((element) => { element.scrollTop = 130; });
  const scrollTop = await list.evaluate((element) => element.scrollTop);
  await reload([...pending, message(10)]);
  assert.equal(await details.getAttribute("open"), "", "新输入不折叠已展开的正文");
  assert.ok(Math.abs(await list.evaluate((element) => element.scrollTop) - scrollTop) < 1, "新输入不重置阅读位置");
  await page.getByRole("button", { name: /收起列表/ }).click();
  await card.getByRole("button", { name: /^查看完整输入：输入-1/ }).click();
  assert.equal(await details.getAttribute("open"), "");
  assert.equal(await details.locator("summary").evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await list.count(), 0);
  assert.equal(await page.getByRole("button", { name: /^展开全部/ }).evaluate((element) => element === document.activeElement), true);
  await expand();
  await filter("哨兵").click();
  const cancel = list.getByRole("button", { name: /^取消哨兵事件/ }).first();
  await cancel.click();
  const dialog = page.getByRole("dialog", { name: "取消这次唤醒？" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /不执行停止哨兵操作/);
  assert.doesNotMatch(await dialog.innerText(), /仍在运行|后续事件仍会/);
  assert.equal(deleted.length, 0, "弹出确认框不能直接删除输入");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await list.isVisible(), true, "第一次 Esc 只关闭确认框");
  failCancel = true;
  await cancel.click();
  await dialog.getByRole("button", { name: "取消这次唤醒", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.match(await dialog.innerText(), /取消失败，输入继续排队/);
  assert.equal(pending.length, 11);
  failCancel = false;
  await dialog.getByRole("button", { name: "取消这次唤醒", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.task-confirm-dialog footer button:last-child')?.disabled);
  assert.equal(await dialog.getByRole("button", { name: "处理中…" }).isDisabled(), true);
  assert.equal(typeof releaseCancel, "function");
  releaseCancel();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector(".scheduled-message-announcement")?.textContent?.startsWith("10 条"));
  assert.deepEqual(deleted, ["msg-0", "msg-0"], "每次确认只取消所选输入，不停止哨兵");
  assert.equal(await list.isVisible(), true);
  await filter("我的消息").click();
  await list.getByRole("button", { name: /引导会话/ }).click();
  await page.waitForFunction(() => document.querySelector(".scheduled-message-announcement")?.textContent?.startsWith("9 条"));
  assert.deepEqual(steered, ["msg-1"]);
  assert.match(await list.getByRole("button", { name: /引导会话/ }).getAttribute("aria-label"), /输入-6/);
  for (const count of [0, 1, 2, 3]) {
    await reload(Array.from({ length: count }, (_, index) => message(index)));
    assert.equal(await card.count(), count > 0 ? 1 : 0, "所有非空数量均只有一张卡片");
    assert.equal(await page.locator(".scheduled-message-row").count(), Math.min(count, 2));
  }
  await expand();
  const managed = { ...message(2), attachments: ["/tmp/review-notes.txt"] };
  await reload([message(0), message(1), managed]);
  const managedDetails = page.locator('details[data-message-id="msg-2"]');
  await managedDetails.locator("summary").click();
  await reload([message(1), managed]);
  assert.equal(await list.count(), 1, "回到两条时保持同一卡片展开");
  assert.equal(await card.count(), 1);
  assert.equal(await managedDetails.getAttribute("open"), "", "三条降两条保留已打开的正文");
  assert.equal(await managedDetails.getByText("/tmp/review-notes.txt", { exact: true }).isVisible(), true);
  assert.match(await managedDetails.locator(".scheduled-message-body").innerText(), /保留完整的正文与排队顺序/);
  await reload([managed]);
  assert.equal(await managedDetails.getAttribute("open"), "", "只剩一条审查答复仍可读全文");
  assert.equal(await page.getByRole("button", { name: /撤回|引导会话|取消哨兵事件/ }).count(), 0, "查看审查答复不扩大操作权限");
  await page.reload();
  await expand();
  await managedDetails.locator("summary").click();
  assert.equal(await managedDetails.getByText("/tmp/review-notes.txt", { exact: true }).isVisible(), true, "刷新后一条消息仍有全文入口");
  await reload([message(0), message(1)]);
  for (const summary of await list.locator("summary").all()) await summary.click();
  assert.equal(await list.locator("details[open]").count(), 2, "两条中的哨兵和个人输入均可完整阅读");
  await reload(Array.from({ length: 10 }, (_, index) => message(index)));
  assert.equal(await list.isVisible(), true, "消息数量增加时保持同一卡片展开");
  await filter("审查答复").click();
  await reload(pending.filter((item) => !item.sessionRole));
  await page.waitForFunction(() => document.querySelector('.scheduled-message-filters button[aria-pressed="true"]')?.textContent?.startsWith("全部"));
  assert.equal(await list.locator(".scheduled-message-item").count(), 8, "审查分类消失后回到全部，不遗留不可选空筛选");
  await reload(Array.from({ length: 30 }, (_, index) => message(index)));
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 500 ? 700 : 900 });
    await settle();
    const position = await geometry();
    assert.ok(position.card.top >= 48, `${width}px 不裁剪卡片顶部`);
    assert.ok(position.draft.bottom <= (width < 500 ? 700 : 900), `${width}px 输入框保持可见`);
    assert.equal(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, `${width}px 卡片不横溢`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px 页面不横溢`);
    if (width === 1280 || width === 390) await page.screenshot({ path: `${artifacts}scheduled-message-production-${width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "切换团队", exact: true }).click();
  await settle();
  assert.equal(await list.getByRole("button", { name: /引导会话/ }).count(), 0, "团队入口不新增引导权限");
  const teamPosition = await geometry();
  assert.ok(teamPosition.card.top >= 48 && teamPosition.draft.bottom <= 700, "团队托盘和回复框同样保持可见");
  await page.screenshot({ path: `${artifacts}scheduled-message-production-team.png`, fullPage: true });
  await page.getByRole("button", { name: "切换任务", exact: true }).click();
  await page.getByRole("button", { name: "展开全部 30 条" }).waitFor();
  assert.equal(await list.count(), 0, "切换任务重置展开和筛选状态");
  assert.equal(await draft.inputValue(), "未发送的草稿", "浏览、筛选和取消哨兵不改动草稿");
  assert.deepEqual(errors, []);
  console.log("✓ 正式排队托盘：原卡片向上展开、输入框锚定、消息权限、筛选、正文阅读、确认失败/重试、引导、实时新增、任务切换及四档宽度通过");
} finally {
  releaseCancel?.();
  await browser?.close();
  await server.close();
}
