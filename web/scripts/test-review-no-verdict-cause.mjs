// 一轮审查没给出结论之后，会话里那颗「第 1 轮审查没有给出结论」气泡下面紧贴的那一句：原因（类型不明时
// 连原话）+ 带字的「继续本轮审查」；审查格里同一轮的原因和原话（夹具见 fixtures/review-no-verdict-cause.tsx）。
//
// 现场（2026-11-13，EhQtqns9fnG2）：那一轮断在原因记录上线之前，会话里只有一条不带 runId 的结论旁注
// 和一句推断错了的「报告可能写完了…report_stage…」；气泡下面只剩一句被挡回的提醒，没有原因、没有按钮。
// 这份回归盯：
//   ① 老记录、能续：气泡下面那一句是服务端给的原因，后面一颗「继续本轮审查」；那句错的推断不出现；
//      点开那半句是执行器原话；
//   ② 新记录、能续：同一个位置、同一个样子，整页会话里按钮只有一颗；
//   ③ 类型不明：原话不用点开就在那一句里；
//   ④ 不能续 / 另开了新链：没有按钮，原因照说；
//   ⑤ 审查格：结论行带原因，那一轮的记录里有原话。
// 跑：npm -w web run test:review-no-verdict-cause
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const SAID = "unexpected status 503 Service Unavailable: auth_unavailable: no auth available";
const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1200, height: 2400 } });
  await page.goto(`${web.origin}/scripts/fixtures/review-no-verdict-cause.html`);
  const scope = (id) => page.locator(`.${id}-fixture`);
  for (const id of ["t-legacy", "t-typed", "t-vague", "t-blocked", "t-newchain"]) {
    await scope(id).locator(".review-verdict").getByText("第 1 轮审查没有给出结论").waitFor();
    await scope(id).locator(".insp-head").getByText(/第 1 轮中断/).waitFor();
  }
  /** 紧贴结论气泡下面那一行（ReviewVerdict 的 trailing）。 */
  const trailing = (id) => scope(id).locator(".review-verdict .turn-footnote.is-trailing");

  // ① 老记录
  const legacy = trailing("t-legacy");
  assert.match(await legacy.innerText(), /^中断 · 模型上游连不上（503）/, "气泡下面第一句就是原因，不被后来那句提醒挤掉");
  const legacyCta = legacy.getByRole("button", { name: "继续本轮审查" });
  assert.equal(await legacyCta.count(), 1, "原因后面挂带字的「继续本轮审查」");
  assert.equal(await scope("t-legacy").locator(".feed").getByRole("button", { name: "继续本轮审查" }).count(), 1, "会话里只有这一颗");
  assert.doesNotMatch(await scope("t-legacy").locator(".feed").innerText(), /report_stage|报告可能已经写完了/, "推断错了的那句不再出现");
  assert.doesNotMatch(await legacy.innerText(), new RegExp(SAID.slice(0, 30).replace(/[()]/g, "\\$&")), "类型明确：原话收在点开里");
  await legacy.locator("button.turn-footnote-part").filter({ hasText: "模型上游连不上" }).click();
  assert.match(await legacy.locator(".turn-footnote-detail").innerText(), new RegExp(`执行器的原话：「${SAID}」`), "点开是执行器原话");
  await legacyCta.click();
  assert.deepEqual(await page.evaluate(() => window.__retried), ["t-legacy"], "点它走「继续本轮审查」那个动作");

  // ② 新记录：同一个位置、同一个样子
  const typed = trailing("t-typed");
  assert.equal(
    (await typed.innerText()).replace(/\s+/g, " "), (await legacy.innerText()).replace(/\s+/g, " ").replace(/执行器的原话.*$/, "").trim(),
    "新老记录那一行一样",
  );
  assert.equal(await scope("t-typed").locator(".feed").getByRole("button", { name: "继续本轮审查" }).count(), 1, "按钮只有一颗");
  assert.equal(await scope("t-typed").locator(".feed").getByText("第 1 轮审查中断：模型上游连不上（503）").count(), 0, "原因不再另说一遍");

  // ③ 类型不明：原话直接摆出来
  const vague = trailing("t-vague");
  assert.match(await vague.innerText(), new RegExp(`中断 · 执行器异常退出（exit 1）：「${SAID}」`), "原话不用点开就看得到");
  assert.equal(await vague.getByRole("button", { name: "继续本轮审查" }).count(), 1);

  // ④ 不能续 / 另开了新链
  for (const id of ["t-blocked", "t-newchain"]) {
    assert.match(await trailing(id).innerText(), /^中断 · 模型上游连不上（503）/, `${id}：原因照说`);
    assert.equal(await scope(id).locator(".feed").getByRole("button", { name: "继续本轮审查" }).count(), 0, `${id}：会话里没有按钮`);
  }

  // ⑤ 审查格（老轮次）
  const pane = scope("t-legacy").locator(".pane");
  assert.match(await pane.locator(".insp-head").innerText(), /第 1 轮中断 · 模型上游连不上（503）/, "结论行带原因");
  await pane.locator(".insp-recs").getByText("第 1 轮").first().click();
  const recs = await pane.locator(".insp-recs").innerText();
  assert.match(recs, /这一轮中断：模型上游连不上（503），报告尚未生成。/);
  assert.match(recs.replace(/\s+/g, ""), new RegExp(`执行器的原话：「${SAID.replace(/\s+/g, "")}」`), "记录里看得到原话");

  console.log("review no-verdict cause tests passed");
} finally {
  await browser?.close();
  await web.close();
}
