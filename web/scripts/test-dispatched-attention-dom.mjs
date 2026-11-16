// 派出的任务来问 / 失败，在派它的那条任务那一头（真浏览器）：会话里一律不出东西，提示只在侧栏、
// 任务头那颗「派出的任务」键的数和右侧那一格里（判据 lib/dispatchTree.ts 的 dispatchNeedsYou）。
//
// 钉的是这几件事：
//   · 名下派出的任务在问：派它的那条任务的回复框还是它自己的普通回复框，会话里没有那几条的气泡；
//     在这里打字发出去，送到的是这条任务自己，提问的那几条一个答复都没收到。
//   · 知道有人在问：侧栏那一行行尾的数、竖轨上「派出的任务」那颗键的数都变色，右侧那一格里那一行
//     写着「等你答复」。
//   · 在哪答：点右侧那一行，左边那一屉里是那条任务自己的答题卡，答复送到它（不带别的任务）；
//     名下都答完了，两处的数不用刷新就收回颜色。
//   · 失败：会话里同样什么都不出；两处的数又变色，右侧那一行写着失败（红），点它在左边打开那条任务。
//   · 刷新后还是这样。
//   · 直接派出的那几条全归档了、再往下一层还在等答复：两处都是变色的 0（任务头那颗键照样冒出来），
//     那一层答掉之后颜色收回、那颗键上的数也撤掉。
// 跑：npm -w web run test:dispatched-attention
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
  await page.goto(`${web.origin}/scripts/fixtures/dispatched-attention.html`);
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
  const feed = await leadFeed.innerText();
  assert.ok(!feed.includes("第一条的问题") && !feed.includes("第二条的问题"), "会话里一个字都不提那几问");

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
  assert.equal(await leadFeed.innerText(), feed, "答完了会话里也一个字都不多");

  // —— 失败：会话里什么都不出；两处的数又变色，右侧那一行写着失败、带红；点它在左边打开那条任务。
  await drawerA.getByRole("button", { name: "关上派出的任务" }).click();
  await drawerA.waitFor({ state: "detached" });
  const feedBefore = await leadFeed.innerText();
  await page.evaluate(() => window.__server.fail("kid-c"));
  await bothWarn(true);
  const rowC = row("第三条派出去的");
  await page.waitForFunction(() => [...document.querySelectorAll(".dispatched-pane em")].some((node) => node.className === "is-bad"));
  assert.match(await rowC.locator("em").innerText(), /失败/, "右侧那一行写着失败");
  assert.equal(await rowC.locator("em").getAttribute("class"), "is-bad");
  assert.equal(await leadFeed.innerText(), feedBefore, "会话一个字都没多");
  assert.equal(await leadPane.locator(".question-card").count(), 0);
  await rowC.click();
  await drawer("第三条派出去的").waitFor();

  // —— 刷新后还是这样：会话里什么都没有，两处的数仍是那个颜色。
  await page.reload();
  await leadReply.waitFor();
  await bothWarn(true);
  assert.equal(await leadFeed.innerText(), feedBefore, "刷新后会话里还是没有");

  // —— 直接派出的全归档了、往下一层还在等：数是 0，两处照样变色；那一层答掉，颜色收回、键上的数撤掉。
  await page.evaluate(() => {
    for (const id of ["kid-a", "kid-b", "kid-c"]) window.__server.patch(id, { archived: true });
    window.__server.add({ id: "kid-mid", title: "又派了一层的", dispatchedBy: "lead", archived: true });
    window.__server.add({ id: "grand", title: "孙一层", dispatchedBy: "kid-mid", status: "paused", question: "孙一层的问题？" });
  });
  await bothWarn(true);
  assert.equal(await sideCount.locator('[aria-hidden="true"]').innerText(), "0");
  assert.equal((await railCount.locator("i").textContent())?.trim(), "0", "任务头那颗键：数是 0 也冒出来、带颜色");
  assert.equal(await leadFeed.innerText(), feedBefore, "会话里还是什么都没有");
  await page.evaluate(() => window.__server.patch("grand", { question: null, status: "running" }));
  await page.waitForFunction(() => !document.querySelector('[data-task-id="lead"] .workspace-dispatch-count')?.classList.contains("is-warn"));
  await railCount.waitFor({ state: "detached" });

  assert.deepEqual(failures, []);
  console.log("✓ 派出的任务来问 / 失败：回复框只属于自己、会话里一律不出东西、两处的数变色、抽屉里答掉收回、失败写在右侧那一行、刷新后照旧");
} finally {
  await browser?.close();
  await web.close();
}
