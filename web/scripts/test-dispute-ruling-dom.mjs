// 回复框顶上那一行：裁定在这里，不用去别处，也不弹确认框（用户 2026-11-15）。
//
// 盯的是：
// ① 出不出、出哪几颗：没驳回 / 锁住 / 在问你 / 辩论中都不出；「转为独立任务」只在执行者写了越界依据时给；
//    「让双方辩论」只在没辩过或上一场断了时给；任务或审查正在跑时键还在但按不动，原因指到才浮出；
// ② 选了一档回复框就成了那一步：提示换成那一档的选填说明，发送键写着这一按的名字；几档之间来回切
//    写的字不丢；再点同一颗或 Esc 回到平常的回复框；不选就照常发普通消息；
// ③ 选「让双方辩论」：正文换成「来回 1 2 3」+「审查者先说，共 N 段」，发送键「开始辩论」；
// ④ 按下去直接发，不弹确认框；发出去的带着选的那一刻冻结的那一条；忙着时键按不动；失败时选择和字都留着；
// ⑤ 驳回换了一条（轮询带来新状态），选择和写的字跟着旧那条走掉，不落到新那条上；
// ⑥ 审查格那一轮下面只有记录：驳回一句话 + 折着的依据（老驳回摊开）、裁定一句结果，没有裁定的按钮。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { waitUntil } from "./wait-until.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const requests = [];
  let respond = null;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const match = /\/api\/tasks\/([^/]+)\/free-workflow\/review\/(dispute\/resolution|debate)$/.exec(url.pathname);
    if (!match) return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    const body = JSON.parse(route.request().postData() ?? "{}");
    requests.push({ task: decodeURIComponent(match[1]), kind: match[2], body });
    const reply = await respond(match[1], match[2], body);
    await route.fulfill({ status: reply.status ?? 200, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  await page.goto(`${web.origin}/scripts/fixtures/dispute-ruling.html`);

  const scope = (name) => page.locator(`.${name}-fixture`);
  const keysOf = (name) => scope(name).locator(".ruling-row .ruling-choice").allInnerTexts();
  const textarea = (name) => scope(name).locator(".task-reply-box textarea");
  await scope("open").locator(".ruling-row").waitFor();

  // ① 出哪几颗。
  assert.deepEqual(await keysOf("open"), ["让它接着改", "这一轮不用改了", "转为独立任务", "让双方辩论"], "两段理由都给时四颗并存");
  assert.deepEqual(await keysOf("old"), ["让它接着改", "这一轮不用改了", "让双方辩论"], "没写越界依据就没有「转为独立任务」");
  assert.deepEqual(await keysOf("debated"), ["让它接着改", "这一轮不用改了", "转为独立任务"], "辩完的那条不再辩");
  for (const name of ["debating", "question", "locked", "ruled"]) {
    assert.equal(await scope(name).locator(".ruling-row").count(), 0, `${name}：这一行不出，回复框就是平常的回复框`);
    assert.equal(await textarea(name).getAttribute("placeholder"), "回复…", `${name}：平常的回复框`);
  }
  // 任务或审查正在跑：键还在、按不动，为什么按不动指到才浮出来。
  for (const [name, why] of [["running", /任务正在跑，这一轮跑完再裁/], ["reviewing", /一轮审查正在进行，审完再裁/]]) {
    const key = scope(name).getByRole("button", { name: "让它接着改" });
    assert.equal(await key.getAttribute("aria-disabled"), "true", `${name}：按不动`);
    await key.hover();
    await page.getByRole("tooltip").filter({ hasText: why }).waitFor();
    await key.click({ force: true });
    assert.equal(await key.getAttribute("aria-pressed"), "false", `${name}：点了也不选中`);
    assert.equal(await scope(name).locator(".ruling-send").count(), 0);
  }

  // ① 指到一颗：什么时候该点它、按下去会怎样，浮在上面，不常驻。
  const open = scope("open");
  assert.equal(await open.locator(".ruling-dock").innerText(), "让它接着改\n这一轮不用改了\n转为独立任务\n让双方辩论", "这一行只有那几颗键，没有常驻的说明");
  await open.getByRole("button", { name: "转为独立任务" }).hover();
  await page.getByRole("tooltip").filter({ hasText: /新建一个待办任务（不会自动开跑）[\s\S]*还没审过，想继续就再派一轮审查/ }).waitFor();
  // 键盘走进来同样浮出，读屏念得到。
  await page.mouse.move(0, 0);
  await open.getByRole("button", { name: "让它接着改" }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "这一轮不用改了", "键盘走得进来");
  await page.getByRole("tooltip").filter({ hasText: /第 1 轮这条意见作废/ }).waitFor();
  assert.match(await open.getByRole("button", { name: "这一轮不用改了" }).evaluate((el) => document.getElementById(el.getAttribute("aria-describedby")).textContent), /第 1 轮这条意见作废/);

  // ⑥ 审查格那一轮下面只有记录（发起辩论之前看：接口回来的状态里这一轮就不在了）。
  const record = scope("open").locator(".dispute-record");
  assert.equal(await record.getByRole("button", { name: /让它接着改|这一轮不用改了|转为独立任务|让双方辩论|去裁定/ }).count(), 0, "审查格里没有裁定的按钮");
  assert.match(await record.locator(".dispute-part").first().innerText(), /^执行者不认其中几条，另几条说该另开任务改\n+第 1 条读错了代码/, "谁不认什么 + 那一句");
  assert.equal(await record.locator(".folded-prose .task-markdown").count(), 0, "有那一句时依据折着");
  assert.match(await record.locator(".folded-prose button em").first().innerText(), /\d+ 字/, "折叠标题报字数");
  // ② 不选：照常发普通消息，不碰裁定。
  await textarea("open").fill("先问一句：第 2 条为什么算越界？");
  await open.locator(".send-key-main").click();
  await page.waitForFunction(() => (window.__sent_open ?? []).length === 1);
  assert.deepEqual(await page.evaluate(() => window.__sent_open), ["先问一句：第 2 条为什么算越界？"]);
  assert.equal(requests.length, 0, "没选一档就不是裁定");

  // ② 选一档：回复框成了那一步。
  const upheld = open.getByRole("button", { name: "让它接着改" });
  await upheld.click();
  assert.equal(await upheld.getAttribute("aria-pressed"), "true");
  assert.match(await textarea("open").getAttribute("placeholder"), /^要交代给执行者的话（选填）/);
  assert.match(await textarea("open").getAttribute("aria-label"), /^让它接着改：/);
  assert.equal(await open.locator(".ruling-send").innerText(), "发起修复", "发送键写着这一按的名字");
  assert.equal(await open.locator(".send-key").count(), 0, "只有一颗发送键");
  await page.waitForFunction(() => document.activeElement?.closest(".open-fixture") && document.activeElement.tagName === "TEXTAREA", null, { timeout: 3000 });
  await textarea("open").fill("按第二种方案改。");
  for (const [name, send, hint] of [["这一轮不用改了", "作废这条意见", /^记一笔你的理由（选填）/], ["转为独立任务", "建任务并转走这几条", /^要交代给新任务的话（选填）/]]) {
    await open.getByRole("button", { name }).click();
    assert.equal(await open.locator(".ruling-send").innerText(), send);
    assert.match(await textarea("open").getAttribute("placeholder"), hint);
    assert.equal(await textarea("open").inputValue(), "按第二种方案改。", "几档之间来回切，写的字不丢");
  }
  // 再点同一颗：回到平常的回复框；再选回来，字还在。
  await open.getByRole("button", { name: "转为独立任务" }).click();
  assert.equal(await textarea("open").getAttribute("placeholder"), "回复…");
  assert.equal(await textarea("open").inputValue(), "", "平常的回复草稿是另一份");
  assert.equal(await open.locator(".ruling-row [aria-pressed='true']").count(), 0);
  await upheld.click();
  assert.equal(await textarea("open").inputValue(), "按第二种方案改。");
  // Esc：同样回到平常的回复框。
  await textarea("open").press("Escape");
  assert.equal(await upheld.getAttribute("aria-pressed"), "false");
  assert.equal(await textarea("open").getAttribute("placeholder"), "回复…");

  // ③ 让双方辩论：正文换成来回几次。
  await open.getByRole("button", { name: "让双方辩论" }).click();
  assert.equal(await textarea("open").isHidden(), true, "正文换成来回几次");
  const exchanges = open.getByRole("radiogroup", { name: "来回" });
  assert.deepEqual(await exchanges.getByRole("radio").allInnerTexts(), ["1", "2", "3"], "来回 1 2 3");
  assert.equal(await exchanges.getByRole("radio", { name: "1" }).getAttribute("aria-checked"), "true");
  assert.match(await open.locator(".ruling-exchanges small").innerText(), /^审查者先说，共 3 段$/);
  await exchanges.getByRole("radio", { name: "3" }).click();
  assert.match(await open.locator(".ruling-exchanges small").innerText(), /共 7 段/);
  assert.equal(await open.locator(".ruling-send").innerText(), "开始辩论");

  // ④ 按下去直接发，不弹确认框；带着冻结的那一条。接口回来的状态里辩论在跑：这一行收起。
  respond = async () => ({ body: { debateId: "debate-new", state: { reviews: [] } } });
  await open.locator(".ruling-send").click();
  await waitUntil(() => requests.length === 1, "发起辩论");
  assert.equal(await page.getByRole("dialog").count(), 0, "不弹确认框");
  assert.deepEqual(requests[0], { task: "t-open", kind: "debate", body: { exchanges: 3, target: { runId: "run-1", round: 1 } } });
  await open.locator(".ruling-row").waitFor({ state: "detached" });

  // ④ 裁定：选「转为独立任务」、写要点、按下去；忙着时键按不动，回来之后这一行收起，提示里带着新任务。
  const resolve = scope("resolve");
  let release;
  respond = () => new Promise((done) => {
    release = () => done({ body: { resolution: "deferred", repairError: null, deferredTask: { id: "derived-1", title: "原任务 · 承接第 1 轮审查的越界意见" }, state: { reviews: [] } } });
  });
  await resolve.getByRole("button", { name: "转为独立任务" }).click();
  await textarea("resolve").fill("这几条连同那个 helper 一起重写。");
  await resolve.locator(".ruling-send").click();
  await waitUntil(() => requests.length === 2, "发出裁定");
  assert.equal(await resolve.locator(".ruling-send").isDisabled(), true, "忙着时按不动");
  assert.equal(await resolve.locator(".ruling-send").getAttribute("aria-busy"), "true");
  assert.deepEqual(requests[1], { task: "t-resolve", kind: "dispute/resolution", body: { resolution: "deferred", note: "这几条连同那个 helper 一起重写。", target: { runId: "run-1", round: 1 } } });
  release();
  await resolve.locator(".ruling-row").waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__notices_resolve), ["已转为独立任务：原任务 · 承接第 1 轮审查的越界意见（待办，未起跑）"]);
  assert.equal(await page.getByRole("dialog").count(), 0, "不弹确认框");
  assert.equal(await textarea("resolve").inputValue(), "", "交完了，框回到平常的样子");

  // ④ 失败：说清哪儿没成，选择和字都留着，可以再按。
  const fail = scope("fail");
  respond = () => ({ status: 409, body: { error: "这条驳回已经不在等裁定了" } });
  await fail.getByRole("button", { name: "这一轮不用改了" }).click();
  await textarea("fail").fill("那段代码确实只在单线程里跑。");
  await fail.locator(".ruling-send").click();
  await fail.getByRole("alert").filter({ hasText: "这条驳回已经不在等裁定了" }).waitFor();
  assert.equal(await fail.getByRole("button", { name: "这一轮不用改了" }).getAttribute("aria-pressed"), "true", "失败时选择留着");
  assert.equal(await textarea("fail").inputValue(), "那段代码确实只在单线程里跑。", "失败时写的字留着");
  assert.equal(await fail.locator(".ruling-send").isDisabled(), false, "可以再按");

  // ⑤ 驳回换了一条：选择和字跟着旧那条走掉，不落到新那条上。
  const replace = scope("replace");
  await replace.getByRole("button", { name: "让它接着改" }).click();
  await textarea("replace").fill("给第 1 轮写的要点。");
  await page.evaluate(() => window.__swap_replace(window.__replaced));
  await waitUntil(async () => (await replace.locator(".ruling-row [aria-pressed='true']").count()) === 0, "选择跟着旧那条走掉");
  assert.equal(await textarea("replace").getAttribute("placeholder"), "回复…");
  await replace.getByRole("button", { name: "让它接着改" }).click();
  assert.equal(await textarea("replace").inputValue(), "", "给旧那条写的字不落到新那条上");
  assert.match(await page.locator(".replace-fixture .ruling-row").innerText(), /让它接着改/);
  respond = () => ({ body: { resolution: "upheld", repairError: null, deferredTask: null, state: { reviews: [] } } });
  await replace.locator(".ruling-send").click();
  await waitUntil(() => requests.length === 4, "发出裁定");
  assert.deepEqual(requests[3].body.target, { runId: "run-1", round: 2 }, "发出去的是新那条");

  // ⑥（续）老驳回、裁过的那一轮。
  const old = scope("old").locator(".dispute-record");
  assert.equal(await old.locator(".dispute-part-gist").count(), 0, "老驳回没有那一句就不编一句");
  assert.equal(await old.locator(".folded-prose .task-markdown").count(), 1, "老驳回的依据默认摊开");
  const ruled = scope("ruled").locator(".dispute-part[aria-label='裁定']");
  assert.equal(await ruled.locator(".dispute-part-gist").innerText(), "让它接着改", "裁定一句结果");

  // 窄屏：这一行折行而不是撑破回复框（量四颗都在的那一份）。
  await page.setViewportSize({ width: 390, height: 900 });
  const narrow = scope("fail");
  const overflow = await narrow.locator(".task-reply-box").evaluate((el) => el.scrollWidth - el.clientWidth);
  assert(overflow <= 1, `窄屏下回复框不横向撑破（多出 ${overflow}px）`);
  const rowBox = await narrow.locator(".ruling-row").boundingBox();
  const replyBox = await narrow.locator(".task-reply-box").boundingBox();
  assert(rowBox.x + rowBox.width <= replyBox.x + replyBox.width + 1, "这一行收在回复框里");
  const sendBox = await narrow.locator(".ruling-send").boundingBox();
  assert(sendBox.x + sendBox.width <= replyBox.x + replyBox.width + 1, "写着字的发送键也收在回复框里");

  console.log("dispute ruling tests passed");
} finally {
  await browser?.close();
  await web.close();
}
