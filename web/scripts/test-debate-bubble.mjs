// 会话里那颗辩论气泡（DebateBubble）、就地摊开的概览、左侧抽屉里的完整记录，和审查格那一轮下面的辩论那一段。
//
// 那一整场辩论原来是时间线上一张卡：`开始辩论…` + 七条「轮到 X 发言」+ 七颗气泡 + `辩论结束…`，
// 而且气泡里根本不是辩论记录——真发言走 debate_reply 落库。后来折成了一张辩论卡；现在它是会话里
// 一颗气泡，跟审查者那颗同一副骨架、同一种点法（用户 2026-11-15）。这份回归盯：
// ① 段间流水一条不留，一场辩论一颗气泡；四种此刻各写各的（辩论中 / 等你裁定 / 裁完 / 中途断了）；
// ② 点法：辩论中点气泡 = 就地摊开概览；辩完点气泡 = 去审查格那一轮的辩论那一段；浮出那一行两颗键；
// ③ 概览一段一行：老记录没有那一句时拿完整发言的开头顶上；点一行，左侧抽屉停在那一段；
// ④ 左侧抽屉只盖中间那一栏，审查格照样点得着；同一时刻左边只有一屉（报告和辩论记录互相顶替）；
// ⑤ 等你裁定时「用这段作要点」落进回复框的是概览上看到的那一句（不是整篇发言）、选中「让它接着改」；
//    三处入口（会话气泡、审查格、左侧抽屉）引完抽屉都收起；按不按得动跟回复框顶上那一行走，抽屉开着
//    时任务跑起来，抽屉里那几颗也跟着不给；
// ⑥ 配不到落盘记录时原始行原样兜底，不凭空少一段。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { waitUntil } from "./wait-until.mjs";

const web = await startWebServer();

