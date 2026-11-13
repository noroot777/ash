// 审查轮在会话里的实际渲染：出了结论的一轮是被审那一回合尾注里的一句（谁审的、用时指到才出），
// 还在跑的一轮是一张卡。判定逻辑由 test:reviewer-turn 钉住，这里钉的是「看得出来」和「没动别的」。
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

  // 收了口的审查轮不占行：结论记在它前面那一回合上，同一回合重审过的只留最近一次。
  assert.equal(await page.locator(".review-milestone, .notice-line").count(), 0, "审查结论不再独占一行");
  // 摊开一轮以后审查者的发言也是 .task-message--agent：按顶层那两回合认，不按下标数。
  const footnoteOf = (index) => page.locator(".task-conversation > .task-message--agent").nth(index).locator(":scope > .task-message-content > .turn-footnote");
  assert.deepEqual(
    await messages.evaluateAll((els) => els.map((el) => [...el.querySelectorAll(".turn-footnote-text")].map((t) => t.textContent))),
    [["第 2 轮验证未通过"], ["第 1 轮审查通过"]],
    "一回合一句结论；自由派审不沿用就地验证的「验证」；重跑、重审过的不并排",
  );
  assert.equal(await page.locator(".turn-footnote-dot").count(), 0, "前一回合上的未通过是过去的事，通过不带颜色");
  assert.equal(await page.locator(".turn-footnote svg").count(), 0, "尾注没有图标");

  // 谁审的、用时、时刻跟在字后面，指到才出。
  const first = footnoteOf(0);
  assert.equal(await first.locator(".turn-footnote-tail").innerText(), "codex@cpa·gpt-5.6-sol · 30m 0s · 08/10 12:10");
  await page.mouse.move(990, 5);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-footnote-tail")).opacity === "0");
  await first.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-footnote-tail")).opacity === "1");
  assert.equal(await footnoteOf(1).locator(".turn-footnote-tail").innerText(), "claude@5.5审查 · 12m 0s · 08/10 23:13");

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
    ["第 3 轮验证通过", "第 1 轮审查没有给出结论", "第 1 轮审查通过"],
    "被盖过的结论照样在记录里",
  );
  assert.equal(await page.locator(".turn-receipt-log").filter({ hasText: "继续（从中断处）" }).count(), 1, "审查轮里的续跑标记不外露");

  // 没有右侧审查格可去（只读视图）：点那一句就在尾注下面摊开这一轮；键盘走得到。
  const part = first.locator("button.turn-footnote-part");
  await part.focus();
  await page.keyboard.press("Enter");
  assert.equal(await part.getAttribute("aria-expanded"), "true");
  const body = first.locator(".turn-footnote-lane");
  await body.waitFor();
  const reviewerTurn = body.locator(".task-message--agent.is-reviewer");
  assert.equal(await reviewerTurn.count(), 1, "审查者的发言在这一轮里");
  assert.equal(await reviewerTurn.locator(".turn-head > b").count(), 0, "身份由那一句代言");
  assert.equal(await reviewerTurn.locator(".task-message-avatar").count(), 0, "摊开的那一轮里不再挂头像");
  const aligned = await page.evaluate(() => {
    const line = document.querySelector(".turn-footnote-text").getBoundingClientRect();
    const turn = document.querySelector(".turn-footnote-lane .task-message-content").getBoundingClientRect();
    return { line: Math.round(line.left), turn: Math.round(turn.left) };
  });
  assert.ok(aligned.turn >= aligned.line, "摊开的发言收在那一句下面，不往外凸");

  // 报告沿用现有应用内 Markdown 弹层，不另开标签页。
  const pageCount = page.context().pages().length;
  await body.getByRole("button", { name: "审查报告" }).click();
  const reportDialog = page.getByRole("dialog", { name: /report\.md/ });
  await reportDialog.waitFor();
  await reportDialog.getByText(/第 2 轮审查报告/).waitFor();
  assert.equal(page.context().pages().length, pageCount);
  await reportDialog.getByRole("button", { name: "关闭审查报告" }).click();

  // 自由派审走另一条带 runId 的路由；启动失败那一次不占用后来重跑生成的报告。
  await footnoteOf(1).locator("button.turn-footnote-part").click();
  const freeBody = footnoteOf(1).locator(".turn-footnote-lane");
  assert.equal(await freeBody.locator(".task-message--agent.is-reviewer").count(), 1, "自由派审的正文归它自己那一轮");
  await freeBody.getByRole("button", { name: "审查报告" }).click();
  const freeDialog = page.getByRole("dialog", { name: /report\.md/ });
  await freeDialog.getByText(/自由派审报告 fr1 第 1 轮/).waitFor();
  await freeDialog.getByRole("button", { name: "关闭审查报告" }).click();
  await part.click();
  assert.equal(await first.locator(".turn-footnote-lane").count(), 0, "再点一下收起");

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
      footnote: ratio(document.querySelector(".turn-footnote-text")),
    };
  });
  for (const [name, value] of Object.entries(contrasts)) {
    assert.ok(value >= 4.5, `${name} 的对比度只有 ${value.toFixed(2)}:1，低于 WCAG AA 的 4.5:1`);
  }

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  console.log("reviewer-turn-dom ok");
} finally {
  await browser?.close();
  await web.close();
}
