// 讨论的浏览器那一半（ReplyBox 的「讨论」、DiscussionBubble、DiscussionRecord、FreeReviewPane 里那一段）。纯逻辑在 test-discussion.mjs。
//
// 盯的是：
// ① 右边那一格叫「审议」，不再有叫「审查」的格；只有讨论、没有审查时，那一格里照样有这一场；
// ② 发起：@ 一个人、选「讨论」——发送键写「开始讨论」、占位写「要讨论什么…」；轮数那一段点一下换一档、下次记得；
//    「和谁」那一段多选，再勾一个就是三方（中间不再摆一个人的模型）；@ 这条任务自己的执行器时「讨论」按不动；
//    `/讨论` 叫上次那个人、停在「讨论」；任务正在跑时「开始讨论」按不动、说清为什么；发出去的是话题、轮数和叫的人；
// ③ 会话里一场一颗气泡、跟在你发起时那一句后面（那一句带着发起时附的文件），段间流水一条不留；四种此刻（一段都
//    没交卷 / 在说 / 说完 / 断了）各写各的；在说时展开前后，谁在说第几段都在气泡下面；
// ④ 点法：在说时点气泡 = 就地摊开、浮出那一行只有文档键；说完点气泡 = 「审议」格里打开这一场、滚过去亮一下，
//    浮出那一行两颗键；「审议」格那一段和就地摊开的是同一个组件；文档键 / 点一行 = 左侧抽屉读完整记录。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { waitUntil } from "./wait-until.mjs";

const PROFILES = [
  { id: "profile-codex", name: "codex@local", type: "codex", isDefault: true },
  { id: "profile-claude", name: "claude@local", type: "claude", isDefault: true },
  { id: "profile-gemini", name: "gemini@local", type: "gemini", isDefault: true },
];

