// 审查轮在会话里的实际渲染：一轮审查从开始到出结论都是被审那一回合之后、靠右的一颗气泡（谁审的、
// 用时指到才出）；还没结论时字前一颗点、气泡里是审查者最新一句，出结论时原地换字、摊开着的照旧摊开。
// 判定逻辑由 test:reviewer-turn 钉住，这里钉的是「看得出来」和「没动别的」。
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
  assert.equal(await messages.count(), 3, "平时只看得见实现与两段修复；审查发言收在各自那一轮里");
  assert.equal(await page.locator(".task-message--agent.is-reviewer").count(), 0);
  for (const index of [0, 1, 2]) {
    assert.equal(await messages.nth(index).locator(".turn-head > b").count(), 1, `第 ${index + 1} 段该报身份`);
  }

  // 收了口的审查轮是被审那一回合之后单独一行的气泡；同一回合重审过的只留最近一次。
  assert.equal(await page.locator(".review-milestone, .notice-line").count(), 0);
  const order = await page.locator(".task-conversation > *").evaluateAll((els) => els.map((el) =>
    el.classList.contains("review-verdict") ? `${el.classList.contains("is-pending") ? "未结" : "结论"}:${el.querySelector(".review-verdict-text").textContent}`
      : el.classList.contains("task-message--agent") ? "回合" : null).filter(Boolean));
  assert.deepEqual(
    order,
    ["回合", "结论:第 2 轮验证未通过", "回合", "结论:第 1 轮审查通过", "回合", "未结:第 2 轮审查停了，没有给出结论"],
    "结论夹在被审回合和下一回合之间；自由派审不沿用就地验证的「验证」；重跑、重审过的不并排",
  );
  assert.equal(await page.locator(".task-conversation > .task-message--agent .turn-footnote").count(), 0, "被审回合下面不再说审查结论");
  assert.equal(await page.locator(".turn-footnote-dot").count(), 0, "前一回合上的未通过是过去的事，通过不带颜色");
  const bubbles = page.locator(".task-conversation > .review-verdict:not(.is-pending)");
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
  // 上一回合尾那一排和这一行都住在两条之间的空里，各占一条带子：不叠在同一行上。
  const bands = await page.locator(".task-conversation > .review-verdict:not(.is-pending)").evaluateAll((els) => els.map((el) => {
    const acts = el.previousElementSibling.querySelector(":scope > .task-message-content > .turn-acts");
    const actsBottom = Math.max(...[...acts.children].map((child) => child.getBoundingClientRect().bottom));
    return Math.round(el.querySelector(".review-verdict-bubble > header").getBoundingClientRect().top - actsBottom);
  }));
  assert.equal(bands.length, 2);
  assert.ok(bands.every((gap) => gap >= 6), `气泡上方那一行整个落在上一回合尾栏下面：${bands}`);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.querySelector(".review-verdict-bubble > header b")).fontWeight),
    "500",
    "「审查者」跟你的气泡上「你」同一种字重",
  );
  assert.equal(await bubbles.nth(1).locator(".review-verdict-bubble > header").textContent(), "审查者 · claude@5.5审查 · 12m 0s · 08/10 23:13");

  // 没出结论的那一轮也是右边一颗气泡，不是卡。任务已经停了（done）、审查者一句没说：没有点、没有可摊的键。
  assert.equal(await page.locator(".verify-lane").count(), 0, "页面上不再有审查卡");
  const pending = page.locator(".task-conversation > .review-verdict.is-pending");
  assert.equal(await pending.count(), 1);
  assert.equal(await pending.locator(".workspace-status-dot").count(), 0, "停了就没有点");
  assert.equal(await pending.locator("button.review-verdict-text").count(), 0, "空正文没有无效展开按钮");
  assert.match(await pending.locator(".review-verdict-meta").textContent(), /第 2\/5 轮审查/, "第几轮/最多几轮在指到才出的那一行里");

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
    const right = conversation.getBoundingClientRect().right - Number.parseFloat(style.paddingRight);
    const pendingBubble = document.querySelector(".review-verdict.is-pending .review-verdict-bubble");
    return {
      contentLeft: Math.round(contentLeft),
      executorLeft: Math.round(executor.getBoundingClientRect().left),
      executorBorder: getComputedStyle(executor).borderTopWidth,
      pendingGap: Math.round(right - pendingBubble.getBoundingClientRect().right),
      pendingBackground: getComputedStyle(pendingBubble).backgroundColor,
    };
  });
  assert.ok(Math.abs(layout.executorLeft - layout.contentLeft) <= 1, "执行消息贴住会话内容区左侧");
  assert.equal(layout.executorBorder, "0px", "执行消息无卡片排版");
  assert.deepEqual([layout.pendingGap, layout.pendingBackground], [0, "rgba(0, 0, 0, 0)"], "没结论的那一颗跟结论气泡同一列、同样不垫底色");

  await page.setViewportSize({ width: 760, height: 1200 });
  const verdictFits = await page.evaluate(() => {
    const conversation = document.querySelector(".task-conversation").getBoundingClientRect();
    return [...document.querySelectorAll(".review-verdict-bubble")].every((el) => {
      const box = el.getBoundingClientRect();
      return box.left >= conversation.left && box.right <= conversation.right;
    });
  });
  assert.equal(verdictFits, true, "窄屏下气泡不撑破正文宽度");
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
      pending: ratio(document.querySelector(".review-verdict.is-pending .review-verdict-text")),
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

  await reviewProgress(browser);
  console.log("reviewer-turn-dom ok");
} finally {
  await browser?.close();
  await web.close();
}

