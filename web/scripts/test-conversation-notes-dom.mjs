// 系统旁注的实际渲染：不再是横贯会话的分隔线，也不再把同一个会话的发言劈成两半。
// 逻辑层的分类和 continuation 由 test:conversation-notes 钉住，这里钉的是渲染结果。
// 设 SHOT=<路径> 可以顺带截一张图自查版式。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { resizeViewport } from "./wait-until.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  // 旁注上的时间是 formatInstant 按**本地时区**渲染的，fixture 里写的是 UTC 时刻。
  // 不钉时区的话，同一份 fixture 在 UTC 机器上显示 07:02、在 UTC+8 上显示 15:02，
  // 断言就随跑测试的机器（甚至同一台机器改了时区）时好时坏。这里把页面时区固定住，
  // 断言才能继续用字面量、真的去看「有没有显示自己那条的时间」。
  const page = await browser.newPage({
    viewport: { width: 1000, height: 1400 },
    timezoneId: "Asia/Shanghai",
  });
  await page.goto(`${web.origin}/scripts/fixtures/conversation-notes.html`);

  // 这份 fixture 全是**没有类型的老记录**：照样认得出哪几句要你知道，它们是所属回合的尾注。
  const messages = page.locator(".task-message--agent");
  await messages.first().waitFor();
  assert.equal(await page.locator(".notice-line").count(), 0, "没有独占一行、图标落在头像轴上的旁注");
  const footnoteTexts = await messages.evaluateAll((elements) => elements.map((el) =>
    [...el.querySelectorAll(".turn-footnote-text")].map((text) => text.textContent).join(" · ")));
  assert.deepEqual(
    footnoteTexts,
    ["", "第 2 轮审查通过 · 已验收，合并到 feat/free-pipeline", "第 3 轮审查未通过 · 工作区已恢复，会话内容都在", "", "本回合没有交卷", ""],
    "会话里要你知道的那几句并成各自回合的尾注",
  );
  const receiptCounts = await messages.evaluateAll((elements) => elements.map((el) =>
    el.querySelector(".turn-receipts-toggle")?.textContent ?? ""));
  assert.deepEqual(
    receiptCounts,
    ["1 条记录", "4 条记录", "3 条记录", "", "2 条记录", "1 条记录"],
    "回执连同尾注里的每一句都记在各自所属的回合上，一条不少（预约、验收阶段、迁移说明、会话轮换、回合边界、实时预约）",
  );
  // 回合边界不再横贯会话：正常收口是那一回合上的一条记录。
  assert.equal(await page.locator(".task-event-line, .system-boundary").count(), 0);
  // 后面又起了回合，它们都是过去的事：没有一颗彩色的点。
  assert.equal(await page.locator(".turn-footnote-dot").count(), 0, "过去回合上的未通过、结算说明都是灰字");
  const openLog = async (index) => {
    const message = messages.nth(index);
    await message.hover();
    await message.locator(".turn-receipts-toggle").click();
    return message.locator(".turn-receipt-log");
  };

  // 会话轮换旁注是中性事实：一个 exit 0 的成功回合、甚至用户自己点的「停止全组」都会带
  // 一句。它是回执，也不该把 Markdown 标记原样露给用户（旁注是纯文本渲染）。
  const rotationLog = await openLog(2);
  const rotation = rotationLog.locator(".turn-receipt").filter({ hasText: "CLI 会话" });
  assert.equal(await rotation.evaluate((el) => el.classList.contains("tone-neutral")), true, "会话轮换旁注被渲染成异常");
  if (await rotation.locator(".turn-receipt-more").count()) await rotation.locator(".turn-receipt-more").click();
  assert.match(await rotation.innerText(), /ash 已经把这个失效的 id 清掉/, "会话轮换的原文点开看得到");
  assert.doesNotMatch(await rotation.textContent(), /\*\*/, "旁注是纯文本，Markdown 标记会原样露给用户");

  // 结算说明（level:"notice"）：是那一回合尾注里的一句，字是灰的（它讲的是流程，不是故障）。
  // 整句点开再看。
  const settlement = messages.nth(4).locator(".turn-footnote");
  const settlementPart = settlement.locator("button.turn-footnote-part").filter({ hasText: "本回合没有交卷" });
  const grey = await page.evaluate(() => [...document.querySelectorAll(".turn-footnote-text")].map((el) => getComputedStyle(el).color));
  assert.equal(new Set(grey).size, 1, "尾注的字一律是同一种灰，结算说明不许被渲染成红色异常");
  await settlementPart.click();
  assert.match(await settlement.locator(".turn-footnote-detail").innerText(), /这不是崩溃.*点重试会从中断处接着跑/s, "结算说明展开后必须能读到完整原因和下一步");

  assert.equal(await messages.count(), 6, "实时旁注后的工具应并回当前回合，不另拆第七段");
  // 第一段照常报身份；被旁注隔开的后几段接着上一段排版，不重报执行器名。
  assert.equal(await messages.nth(0).locator(".turn-head > b").count(), 1);
  assert.equal(await messages.nth(1).locator(".turn-head > b").count(), 0, "旁注不该让会话重报身份");
  assert.equal(await messages.nth(2).locator(".turn-head > b").count(), 0);
  assert.equal(await messages.nth(3).locator(".turn-head > b").count(), 0);
  assert.equal(
    await page.locator(".task-message--agent.is-continuation .turn-meta").filter({ hasText: /\d:\d\d/ }).count(),
    0,
    "旁注已经显示同一时间时，续写段不该再重复",
  );
  assert.equal(
    await page.locator('.task-message--agent button[aria-label="复制这条回复"]').count(),
    await messages.count(),
    "每段回复都必须保留复制入口",
  );
  // 真人插过话之后是新的一段，身份要回来；回合边界之后同理。
  assert.equal(await messages.nth(4).locator(".turn-head > b").count(), 1, "真人插话后必须重新报身份");
  assert.equal(await messages.nth(5).locator(".turn-head > b").count(), 1, "回合边界之后必须重新报身份");
  const liveLog = await openLog(5);
  assert.match(await liveLog.innerText(), /08\/10 15:02.*审查已预约|08\/10 15:02.*已预约完成后审查/s, "实时旁注在流水里带着自己的精确时间，时间排在最前面");
  assert.equal(await messages.last().locator(".task-tool-line").count(), 1, "旁注后到达的工具应显示在旁注之前的当前回合里");
  assert.equal(await messages.last().locator(".turn-receipts-toggle").count(), 1, "实时旁注记在当前回合上，后到的工具不另起一段");

  await resizeViewport(page, { width: 390, height: 1000 });
  const narrowTime = await liveLog.locator(".turn-receipt > time").first().evaluate((time) => {
    const range = document.createRange();
    range.selectNodeContents(time);
    return { whiteSpace: getComputedStyle(time).whiteSpace, lineCount: range.getClientRects().length };
  });
  assert.deepEqual(narrowTime, { whiteSpace: "nowrap", lineCount: 1 }, "窄屏日期与时分不能从中间拆成两行");
  await page.setViewportSize({ width: 1000, height: 1400 });

  // 回合记录低于正文层级：比 agent 正文小一档，但不小于界面的最小字号 12px。
  const metrics = await page.evaluate(() => {
    const size = (node) => Number.parseFloat(getComputedStyle(node).fontSize);
    return {
      body: size(document.querySelector(".task-message--agent .task-markdown p")),
      log: size(document.querySelector(".turn-receipt-log")),
      line: size(document.querySelector(".turn-footnote")),
    };
  });
  assert.ok(metrics.log < metrics.body, "回合记录不能比 agent 正文更抢眼");
  assert.ok(metrics.log >= 12 && metrics.line >= 12, "字号不小于 12px");

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  console.log("conversation-notes-dom ok");
} finally {
  await browser?.close();
  await web.close();
}
