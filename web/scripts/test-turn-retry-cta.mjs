// 普通回合异常结束以后，那一回合失败那句话带上原因、后面挂「重试这一回合」；任务头不再有那颗
// 不带字的重试图标（夹具见 fixtures/turn-retry-cta.tsx，每一份都照 TaskDetail 那条链路推出动作）。
//
// 现场（2026-11-13）：续聊回合崩了，会话里只有一句「这一轮异常结束」，点开是「执行异常结束 · exit 1」；
// 能重来的只有任务头一颗不带字的图标，用户没认出来，也看不到出了什么错。这份回归盯：
// ① 刷新以后与开着页面看两路：那句话是「这一轮中断 · 模型上游连不上（503）」，点开是带执行器原话的经过，
//    后面挂「重试这一回合」、点了走那个动作；两路结果一样；
// ② 老记录（没有结构化原因）：那句话照老样子「这一轮异常结束」，动作照样在；会话行已判失败却还没有
//    收尾时刻（第 1 轮审查第 1 条）：那句话和动作也都在；
// ③ 不能重试（后面又跑过一回合、手动停止的、任务在跑）：没有动作；同一条会话重试成功以后（刷新与开着
//    页面看两路，失败那一回合只跑了工具、没说话的那种，以及哨兵叫醒后失败、回复并回等它那一回合的那种）：前一
//    回合那句话和原因还在它自己后面，没有动作（第 2 轮审查第 2 条、第 3、4 轮审查第 1 条）；
// ④ 任务头上没有回合级的重试图标；
// ⑤ 服务端说此刻重来不了（能不能重来整份由服务端判，夹具带着它那一刻的结论）：动作灰着、指上去说原因，点了不走。
// 跑：npm -w web run test:turn-retry-cta
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1000, height: 2400 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/scripts/fixtures/turn-retry-cta.html`);
  const scope = (name) => page.locator(`.t-${name}-fixture`);
  await scope("running").locator(".task-detail-header").waitFor();
  const footnoteOf = (name) => scope(name).locator(".feed .turn-footnote");

  // ① 两路
  const shapes = [];
  for (const name of ["persisted", "live"]) {
    const line = footnoteOf(name).filter({ hasText: "这一轮中断 · 模型上游连不上（503）" });
    assert.equal(await line.count(), 1, `${name}：那句话带上服务端判的原因`);
    const cta = line.getByRole("button", { name: "重试这一回合" });
    assert.equal(await cta.count(), 1, `${name}：那句话后面挂「重试这一回合」`);
    assert.equal(await line.locator("button.turn-footnote-part .system-event-cta").count(), 0, `${name}：键不落在那半句自己的展开键里`);
    await line.getByRole("button", { name: /这一轮中断/ }).click();
    assert.match(await scope(name).locator(".turn-footnote-detail").innerText(), /执行器的原话：「unexpected status 503 Service Unavailable」/,
      `${name}：点开是带执行器原话的经过`);
    await cta.click();
    // 字与键的排布（时刻不算：直播那条边界本来就不带时刻）。
    shapes.push(await line.locator(".turn-footnote-line").evaluate((node) => [...node.children]
      .filter((child) => child.tagName !== "TIME").map((child) => child.textContent).join("|")));
  }
  assert.deepEqual(await page.evaluate(() => window.__retried), ["t-persisted", "t-live"], "点了走的是「重试这一回合」那个动作");
  assert.equal(shapes[0], shapes[1], "开着页面看和刷新以后是同一个样子");

  // ② 老记录
  const legacy = footnoteOf("legacy").filter({ hasText: "这一轮异常结束" });
  assert.equal(await legacy.count(), 1, "老记录：那句话照老样子");
  assert.equal(await legacy.getByText(/这一轮中断/).count(), 0, "老记录：不编原因");
  assert.equal(await legacy.getByRole("button", { name: "重试这一回合" }).count(), 1, "老记录：动作照样在");
  const noEnd = footnoteOf("no-end").filter({ hasText: "这一轮异常结束" });
  assert.equal(await noEnd.count(), 1, "已判失败、会话行没收尾：那句话照样补出来");
  assert.equal(await noEnd.getByRole("button", { name: "重试这一回合" }).count(), 1, "已判失败、会话行没收尾：动作挂在那句话后面");

  // ③ 不能重试
  assert.equal(await footnoteOf("later").filter({ hasText: "这一轮中断 · 模型上游连不上（503）" }).count(), 1, "后面又跑过一回合：那句话还在");
  for (const name of ["retried", "retried-live"]) {
    const line = footnoteOf(name).filter({ hasText: "这一轮中断 · 模型上游连不上（503）" });
    assert.equal(await line.count(), 1, `${name}：重试成功以后，前一回合那句话和原因还在`);
    await line.getByRole("button", { name: /这一轮中断/ }).click();
    assert.match(await scope(name).locator(".turn-footnote-detail").innerText(), /执行器的原话/, `${name}：还点得开原因`);
    const text = await scope(name).locator(".feed").innerText();
    assert.ok(text.indexOf("改到一半。") < text.indexOf("这一轮中断") && text.indexOf("这一轮中断") < text.indexOf("重试好了。"),
      `${name}：那句话挂在失败那一回合后面，不在重试成功的那一回合后面`);
    assert.equal(await footnoteOf(name).filter({ hasText: /这一轮(中断|异常结束)/ }).count(), 1, `${name}：成功的那一回合不补`);
  }
  {
    // 叫醒后失败的那一回合并回了等它的那一回合：并出来的气泡带的是叫醒那一回合自己的原因（第 4 轮审查第 1 条）。
    const scope3 = scope("woken-retried");
    const feed = await scope3.locator(".feed").innerText();
    assert.ok(feed.includes("等了 1 次哨兵") && feed.includes("构建挂了，接着看。"), "woken-retried：叫醒后的回复并回了等它的那一回合");
    const line = footnoteOf("woken-retried").filter({ hasText: "这一轮中断 · 模型上游连不上（503）" });
    assert.equal(await line.count(), 1, "woken-retried：叫醒后失败、重试成功以后，那句话带的还是它自己的原因");
    await line.getByRole("button", { name: /这一轮中断/ }).click();
    assert.match(await scope3.locator(".turn-footnote-detail").innerText(), /执行器的原话/, "woken-retried：还点得开原因");
    const text = await scope3.locator(".feed").innerText();
    assert.ok(text.indexOf("构建挂了，接着看。") < text.indexOf("这一轮中断") && text.indexOf("这一轮中断") < text.indexOf("重试好了。"),
      "woken-retried：那句话挂在叫醒后失败的那一回合后面");
    assert.equal(await footnoteOf("woken-retried").filter({ hasText: /这一轮(中断|异常结束)/ }).count(), 1, "woken-retried：成功的回合不补");
  }
  {
    // 失败那一回合只跑了工具、没来得及说话：只剩执行过程那颗气泡，那句话和原因照样挂在它后面（第 3 轮审查第 1 条）。
    const line = footnoteOf("retried-tools").filter({ hasText: "这一轮中断 · 模型上游连不上（503）" });
    assert.equal(await line.count(), 1, "retried-tools：只有执行过程的失败回合，重试成功后那句话和原因还在");
    await line.getByRole("button", { name: /这一轮中断/ }).click();
    assert.match(await scope("retried-tools").locator(".turn-footnote-detail").innerText(), /执行器的原话/, "retried-tools：还点得开原因");
    const text = await scope("retried-tools").locator(".feed").innerText();
    assert.ok(text.indexOf("这一轮中断") < text.indexOf("重试好了。"), "retried-tools：那句话挂在失败那一回合后面");
    assert.equal(await footnoteOf("retried-tools").filter({ hasText: /这一轮(中断|异常结束)/ }).count(), 1, "retried-tools：成功的那一回合不补");
  }
  for (const name of ["later", "stopped", "running", "retried", "retried-live", "retried-tools", "woken-retried"]) {
    assert.equal(await scope(name).getByRole("button", { name: "重试这一回合" }).count(), 0, `${name}：不能重试，没有动作`);
  }
  assert.equal(await footnoteOf("stopped").filter({ hasText: /这一轮(中断|异常结束)/ }).count(), 0, "手动停止的不算异常");

  // ⑤ 灰着说原因
  {
    const cta = footnoteOf("blocked").getByRole("button", { name: "重试这一回合" });
    assert.equal(await cta.count(), 1, "blocked：动作在");
    assert.equal(await cta.getAttribute("aria-disabled"), "true", "blocked：灰着");
    await cta.hover();
    await page.getByText("所在分组已暂停，先恢复分组再重试这一回合").waitFor();
    // aria-disabled 在 playwright 眼里就是点不了，强点一下看它确实不走。
    await cta.click({ force: true });
    assert.deepEqual(await page.evaluate(() => window.__retried), ["t-persisted", "t-live"], "blocked：点了不走");
  }

  // ④ 任务头
  for (const name of ["persisted", "live", "legacy", "no-end", "later", "retried", "retried-live", "retried-tools", "woken-retried", "stopped", "running", "blocked"]) {
    assert.equal(await scope(name).locator(".task-detail-header").getByRole("button", { name: /重试|继续本轮审查/ }).count(), 0,
      `${name}：任务头没有回合级的重试图标`);
  }
  assert.deepEqual(errors, [], "页面没有报错");
  console.log("turn retry cta tests passed");
} finally {
  await browser?.close();
  await web.close();
}
