// 会话里那一句审查结论点过去，右侧审查格要展开**那一场的那一轮**（第 1 轮审查 F2）：
//   · 两场派审都有「第 1 轮」：点旧的那句展开旧那场，不是后来那场；
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

  // ① 记录还没读到就点旧那句：请求挂着等，读到之后展开的是旧那场。
  await milestone("old").click();
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

  // ③ 就地验证：验证记录还在读时点过来也要等，读到了展开第 1 轮（不是最新那轮）。
  await milestone("verify").click();
  await page.waitForTimeout(150);
  assert.match(await page.evaluate(() => window.__pendingRequest.verify()) ?? "", /inline/, "验证记录没读到时这份请求等着");
  await page.evaluate(() => window.__releaseRounds());
  await waitUntil(async () => (await expanded("verify", "1-inline")) === "true", "验证记录展开第 1 轮");
  assert.equal(await expanded("verify", "2-inline"), "false", "别的轮次不动");
  assert.deepEqual(errors, [], "页面没有报错");
  console.log("review navigation dom ok: 同号两场认得出、记录读到之前请求等着、就地验证也展开那一轮");
} finally {
  await browser?.close();
  await web.close();
}
