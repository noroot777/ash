// 会话流里那几颗复制按钮点完必须有**就地反馈**：回合尾的复制图标、审查卡里那一条的、
// 用户气泡头部的。它们拿不到全局 toast，反馈全靠
// 按钮自己变（components/CopyButton.tsx）——没有反馈时「点了没生效」和「点了已生效」
// 长得一模一样，用户只能反复点。设 SHOT=<路径> 可以顺带截一张图自查版式。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { settlePage, waitUntil } from "./wait-until.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const context = await browser.newContext({ viewport: { width: 1000, height: 1100 }, timezoneId: "Asia/Shanghai" });
  const origin = web.origin;
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  // 反馈 1.6 秒后自己退回常态（components/CopyButton.tsx 的 FEEDBACK_MS）。满载时点完到读完
  // 属性可能就过了这么久，读到的是「已经退回去了」—— 所以页面时钟停住，退回只在下面
  // runFor 推过那一档时发生。进入「已复制」靠的是剪贴板写入的 promise，跟时钟无关。
  await page.clock.install();
  await page.goto(`${origin}/scripts/fixtures/copy-feedback.html`);
  await page.locator(".task-message--agent").first().waitFor();
  await page.clock.pauseAt(Date.now() + 60_000);

  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  // 进入反馈态等的是剪贴板写完那一下（异步），等到按钮挂上 is-copied 再读其余属性。
  const copied = (button, what) => waitUntil(
    async () => /\bis-copied\b/.test(await button.getAttribute("class") ?? ""),
    `${what}点完进入已复制态`,
  );

  // ① 回合尾那颗复制图标（TurnActions）：反馈只换图标，不塞文字，而且必须自己现形 ——
  //    这一排平时 opacity:0 靠悬停露脸，点完鼠标一移开就什么都看不见了。
  const turn = page.locator(".task-message--agent").filter({ hasText: "先探索一下现有结构" }).first();
  // 点完 aria-label 会变成「已复制」，按位置找它，别按名字。
  const turnCopy = turn.locator(".turn-acts .ui-icon-button").first();
  await turn.hover();
  const sizeBefore = await turnCopy.boundingBox();
  await turnCopy.click();
  await copied(turnCopy, "回合尾复制图标");
  assert.equal((await turnCopy.innerText()).trim(), "", "只有图标的按钮不能因为反馈多出文字");
  assert.equal(await turnCopy.getAttribute("aria-label"), "已复制", "读屏用户的反馈只能来自 aria-label");
  const sizeAfter = await turnCopy.boundingBox();
  assert.equal(sizeBefore.width, sizeAfter.width, "反馈不能改变按钮宽度");
  assert.equal(sizeBefore.height, sizeAfter.height, "反馈不能改变按钮高度");
  assert.match(await clipboard(), /先探索一下现有结构/, "复制的是这条回复的 markdown");
  await page.mouse.move(2, 2);
  // 等悬停真的离开这条气泡再读样式，否则 opacity:1 可能只是 :hover 还挂着。
  await waitUntil(() => turnCopy.evaluate((button) => !button.closest(".task-message")?.matches(":hover")), "鼠标离开这条气泡");
  await waitUntil(
    async () => (await turnCopy.evaluate((node) => getComputedStyle(node.closest(".turn-acts")).opacity)) === "1",
    "鼠标移开后反馈仍要看得见，否则等于没有反馈",
  );

  // ② 审查卡内首条发言：头部被卡头顶替，复制入口同样在回合尾那一排。
  const action = page.locator(".task-message--agent.is-lane-owned .turn-acts .ui-icon-button").first();
  await action.scrollIntoViewIfNeeded();
  await action.hover();
  await action.click();
  await copied(action, "审查卡里的复制图标");
  assert.match(await clipboard(), /审查结论/, "复制的是这条审查发言");

  // 会话号、resume 命令、用量、上下文不在回合尾了（docs/ui-ux-audit feed-2），住在右侧「信息」格。
  assert.equal(await page.locator(".task-message-footer").count(), 0, "回合尾不再挂账目胶囊");

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  // 用户气泡那颗图标同源同款，一起钉住，免得下次只改一半。
  const userBubble = page.locator(".task-user-bubble header").first();
  await userBubble.hover();
  const userCopy = userBubble.locator("button.copy-button").first();
  await userCopy.click();
  await copied(userCopy, "用户气泡的复制图标");
  assert.match(await userCopy.getAttribute("class"), /is-copied/, "用户气泡的复制图标同样要有反馈");
  assert.equal(await clipboard(), "这块再改一下，右边留白太挤了");

  // 反馈是暂时的：一秒多之后按钮要自己回到常态，不能永远停在「已复制」。时钟推过那一档，
  // 退回的定时器就在这一步里触发；再冲刷一轮让它排上的提交落地。
  await page.clock.runFor(1_800);
  await settlePage(page);
  assert.equal(await turnCopy.getAttribute("aria-label"), "复制这条回复", "反馈过后要自己退回常态");
  assert.doesNotMatch(await turnCopy.getAttribute("class"), /is-copied/);

  console.log("copy feedback: 回合尾、审查卡、用户气泡三处点完都有就地反馈 ✔");
} finally {
  await browser?.close();
  await web.close();
}
