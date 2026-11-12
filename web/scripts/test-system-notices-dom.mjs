import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./dom-stage.mjs";
import { createServer } from "vite";
import { resizeViewport } from "./wait-until.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", define: { "import.meta.env.VITE_ASH_PREVIEW": '"1"' },
  server: { host: "127.0.0.1", port: 0, strictPort: false } });

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object");
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1300 } });
  const fixture = `http://127.0.0.1:${address.port}/scripts/fixtures/system-notices.html`;
  await page.goto(fixture);

  const action = page.locator(".system-action-note.is-conflict");
  await action.waitFor();
  assert.equal(await page.locator(".system-notice-mode-switch").count(), 0, "四套试验摆法连同切换条一起拿掉了");
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

  // —— 会话里平时只有你说的、它说的、里程碑一句，以及出了岔子 / 要你知道的 ——
  const lines = page.locator(".task-conversation-feed .notice-line, .notice-line");
  assert.deepEqual(
    await lines.locator(".notice-line-text").allInnerTexts(),
    ["已验收，合并到 main", "冲突交接失败：没能叫醒该任务解冲突。", "本回合没有交卷：产物仍保留，可直接重试。", "工作区已恢复，会话内容都在"],
    "回执（审查已预约、不再等、验收阶段、本轮执行结束）不在会话里占行",
  );
  assert.deepEqual(
    await lines.evaluateAll((elements) => elements.map((el) => [...el.classList].filter((name) => /^(is|tone)-/.test(name)).join(" "))),
    ["is-milestone tone-ok", "is-alert tone-bad", "is-alert tone-warn", "is-alert tone-neutral"],
  );
  const milestone = lines.first();
  const iconColors = await lines.evaluateAll((elements) => elements.map((el) => ({
    icon: getComputedStyle(el.querySelector(".notice-line-icon")).color,
    text: getComputedStyle(el.querySelector(".notice-line-text")).color,
  })));
  assert.notEqual(iconColors[0].icon, iconColors[0].text, "颜色只落在行首图标上");
  assert.equal(new Set(iconColors.map((c) => c.text)).size, 1, "几档的字是同一种颜色，结论写在字里");

  // 头像轴：图标中心对智能体头像中心，字对正文起点。
  const axis = await page.evaluate(() => {
    const avatar = document.querySelector(".task-message-avatar").getBoundingClientRect();
    const body = document.querySelector(".task-message-content").getBoundingClientRect();
    const line = document.querySelector(".notice-line");
    const icon = line.querySelector(".notice-line-icon").getBoundingClientRect();
    const text = line.querySelector(".notice-line-text").getBoundingClientRect();
    const actionIcon = document.querySelector(".system-action-icon").getBoundingClientRect();
    const actionMain = document.querySelector(".system-action-main").getBoundingClientRect();
    return {
      avatar: Math.round(avatar.left + avatar.width / 2),
      icon: Math.round(icon.left + icon.width / 2),
      action: Math.round(actionIcon.left + actionIcon.width / 2),
      body: Math.round(body.left),
      text: Math.round(text.left),
      actionMain: Math.round(actionMain.left),
    };
  });
  assert.equal(axis.icon, axis.avatar, "里程碑图标落在头像轴上");
  assert.equal(axis.action, axis.avatar, "系统长提示同样进入头像轴");
  assert.equal(axis.text, axis.body, "里程碑的字与智能体正文起点对齐");
  assert.equal(axis.actionMain, axis.body, "系统长提示正文与智能体正文起点对齐");

  // 里程碑的时刻紧跟在字后面，指到这一行才出。
  const tailOpacity = () => milestone.locator(".notice-line-tail").evaluate((el) => getComputedStyle(el).opacity);
  await page.mouse.move(990, 5);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".notice-line-tail")).opacity === "0");
  await milestone.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".notice-line-tail")).opacity === "1");
  assert.equal(await tailOpacity(), "1");
  const tailGap = await milestone.evaluate((el) => {
    const text = el.querySelector(".notice-line-text").getBoundingClientRect();
    const tail = el.querySelector(".notice-line-tail").getBoundingClientRect();
    return Math.round(tail.left - text.right);
  });
  assert.ok(tailGap >= 0 && tailGap <= 16, `时刻紧跟在字后面（隔了 ${tailGap}px）`);

  // 长原文只写一句，点开那一行才看全文。
  const workspace = lines.nth(3);
  await workspace.locator(".notice-line-button").click();
  assert.match(await workspace.locator(".notice-line-detail").innerText(), /原目录已不存在/);
  assert.equal(await workspace.locator(".notice-line-button").getAttribute("aria-expanded"), "true");

  // —— 回执记在它所属的那一回合上：平时不画，指到这一回合才有「N 条记录」 ——
  const owner = page.locator(".task-message--agent").filter({ hasText: "冲突已经解决并提交。" });
  // 收了口的回合里，「N 条记录」是回合尾那一排悬停操作里的一颗（复制 / 派生 / 更多 旁边）。
  const receipts = owner.locator(".turn-acts");
  assert.equal(await owner.locator(".turn-receipts-toggle").count(), 1, "回执记到了它之前最近的那一回合上");
  const actsOpacity = () => receipts.evaluate((el) => getComputedStyle(el).opacity);
  await page.mouse.move(990, 5);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-acts:has(.turn-receipts-toggle)")).opacity === "0");
  await owner.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-acts:has(.turn-receipts-toggle)")).opacity === "1");
  const toggle = receipts.locator(".turn-receipts-toggle");
  assert.equal(await toggle.innerText(), "4 条记录");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  const log = owner.locator(".turn-receipt-log");
  assert.deepEqual(
    await log.locator(".turn-receipt-text").allInnerTexts(),
    ["审查已预约，这一轮跑完自动开始", "不再等「全量回归」了，它已经跑完", "验收阶段：验收完成", "本轮执行结束"],
    "流水里每一条写的是结果",
  );
  const leading = await log.locator(".turn-receipt").first().evaluate((el) => {
    const time = el.querySelector(":scope > time");
    const text = el.querySelector(".turn-receipt-text").getBoundingClientRect();
    return { first: el.firstElementChild === time, before: time.getBoundingClientRect().right <= text.left, label: time.getAttribute("aria-label") };
  });
  assert.equal(leading.first, true, "时刻排在每一条最前面");
  assert.equal(leading.before, true);
  assert.match(leading.label, /\d\d\/\d\d \d\d:\d\d/, "读屏拿到完整的日期时刻");
  await page.mouse.move(990, 5);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-acts:has(.turn-receipts-toggle)")).opacity === "1");
  assert.equal(await actsOpacity(), "1", "点开以后一直在，不等指到");
  const released = log.locator(".turn-receipt").nth(1);
  await released.locator(".turn-receipt-more").click();
  assert.match(await released.locator(".turn-receipt-detail").innerText(), /exit 0/, "原文点那一条再看");

  // 键盘：Tab 走到「N 条记录」时它现形，焦点看得见。
  await page.reload();
  await page.locator(".turn-receipts-toggle").first().waitFor({ state: "attached" });
  await page.mouse.move(990, 5);
  await page.locator(".turn-receipts-toggle").first().focus();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-acts:has(.turn-receipts-toggle)")).opacity === "1", null, { timeout: 2000 });

  // 触屏没有「指到」：回执那颗键与里程碑的时刻常显。
  const touch = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true });
  const touchPage = await touch.newPage();
  await touchPage.goto(fixture);
  await touchPage.locator(".notice-line").first().waitFor();
  assert.equal(await touchPage.evaluate(() => matchMedia("(hover: none)").matches), true, "模拟的触屏得真是「没有指到」");
  assert.equal(await touchPage.locator(".notice-line-tail").first().evaluate((el) => getComputedStyle(el).opacity), "1", "触屏上时刻常显");
  assert.equal(await touchPage.locator(".turn-acts:has(.turn-receipts-toggle)").first().evaluate((el) => getComputedStyle(el).opacity), "1", "触屏上「N 条记录」常显");
  await touch.close();

  await resizeViewport(page, { width: 390, height: 900 });
  const geometry = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    actionWidth: Math.round(document.querySelector(".system-action-note").getBoundingClientRect().width),
  }));
  assert.equal(geometry.overflow, false, "窄屏不能横向溢出");
  assert.ok(geometry.actionWidth <= 370, "系统旁注应收进窄屏可用宽度");

  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/review-system-prompts.html`);
  await page.locator('[data-surface="team"] .is-system-authored').waitFor();
  const authoredStyles = await page.evaluate(() => {
    const read = (surface) => {
      const root = document.querySelector(`[data-surface="${surface}"]`);
      const authored = root.querySelector(".is-system-authored");
      const authoredBubble = authored.querySelector(surface === "task" ? ".task-user-bubble" : ":scope > div");
      const authoredText = authoredBubble.querySelector(".task-markdown");
      const user = root.querySelector(surface === "task"
        ? ".task-message--user:not(.is-system-authored)"
        : ".team-feed-user:not(.is-system-authored)");
      const userBubble = user.querySelector(surface === "task" ? ".task-user-bubble" : ":scope > div");
      const articleStyle = getComputedStyle(authored);
      const bubbleStyle = getComputedStyle(authoredBubble);
      const userArticleStyle = getComputedStyle(user);
      const userBubbleStyle = getComputedStyle(userBubble);
      return {
        justify: articleStyle.justifyContent,
        background: bubbleStyle.backgroundColor,
        borderTop: bubbleStyle.borderTopWidth,
        borderLeft: bubbleStyle.borderLeftWidth,
        radius: bubbleStyle.borderRadius,
        fontSize: getComputedStyle(authoredText).fontSize,
        userJustify: userArticleStyle.justifyContent,
        userBackground: userBubbleStyle.backgroundColor,
        userBorderTop: userBubbleStyle.borderTopWidth,
        userRadius: userBubbleStyle.borderRadius,
      };
    };
    return { task: read("task"), team: read("team") };
  });
  for (const [surface, styles] of Object.entries(authoredStyles)) {
    assert.equal(styles.justify, "flex-start", `${surface} 审查系统提示必须左对齐`);
    assert.equal(styles.background, "rgba(0, 0, 0, 0)", `${surface} 审查系统提示不使用用户气泡底色`);
    assert.equal(styles.borderTop, "0px", `${surface} 审查系统提示不使用用户气泡外框`);
    assert.equal(styles.borderLeft, "2px", `${surface} 审查系统提示保留原来的短竖线`);
    assert.equal(styles.radius, "0px", `${surface} 审查系统提示不使用用户气泡圆角`);
    assert.equal(styles.fontSize, "12px", `${surface} 审查系统提示保留原字号`);
    assert.equal(styles.userJustify, "flex-end", `${surface} 普通用户消息仍右对齐`);
    assert.notEqual(styles.userBackground, "rgba(0, 0, 0, 0)", `${surface} 普通用户气泡仍保留底色`);
    assert.notEqual(styles.userBorderTop, "0px", `${surface} 普通用户气泡仍保留外框`);
    assert.notEqual(styles.userRadius, "0px", `${surface} 普通用户气泡仍保留圆角`);
  }

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  await page.goto(`${fixture}?boundaries`);
  await page.locator("[data-surface] .system-boundary").first().waitFor();
  for (const width of [1100, 390]) {
    await resizeViewport(page, { width, height: 1000 });
    const boundaries = await page.locator("[data-surface] .system-boundary").evaluateAll((elements) =>
      elements.map((element) => ({
        surface: element.closest("[data-surface]").dataset.surface,
        error: element.classList.contains("is-error"),
        rules: [...element.querySelectorAll(".system-boundary-rule")].map((rule) => {
          const box = rule.getBoundingClientRect();
          return { width: box.width, height: box.height, hidden: rule.getAttribute("aria-hidden") };
        }),
      })),
    );
    assert.equal(boundaries.length, 4, "两种会话和两种结束状态都应覆盖");
    for (const boundary of boundaries) {
      const label = `${width}px ${boundary.surface}/${boundary.error ? "error" : "neutral"}`;
      assert.equal(boundary.rules.length, 2, `${label} 两侧各一条分隔线`);
      for (const rule of boundary.rules) {
        assert.equal(rule.height, 1, `${label} 分隔线应为 1px`);
        assert.ok(rule.width > 0, `${label} 分隔线应保持可见`);
        assert.equal(rule.hidden, "true", `${label} 装饰横线不应进入无障碍朗读`);
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px 回合边界不应横向溢出`);
  }
  if (process.env.BOUNDARY_SHOT) {
    await resizeViewport(page, { width: 1100, height: 1000 });
    await page.screenshot({ path: process.env.BOUNDARY_SHOT, fullPage: true });
  }
  console.log("system-notices-dom ok");
} finally {
  await browser?.close();
  await server.close();
}
