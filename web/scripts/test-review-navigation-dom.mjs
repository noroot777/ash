// 会话里那一句审查结论点过去，右侧审查格要展开**那一场的那一轮**（第 1~3 轮审查 F2）：
//   · 两场派审都有「第 1 轮」：点旧的那句展开旧那场，不是后来那场——旧那场启动失败的那张
//     旧卡也认旧那场（它的开始那一条是升级前落的，不带 runId）；升级前那场没收尾、升级后
//     新一场又从第 1 轮开始，后面那句结论归新一场；
//   · 手里那份是点之前的旧快照（还没有新一场）：这份请求等新数据到了再办，不当场收掉；
//     重读过也没有：说出来（说是哪一轮）、给「重试」，重试时那一场到了就展开；接着点了别的，
//     上一份的失败提示连同它的「重试」当场撤掉；第一次读就失败也说出来、能重试；
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
  // ⓪ 卡片的身份：两次尝试都是旧那场，新那场带着自己的；同号不同场接连开始是两张卡。
  await page.waitForFunction(() => window.__lanes);
  const lanes = await page.evaluate(() => window.__lanes);
  assert.deepEqual(lanes.free.map((lane) => lane.runId), [null, "old-run", "old-run", null, "new-run"], "每张卡认得出自己是哪一场");
  assert.deepEqual(lanes.superseded.map((lane) => lane.runId), ["old-run", "new-run"], "同号不同场不是同一轮重跑");
  assert.deepEqual(lanes.mixed.map((lane) => lane.runId), ["old-run", "new-run"], "没说是哪一场的旧开始不吞掉新一场");
  assert.deepEqual(lanes.adopted.map((lane) => lane.runId), ["old-run"], "重跑那一条说了是哪一场，整张卡认它");
  assert.deepEqual(lanes.text.map((lane) => lane.runId), [null], "只有原文的老旁注同号照旧算重跑");

  const milestone = (name) => page.locator(`[data-lane="${name}"] .review-milestone button`).first();
  await milestone("old").waitFor();
  const expanded = (pane, record) => page.locator(`[data-pane="${pane}"] [data-record="${record}"] [aria-expanded]`).first().getAttribute("aria-expanded");
  const freeKey = async (runId) => page.locator(`[data-pane="free"] [data-record^="${runId}"]`).first().getAttribute("data-record");

  // ① 记录还没读到就点旧那场启动失败的那张卡：请求挂着等，读到之后展开的是旧那场。
  await milestone("old-failed").click();
  await page.waitForTimeout(150);
  assert.match(await page.evaluate(() => window.__pendingRequest.free()) ?? "", /old-run/, "记录没读到时这份请求不能被当场收掉");
  await page.evaluate(() => window.__reviews.release("nav-task"));
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

  // ④ 旧快照：手里那份只有旧那场，新一场的 GET 还在路上时点它——请求挂着，数据到了就展开。
  await page.locator('[data-pane="stale"] [data-record^="old-run"]').first().waitFor();
  await page.evaluate(() => { window.__reviews.hold("nav-stale"); window.__reviews.set("nav-stale", ["old-run", "new-run"]); });
  await milestone("stale-new").click();
  await page.waitForTimeout(300);
  assert.match(await page.evaluate(() => window.__pendingRequest.stale()) ?? "", /new-run/, "旧快照里没有不等于找不到：请求不能被收掉");
  await page.evaluate(() => window.__reviews.release("nav-stale"));
  const staleKey = async (runId) => page.locator(`[data-pane="stale"] [data-record^="${runId}"]`).first().getAttribute("data-record");
  await page.locator('[data-pane="stale"] [data-record^="new-run"]').first().waitFor();
  const staleNew = await staleKey("new-run");
  await waitUntil(async () => (await expanded("stale", staleNew)) === "true", "新数据到了，展开新一场");
  await waitUntil(async () => (await page.evaluate(() => window.__pendingRequest.stale())) === null, "办成之后请求收下");

  // ⑤ 重读过也没有：说出来、能重试；重试时那一场到了就展开。
  const miss = page.locator('[data-pane="stale"] [role="alert"]', { hasText: "没找到要打开的第 1 轮审查" });
  await milestone("ghost").click();
  await miss.waitFor();
  assert.equal(await page.evaluate(() => window.__pendingRequest.stale()), null, "确认办不成才收下");
  await page.evaluate(() => window.__reviews.set("nav-stale", ["old-run", "new-run", "ghost-run"]));
  await miss.getByRole("button", { name: "重试" }).click();
  await page.locator('[data-pane="stale"] [data-record^="ghost-run"]').first().waitFor();
  const ghostKey = await staleKey("ghost-run");
  await waitUntil(async () => (await expanded("stale", ghostKey)) === "true", "重试时那一场到了，展开它");
  assert.equal(await miss.count(), 0, "办成了，提示收起");

  // ⑥ 一处没找到、接着点了另一处（数据还在路上）：上一份的失败提示和「重试」当场撤掉，
  //    后点的那一处到了就展开，不被旧目标顶掉。
  const staleAlert = page.locator('[data-pane="stale"] [role="alert"]');
  await milestone("future").click();
  await staleAlert.filter({ hasText: "没找到要打开的第 2 轮审查" }).waitFor();
  await page.evaluate(() => { window.__reviews.hold("nav-stale"); window.__reviews.set("nav-stale", ["old-run", "new-run", "ghost-run", "later-run"]); });
  await milestone("later").click();
  await waitUntil(async () => (await staleAlert.count()) === 0, "点了别的，上一份的失败提示当场撤掉");
  assert.match(await page.evaluate(() => window.__pendingRequest.stale()) ?? "", /later-run/, "后点的那一处在等数据");
  await page.evaluate(() => window.__reviews.release("nav-stale"));
  await page.locator('[data-pane="stale"] [data-record^="later-run"]').first().waitFor();
  const laterKey = await staleKey("later-run");
  await waitUntil(async () => (await expanded("stale", laterKey)) === "true", "后点的那一处到了就展开");
  assert.equal(await staleAlert.count(), 0, "旧目标的失败没有回来");

  // ⑦ 第一次读就失败：说出来、能重试；恢复后重试就展开。
  await milestone("cold").click();
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.__reviews.fail("nav-cold", "网络断了"); window.__reviews.release("nav-cold"); });
  const coldMiss = page.locator('[data-pane="cold"] [role="alert"]', { hasText: "没找到要打开的第 1 轮审查" });
  await coldMiss.waitFor();
  assert.equal(await page.evaluate(() => window.__pendingRequest.cold()), null, "读失败了不再挂着");
  await page.evaluate(() => window.__reviews.fail("nav-cold", null));
  await coldMiss.getByRole("button", { name: "重试" }).click();
  await page.locator('[data-pane="cold"] [data-record^="old-run"]').first().waitFor();
  const coldKey = await page.locator('[data-pane="cold"] [data-record^="old-run"]').first().getAttribute("data-record");
  await waitUntil(async () => (await expanded("cold", coldKey)) === "true", "恢复后重试就展开");

  // ③ 就地验证：验证记录还在读时点过来也要等，读到了展开第 1 轮（不是最新那轮）。
  await milestone("verify").click();
  await page.waitForTimeout(150);
  assert.match(await page.evaluate(() => window.__pendingRequest.verify()) ?? "", /inline/, "验证记录没读到时这份请求等着");
  await page.evaluate(() => window.__releaseRounds());
  await waitUntil(async () => (await expanded("verify", "1-inline")) === "true", "验证记录展开第 1 轮");
  assert.equal(await expanded("verify", "2-inline"), "false", "别的轮次不动");
  // 没有的那一轮：重读过也没有，说出来。
  await milestone("verify-3").click();
  await page.locator('[data-pane="verify"] [role="alert"]', { hasText: "没找到要打开的第 3 轮验证" }).waitFor();
  assert.equal(await page.evaluate(() => window.__pendingRequest.verify()), null, "确认办不成才收下");
  assert.deepEqual(errors, [], "页面没有报错");
  console.log("review navigation dom ok: 同号两场（含启动失败的旧卡、升级前没收尾的旧开始）认得出、认不出的在原处展开、记录没读到或是旧快照时请求等着、重读也没有就说出来并能重试、点了别的旧提示当场撤掉、第一次读就失败也能重试、就地验证也展开那一轮");
} finally {
  await browser?.close();
  await web.close();
}
