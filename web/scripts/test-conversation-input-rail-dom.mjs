// 会话左侧的输入导航：真渲染、真指针、真按键、真滚动。
//
// 钉的是用户要的那几件事（2026-11-06，照 codex 桌面版那条做）：
//   · 每条横线是我说过的一句话 —— 原始需求打头，后面是追问；哨兵投喂、审查打回不算；
//   · 指上去附近几条横线一起鼓起来，旁边浮出那条输入的全文（长输入在卡片里滚得到结尾）；
//   · 点一下会话直接跳到那颗气泡（原始需求跳到顶），而且跳过去之后来了新消息不把人拽回底部；
//   · 按 Q 把每条输入都摊开（第一行之后的正文整段跟着，开头一样的两条分得开），方向键挑、回车跳；Esc / 再按 Q / 点外面收起；输入框里的 q 是字；
//     会话被抽屉盖住时不摊开；列表半透明、放得下就 760 宽，摊开期间后面的会话不跟着新消息滚，收起再补上；
//   · 滚轮落在导航条上照样滚会话，窄屏下正文不被刻度带压住。
// 跑法：npm -w web run test:conversation-input-rail-dom
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { WAIT_TIMEOUT_MS } from "./wait-until.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/scripts/fixtures/conversation-input-rail.html`);

  const feed = page.getByTestId("feed");
  const strip = page.locator(".conversation-input-strip");
  const ticks = page.locator(".conversation-input-tick");
  const card = page.locator(".conversation-input-card");
  const menu = page.getByRole("menu", { name: "我的输入" });
  await strip.waitFor();

  const flush = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  // 平滑滚动要走一阵：等 scrollTop 连着几帧不动了再量。
  const settle = () => feed.evaluate((element) => new Promise((done) => {
    let last = -1;
    let still = 0;
    const tick = () => {
      if (element.scrollTop === last) still += 1;
      else { still = 0; last = element.scrollTop; }
      if (still >= 6) done();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const metrics = () => feed.evaluate((element) => ({
    top: Math.round(element.scrollTop),
    distance: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
  }));
  // 那颗气泡的顶边离视口顶边多远。
  const bubbleOffset = (id) => feed.evaluate((element, target) => {
    const bubble = element.querySelector(`[data-conversation-input="${CSS.escape(target)}"]`);
    return Math.round(bubble.getBoundingClientRect().top - element.getBoundingClientRect().top);
  }, id);
  const tickCenter = async (index) => {
    const box = await ticks.nth(index).boundingBox();
    return { x: box.x + 4, y: box.y + box.height / 2 };
  };
  const pointAt = async (index) => {
    const { x, y } = await tickCenter(index);
    await page.mouse.move(x, y);
    await flush();
  };
  const currentTick = () => page.locator('.conversation-input-tick[aria-current="location"]').getAttribute("aria-label");
  const widths = () => ticks.evaluateAll((elements) => elements.map((element) => Number.parseFloat(element.style.width)));
  // 等页面里某个条件成立；等不到就按断言失败报出来。
  const until = async (condition, message, arg) => {
    try {
      await page.waitForFunction(condition, arg, { timeout: WAIT_TIMEOUT_MS });
    } catch {
      assert.fail(message);
    }
  };
  const LONG_LAST_LINE = "第24段：摊开之后每一条都要看得到全文，不能只剩第一行。";

  // ── 哪些话上了导航 ──
  await flush();
  assert.deepEqual(await ticks.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label"))), [
    "原始需求：在会话左侧加一条输入导航",
    "第一次追问：Q 摊开全部",
    "第二次追问：点横线要跳到气泡",
    "第三次追问：哨兵别算进去",
    "第四次追问：读到哪一条要标出来",
  ], "原始需求打头、只收我自己打的字，哨兵投喂和审查打回不上导航");
  // 首屏贴着底：正读着的是最后一条追问。
  assert.equal((await metrics()).distance, 0, "首屏应落在最新一条");
  assert.equal(await currentTick(), "第四次追问：读到哪一条要标出来", "贴着底时标的是视口里最后那条追问");

  // ── 指上去 ──
  await pointAt(2);
  assert.equal(await card.locator("p").textContent(), "第二次追问：点横线要跳到气泡", "卡片里应是指着的那条输入的全文");
  const hoverWidths = await widths();
  assert.ok(hoverWidths[2] > hoverWidths[1] && hoverWidths[1] > hoverWidths[0], `离指针越近越长：${hoverWidths}`);
  assert.ok(Math.abs(hoverWidths[1] - hoverWidths[3]) < 0.5 || hoverWidths[3] > hoverWidths[1], `上下两侧一起鼓起来：${hoverWidths}`);
  // 鼓到最长（正读着的那一格又被指着）也整条画得出来，不被刻度带裁平。量的是要长到的长度
  // （style.width），不是此刻画出来的：宽度带过渡，量 offsetWidth 量到的是半路上的。
  await pointAt(4);
  assert.ok(
    await ticks.evaluateAll((elements) => elements.every((element) => (
      element.offsetLeft + Number.parseFloat(element.style.width) <= element.parentElement.clientWidth
    ))),
    "放大后的横线不该伸出刻度带被裁掉",
  );
  await pointAt(0);
  assert.equal(
    await card.locator("p").textContent(),
    "原始需求：在会话左侧加一条输入导航\n指上去看全文，点一下跳过去",
    "原始需求的卡片是全文，不只第一行",
  );
  await page.mouse.move(600, 300);
  await flush();
  assert.equal(await card.count(), 0, "指针离开导航条，卡片收起");
  assert.ok((await widths()).every((width, index) => width === (index === 4 ? 12 : 8)), "指针离开后横线恢复原长（只有正读着的那条长一截）");

  // 长输入：卡片给全文，高出卡片的部分在卡片里自己滚、滚得到结尾；卡片还能滚时滚轮不带着会话走。
  await pointAt(1);
  const cardText = card.locator("p");
  assert.ok((await cardText.textContent()).endsWith(LONG_LAST_LINE), "卡片里是长输入的全文");
  assert.ok(await cardText.evaluate((element) => element.scrollHeight > element.clientHeight + 20), "长输入高出卡片，得能在卡片里滚");
  const cardBox = await card.boundingBox();
  const feedBeforeCard = await metrics();
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.wheel(0, 5_000);
  await until(() => {
    const element = document.querySelector(".conversation-input-card p");
    return element !== null && element.scrollTop > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
  }, "卡片里应滚得到长输入的结尾");
  assert.equal((await metrics()).top, feedBeforeCard.top, "卡片还在滚的时候不该带着会话滚");
  await page.mouse.move(600, 300);
  await flush();

  // 滚轮落在刻度带上照样滚会话：导航条盖在会话上，却不在滚动容器里头。
  await pointAt(2);
  const beforeWheel = await metrics();
  await page.mouse.wheel(0, -240);
  await flush();
  await flush();
  assert.ok((await metrics()).top < beforeWheel.top - 100, "在刻度带上往上滚，会话应跟着往上走");
  await page.mouse.move(600, 300);
  await flush();

  // ── 点一下跳过去 ──
  await pointAt(2);
  await page.mouse.down();
  await page.mouse.up();
  await settle();
  const landed = await bubbleOffset("persisted:user:s1:6");
  assert.ok(landed >= 10 && landed <= 22, `应跳到第二次追问那颗气泡、顶边留一点空：${landed}`);
  assert.equal(
    await page.locator('[data-conversation-input="persisted:user:s1:6"]').evaluate((element) => element.classList.contains("is-jump-target")),
    true,
    "落点那颗气泡应闪一下",
  );
  assert.equal(await currentTick(), "第二次追问：点横线要跳到气泡", "跳过去之后标的是这一条");

  // 跳过去是读者自己要看的：末尾来了新回复，不许被拽回底部。
  const before = await metrics();
  await page.getByTestId("append").click();
  await page.getByTestId("append").evaluate((element) => element.blur());
  await flush();
  await flush();
  assert.equal((await metrics()).top, before.top, "跳到某条输入之后，新消息不该把人拽回底部");

  // 点卡片也能跳。
  await pointAt(3);
  await card.click();
  await settle();
  const fromCard = await bubbleOffset("persisted:user:s2:1");
  assert.ok(fromCard >= 10 && fromCard <= 22, `点卡片应跳到第三次追问：${fromCard}`);
  assert.equal(await currentTick(), "第三次追问：哨兵别算进去", "第四次那颗挨得近、也越过了阅读线，标的仍是点的这一条");

  // 原始需求在会话流里没有气泡：跳到会话顶端。
  await pointAt(0);
  await page.mouse.down();
  await page.mouse.up();
  await settle();
  assert.equal((await metrics()).top, 0, "点原始需求那一格应回到会话顶端");
  assert.equal(await currentTick(), "原始需求：在会话左侧加一条输入导航");
  await page.mouse.move(600, 300);

  // ── Q 摊开 ──
  await page.keyboard.press("q");
  await menu.waitFor();
  assert.deepEqual(await menu.getByRole("menuitem").evaluateAll((elements) => elements.map((element) => element.querySelector("span").textContent)), [
    "原始需求：在会话左侧加一条输入导航",
    "第一次追问：Q 摊开全部",
    "第二次追问：点横线要跳到气泡",
    "第三次追问：哨兵别算进去",
    "第四次追问：读到哪一条要标出来",
  ], "摊开后每条输入一块，第一行打头");
  const rests = () => menu.getByRole("menuitem").evaluateAll((elements) => elements.map((element) => (
    element.querySelector(".conversation-input-menu-rest")?.textContent ?? ""
  )));
  const opened = await rests();
  assert.equal(opened[0], "指上去看全文，点一下跳过去", "第一行之后的正文整段接在下面");
  assert.ok(opened[1].endsWith(LONG_LAST_LINE), "长输入摊开后一直到结尾都在");
  assert.deepEqual(opened.slice(2), ["", "", ""], "只有一行的输入下面不多出东西");
  assert.ok(
    await menu.locator(".conversation-input-menu-rest > span").evaluateAll((elements) => elements.every((element) => element.scrollHeight <= element.clientHeight + 1)),
    "摊开的正文不该被截断",
  );
  // 加宽、半透（2026-11-06 用户挑的「半透 + 760」）：会话区放得下就 760 宽，窄了左右各让出 8px；
  // 后面的会话隔着玻璃糊成色块透出来。
  const look = await menu.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    room: element.parentElement.clientWidth - 16,
    filter: getComputedStyle(element).backdropFilter,
    background: getComputedStyle(element).backgroundColor,
  }));
  assert.equal(look.width, Math.min(760, look.room), `会话区不够宽时列表贴着两边：${JSON.stringify(look)}`);
  assert.match(look.filter, /blur\(/, `列表应是毛玻璃：${look.filter}`);
  assert.match(look.background, /(\/ |, )0?\.\d+\)$/, `列表底色应半透明：${look.background}`);
  const shell = page.locator("main");
  await shell.evaluate((element) => {
    element.style.width = "1000px";
  });
  assert.equal(await menu.evaluate((element) => element.getBoundingClientRect().width), 760, "会话区够宽时列表就是 760 宽");
  await shell.evaluate((element) => {
    element.style.width = "760px";
  });
  const focused = () => page.evaluate(() => document.activeElement?.querySelector("span")?.textContent ?? null);
  assert.equal(await focused(), "原始需求：在会话左侧加一条输入导航", "焦点落在正读着的那一条");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-current")), "location", "读屏也要知道哪一条是正读着的");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "第一次追问：Q 摊开全部", "方向键挑");
  assert.ok(
    await menu.evaluate((element) => document.activeElement.getBoundingClientRect().top >= element.getBoundingClientRect().top - 1),
    "挪到比列表还高的长输入上，露出的是它的开头",
  );
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "第二次追问：点横线要跳到气泡", "方向键挑");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  assert.equal(await focused(), "第四次追问：读到哪一条要标出来", "到头回绕");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await settle();
  assert.equal(await menu.count(), 0, "回车跳过去之后列表收起");
  const fromMenu = await bubbleOffset("persisted:user:s2:1");
  assert.ok(fromMenu >= 10 && fromMenu <= 22, `回车应跳到第三次追问：${fromMenu}`);

  // 再按 Q 收起；Esc 收起；点外面收起。
  await page.keyboard.press("q");
  await menu.waitFor();
  assert.equal(await focused(), "第三次追问：哨兵别算进去", "再摊开时焦点跟着读到的那一条走");
  // 摊开期间工作区重渲过一遍，它的快捷键监听重挂到了列表的监听后面：这下 Q 也只收起，不会收了又被它摊开。
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-rerender")));
  await flush();
  await page.keyboard.press("q");
  await flush();
  assert.equal(await menu.count(), 0, "摊开时再按 Q 收起");
  await page.keyboard.press("q");
  await menu.waitFor();
  await page.keyboard.press("Escape");
  await flush();
  assert.equal(await menu.count(), 0, "Esc 收起");
  await page.keyboard.press("q");
  await menu.waitFor();
  await page.mouse.click(700, 400);
  await flush();
  assert.equal(await menu.count(), 0, "点外面收起");
  // 点列表里的一行直接跳。
  await page.keyboard.press("q");
  await menu.waitFor();
  await menu.getByRole("menuitem").nth(1).click();
  await settle();
  assert.equal(await menu.count(), 0);
  const fromClick = await bubbleOffset("persisted:user:s1:2");
  assert.ok(fromClick >= 10 && fromClick <= 22, `点列表里那一行应跳到第一次追问：${fromClick}`);

  // 会话被抽屉盖住：Q 不该在底下摊开一张看不见、还把键盘收走的列表。
  await page.getByTestId("cover").click();
  await page.keyboard.press("q");
  await flush();
  assert.equal(await menu.count(), 0, "会话被盖住时按 Q 不应摊开");
  await page.getByTestId("uncover").click();
  await page.keyboard.press("q");
  await menu.waitFor();
  await page.keyboard.press("Escape");
  await flush();
  assert.equal(await menu.count(), 0);

  // 输入框里的 q 是字，不是快捷键。
  const entry = page.getByTestId("text-entry");
  await entry.click();
  await entry.type("q");
  assert.equal(await entry.inputValue(), "q");
  await flush();
  assert.equal(await menu.count(), 0, "输入框里打 q 不应摊开列表");

  // 平滑跳转半路被接管（拖滚动条、按翻页键之类，不经滚轮）：滚动一停就别再死守着点的那一条。
  await pointAt(0);
  await page.mouse.down();
  await page.mouse.up();
  await feed.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.mouse.move(600, 300);
  await until(
    () => document.querySelector('.conversation-input-tick[aria-current="location"]')?.getAttribute("aria-label") === "第四次追问：读到哪一条要标出来",
    "跳转被半路接管、停在了底部，标的应回到按位置推出来的那一条",
  );

  // 开头一样的两次追问：摊开后靠后文分得开。
  await page.getByTestId("append-twins").click();
  await page.getByTestId("append-twins").evaluate((element) => element.blur());
  await flush();
  await page.keyboard.press("q");
  await menu.waitFor();
  const twins = await menu.getByRole("menuitem").evaluateAll((elements) => elements.slice(-2).map((element) => [
    element.querySelector("span").textContent,
    element.querySelector(".conversation-input-menu-rest").textContent,
  ]));
  assert.deepEqual(twins, [
    ["请按以下要求修改", "标题改成「我的输入」"],
    ["请按以下要求修改", "列表要能读到每条的结尾"],
  ], "开头一样的两条，摊开后各自的后文都在");
  await page.keyboard.press("Escape");
  await flush();

  // 摊开期间后面的会话不跟着新消息滚：玻璃底下一直有东西在动，字也跟着晃。收起时补上那一下；
  // 被列表盖住的回顶 / 回底按钮先藏起来。
  const atBottom = () => {
    const element = document.querySelector('[data-testid="feed"]');
    return element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
  };
  // 不经指针来一段新回复（列表开着时点哪儿都算点外面），并等它真渲染出来：会话长高了才算来了。
  const appendReply = async () => {
    const before = await feed.evaluate((element) => element.scrollHeight);
    await page.evaluate(() => window.dispatchEvent(new Event("fixture-append")));
    await until((height) => document.querySelector('[data-testid="feed"]').scrollHeight > height, "新回复应渲染出来", before);
    await flush();
  };
  // 回到跟随（End 是贴底逻辑认的「我要看最新」）并落到最新一条。
  const follow = async () => {
    await page.keyboard.press("End");
    await feed.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await settle();
  };
  const openList = async () => {
    await page.keyboard.press("q");
    await menu.waitFor();
  };
  // 先确认没摊开时新消息照常跟到底：不然下面「摊开期间不跟」量到的只是本来就没在跟。
  await follow();
  await appendReply();
  await until(atBottom, "没摊开时新消息应照常跟到底");
  const topButton = page.locator(".conversation-scroll-button--top");
  const topButtonClickable = () => topButton.evaluate((element) => getComputedStyle(element).pointerEvents !== "none");
  assert.equal(await topButtonClickable(), true, "没摊开时回顶按钮照常能点");
  await openList();
  assert.equal(await topButtonClickable(), false, "被列表盖住的回顶按钮应藏起来");
  await appendReply();
  await flush();
  const held = await metrics();
  assert.ok(held.distance > 100, `列表摊开期间新消息不该带着会话往下滚：${JSON.stringify(held)}`);
  await page.keyboard.press("Escape");
  await until(atBottom, "收起列表后应补上那一下、落到最新一条");
  assert.equal(await topButtonClickable(), true, "收起后回顶按钮回来");

  // 点外面收起：按下那一刻列表就收了，补到底却要等松手 —— 不然松手的 click 落到换过的内容上。
  await openList();
  await appendReply();
  const outside = await page.getByTestId("text-entry").boundingBox();
  await page.mouse.move(outside.x + 20, outside.y + outside.height / 2);
  await page.mouse.down();
  await flush();
  await flush();
  assert.equal(await menu.count(), 0, "按下就收起");
  assert.ok((await metrics()).distance > 100, "手还按着时不该补那一下");
  await page.mouse.up();
  await until(atBottom, "松手后应补上那一下");
  await page.getByTestId("text-entry").evaluate((element) => element.blur());

  // 摊开时在露出来的会话上往下滚了一格（滚在刻度带最左边、列表没盖住的那一截上）：离底远只是因为
  // 按住了没跟，不算离开跟随，收起照样补到底。
  await openList();
  await appendReply();
  const stripBox = await strip.boundingBox();
  await page.mouse.move(stripBox.x + 3, stripBox.y + stripBox.height / 2);
  await page.mouse.wheel(0, 120);
  await settle();
  await page.keyboard.press("Escape");
  await until(atBottom, "摊开时往下滚过一格，收起照样应补到底");
  await page.mouse.move(600, 300);

  // 从列表里挑了一条跳过去：收起那一下不补。
  await openList();
  await appendReply();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await settle();
  await flush();
  const picked = await bubbleOffset("persisted:user:s3:1");
  assert.ok(picked >= 10 && picked <= 22, `从列表里挑了一条跳过去，收起那一下不该再把人拽到底：${picked}`);

  // 摊开之前往上翻过的：摊开、来新消息、收起，都不被拽下去。
  await follow();
  await page.mouse.move(600, 300);
  await page.mouse.wheel(0, -300);
  await settle();
  const readingAt = (await metrics()).top;
  await openList();
  await appendReply();
  await page.keyboard.press("Escape");
  await flush();
  await flush();
  assert.equal((await metrics()).top, readingAt, "摊开之前往上翻过的，收起时不该被拽到底");

  // 窄屏下正文的左边距比刻度带还窄：挂着导航时正文让到刻度带右边，免得指正文弹卡片、点正文跳走。
  await page.setViewportSize({ width: 600, height: 640 });
  assert.equal(await feed.evaluate((element) => getComputedStyle(element).paddingLeft), "34px", "正文应从刻度带右边起");

  assert.deepEqual(errors, [], "页面不应报错");
  console.log("conversation input rail DOM tests passed");
} finally {
  await browser?.close();
  await web.close();
}
