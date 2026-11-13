// 审查轮在会话里的实际渲染：出了结论的一轮是被审那一回合之后、靠右的一颗审查结论气泡（谁审的、
// 用时指到才出），还在跑的一轮是一张卡。判定逻辑由 test:reviewer-turn 钉住，这里钉的是「看得出来」和「没动别的」。
// 设 SHOT=<路径> 可以顺带截一张图自查版式。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  await page.route(/\/api\/tasks\/t1\/review\/file/, async (route) => {
    const round = new URL(route.request().url()).searchParams.get("round") ?? "?";
    await route.fulfill({
      status: 200,
      contentType: "text/markdown; charset=utf-8",
      body: `# 第 ${round} 轮审查报告\n\n报告已在应用内打开。`,
    });
  });
  // 自由派审的报告是另一条路由，多带一个 runId —— 拼错的话点开就是 404。
  await page.route(/\/api\/tasks\/t1\/free-workflow\/review-file/, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({
      status: 200,
      contentType: "text/markdown; charset=utf-8",
      body: `# 自由派审报告 ${params.get("run")} 第 ${params.get("round")} 轮`,
    });
  });
  await page.goto(`${web.origin}/scripts/fixtures/reviewer-turn.html`);

  // 出了结论的轮次在会话里只剩一句：审查者那几段发言、报告都收在这一行后面。
  const messages = page.locator(".task-message--agent");
  await messages.first().waitFor();
  assert.equal(await messages.count(), 2, "平时只看得见实现与修复这两段；审查发言收在各自那一轮里");
  assert.equal(await page.locator(".task-message--agent.is-reviewer").count(), 0);
  for (const index of [0, 1]) {
    assert.equal(await messages.nth(index).locator(".turn-head > b").count(), 1, `第 ${index + 1} 段该报身份`);
  }

  // 收了口的审查轮是被审那一回合之后单独一行的气泡；同一回合重审过的只留最近一次。
  assert.equal(await page.locator(".review-milestone, .notice-line").count(), 0);
  const order = await page.locator(".task-conversation > *").evaluateAll((els) => els.map((el) =>
    el.classList.contains("review-verdict") ? `结论:${el.querySelector(".review-verdict-text").textContent}`
      : el.classList.contains("verify-lane") ? "审查卡"
        : el.classList.contains("task-message--agent") ? "回合" : null).filter(Boolean));
  assert.deepEqual(
    order,
    ["回合", "结论:第 2 轮验证未通过", "回合", "结论:第 1 轮审查通过", "审查卡"],
    "结论夹在被审回合和下一回合之间；自由派审不沿用就地验证的「验证」；重跑、重审过的不并排",
  );
  assert.equal(await page.locator(".task-conversation > .task-message--agent .turn-footnote").count(), 0, "被审回合下面不再说审查结论");
  assert.equal(await page.locator(".turn-footnote-dot").count(), 0, "前一回合上的未通过是过去的事，通过不带颜色");
  const bubbles = page.locator(".task-conversation > .review-verdict");
  const first = bubbles.nth(0);
  // 靠右，跟你的气泡同一列；不垫底色，只有一圈细边。
  const shape = await first.locator(".review-verdict-bubble").evaluate((el) => {
    const conversation = document.querySelector(".task-conversation");
    const style = getComputedStyle(conversation);
    const right = conversation.getBoundingClientRect().right - Number.parseFloat(style.paddingRight);
    const bubble = getComputedStyle(el);
    return { gap: Math.round(right - el.getBoundingClientRect().right), background: bubble.backgroundColor, border: bubble.borderTopWidth, icons: el.querySelectorAll(".review-verdict-text svg").length };
  });
  assert.deepEqual(shape, { gap: 0, background: "rgba(0, 0, 0, 0)", border: "1px", icons: 0 });

  // 「审查者 · 谁审的 · 用时 · 时刻」指到气泡才在它上方浮出，不占排版高度：指上指下会话不跳。
  const head = first.locator(".review-verdict-bubble > header");
  assert.equal(await head.textContent(), "审查者 · codex@cpa·gpt-5.6-sol · 30m 0s · 08/10 12:10");
  await page.mouse.move(990, 5);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".review-verdict-bubble > header")).opacity === "0");
  const before = await messages.nth(1).boundingBox();
  await first.locator(".review-verdict-bubble").hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".review-verdict-bubble > header")).opacity === "1");
  assert.deepEqual(await messages.nth(1).boundingBox(), before, "那一行出不出现，会话都不跳");
  const placed = await first.evaluate((el) => {
    const bubble = el.querySelector(".review-verdict-bubble").getBoundingClientRect();
    const line = el.querySelector(".review-verdict-bubble > header").getBoundingClientRect();
    return { above: line.bottom <= bubble.top + 1, right: Math.abs(bubble.right - line.right) <= 4 };
  });
  assert.deepEqual(placed, { above: true, right: true }, "浮在气泡上方右侧");
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.querySelector(".review-verdict-bubble > header b")).fontWeight),
    "500",
    "「审查者」跟你的气泡上「你」同一种字重",
  );
  assert.equal(await bubbles.nth(1).locator(".review-verdict-bubble > header").textContent(), "审查者 · claude@5.5审查 · 12m 0s · 08/10 23:13");

  // 还在跑的那一轮照旧是整张卡：看得见审查者在说什么（这一轮还没开口，卡里是空的）。
  const lanes = page.locator(".verify-lane");
  assert.deepEqual(await lanes.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))), ["第 2/5 轮审查"]);
  assert.equal(await lanes.first().evaluate((el) => el.classList.contains("is-collapsed")), true, "空正文按收起态绘制");
  assert.equal(await lanes.first().locator(".verify-lane-body > *").count(), 0);
  assert.deepEqual(await lanes.first().locator(".verify-lane-actions > button").allInnerTexts(), [], "空正文没有无效展开按钮");
  assert.match(await lanes.first().locator(".verify-lane-state").innerText(), /进行中/);

  assert.equal(await page.getByText(/审查开始|审查重跑上一回合/).count(), 0, "开始旁注不在会话里");
  assert.equal(await page.getByText(/请先完整读取 report\.md/).count(), 0, "自由审查修复 prompt 不伪装成系统消息块");
  // 普通任务的续跑标记、连同审查结论，都是那一回合的记录；审查轮里的那条续跑标记不外露。
  await messages.nth(0).hover();
  await messages.nth(0).locator(".turn-receipts-toggle").click();
  const firstLog = await messages.nth(0).locator(".turn-receipt-log").innerText();
  assert.match(firstLog, /继续（从中断处）[\s\S]*第 2 轮验证未通过/);
  await messages.nth(1).hover();
  await messages.nth(1).locator(".turn-receipts-toggle").click();
  assert.deepEqual(
    await messages.nth(1).locator(".turn-receipt-text").allInnerTexts(),
    ["第 3 轮验证通过", "第 1 轮审查没能开始", "第 1 轮审查通过"],
    "被盖过的结论照样在记录里；没能开始的那一轮不说成没有结论",
  );
  assert.equal(await page.locator(".turn-receipt-log").filter({ hasText: "继续（从中断处）" }).count(), 1, "审查轮里的续跑标记不外露");
  // 被盖过的那几轮尾注里不再说，记录里那一条就是它的入口：没有审查格可去，就在记录下面摊开那一轮。
  const secondLog = messages.nth(1).locator(".turn-receipt-log");
  const supersededVerify = secondLog.locator("button.turn-receipt-more", { hasText: "第 3 轮验证通过" });
  await supersededVerify.click();
  assert.equal(await supersededVerify.getAttribute("aria-expanded"), "true");
  const supersededBody = secondLog.locator(".turn-receipt-lane .turn-footnote-lane");
  await supersededBody.waitFor();
  assert.equal(await supersededBody.locator(".task-message--agent.is-reviewer").count(), 1, "被盖过的那一轮的发言还找得回来");
  await supersededBody.getByRole("button", { name: "审查报告" }).click();
  const supersededReport = page.getByRole("dialog", { name: /report\.md/ });
  await supersededReport.getByText(/第 3 轮审查报告/).waitFor();
  await supersededReport.getByRole("button", { name: "关闭审查报告" }).click();
  await supersededVerify.click();
  assert.equal(await secondLog.locator(".turn-receipt-lane").count(), 0, "再点一下收起");
  // 启动失败那一次不能占用后来重跑生成的报告。
  const abortedEntry = secondLog.locator("button.turn-receipt-more", { hasText: "第 1 轮审查没能开始" });
  await abortedEntry.click();
  await secondLog.locator(".turn-receipt-lane").waitFor();
  assert.equal(await secondLog.locator(".turn-receipt-lane").getByRole("button", { name: "审查报告" }).count(), 0);
  await abortedEntry.click();

  // 没有右侧审查格可去（只读视图）：点气泡就在它下面摊开这一轮；键盘走得到。
  await page.mouse.move(990, 5);
  const part = first.locator("button.review-verdict-text");
  await part.focus();
  // 键盘走到气泡，那一行同样浮出。
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".review-verdict-bubble > header")).opacity === "1");
  await page.keyboard.press("Enter");
  assert.equal(await part.getAttribute("aria-expanded"), "true");
  const body = first.locator(":scope > .turn-footnote-lane");
  await body.waitFor();
  const reviewerTurn = body.locator(".task-message--agent.is-reviewer");
  assert.equal(await reviewerTurn.count(), 1, "审查者的发言在这一轮里");
  assert.equal(await reviewerTurn.locator(".turn-head > b").count(), 0, "身份由气泡代言");
  assert.equal(await reviewerTurn.locator(".task-message-avatar").count(), 0, "摊开的那一轮里不再挂头像");
  const spread = await page.evaluate(() => {
    const lane = document.querySelector(".review-verdict > .turn-footnote-lane").getBoundingClientRect();
    const bubble = document.querySelector(".review-verdict-bubble").getBoundingClientRect();
    const executor = document.querySelector(".task-conversation > .task-message--agent .task-message-content").getBoundingClientRect();
    return { left: Math.round(lane.left - executor.left), wider: lane.width > bubble.width, below: lane.top >= bubble.bottom };
  });
  assert.deepEqual(spread, { left: 0, wider: true, below: true }, "摊开的那一块在气泡下面、占满正文宽度，左缘跟回合正文对齐");
  assert.equal(await body.getByRole("button", { name: "审查报告" }).count(), 0, "报告键在气泡那一行里，摊开的经过里不再出一颗");

  // 报告键在指到才出的那一行里，键盘走得到；沿用现有应用内 Markdown 弹层，不另开标签页。
  const pageCount = page.context().pages().length;
  const reportKey = head.getByRole("button", { name: "审查报告" });
  await reportKey.focus();
  await page.keyboard.press("Enter");
  const reportDialog = page.getByRole("dialog", { name: /report\.md/ });
  await reportDialog.waitFor();
  await reportDialog.getByText(/第 2 轮审查报告/).waitFor();
  assert.equal(page.context().pages().length, pageCount);
  await reportDialog.getByRole("button", { name: "关闭审查报告" }).click();

  // 自由派审走另一条带 runId 的路由；启动失败那一次不占用后来重跑生成的报告。
  await bubbles.nth(1).locator("button.review-verdict-text").click();
  const freeBody = bubbles.nth(1).locator(":scope > .turn-footnote-lane");
  assert.equal(await freeBody.locator(".task-message--agent.is-reviewer").count(), 1, "自由派审的正文归它自己那一轮");
  await bubbles.nth(1).locator(".review-verdict-bubble").hover();
  await bubbles.nth(1).locator(".review-verdict-bubble > header").getByRole("button", { name: "审查报告" }).click();
  const freeDialog = page.getByRole("dialog", { name: /report\.md/ });
  await freeDialog.getByText(/自由派审报告 fr1 第 1 轮/).waitFor();
  await freeDialog.getByRole("button", { name: "关闭审查报告" }).click();
  await bubbles.nth(1).locator("button.review-verdict-text").click();
  await part.click();
  assert.equal(await first.locator(":scope > .turn-footnote-lane").count(), 0, "再点一下收起");

  // 执行方恢复普通任务原来的无卡片排版。
  const layout = await page.evaluate(() => {
    const conversation = document.querySelector(".task-conversation");
    const style = getComputedStyle(conversation);
    const contentLeft = conversation.getBoundingClientRect().left + Number.parseFloat(style.paddingLeft);
    const executor = document.querySelector(".task-message--agent:not(.is-reviewer)");
    const lane = document.querySelector(".verify-lane");
    return {
      contentLeft: Math.round(contentLeft),
      executorLeft: Math.round(executor.getBoundingClientRect().left),
      executorBorder: getComputedStyle(executor).borderTopWidth,
      laneLeft: Math.round(lane.getBoundingClientRect().left),
      laneLine: Number.parseFloat(getComputedStyle(lane, "::before").width),
    };
  });
  assert.ok(Math.abs(layout.executorLeft - layout.contentLeft) <= 1, "执行消息贴住会话内容区左侧");
  assert.equal(layout.executorBorder, "0px", "执行消息无卡片排版");
  assert.ok(Math.abs(layout.laneLeft - layout.contentLeft) <= 1, "进行中的审查卡在会话内容区左侧");
  assert.equal(layout.laneLine, 2, "审查身份线细细一根");

  await page.setViewportSize({ width: 760, height: 1200 });
  const verdictFits = await page.evaluate(() => {
    const conversation = document.querySelector(".task-conversation").getBoundingClientRect();
    return [...document.querySelectorAll(".review-verdict-bubble")].every((el) => {
      const box = el.getBoundingClientRect();
      return box.left >= conversation.left && box.right <= conversation.right;
    });
  });
  assert.equal(verdictFits, true, "窄屏下气泡不撑破正文宽度");
  const narrow = await page.evaluate(() => {
    const conversation = document.querySelector(".task-conversation");
    const style = getComputedStyle(conversation);
    const available = conversation.getBoundingClientRect().width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    return { available: Math.round(available), lane: Math.round(document.querySelector(".verify-lane").getBoundingClientRect().width) };
  });
  assert.equal(narrow.lane, narrow.available, "较窄工作区里的审查卡铺满可用宽度");
  await page.setViewportSize({ width: 1000, height: 1200 });

  // 这几处小字承载的是「哪一轮、什么结论、谁在审」，按 WCAG 相对亮度实测至少 4.5:1。
  const contrasts = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const channel = (value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = (color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return 0.2126 * channel(r / 255) + 0.7152 * channel(g / 255) + 0.0722 * channel(b / 255);
    };
    const backdrop = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor;
        if (color && color !== "transparent" && !/,\s*0\s*\)$/.test(color)) return color;
      }
      return "#fff";
    };
    const ratio = (el) => {
      const front = luminance(getComputedStyle(el).color);
      const back = luminance(backdrop(el));
      return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
    };
    return {
      laneBy: ratio(document.querySelector(".verify-lane-by")),
      verdict: ratio(document.querySelector(".review-verdict-text")),
      verdictHead: ratio(document.querySelector(".review-verdict-bubble > header b")),
    };
  });
  for (const [name, value] of Object.entries(contrasts)) {
    assert.ok(value >= 4.5, `${name} 的对比度只有 ${value.toFixed(2)}:1，低于 WCAG AA 的 4.5:1`);
  }

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  // 触屏没有悬停：那一行常显在气泡里。
  const touch = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true });
  await touch.goto(`${web.origin}/scripts/fixtures/reviewer-turn.html`);
  await touch.locator(".review-verdict").first().waitFor();
  const touchHead = await touch.evaluate(() => {
    const bubble = document.querySelector(".review-verdict-bubble").getBoundingClientRect();
    const line = document.querySelector(".review-verdict-bubble > header");
    const box = line.getBoundingClientRect();
    return { opacity: getComputedStyle(line).opacity, inside: box.top >= bubble.top && box.bottom <= bubble.bottom };
  });
  assert.deepEqual(touchHead, { opacity: "1", inside: true });
  await touch.close();
  console.log("reviewer-turn-dom ok");
} finally {
  await browser?.close();
  await web.close();
}
