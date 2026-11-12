// 会话里那一句审查结论点过去，右侧审查格要展开**那一场的那一轮**（第 1、2 轮审查 F2）：
//   · 两场派审都有「第 1 轮」：点旧的那句展开旧那场，不是后来那场——旧那场启动失败的那张
//     旧卡也认旧那场（它的开始那一条是升级前落的，不带 runId）；
//   · 认不出是哪一场的老卡、自由工作流里的就地验证卡不去审查格猜，在原处展开；
//   · 审查记录还没读到时点过来，这份请求要等记录到了再办，不能切过去就算办完；
//   · 就地验证的「第 N 轮验证」走验证记录那一格，同样展开那一轮。
// 跑:npm -w web run test:review-navigation-dom
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { waitUntil } from "./wait-until.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/scripts/fixtures/review-navigation.html`);
  const milestone = (name) => page.locator(`[data-lane="${name}"] .review-milestone button`).first();
  await milestone("old").waitFor();
  const expanded = (pane, record) => page.locator(`[data-pane="${pane}"] [data-record="${record}"] [aria-expanded]`).first().getAttribute("aria-expanded");
  const freeKey = async (runId) => page.locator(`[data-pane="free"] [data-record^="${runId}"]`).first().getAttribute("data-record");

  // ⓪ 卡片的身份：两次尝试都是旧那场，新那场带着自己的；同号不同场接连开始是两张卡。
  const lanes = await page.evaluate(() => window.__lanes);
  assert.deepEqual(lanes.free.map((lane) => lane.runId), [null, "old-run", "old-run", null, "new-run"], "每张卡认得出自己是哪一场");
  assert.deepEqual(lanes.superseded.map((lane) => lane.runId), ["old-run", "new-run"], "同号不同场不是同一轮重跑");

  // ① 记录还没读到就点旧那场启动失败的那张卡：请求挂着等，读到之后展开的是旧那场。
  await milestone("old-failed").click();
  await page.waitForTimeout(150);
  assert.match(await page.evaluate(() => window.__pendingRequest.free()) ?? "", /old-run/, "记录没读到时这份请求不能被当场收掉");
  await page.evaluate(() => window.__releaseReviews());
  await page.locator('[data-pane="free"] [data-record]').first().waitFor();
  const oldKey = await freeKey("old-run");
  const newKey = await freeKey("new-run");
  assert.ok(oldKey && newKey && oldKey !== newKey, "两场各有自己那条第 1 轮记录");
  await waitUntil(async () => (await expanded("free", oldKey)) === "true", "读到记录后展开旧那场的第 1 轮");
  assert.equal(await expanded("free", newKey), "false", "后来那场的同号轮不许被展开");
  await waitUntil(async () => (await page.evaluate(() => window.__pendingRequest.free())) === null, "办成之后请求收下");

  // ② 点新那句：展开新那场。
  await milestone("new").click();
  await waitUntil(async () => (await expanded("free", newKey)) === "true", "点新那句展开新那场");

  // ②' 认不出的两张：不发请求，在原处展开这一轮的经过。
  for (const name of ["legacy", "inline-in-free"]) {
    assert.match(await milestone(name).getAttribute("aria-label") ?? "", /展开这一轮的经过$/, `${name} 不说要去审查格`);
    await milestone(name).click();
    await page.locator(`[data-lane="${name}"] .review-milestone-body`).waitFor();
    assert.equal(await page.evaluate(() => window.__pendingRequest.free()), null, `${name} 不往审查格发请求`);
  }

  // ③ 就地验证：验证记录还在读时点过来也要等，读到了展开第 1 轮（不是最新那轮）。
  await milestone("verify").click();
  await page.waitForTimeout(150);
  assert.match(await page.evaluate(() => window.__pendingRequest.verify()) ?? "", /inline/, "验证记录没读到时这份请求等着");
  await page.evaluate(() => window.__releaseRounds());
  await waitUntil(async () => (await expanded("verify", "1-inline")) === "true", "验证记录展开第 1 轮");
  assert.equal(await expanded("verify", "2-inline"), "false", "别的轮次不动");
  assert.deepEqual(errors, [], "页面没有报错");
  console.log("review navigation dom ok: 同号两场（含启动失败的旧卡）认得出、认不出的在原处展开、记录读到之前请求等着、就地验证也展开那一轮");
} finally {
  await browser?.close();
  await web.close();
}
