// 派出的任务来问 / 失败，在派它的那条任务里（真浏览器）。判据本身在 test-dispatch-signals.mjs。
//
// 钉的是这几件事：
//   · 名下派出的任务在问：回复框那一格是它的答题卡，题目前面写着是谁在问，题目和选项是原话；
//     几条同时在问一次一张、按提问先后（不按派出的先后）；孙一层的提问不冒到这里。
//   · 会话里按提问那一刻插一颗气泡（标题 + 题目头一句），点它在左边打开那条任务。
//   · 答复直接送给提问的那一条（带着 via），这条任务自己一个请求都没发；答完下一张上来，
//     会话里留下「你」那颗气泡和一句「答复直接送到了…」。
//   · 在别处答了：这里的卡收走，平常的回复框回来；气泡还在，写着已答复。
//   · 这条任务自己也在问：先答它自己的，答完才轮到派出的那一条。
//   · 失败：一颗气泡（标题 + 原因头一句），不出答题卡；点它打开那条任务。
//   · 刷新后那几颗气泡还在原来的位置。
// 跑：npm -w web run test:dispatch-signals
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
  await page.goto(`${web.origin}/scripts/fixtures/dispatch-signals.html`);
  await page.evaluate(() => window.__server.reset());
  await page.reload();

  const card = page.locator(".question-card");
  const asker = card.locator(".question-card-asker");
  const bubbles = page.locator(".task-conversation .dispatched-bubble");
  const bubble = (text) => bubbles.filter({ hasText: text });
  const meta = async (text) => (await bubble(text).locator(".review-verdict-meta").textContent())?.trim();
  const opened = page.locator('output[aria-label="左边抽屉里开着的"]');
  const replyBox = page.getByRole("textbox", { name: "回复任务" });
  const requests = () => page.evaluate(() => window.__server.requests());
  const feedText = () => page.locator(".task-conversation").innerText();
  const waitText = (needle) => page.waitForFunction((value) => document.querySelector(".task-conversation")?.textContent?.includes(value), needle);

  // —— 几条同时在问：一次一张，按提问先后（第二条先问的）。
  await card.waitFor();
  assert.equal(await asker.textContent(), "「第二条派出去的」问：", "题目前面写着是谁在问");
  assert.match(await card.locator(".question-card-title").innerText(), /^第二条的问题：要不要顺手改文档？后面这句不进气泡。$/, "题目是它的原话");
  assert.equal(await card.getByRole("button", { name: "要", exact: true }).count(), 1, "选项是它的原话");
  assert.equal(await page.locator(".question-card").count(), 1, "一次一张");
  assert.equal(await replyBox.isVisible(), false, "答题卡展开着就只有答题卡");
  assert.ok(!(await page.locator("main").innerText()).includes("孙一层的问题"), "只冒一层：孙一层的提问不到这里");

  // —— 会话里按提问那一刻插一颗气泡：u1(0) → 第二条来问(6) → u2(10) → 第一条来问(12)。
  await bubbles.nth(1).waitFor();
  const order = async () => {
    const text = await feedText();
    return ["按刚才的拆法派出去吧", "第二条的问题", "第二条先别动数据库", "第一条的问题"].map((needle) => text.indexOf(needle));
  };
  const positions = await order();
  assert.ok(positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1])), `气泡按提问那一刻插在会话里：${positions}`);
  assert.equal(await bubble("第二条派出去的").locator("b").first().textContent(), "派出的任务");
  assert.match(await bubble("第二条派出去的").locator(".debate-bubble-say").innerText(), /^第二条派出去的\s*第二条的问题：要不要顺手改文档？$/, "标题 + 题目头一句");
  assert.match(await meta("第二条派出去的"), /^· claude@nodemach · 在等答复 · /, "浮出那一行：执行器 · 在等答复");
  await bubble("第二条派出去的").locator("button.review-verdict-text").click();
  assert.equal(await opened.textContent(), "kid-b", "点气泡，在左边打开那条任务");

  // —— 在这里答：直接送给提问的那一条，这条任务自己一个请求都没发。
  await card.getByRole("button", { name: "要", exact: true }).click();
  await card.getByRole("button", { name: "发送答复" }).click();
  await page.waitForFunction(() => window.__server.requests().some((request) => request.url === "/tasks/kid-b/answer"));
  const sent = (await requests()).filter((request) => request.url.endsWith("/answer"));
  assert.deepEqual(sent.map((request) => request.url), ["/tasks/kid-b/answer"], "答复送到的是提问的那一条");
  assert.equal(sent[0].body.via, "lead", "带着是在派它的那条里答的");
  assert.equal((await requests()).filter((request) => request.url.startsWith("/tasks/lead")).length, 0,
    "这条任务自己一发写请求都没收到（不叫醒、不占回合）");
  // 答完一张，下一张上来。
  await page.waitForFunction(() => document.querySelector(".question-card-asker")?.textContent === "「第一条派出去的」问：");
  await waitText("答复直接送到了「第二条派出去的」，它接着跑了");
  assert.equal(await page.locator(".dispatched-answer .task-question-record").count(), 1, "题目和答案留在你那颗气泡里");
  assert.match(await page.locator(".dispatched-answer .task-question-record").innerText(), /第二条的问题[\s\S]*要/);
  await page.waitForFunction(() => [...document.querySelectorAll(".dispatched-bubble .review-verdict-meta")].some((node) => node.textContent?.includes("已答复")));
  assert.match(await meta("第二条派出去的"), /已答复/, "气泡还在，看得出答过了");

  // —— 在别处答了：这里的卡收走，不留一张答不了的卡；气泡还在。
  await page.evaluate(() => window.__server.answerElsewhere("kid-a"));
  await card.waitFor({ state: "detached" });
  await replyBox.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".dispatched-bubble")].some((node) => node.textContent?.includes("第一条派出去的") && node.textContent.includes("已答复")));
  assert.equal((await feedText()).split("答复直接送到了").length - 1, 1, "在别处答的不留「你」那颗气泡");

  // —— 这条任务自己也在问：先答它自己的。
  await page.evaluate(() => {
    window.__server.ask("kid-c", "第三条来问：接口名用哪个？", 15);
    window.__server.ask("lead", "自己的问题：要不要先开会？", 16);
  });
  await page.waitForFunction(() => document.querySelector(".question-card-title")?.textContent?.includes("自己的问题"));
  assert.equal(await asker.count(), 0, "自己的卡跟改之前一样，不写是谁在问");
  await card.locator("textarea").fill("先不开");
  await card.getByRole("button", { name: "发送答复" }).click();
  await page.waitForFunction(() => document.querySelector(".question-card-asker")?.textContent === "「第三条派出去的」问：");
  const own = (await requests()).filter((request) => request.url === "/tasks/lead/answer");
  assert.equal(own.length, 1, "自己的提问答给自己");
  assert.equal(own[0].body.via, undefined);

  // —— 失败：一颗气泡，不出答题卡；点它打开那条任务。
  await page.evaluate(() => window.__server.fail("kid-a", "模型上游连不上（503）。点重试会接着跑。", 18));
  const failed = page.locator(".dispatched-bubble.is-failed");
  await failed.waitFor();
  assert.match(await failed.locator(".debate-bubble-say").innerText(), /^第一条派出去的\s*模型上游连不上（503）。$/, "标题 + 原因头一句");
  assert.match(await failed.locator(".review-verdict-meta").textContent(), /失败了/);
  assert.equal(await asker.textContent(), "「第三条派出去的」问：", "失败不出答题卡");
  await failed.locator("button.review-verdict-text").click();
  assert.equal(await opened.textContent(), "kid-a");

  // —— 刷新后那几颗气泡还在原来的位置。
  const before = await feedText();
  await page.reload();
  await page.locator(".dispatched-bubble.is-failed").waitFor();
  await waitText("答复直接送到了「第二条派出去的」");
  assert.equal(await bubbles.count(), 4, "来问的三颗、失败的一颗都还在");
  assert.equal(await feedText(), before, "刷新后在原来的位置");

  assert.deepEqual(failures, []);
  console.log("✓ 派出的任务来问 / 失败：气泡、答题卡、答复送到提问的那一条、别处答了收卡、先后、刷新后还在");
} finally {
  await browser?.close();
  await web.close();
}