// —— 进行中的那一轮：同一颗气泡，从开始审到出结论（fixtures/review-progress.tsx）——
async function reviewProgress(browser) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  await page.goto(`${web.origin}/scripts/fixtures/review-progress.html?opener=1`);
  const bubble = page.locator(".task-conversation > .review-verdict");
  await bubble.waitFor();
  assert.equal(await page.locator(".verify-lane").count(), 0, "没有卡");
  assert.equal(await bubble.count(), 1, "收着的永远只是一颗");
  const text = bubble.locator(".review-verdict-text");
  assert.equal(await text.innerText(), "接下来验证配置冲突和启动状态误判。", "气泡里是审查者最新说完的那一句");
  const dot = bubble.locator(".review-verdict-text > .workspace-status-dot--run");
  assert.notEqual(await dot.evaluate((el) => getComputedStyle(el).animationName), "none", "在往前走：点会动");
  assert.equal(await page.locator(".live-strip").count(), 0, "那颗点就是此刻活的那一个，底下不另起进行条");
  const now = bubble.locator(":scope > .review-progress-now");
  assert.match(await now.locator(".review-progress-step").innerText(), /^正在跑 git diff --stat/, "下面那一行是正在跑的命令");
  const clock = await now.locator("time").innerText();
  await page.waitForFunction((before) => document.querySelector(".review-progress-now time")?.textContent !== before, clock);
  const placed = await bubble.evaluate((el) => {
    const conversation = document.querySelector(".task-conversation");
    const right = conversation.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(conversation).paddingRight);
    const box = el.querySelector(".review-verdict-bubble").getBoundingClientRect();
    const line = el.querySelector(".review-progress-now").getBoundingClientRect();
    return { bubble: Math.round(right - box.right), line: Math.abs(box.right - line.right) <= 4 };
  });
  assert.deepEqual(placed, { bubble: 0, line: true }, "气泡靠右，下面那一行跟它右缘对齐");

  // 流式输出：半句冒出来不换字；说完一句才换，换的那一下淡入。
  await page.evaluate(() => window.__stream("再看一处"));
  await page.waitForTimeout(100);
  assert.equal(await text.innerText(), "接下来验证配置冲突和启动状态误判。", "还在冒的半句不进气泡");
  const width = (await bubble.locator(".review-verdict-bubble").boundingBox()).width;
  await page.evaluate(() => window.__stream("没覆盖的启动路径。"));
  await page.waitForFunction(() => document.querySelector(".review-verdict-text")?.textContent === "再看一处没覆盖的启动路径。");
  assert.equal(await text.locator(".is-fresh").count(), 1, "字真的换了才过渡一下");
  // 说回最初那一句也是换了字：跟上一句比，不跟第一句比。
  await page.evaluate(() => window.__say("接下来验证配置冲突和启动状态误判。"));
  await page.waitForFunction(() => document.querySelector(".review-verdict-text")?.textContent === "接下来验证配置冲突和启动状态误判。");
  assert.equal(await text.locator(".is-fresh").count(), 1, "说回原来那句同样过渡一下");
  assert.ok(Math.abs((await bubble.locator(".review-verdict-bubble").boundingBox()).width - width) < 400);

  // 指到（键盘走进来）上方浮出「审查者 · 谁 · 模型 · 智能水平 · 第 N/M 轮 · 开始时刻 · 含附言」。
  await text.focus();
  const head = bubble.locator(".review-verdict-bubble > header");
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".review-verdict-bubble > header")).opacity === "1");
  assert.match(await head.textContent(), /^审查者 · codex@nodemach · gpt-6\.1-sol · medium · 第 1\/7 轮审查 · 11\/14 \d\d:22 · 含附言$/);
  assert.equal(await text.getAttribute("aria-expanded"), "false", "默认收着");

  // 点气泡：经过在原处摊开，附言在最前；下面那一行不再出现。
  await page.keyboard.press("Enter");
  assert.equal(await text.getAttribute("aria-expanded"), "true");
  const body = bubble.locator(":scope > .turn-footnote-lane");
  await body.waitFor();
  assert.equal(await body.evaluate((el) => el.firstElementChild?.classList.contains("review-note")), true, "附言在最前");
  assert.equal(await body.locator(".task-message--agent").count(), 3, "审查者说过的每一回合都在");
  assert.equal(await body.locator(".monitor-wake-input").count(), 1, "喂给审查者的叫醒留在这一轮里");
  assert.equal(await body.locator(".monitor-wake-reply").count(), 1);
  assert.equal(await bubble.locator(":scope > .review-progress-now").count(), 0, "摊开以后下面那一行不出现");

  // 出结论：同一颗气泡（同一个节点、同一个位置）原地换字，摊开着的照旧摊开。
  await bubble.evaluate((el) => { el.dataset.same = "1"; });
  const before = await bubble.locator(".review-verdict-bubble").boundingBox();
  await page.evaluate(() => window.__conclude());
  await page.waitForFunction(() => document.querySelector(".review-verdict-text")?.textContent === "第 1 轮审查通过");
  const after = page.locator(".task-conversation > .review-verdict");
  assert.equal(await after.count(), 1);
  assert.equal(await after.evaluate((el) => el.dataset.same === "1" && !el.classList.contains("is-pending")), true, "是同一颗气泡换了状态，不是卸掉重建");
  assert.ok(Math.abs((await after.locator(".review-verdict-bubble").boundingBox()).y - before.y) <= 1, "位置不变");
  assert.equal(await after.locator(":scope > .turn-footnote-lane").count(), 1, "摊开着的照旧摊开");
  await after.locator(".review-verdict-bubble").hover();
  assert.equal(await after.locator(".review-verdict-bubble > header").getByRole("button", { name: "这一轮的经过" }).getAttribute("aria-expanded"), "true");
  assert.equal(await after.locator(".workspace-status-dot").count(), 0, "出了结论就没有那颗点");

  // 同一份产出之前已经审过一场（重新派审）：新的一轮一开始就占了那一行结论的位置，出结论时它上面
  // 什么都不变，气泡（连同摊开着的经过）不跳。
  await page.goto(`${web.origin}/scripts/fixtures/review-progress.html?opener=1&earlier=1`);
  const again = page.locator(".task-conversation > .review-verdict");
  await again.first().waitFor();
  assert.equal(await again.count(), 1, "同一回合只留最近那一轮：上一场的结论此刻就让位，回到记录里");
  assert.equal(await again.evaluate((el) => el.classList.contains("is-pending")), true);
  await again.locator("button.review-verdict-text").click();
  await again.locator(":scope > .turn-footnote-lane").waitFor();
  await again.evaluate((el) => { el.dataset.same = "1"; });
  const top = (await again.locator(".review-verdict-bubble").boundingBox()).y;
  await page.evaluate(() => window.__conclude());
  await page.waitForFunction(() => document.querySelector(".review-verdict-text")?.textContent === "第 1 轮审查通过");
  assert.equal(await again.count(), 1);
  assert.equal(await again.evaluate((el) => el.dataset.same), "1", "同一颗气泡");
  assert.ok(Math.abs((await again.locator(".review-verdict-bubble").boundingBox()).y - top) <= 1, "出结论时位置不变");
  assert.equal(await again.locator(":scope > .turn-footnote-lane").count(), 1, "摊开着的照旧摊开");

  // 不在往前走的几种：点不动（或没有），字说此刻等的是谁、等什么。
  for (const [phase, words, mark] of [
    ["question", "在等你答复它的提问", "wait"],
    ["monitor", "在等哨兵的结果", "queue"],
    ["checkpoint", "停在检查点，等续跑", "wait"],
  ]) {
    await page.goto(`${web.origin}/scripts/fixtures/review-progress.html?phase=${phase}`);
    const still = page.locator(".task-conversation > .review-verdict.is-pending");
    await still.waitFor();
    assert.equal(await still.locator(".review-verdict-text").innerText(), words, phase);
    const look = await still.locator(".review-verdict-text > .workspace-status-dot").evaluate((el) => ({ cls: el.className, animation: getComputedStyle(el).animationName }));
    assert.match(look.cls, new RegExp(`workspace-status-dot--${mark}`), phase);
    assert.equal(look.animation, "none", `${phase}：点不动`);
    assert.equal(await still.locator(".review-progress-step").count(), 0, `${phase}：没有在跑的命令`);
  }

  // 减少动效：在跑的那颗也不动。深色主题：气泡里那一句照样读得清。
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.goto(`${web.origin}/scripts/fixtures/review-progress.html`);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const runningDot = page.locator(".review-verdict-text > .workspace-status-dot--run");
  await runningDot.waitFor();
  assert.equal(await runningDot.evaluate((el) => getComputedStyle(el).animationName), "none", "prefers-reduced-motion 下点不动");
  const dark = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const channel = (value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = (color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return 0.2126 * channel(r / 255) + 0.7152 * channel(g / 255) + 0.0722 * channel(b / 255);
    };
    const el = document.querySelector(".review-verdict-text");
    let back = "#000";
    for (let node = el; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color && color !== "transparent" && !/,\s*0\s*\)$/.test(color)) { back = color; break; }
    }
    const front = luminance(getComputedStyle(el).color);
    const behind = luminance(back);
    return (Math.max(front, behind) + 0.05) / (Math.min(front, behind) + 0.05);
  });
  assert.ok(dark >= 4.5, `深色主题下那一句的对比度只有 ${dark.toFixed(2)}:1`);
  await page.close();

  // 触屏（那一行常显在气泡里）和窄屏（指到才浮出）：谁审的、第几轮、什么时候、含附言一个字都不截。
  const meta = /codex@nodemach · gpt-6\.1-sol · medium · 第 1\/7 轮审查 · 11\/14 \d\d:22 · 含附言/;
  const readable = (el) => {
    const box = el.getBoundingClientRect();
    return { whole: el.scrollWidth <= el.clientWidth + 1, inside: box.left >= 0 && box.right <= window.innerWidth, opacity: getComputedStyle(el.parentElement).opacity };
  };
  const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await touch.goto(`${web.origin}/scripts/fixtures/review-progress.html`);
  const touchMeta = touch.locator(".review-verdict-meta");
  await touchMeta.waitFor();
  assert.match(await touchMeta.textContent(), meta);
  assert.deepEqual(await touchMeta.evaluate(readable), { whole: true, inside: true, opacity: "1" }, "触屏上那一行换行读全");
  await touch.close();
  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await narrow.goto(`${web.origin}/scripts/fixtures/review-progress.html`);
  await narrow.locator(".review-verdict-text").focus();
  await narrow.waitForFunction(() => getComputedStyle(document.querySelector(".review-verdict-bubble > header")).opacity === "1");
  assert.deepEqual(await narrow.locator(".review-verdict-meta").evaluate(readable), { whole: true, inside: true, opacity: "1" }, "窄屏浮出的那一行换行读全、不出屏");
  await narrow.close();
}
