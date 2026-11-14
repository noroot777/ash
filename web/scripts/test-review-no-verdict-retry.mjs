// 一轮审查中途断了之后，「继续本轮审查」在审查格结论行和会话尾注上（夹具见
// fixtures/review-no-verdict-retry.tsx，三种情形都照 TaskDetail 那条链路从审查状态推出动作）。
//
// 现场（2026-11-13）：上游 503 把第 1 轮审查打断，审查格写「第 1 轮异常」、主按钮是「再审一轮」
// （另开一条链、从头审），能续这一轮的只有任务头一颗不带字的图标，用户没认出来。这份回归盯：
// ① 能续：审查格主按钮是「继续本轮审查」、点了走那个动作；「再审一轮」在更多里；结论那句带原因；
//    会话里说原因的那句尾注后面挂同一个动作；
// ② 不能续：两处都不带，主按钮照旧「再审一轮」；
// ③ 续过之后（round.retry 没了）：审查格、尾注都没了；
// ④ 合并结果审查中断、能续：同样是「继续本轮审查」，「再审一次」在更多里，结论带原因，尾注叫
//    「合并结果审查」（第 1 轮审查第 2 条与 N2）。
// ⑤ 任务头上没有回合级的重来图标：能续这一轮时入口在审查格和尾注上，不在头上。
// 跑：npm -w web run test:review-no-verdict-retry
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
  await page.goto(`${web.origin}/scripts/fixtures/review-no-verdict-retry.html`);
  const retry = page.locator(".t-retry-fixture");
  const blocked = page.locator(".t-blocked-fixture");
  const after = page.locator(".t-after-fixture");
  for (const scope of [retry, blocked]) await scope.locator(".insp-head").getByText(/第 1 轮中断/).waitFor();
  await after.locator(".insp-head").getByText("第 1 轮审查中").waitFor();
  await page.locator(".t-merge-fixture .insp-head").getByText(/合并结果审查中断/).waitFor();

  // ① 能续
  const head = retry.locator(".insp-head");
  assert.match(await head.innerText(), /第 1 轮中断 · 模型上游连不上（503）/, "结论那句带上服务端判的原因");
  const main = head.getByRole("button", { name: "继续本轮审查" });
  assert.equal(await main.count(), 1, "能续的那一轮：主按钮是「继续本轮审查」");
  assert.equal(await head.getByRole("button", { name: "再审一轮" }).count(), 0, "「再审一轮」不再摆在明面上");
  await head.getByRole("button", { name: "更多" }).click();
  assert.equal(await page.getByRole("menuitem", { name: "再审一轮" }).count()
    + await page.locator("[role=menu] button", { hasText: "再审一轮" }).count() > 0, true, "「再审一轮」退到更多里");
  await page.keyboard.press("Escape");
  await main.click();
  assert.deepEqual(await page.evaluate(() => window.__retried), ["t-retry"], "点主按钮走的是「继续本轮审查」那个动作");

  const note = retry.locator(".feed .turn-footnote").filter({ hasText: "第 1 轮审查中断：模型上游连不上（503）" });
  assert.equal(await note.count(), 1, "会话里说原因的那句尾注按结构说，不贴长原文");
  const cta = note.getByRole("button", { name: "继续本轮审查" });
  assert.equal(await cta.count(), 1, "尾注后面挂同一个动作");
  assert.equal(await note.locator("button.turn-footnote-part .system-event-cta").count(), 0, "键不落在那半句自己的展开键里");
  await cta.click();
  assert.deepEqual(await page.evaluate(() => window.__retried), ["t-retry", "t-retry"], "尾注上的键走同一个动作");
  // 记录里报告还没有时，说同一个原因。
  await retry.locator(".insp-recs").getByText("第 1 轮").first().click();
  assert.match(await retry.locator(".insp-recs").innerText(), /这一轮中断：模型上游连不上（503），报告尚未生成。/);

  // ② 不能续
  const blockedHead = blocked.locator(".insp-head");
  assert.equal(await blockedHead.getByRole("button", { name: "继续本轮审查" }).count(), 0, "不能续：审查格不带");
  assert.equal(await blockedHead.getByRole("button", { name: "再审一轮" }).count(), 1, "不能续：主按钮照旧");
  assert.equal(await blocked.locator(".feed").getByRole("button", { name: "继续本轮审查" }).count(), 0, "不能续：尾注不带");

  // ③ 续过之后
  assert.equal(await after.getByRole("button", { name: "继续本轮审查" }).count(), 0, "续过了：审查格与尾注都没了");

  // ④ 合并结果审查
  const merge = page.locator(".t-merge-fixture");
  const mergeHead = merge.locator(".insp-head");
  assert.match(await mergeHead.innerText(), /合并结果审查中断 · 模型上游连不上（503）/, "合并结果那句也带原因");
  assert.equal(await mergeHead.getByRole("button", { name: "再审一次" }).count(), 0, "「再审一次」不摆在明面上");
  await mergeHead.getByRole("button", { name: "继续本轮审查" }).click();
  await mergeHead.getByRole("button", { name: "更多" }).click();
  assert.equal(await page.locator("[role=menu]").getByText("再审一次").count(), 1, "「再审一次」退到更多里");
  await page.keyboard.press("Escape");
  const mergeNote = merge.locator(".feed .turn-footnote").filter({ hasText: "合并结果审查中断：模型上游连不上（503）" });
  assert.equal(await mergeNote.count(), 1, "尾注沿用「合并结果审查」的叫法");
  await mergeNote.getByRole("button", { name: "继续本轮审查" }).click();
  assert.deepEqual(await page.evaluate(() => window.__retried), ["t-retry", "t-retry", "t-merge", "t-merge"], "两处走同一个动作");

  // ⑤ 任务头
  for (const scope of [retry, blocked, after, merge]) {
    assert.equal(await scope.locator(".task-detail-header").getByRole("button", { name: /继续本轮审查|重试/ }).count(), 0,
      "任务头没有回合级的重来图标");
  }

  console.log("review no-verdict retry tests passed");
} finally {
  await browser?.close();
  await web.close();
}
