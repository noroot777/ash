// 派出的任务来问 / 失败，在派它的那条任务那一头（真浏览器）。判据本身在 test-dispatch-signals.mjs。
//
// 钉的是这几件事：
//   · 名下派出的任务在问：派它的那条任务的回复框还是它自己的普通回复框，会话里没有那几条的气泡；
//     在这里打字发出去，送到的是这条任务自己，提问的那几条一个答复都没收到。
//   · 知道有人在问：侧栏那一行行尾的数、竖轨上「派出的任务」那颗键的数都变色，右侧那一格里那一行
//     写着「等你答复」。
//   · 在哪答：点右侧那一行，左边那一屉里是那条任务自己的答题卡，答复送到它（不带别的任务）；
//     名下都答完了，两处的数不用刷新就收回颜色。
//   · 失败：会话里一颗气泡（标题 + 原因头一句），点它在左边打开那条任务；两处的数又变色。
//   · 刷新后失败那颗还在，提问的气泡还是一颗都没有。
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

  const leadPane = page.locator('[data-pane="lead"] > .task-detail-main');
  const leadFeed = leadPane.locator(".task-conversation");
  const leadReply = leadPane.getByRole("textbox", { name: "回复任务" });
  const drawer = (title) => page.locator(`aside.side-drawer[aria-label="派出的任务：${title}"]`);
  const requests = () => page.evaluate(() => window.__server.requests());
  const sideCount = page.locator('[data-task-id="lead"] .workspace-dispatch-count');
  const tab = page.getByRole("tab", { name: /^派出的任务/ });
  const railCount = tab.locator(".insp-counted-icon");
  const warned = async (locator) => locator.evaluate((node) => node.classList.contains("is-warn"));
  const bothWarn = (want) => page.waitForFunction((value) => {
    const side = document.querySelector('[data-task-id="lead"] .workspace-dispatch-count');
    const rail = document.querySelector('[role="tab"] .insp-counted-icon');
    return !!side && !!rail && side.classList.contains("is-warn") === value && rail.classList.contains("is-warn") === value;
  }, want);
  const pane = page.locator(".dispatched-pane");
  const row = (title) => pane.getByRole("button", { name: new RegExp(`^${title}，`) });

  // —— 名下两条在问：这条任务的回复框是它自己的普通回复框，会话里没有那两条的气泡。
  await leadReply.waitFor();
  assert.equal(await leadPane.locator(".question-card").count(), 0, "派它的那条：回复框不长成那几条的答题卡");
  assert.equal(await leadPane.locator(".dispatched-bubble").count(), 0, "会话里没有派出的任务来问的气泡");
  const feed = await leadFeed.innerText();
  assert.ok(!feed.includes("第一条的问题") && !feed.includes("第二条的问题"), "会话里一个字都不提那几问");
  assert.ok(!feed.includes("答复直接送到了"));

  // —— 知道有人在问：侧栏和竖轨那颗键的数都变色，右侧那一行写着等你答复。
  await bothWarn(true);
  assert.equal(await sideCount.innerText(), "3");
  assert.equal((await railCount.locator("i").textContent())?.trim(), "3");
  await pane.waitFor();
  assert.equal(await row("第二条派出去的").locator("em").innerText(), "等你答复");
  assert.equal(await row("第二条派出去的").locator("em").getAttribute("class"), "is-ask");

  // —— 在这里打字发出去：送到的是这条任务自己，提问的那几条一个答复都没收到。
  await leadReply.fill("先把两条的进度汇总一下(lead-own)");
  await leadReply.press("Enter");
  await page.waitForFunction(() => window.__server.requests().some((request) => request.url === "/tasks/lead/reply"));
  const sent = await requests();
  assert.deepEqual(sent.map((request) => request.url), ["/tasks/lead/reply"], "这一句只送给这条任务自己");
  assert.equal(sent[0].body.text, "先把两条的进度汇总一下(lead-own)");
  assert.equal(await leadPane.locator(".question-card").count(), 0);

  // —— 点右侧那一行：左边那一屉里是它自己的答题卡，答复送到它。
  await row("第二条派出去的").click();
  const drawerB = drawer("第二条派出去的");
  await drawerB.locator(".question-card").waitFor();
  assert.match(await drawerB.locator(".question-card-title").innerText(), /^第二条的问题：要不要顺手改文档？$/, "抽屉里是它自己的那一问");
  await drawerB.getByRole("button", { name: "要", exact: true }).click();
  await drawerB.getByRole("button", { name: "发送答复" }).click();
  await page.waitForFunction(() => window.__server.requests().some((request) => request.url === "/tasks/kid-b/answer"));
  const answerB = (await requests()).find((request) => request.url === "/tasks/kid-b/answer");
  assert.equal(answerB.body.via, undefined, "答复就是它自己的答复，不带派它的那条");
  assert.equal(await row("第二条派出去的").locator("em").innerText(), "运行中", "右侧那一行跟着变");
  assert.ok(await warned(sideCount) && await warned(railCount), "还有一条在问：数还是那个颜色");

  // —— 另一条也在抽屉里答掉：两处的数不用刷新就收回颜色。
  await row("第一条派出去的").click();
  const drawerA = drawer("第一条派出去的");
  await drawerA.locator(".question-card").waitFor();
  await drawerA.getByRole("button", { name: "先改接口", exact: true }).click();
  await drawerA.getByRole("button", { name: "发送答复" }).click();
  await bothWarn(false);
  assert.equal((await requests()).filter((request) => request.url.endsWith("/answer")).map((request) => request.url).join(),
    "/tasks/kid-b/answer,/tasks/kid-a/answer");
  assert.equal(await leadPane.locator(".dispatched-bubble").count(), 0, "答完了会话里也什么都不多");
  assert.ok(!(await leadFeed.innerText()).includes("答复直接送到了"));

  // —— 失败：一颗气泡（标题 + 原因头一句），不出答题卡；点它打开那条任务；数又变色。
  await page.evaluate(() => window.__server.fail("kid-c", "模型上游连不上（503）。点重试会接着跑。", 18));
  const failed = leadPane.locator(".dispatched-bubble.is-failed");
  await failed.waitFor();
  assert.match(await failed.locator(".debate-bubble-say").innerText(), /^第三条派出去的\s*模型上游连不上（503）。$/, "标题 + 原因头一句");
  assert.match(await failed.locator(".review-verdict-meta").textContent(), /claude@nodemach · 失败了/);
  assert.equal(await leadPane.locator(".question-card").count(), 0, "失败不出答题卡");
  await bothWarn(true);
  await drawerA.getByRole("button", { name: "关上派出的任务" }).click();
  await drawerA.waitFor({ state: "detached" });
  await failed.locator("button.review-verdict-text").click();
  await drawer("第三条派出去的").waitFor();
  const feedOrder = await leadFeed.innerText();
  assert.ok(feedOrder.indexOf("第二条先别动数据库") < feedOrder.indexOf("模型上游连不上"), "按失败那一刻插在会话里");

  // —— 刷新后失败那颗还在原来的位置，提问的气泡还是一颗都没有。
  const before = await leadFeed.innerText();
  await page.reload();
  await leadPane.locator(".dispatched-bubble.is-failed").waitFor();
  assert.equal(await leadPane.locator(".dispatched-bubble").count(), 1, "只有失败的那一颗");
  assert.equal(await leadFeed.innerText(), before, "刷新后在原来的位置");

  assert.deepEqual(failures, []);
  console.log("✓ 派出的任务来问 / 失败：回复框只属于自己、会话里没有提问气泡、两处的数变色、抽屉里答掉收回、失败气泡与刷新");
} finally {
  await browser?.close();
  await web.close();
}