/** 浮出那一行指到气泡才出：先把气泡滚进视野、指上去，再按那一颗（滚动会把指针挪开）。 */
async function pressKey(bubble, name) {
  await bubble.locator(".review-verdict-bubble").scrollIntoViewIfNeeded();
  await bubble.locator(".review-verdict-text").hover();
  await bubble.getByRole("button", { name }).click();
}

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  // 回复框挂着时会去读执行器之类的东西；这里只看它顶上那一行和框里的字。
  await page.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto(`${web.origin}/scripts/fixtures/debate-bubble.html`);

  const awaiting = page.locator(".awaiting-fixture");
  const bubble = awaiting.locator(".debate-bubble");
  await bubble.waitFor();

  // ① 一场辩论一颗气泡，段间流水全部收走。
  assert.equal(await bubble.count(), 1, "一场辩论就是一颗气泡");
  assert.doesNotMatch(await awaiting.locator(".task-detail").innerText(), /轮到(审查者|执行者)发言/, "段间流水讲的是进度不是内容，一条都不留");
  assert.equal(await page.locator(".debate-lane").count(), 0, "原来那张辩论卡没了");

  // ① 等你裁定：审查者收尾的立场 + 它收尾那一段的一句话，正文的字色。
  assert.match(await bubble.getAttribute("class"), /\bis-awaiting\b/);
  const awaitingSay = await bubble.locator(".debate-bubble-say").innerText();
  assert.match(awaitingSay, /^审查者收尾 · 维持原意见/, "先写立场");
  assert.match(awaitingSay, /我的最终立场是 upheld/, "老记录没有那一句：拿收尾那段发言的开头顶上");
  const settledBubble = page.locator(".settled-fixture .debate-bubble");
  const colorOf = (locator) => locator.locator(".review-verdict-text").evaluate((el) => getComputedStyle(el).color);
  assert.notEqual(await colorOf(bubble), await colorOf(settledBubble), "等你裁定的那一句用正文色，裁完回到小灰字");
  const meta = (await bubble.locator("header").innerText()).replace(/\s+/g, " ");
  assert.match(meta, /辩论 · 审查者和执行者 · 7 段 · 16m 4s · /, "浮出那一行：辩论 · 谁和谁 · 几段 · 用时 · 时刻");

  // ② 浮出那一行的两颗键：文档 = 左侧抽屉；列表 = 就地摊开。
  const docKey = bubble.getByRole("button", { name: "辩论的完整记录" });
  const listKey = bubble.getByRole("button", { name: "每段一句" });
  assert.equal(await docKey.count(), 1);
  assert.equal(await listKey.count(), 1);
  await pressKey(bubble, "每段一句");
  const overview = awaiting.locator(".debate-bubble-lane .debate-overview");
  await overview.waitFor();
  assert.equal(await listKey.getAttribute("aria-expanded"), "true");

  // ③ 概览一段一行：左边写谁，右边是那一句；老记录拿完整发言的开头顶上，标着全文几个字。
  const rows = overview.locator(".debate-row");
  assert.equal(await rows.count(), 7, "七段发言，一段一行");
  assert.equal(await rows.nth(0).locator(".debate-row-who").innerText(), "审查者");
  assert.equal(await rows.nth(1).locator(".debate-row-who").innerText(), "执行者");
  assert.match(await rows.nth(0).locator(".debate-row-gist").innerText(), /^本段没有实际可回应的技术驳回[\s\S]*…全文 921 字$/, "第 1 段的开头 + 全文字数");
  assert.doesNotMatch(await overview.innerText(), /第 2 段已交卷/, "气泡里那句随口的交代不是辩论记录");

  // ③ 点第 3 段：左侧抽屉打开，停在那一段。
  await rows.nth(2).locator("button.debate-row-gist").click();
  const drawer = awaiting.locator(".side-drawer");
  await drawer.waitFor();
  assert.equal(await drawer.locator(".side-drawer__kind").innerText(), "辩论");
  assert.equal(await drawer.locator(".debate-record-seg").count(), 7, "完整记录一段一节");
  assert.match(await drawer.locator('.debate-record-seg[data-seq="7"] > header').innerText(), /第 7 段 · 收尾，它自己的立场：维持原意见/, "收尾那段写明它自己的立场");
  assert.match(await drawer.innerText(), /我的最终立场是 upheld/, "抽屉里是完整发言");
  await page.waitForFunction(() => {
    const scroll = document.querySelector(".awaiting-fixture .side-drawer__scroll");
    const seg = scroll?.querySelector('[data-seq="3"]');
    if (!scroll || !seg) return false;
    return Math.abs(seg.getBoundingClientRect().top - scroll.getBoundingClientRect().top) < 40;
  }, null, { timeout: 3000 });
  assert.equal(await docKey.getAttribute("aria-pressed"), "true", "开着的是它：文档键画「按下」");

  // ④ 只盖中间那一栏：抽屉在 .task-detail 里面，右边审查格不被盖住、照样点得着。
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  const detailBox = await awaiting.locator(".task-detail").boundingBox();
  const drawerBox = await drawer.boundingBox();
  const inspectorBox = await awaiting.locator(".fixture-inspector").boundingBox();
  assert(drawerBox.x >= detailBox.x - 1 && drawerBox.x + drawerBox.width <= detailBox.x + detailBox.width + 1, `抽屉不出中间那一栏（${JSON.stringify({ detailBox, drawerBox })}）`);
  assert(drawerBox.x + drawerBox.width <= inspectorBox.x + 1, "抽屉不盖审查格");
  await awaiting.locator(".fixture-inspector-probe").click();
  assert.deepEqual(await page.evaluate(() => window.__probe_awaiting), [1], "抽屉开着时审查格照样点得着");
  assert.equal(await drawer.isVisible(), true, "点审查格不把抽屉关掉");

  // ④ 同一时刻左边只有一屉：审查格那一轮的报告「在左侧铺开看」顶替辩论记录。
  await awaiting.locator(".fixture-inspector").getByRole("button", { name: "在左侧铺开看" }).click();
  await page.waitForFunction(() => document.querySelector(".awaiting-fixture .side-drawer__kind")?.textContent === "审查报告");
  assert.equal(await awaiting.locator(".side-drawer").count(), 1, "只有一屉");
  assert.match(await awaiting.locator(".side-drawer").innerText(), /代理层缺有界超时/, "换成了报告全文");
  assert.equal(await docKey.getAttribute("aria-pressed"), "false");
  // 审查格那一轮下面的辩论那一段：同一份概览，右上那颗展开键 = 左侧抽屉读完整记录。
  const inspectorDebate = awaiting.locator(".fixture-inspector .dispute-part[data-debate]");
  assert.equal(await inspectorDebate.locator(".debate-row").count(), 7, "审查格里是同一份概览");
  await inspectorDebate.getByRole("button", { name: "在左侧读完整记录" }).click();
  await page.waitForFunction(() => document.querySelector(".awaiting-fixture .side-drawer__kind")?.textContent === "辩论");
  assert.equal(await awaiting.locator(".side-drawer").count(), 1);
  await page.keyboard.press("Escape");
  await awaiting.locator(".side-drawer").waitFor({ state: "detached" });

  // ⑤ 「用这段作要点」：指到那一行才出；点了落进回复框、选中「让它接着改」。
  const textarea = awaiting.locator(".task-reply-box textarea");
  assert.equal(await textarea.inputValue(), "");
  await rows.nth(6).hover();
  const quote = rows.nth(6).getByRole("button", { name: "用这段作要点" });
  // 淡入有一小段过渡：等它落定再量。
  await quote.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  assert.equal(await quote.evaluate((el) => getComputedStyle(el).opacity), "1", "指到那一行才出");
  assert.equal(await rows.nth(0).getByRole("button", { name: "用这段作要点" }).evaluate((el) => getComputedStyle(el).opacity), "0", "没指到的那几行不出");
  // 概览上那一句（不连「全文 N 字」）：引的就是它。
  const gistOf = (row) => row.locator(".debate-row-gist").evaluate((el) =>
    [...el.childNodes].filter((node) => node.nodeName !== "EM").map((node) => node.textContent).join("").trim());
  const gist7 = await gistOf(rows.nth(6));
  await quote.click();
  await waitUntil(async () => (await textarea.inputValue()) === `〔审查者第 7 段〕${gist7}`, "落进回复框的是那一句");
  assert(gist7.length <= 81, `是一句，不是整篇发言（${gist7.length} 字）`);
  assert.equal(await awaiting.getByRole("button", { name: "让它接着改" }).getAttribute("aria-pressed"), "true", "选中「让它接着改」");
  assert.equal(await awaiting.getByRole("button", { name: "发起修复" }).count(), 1, "发送键写着这一按的名字");
  // 抽屉里那一节同样能引：往后追加，引完抽屉收起。
  await pressKey(bubble, "辩论的完整记录");
  await drawer.waitFor();
  const seg = drawer.locator('.debate-record-seg[data-seq="5"]');
  await seg.hover();
  await seg.getByRole("button", { name: "用这段作要点" }).click();
  await awaiting.locator(".side-drawer").waitFor({ state: "detached" });
  const gist5 = await gistOf(rows.nth(4));
  await waitUntil(async () => (await textarea.inputValue()) === `〔审查者第 7 段〕${gist7}\n\n〔审查者第 5 段〕${gist5}`, "已经写了字就往后追加，不覆盖");
  // 审查格那一轮下面的概览同样能引：引完抽屉收起（它盖着回复框）。
  await pressKey(bubble, "辩论的完整记录");
  await drawer.waitFor();
  const inspectorRow = inspectorDebate.locator(".debate-row").nth(0);
  await inspectorRow.hover();
  await inspectorRow.getByRole("button", { name: "用这段作要点" }).click();
  await awaiting.locator(".side-drawer").waitFor({ state: "detached" });
  await waitUntil(async () => (await textarea.inputValue()).endsWith(`\n\n〔审查者第 1 段〕${await gistOf(rows.nth(0))}`), "审查格里引的也是那一句");
  // 抽屉开着时任务跑起来（另一个窗口点了续跑）：回复框顶上那一行按不动了，抽屉里那几颗也跟着不给；停下来又回来。
  await pressKey(bubble, "辩论的完整记录");
  await drawer.waitFor();
  assert.equal(await drawer.getByRole("button", { name: "用这段作要点" }).count(), 7);
  await page.evaluate(() => window.__task_awaiting({ status: "running" }));
  await waitUntil(async () => (await drawer.getByRole("button", { name: "用这段作要点" }).count()) === 0, "任务跑起来，抽屉里不再给引");
  assert.equal(await inspectorDebate.getByRole("button", { name: "用这段作要点" }).count(), 0, "审查格里同样不给");
  await page.evaluate(() => window.__task_awaiting({}));
  await waitUntil(async () => (await drawer.getByRole("button", { name: "用这段作要点" }).count()) === 7, "停下来又回来");
  await page.keyboard.press("Escape");
  await awaiting.locator(".side-drawer").waitFor({ state: "detached" });

  // ② 辩完以后点气泡：去审查格那一轮的辩论那一段。
  await bubble.locator(".review-verdict-text").click();
  const opened = await page.evaluate(() => window.__opened_awaiting);
  assert.equal(opened.length, 1, "点一下去一次");
  assert.deepEqual(opened[0], { source: "free", runId: "run-1", round: 1, debateId: "Q8LMxUXU90rw" }, "带着哪一场审查、哪一轮、哪一场辩论");

  // ① 辩论中：刚说完那一段的一句话，最多两行；下面一行小灰字是此刻谁在说第几段。
  const live = page.locator(".live-fixture .debate-bubble");
  assert.match(await live.getAttribute("class"), /\bis-live\b/);
  assert.equal(await live.locator(".review-progress-dot").count(), 1, "在跑的点会动");
  assert.equal(await live.locator(".debate-bubble-say").innerText(), "审查者我坚持这一条：超时那一处必须在这个任务里修。");
  assert.equal(await live.locator(".debate-bubble-say").evaluate((el) => getComputedStyle(el).webkitLineClamp), "2", "最多两行，不往下长");
  assert.equal(await live.locator(".review-progress-now").innerText(), "执行者在说第 2 / 3 段");
  assert.match(await live.locator("header").innerText(), /共 3 段/);
  // ② 辩论中浮出那一行只有文档键；点气泡就地摊开，不去别处。
  assert.equal(await live.getByRole("button", { name: "每段一句" }).count(), 0, "辩论中没有列表键");
  assert.equal(await live.getByRole("button", { name: "辩论的完整记录" }).count(), 1);
  await live.locator(".review-verdict-text").click();
  const liveRows = page.locator(".live-fixture .debate-bubble-lane .debate-row");
  await liveRows.first().waitFor();
  assert.equal(await liveRows.count(), 2, "说完的一段 + 正在说的一段");
  assert.match(await liveRows.nth(1).innerText(), /执行者\s*正在组织发言…/);
  assert.equal(await page.evaluate(() => window.__opened_live ?? null), null, "辩论中点气泡不去审查格");
  assert.equal(await page.locator(".live-fixture .ruling-row").count(), 0, "辩论中回复框就是平常的回复框");

  // ① 裁完以后：缩成一行小灰字；概览里没有「用这段作要点」。
  assert.match(await settledBubble.getAttribute("class"), /\bis-settled\b/);
  assert.equal(await settledBubble.locator(".debate-bubble-say").innerText(), "辩了 7 段，审查者收尾：维持原意见");
  await pressKey(settledBubble, "每段一句");
  await page.locator(".settled-fixture .debate-bubble-lane .debate-row").first().waitFor();
  assert.equal(await page.locator(".settled-fixture .debate-bubble-lane").getByRole("button", { name: "用这段作要点" }).count(), 0, "裁完了没有要点可引");
  // 审查格那一轮下面：裁定那一段一句结果，附的话折着。
  const ruling = page.locator(".settled-fixture .dispute-part[aria-label='裁定']");
  assert.match(await ruling.innerText(), /让它接着改/);
  assert.match(await ruling.innerText(), /附了一段要交代的话/);
  assert.equal(await page.locator(".settled-fixture .ruling-row").count(), 0, "裁完了回复框顶上没有那一行");

  // ① 中途断了：断在哪一段、谁没能发言；回复框顶上那一行仍给「让双方辩论」。
  const failed = page.locator(".failed-fixture .debate-bubble");
  assert.match(await failed.getAttribute("class"), /\bis-failed\b/);
  assert.equal(await failed.locator(".debate-bubble-say").innerText(), "辩论断在第 2 段：执行者没能发言，前 1 段都在");
  assert.equal(await page.locator(".failed-fixture .ruling-row").getByRole("button", { name: "让双方辩论" }).count(), 1, "上一场断了可以再辩");
  assert.equal(await page.locator(".awaiting-fixture .ruling-row").getByRole("button", { name: "让双方辩论" }).count(), 0, "辩完的那条不再辩");

  // ⑥ 配不到落盘记录：原始行一条都不少。
  const fallback = page.locator(".fallback-fixture .debate-bubble");
  assert.equal(await fallback.count(), 1, "没有 reviews 也照样是一颗气泡");
  await fallback.locator(".review-verdict-text").click();
  const raw = await page.locator(".fallback-fixture .review-verdict > .turn-footnote-lane").innerText();
  assert.match(raw, /轮到审查者发言/, "配不到 statement 时段间流水要留着——宁可啰嗦，也不凭空少掉一段");
  assert.match(raw, /第 2 段已交卷/, "兜底时原始气泡原样摆出来");
  assert.match(raw, /辩论结束/, "收口那句还在");

  // 窄屏不撑破：气泡和概览都收在中间那一栏里。
  // 窄屏上审查格是盖在会话上的一层，这里把它收起来，只量中间那一栏。
  await page.addStyleTag({ content: ".fixture-inspector { display: none !important; }" });
  await page.setViewportSize({ width: 390, height: 900 });
  for (const selector of [".task-conversation", ".task-reply-box", ".debate-overview"]) {
    const overflow = await page.locator(`.awaiting-fixture ${selector}`).first().evaluate((el) => el.scrollWidth - el.clientWidth);
    assert(overflow <= 1, `窄屏下 ${selector} 不横向撑破（多出 ${overflow}px）`);
  }

  console.log("debate bubble tests passed");
} finally {
  await browser?.close();
  await web.close();
}
