// 答题卡（task-detail/QuestionCard.tsx + QuestionSlot.tsx）在真浏览器里：停在回复框那一格、全页只有一处
// 打字一颗发送键、勾选不抄进输入框而答复里有它、多题跳题与「下一题 / 发送答复」、数字键与最后一格、
// 收起后平常的回复框出现、那一轮没结束点不动、发送失败答案不丢、问题全文只出现一次。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { WAIT_TIMEOUT_MS } from "./wait-until.mjs";

const web = await startWebServer();
let browser;
const failures = [];
try {
  browser = await launchChrome();
  const page = await browser.newPage();
  page.setDefaultTimeout(WAIT_TIMEOUT_MS);
  page.on("pageerror", (error) => failures.push(error.message));
  // 夹具不该连服务端；会话区那几条后台读取（挡回记录之类）给空的。
  await page.route("**/api/**", (route) => route.fulfill({ json: [] }));
  await page.goto(`${web.origin}/scripts/fixtures/question-card.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const card = page.locator(".question-card");
  const send = card.locator(".question-card-send");
  const note = card.locator(".question-card-note textarea");
  const replyBox = page.getByRole("textbox", { name: "回复任务" });
  const option = (name) => card.getByRole("button", { name, exact: true });
  const visibleInputs = () => page.locator("textarea:visible, input[type=text]:visible").count();

  // 卡停在回复框那一格（会话滚动区外面），展开时平常那个框不出现：全页一处输入、一颗发送键。
  await card.waitFor();
  assert.equal(await page.locator(".task-conversation .question-card").count(), 0);
  assert.equal(await page.locator(".task-reply-shell > .question-dock > .question-card").count(), 1);
  assert.equal(await replyBox.isVisible(), false, "卡展开时不出现平常的回复框");
  assert.equal(await visibleInputs(), 1, "全页只有一处打字的地方");
  assert.equal(await page.locator("button:visible", { hasText: /^(发送答复|下一题)$/ }).count(), 1, "只有一颗发送键");
  // 卡刚出现时不抢焦点。
  assert.equal(await page.evaluate(() => document.activeElement?.closest(".question-card") ? "card" : "elsewhere"), "elsewhere");
  // 问题全文只出现一次：会话里那句「以提问暂停,等待答复:「…」」不画。
  const mainText = await page.locator("main").innerText();
  assert.equal(mainText.split("开始前，确认两个细节。").length - 1, 1, "共同背景只出现在卡上");
  assert.equal(mainText.split("回答过的卡片放在哪里？").length - 1, 1, "题目只出现在卡上");
  assert.doesNotMatch(mainText, /以提问暂停/);

  // 什么都没答时那颗键点不动；勾了就是选了，不把那句话抄进输入框。
  assert.equal(await send.innerText(), "下一题");
  assert.equal(await send.isDisabled(), true);
  await option("留在会话里，点击展开").click();
  assert.equal(await option("留在会话里，点击展开").getAttribute("aria-pressed"), "true");
  assert.equal(await note.inputValue(), "", "勾选不再写进输入框");
  assert.equal(await card.getByRole("button", { name: "第 1 题（已答）" }).count(), 1);
  assert.equal(await send.isDisabled(), false);

  // 下一题：焦点落在第一个选项上，数字键立刻能按；按下一个数字（最后一格）光标落进输入行。
  await send.click();
  assert.match(await card.locator(".question-card-title").innerText(), /发给智能体的回复保留哪些内容/);
  assert.equal(await card.getByText("同时提供历史入口").count(), 0, "一次只出一题");
  assert.equal(await send.innerText(), "发送答复", "到最后一题那颗键写「发送答复」");
  await page.waitForFunction(() => document.activeElement?.matches(".question-card-options button"));
  await page.keyboard.press("2");
  assert.equal(await option("加一句简短说明").getAttribute("aria-pressed"), "true");
  await page.keyboard.press("3");
  assert.equal(await page.evaluate(() => document.activeElement?.matches(".question-card-note textarea")), true, "最后一格的数字把光标送进输入行");
  // 焦点在输入框里时数字是字，不是勾选。
  await page.keyboard.type("1 份就够");
  assert.equal(await note.inputValue(), "1 份就够");
  assert.equal(await option("只发答案和必要编号").getAttribute("aria-pressed"), "false");

  // 题号跳题：回到第 1 题，勾的还在；题号上看得出答过。
  await card.getByRole("button", { name: "第 1 题（已答）" }).click();
  assert.equal(await option("留在会话里，点击展开").getAttribute("aria-pressed"), "true");
  assert.equal(await send.innerText(), "下一题");

  // 收起：只剩题目一行，平常的回复框出现在它下面；再展开，勾的写的都不丢。
  await card.getByRole("button", { name: "收起答题卡，先看上文" }).click();
  assert.equal(await card.locator(".question-card-peek").innerText(), "回答过的卡片放在哪里？");
  assert.equal(await replyBox.isVisible(), true, "收起后出现平常的回复框");
  assert.equal(await visibleInputs(), 1, "收起后仍只有一处打字的地方");
  await card.locator(".question-card-peek").click();
  assert.equal(await replyBox.isVisible(), false);
  assert.equal(await option("留在会话里，点击展开").getAttribute("aria-pressed"), "true");
  await card.getByRole("button", { name: "第 2 题（已答）" }).click();
  assert.equal(await note.inputValue(), "1 份就够");

  // 发送失败：说得出来，答案不丢。
  await page.getByLabel("模拟发送失败").check();
  await send.click();
  await card.getByRole("alert").waitFor();
  assert.match(await card.getByRole("alert").innerText(), /发送失败/);
  assert.equal(await note.inputValue(), "1 份就够");
  assert.equal(await option("加一句简短说明").getAttribute("aria-pressed"), "true");

  // 发出去的答复 = 勾了的几项 + 补充的话，形状跟从前一样；已答气泡照样认得出选了哪几项。
  await page.getByLabel("模拟发送失败").uncheck();
  await send.click();
  await page.getByLabel("发给智能体的回复", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("发给智能体的回复", { exact: true }).innerText(), "【答复】\n1. 留在会话里，点击展开\n2. 加一句简短说明\n1 份就够");
  await card.waitFor({ state: "detached" });
  assert.equal(await replyBox.isVisible(), true, "答完卡收回，平常的回复框回来");
  const bubble = page.locator(".task-question-record").last();
  await bubble.locator(".task-question-quote").filter({ hasText: "发给智能体的回复保留哪些内容" }).click();
  assert.equal(await bubble.locator("li.is-selected").innerText(), "加一句简短说明", "已答气泡标出选了哪一项");

  // 那一轮还没结束：选项点不动，最后一行写着什么时候能答。
  await page.getByRole("button", { name: "单题" }).click();
  await card.waitFor();
  assert.equal(await send.innerText(), "发送答复");
  assert.equal(await card.locator(".question-card-steps").count(), 0);
  await page.getByRole("button", { name: "切换提问状态" }).click();
  assert.equal(await option("清楚展示问题").isDisabled(), true);
  assert.equal(await note.getAttribute("placeholder"), "这一轮结束后即可答复");
  assert.equal(await note.isDisabled(), true);
  await page.getByRole("button", { name: "切换提问状态" }).click();
  assert.equal(await option("清楚展示问题").isDisabled(), false);

  // 没有选项：最后一行就是「写下你的答案…」，写了才能发。
  await page.getByRole("button", { name: "没有选项" }).click();
  await card.locator(".question-card-options").waitFor({ state: "detached" });
  assert.equal(await note.getAttribute("placeholder"), "写下你的答案…");
  assert.equal(await send.isDisabled(), true);
  await note.fill("ask-card");
  assert.equal(await send.isDisabled(), false);

  // 窄屏不横向溢出。
  await page.setViewportSize({ width: 360, height: 720 });
  await page.getByRole("button", { name: "重置" }).click();
  await card.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "窄屏不横向溢出");

  assert.deepEqual(failures, []);
  console.log("question card DOM: docked in the reply slot, one input + one send key, picks not copied but sent, jump/next/send switch, digit keys + last cell, collapse shows the reply box, settling locked, failure keeps answers, question shown once, narrow screen passed");
} finally {
  await browser?.close();
  await web.close();
}