/** 浮出那一行指到气泡才出：先把气泡滚进视野、指上去，再按那一颗。 */
async function pressKey(bubble, name) {
  await bubble.locator(".review-verdict-bubble").scrollIntoViewIfNeeded();
  await bubble.locator(".review-verdict-text").hover();
  await bubble.getByRole("button", { name }).click();
}

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const started = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/agents") return json(PROFILES);
    // @ 菜单也在查文件（引用文件那一半）：给它一个空的结果，别拿通配的 [] 让它读不出 hits。
    if (/\/file-(search|dir)$/.test(path)) return json({ hits: [], more: false });
    let match = /^\/tasks\/([^/]+)\/free-workflow$/.exec(path);
    if (match) {
      const discussion = await page.evaluate((id) => window.__discussions?.[id] ?? null, match[1]);
      return json({
        taskId: match[1], selectedReviewerId: null, stateVersion: 1, workspaceHead: null, workspaceDirty: null,
        reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null },
        reviewTurn: false, preview: { running: false, url: null, port: null, command: null, startedAt: null },
        executions: [], reviews: [], discussions: discussion ? [discussion] : [],
      });
    }
    match = /^\/tasks\/([^/]+)\/discussions$/.exec(path);
    if (match && request.method() === "POST") {
      started.push({ task: match[1], body: JSON.parse(request.postData() ?? "{}") });
      return json({ discussionId: `new-${started.length}`, state: { stateVersion: 99, reviews: [], discussions: [{}] } }, 201);
    }
    return json([]);
  });
  await page.goto(`${web.origin}/scripts/fixtures/discussion.html`);
  const scope = (name) => page.locator(`.${name}-fixture`);
  const input = (name) => scope(name).getByRole("textbox", { name: "回复任务" });
  const row = (name, agent) => scope(name).getByRole("group", { name: `叫 ${agent} 来做什么` });
  const key = (name, agent, label) => row(name, agent).getByRole("button", { name: label, exact: true });
  const call = async (name, text, agent) => {
    await input(name).fill(`${text}@${agent.slice(0, 2)}`);
    await scope(name).getByRole("option", { name: new RegExp(`@${agent}`) }).click();
    await row(name, agent).waitFor();
  };
  await input("start").waitFor();

  // ① 右边那一格叫「审议」。
  const titles = await page.evaluate(() => window.__tabTitles);
  assert.ok(titles.includes("审议"), "有「审议」那一格");
  assert.ok(!titles.includes("审查"), "不再有叫「审查」的格");

  // ② 发起：@ codex，三种做法，选「讨论」。
  await call("start", "", "codex");
  assert.deepEqual(await row("start", "codex").getByRole("button").allInnerTexts(), ["问一句", "讨论", "派出去"], "问一句 / 讨论 / 派出去");
  await key("start", "codex", "讨论").click();
  assert.equal(await key("start", "codex", "讨论").getAttribute("aria-pressed"), "true");
  assert.equal(await input("start").getAttribute("placeholder"), "要讨论什么…");
  const send = scope("start").getByRole("button", { name: "开始讨论", exact: true });
  assert.equal(await send.isDisabled(), true, "还没写话题：按不动");
  const rounds = scope("start").getByRole("button", { name: /^来回几轮：/ });
  assert.match(await rounds.getAttribute("aria-label"), /^来回几轮：2 轮；点击改成3 轮$/, "默认 2 轮");
  await rounds.click();
  assert.match(await rounds.innerText(), /3 轮/, "点一下换一档");
  assert.equal(await scope("start").getByRole("button", { name: /^模型：/ }).count(), 1, "只叫一个人：中间照旧是他的模型");
  await input("start").fill("幽灵回合锁走哪条路？");
  await send.click();
  await waitUntil(() => started.length === 1, "发出去");
  assert.deepEqual(started[0], {
    task: "t-start",
    body: { topic: "幽灵回合锁走哪条路？", attachments: [], rounds: 3, guests: [{ agentType: "codex", executorId: null, model: null, reasoningEffort: null }] },
  }, "发出去的是话题、轮数和叫的人");
  await waitUntil(async () => (await input("start").inputValue()) === "", "发完框清空");
  assert.equal(await scope("start").getByRole("button", { name: "开始讨论", exact: true }).count(), 0, "发完不再叫着人");

  // ② 再叫一次：轮数记得上次的；「和谁」那一段再勾一个就是三方。
  await call("start", "", "codex");
  await key("start", "codex", "讨论").click();
  assert.match(await scope("start").getByRole("button", { name: /^来回几轮：/ }).innerText(), /3 轮/, "轮数记得上次选的");
  await scope("start").getByRole("button", { name: /^和谁讨论：codex/ }).click();
  const menu = page.getByRole("menu", { name: "和谁讨论" });
  await menu.waitFor();
  assert.equal(await menu.getByRole("menuitemcheckbox", { name: /claude/ }).getAttribute("aria-disabled"), "true", "这条任务自己的执行器在单子里按不动");
  await menu.getByRole("menuitemcheckbox", { name: /gemini/ }).click();
  await page.keyboard.press("Escape");
  assert.match(await scope("start").getByRole("button", { name: /^和谁讨论：/ }).getAttribute("aria-label"), /^和谁讨论：codex、gemini/, "三方");
  assert.equal(await scope("start").getByRole("button", { name: /^模型：/ }).count(), 0, "叫了两个人：中间不摆一个人的模型");
  await input("start").fill("三方谈谈");
  await scope("start").getByRole("button", { name: "开始讨论", exact: true }).click();
  await waitUntil(() => started.length === 2, "三方发出去");
  assert.deepEqual(started[1].body.guests.map((guest) => guest.agentType), ["codex", "gemini"]);

  // ② @ 这条任务自己的执行器：「讨论」按不动。
  await call("start", "", "claude");
  assert.equal(await key("start", "claude", "讨论").getAttribute("aria-disabled"), "true", "和自己讨论没有意义");
  await scope("start").getByRole("button", { name: "不叫 claude 了" }).click();

  // ② `/讨论`：叫上次那个人，停在「讨论」，后面的话留在框里。
  await input("start").fill("/讨论 再谈一轮");
  await input("start").press("Enter");
  await row("start", "codex").waitFor();
  assert.equal(await key("start", "codex", "讨论").getAttribute("aria-pressed"), "true", "/讨论 停在讨论");
  assert.equal(await input("start").inputValue(), "再谈一轮");
  await scope("start").getByRole("button", { name: "不叫 codex 了" }).click();

  // ② 任务正在跑：按不动，说清为什么。
  await call("busy", "现在谈 ", "codex");
  await key("busy", "codex", "讨论").click();
  const busySend = scope("busy").getByRole("button", { name: "开始讨论", exact: true });
  assert.equal(await busySend.isDisabled(), true);
  const reasonId = await busySend.getAttribute("aria-describedby");
  assert.equal(await scope("busy").locator(`[id="${reasonId}"]`).textContent(), "任务正在跑，这一轮结束后再开讨论");

  // ③ 一段都没交卷。
  const blind = scope("blind").locator(".discussion-bubble");
  await blind.waitFor();
  assert.match(await blind.locator(".debate-bubble-say").innerText(), /^各自在写第一段，互相看不到$/);
  assert.equal(await scope("blind").locator(".review-progress-now").innerText(), "codex 在说第 1 / 4 段", "下面一行小灰字：谁在说第几段");

  // ③④ 在说：跟在你那一句后面；段间流水不留；点气泡就地摊开，浮出那一行只有文档键。
  const live = scope("live").locator(".discussion-bubble");
  assert.equal(await live.count(), 1, "一场一颗");
  assert.doesNotMatch(await scope("live").locator(".task-conversation").innerText(), /轮到 (codex|claude)/, "段间流水一条不留");
  const order = await scope("live").locator(".task-conversation").evaluate((root) => {
    const topic = [...root.querySelectorAll(".task-message--user")].find((el) => el.textContent?.includes("幽灵回合锁走哪条路"));
    const bubble = root.querySelector(".discussion-bubble");
    return !!topic && !!bubble && !!(topic.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.equal(order, true, "气泡跟在你发起时那一句后面");
  assert.match(await live.locator(".debate-bubble-say").innerText(), /^codex\s*让收尾每一步自己带时限$/);
  assert.equal(await live.locator(".review-progress-dot").count(), 1, "在跑的点会动");
  assert.equal(await live.getByRole("button", { name: "每段一句" }).count(), 0, "在说时浮出那一行只有文档键");
  assert.equal(await live.getByRole("button", { name: "讨论的完整记录" }).count(), 1);
  await live.locator(".review-verdict-text").click();
  const liveOverview = live.locator(".debate-overview[aria-label='讨论概览']");
  await liveOverview.waitFor();
  assert.equal(await liveOverview.locator(".debate-row").count(), 2, "一段一行（说完的 + 正在说的）");
  assert.equal(await scope("live").locator(".review-progress-now").innerText(), "claude 在说第 2 / 4 段", "展开之后谁在说第几段照样在气泡下面");
  assert.equal(await page.evaluate(() => window.__opened_live ?? null), null, "在说时点气泡不去审议格");

  // ③④ 说完：写谈了几段、谈拢了；点气泡去「审议」格那一场，滚过去亮一下。
  const done = scope("done").locator(".discussion-bubble");
  assert.equal(await done.locator(".debate-bubble-say").innerText(), "claude 和 codex 谈了 3 段 · 谈拢了");
  const doneText = await scope("done").locator(".task-conversation").innerText();
  assert.match(doneText, /合稿：先修泄漏/, "合稿是主会话里照常的一段回复");
  const topicBubble = scope("done").locator(".task-message--user", { hasText: "幽灵回合锁走哪条路" });
  assert.equal(await topicBubble.getByRole("link", { name: "打开附件 方案草图.txt" }).count(), 1, "发起时附的文件在那一句上，点得开");
  assert.doesNotMatch(doneText, /写合稿】|【讨论】/, "系统替你说的那几句（每段的提示、写合稿那一句）不出现");
  assert.match(await done.locator(".review-verdict-text").getAttribute("aria-label"), /在右侧审议格里打开这场讨论$/, "读屏念得出点了去哪");
  const record = scope("done").locator('.fixture-inspector [data-record="discussion:d-done"]');
  await record.waitFor();
  assert.equal(await scope("done").locator(".fixture-inspector").getByText("审议记录").count(), 1, "只有讨论、没有审查：那一格里照样有它");
  await done.locator(".review-verdict-text").click();
  await waitUntil(async () => (await page.evaluate(() => window.__opened_done ?? [])).length === 1, "点了去审议格");
  assert.deepEqual((await page.evaluate(() => window.__opened_done))[0].params.discussionId, "d-done");
  await waitUntil(async () => /\bis-here\b/.test(await record.getAttribute("class")), "那一条亮一下");
  await waitUntil(async () => /\bis-open\b/.test(await record.getAttribute("class")), "那一场摊开");
  const paneRows = await record.locator(".debate-overview[aria-label='讨论概览'] .debate-row").allInnerTexts();
  await pressKey(done, "每段一句");
  const inlineRows = await done.locator(".debate-overview[aria-label='讨论概览'] .debate-row").allInnerTexts();
  assert.equal(paneRows.length, 3);
  assert.deepEqual(inlineRows, paneRows, "审议格那一段和就地摊开的是同一个组件");

  // ④ 文档键 = 左侧抽屉读完整记录：一段一节，第一轮写明写的时候没看对方的。
  await pressKey(done, "讨论的完整记录");
  const drawer = scope("done").locator(".side-drawer");
  await drawer.waitFor();
  assert.equal(await drawer.locator(".side-drawer__kind").innerText(), "讨论");
  assert.equal(await drawer.locator(".debate-record-seg").count(), 3);
  assert.match(await drawer.locator('.debate-record-seg[data-seq="1"] > header').innerText(), /codex\s*第 1 段 · 写的时候没看对方的/);
  assert.doesNotMatch(await drawer.locator('.debate-record-seg[data-seq="3"] > header').innerText(), /没看/, "第二轮起不写");
  assert.match(await drawer.innerText(), /第 2 段的完整发言/, "抽屉里是完整发言");
  // 点审议格那一段的一行：抽屉换到那一段（同一屉，不叠两屉）。
  await record.locator("button.debate-row-gist").nth(1).click();
  await page.waitForFunction(() => {
    const scroll = document.querySelector(".done-fixture .side-drawer__scroll");
    const seg = scroll?.querySelector('[data-seq="2"]');
    return !!scroll && !!seg && Math.abs(seg.getBoundingClientRect().top - scroll.getBoundingClientRect().top) < 40;
  }, null, { timeout: 3000 });
  assert.equal(await scope("done").locator(".side-drawer").count(), 1, "同一时刻左边只有一屉");

  // ③ 断了：如实写断在哪。
  assert.match(await scope("failed").locator(".discussion-bubble .debate-bubble-say").innerText(),
    /^讨论中止：claude 第 2 段被停下或异常结束，前 1 段都在$/);

  // 窄屏上回复框（三方 + 轮数那一颗胶囊）和气泡都不横向溢出。
  await page.setViewportSize({ width: 390, height: 900 });
  await call("start", "", "codex");
  await key("start", "codex", "讨论").click();
  await scope("start").getByRole("button", { name: /^和谁讨论：/ }).click();
  await page.getByRole("menu", { name: "和谁讨论" }).getByRole("menuitemcheckbox", { name: /gemini/ }).click();
  await page.keyboard.press("Escape");
  for (const name of ["start", "failed"]) {
    const overflow = await scope(name).evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok(overflow <= 1, `${name}：窄屏不横向溢出（多出 ${overflow}px）`);
  }

  console.log("discussion dom ok: 审议格、发起（做法/轮数/三方/自己/命令/在跑）、四种此刻、点法、同一个组件、左侧抽屉");
} finally {
  await browser?.close();
  await web.close();
}
