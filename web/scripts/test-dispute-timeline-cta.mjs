// 时间线上那条「现在由你裁定」旁注的行动入口。
//
// 那句话把三四条出路列了出来，却不给任何能点的东西，用户读完还得自己去右边翻出审查面板
// （用户 2026-09-24：「直接给个按钮不行吗」）。这份回归盯四件事：
// ① 挂着未裁定驳回时，那条旁注上有「去裁定」，点下去打开审查面板；
// ② **裁定完按钮必须消失**——旁注是历史记录、永远在，而它指向的那张卡已经不在了。
//    只按文本匹配就会留下一颗点了什么也看不到的按钮；
// ③ 没有 onOpenReviewPanel（只读会话视图、团队时间线）时一颗都不给；
// ④ 它得长得像颗按钮：在那句话的同一行上、不被挤断行——①②③ 全过的那一版，按钮是竖着
//    的三个字（用户 2026-09-24：「这个按钮做的也太儿戏了」）。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  await page.goto(`${web.origin}/scripts/fixtures/dispute-timeline-cta.html`);

  const open = page.locator(".open-fixture");
  const resolved = page.locator(".resolved-fixture");
  const readonly = page.locator(".readonly-fixture");
  await open.locator(".turn-footnote").first().waitFor();

  // 前置：三份渲染的是同一条旁注，差别只在审查链状态和有没有入口。
  for (const [name, scope] of [["open", open], ["resolved", resolved], ["readonly", readonly]]) {
    assert.match(
      await scope.innerText(),
      /第 2 轮审查意见被驳回，等你裁定/,
      `${name}: 那一句必须一直在——它是历史记录，不随裁定消失`,
    );
  }

  // ① 有待裁定的驳回 → 按钮在，且点下去打开审查面板。
  const cta = open.getByRole("button", { name: "去裁定" });
  assert.equal(await cta.count(), 1, "挂着待裁定驳回时，那条旁注上要有一颗能点的「去裁定」");
  await cta.click();
  assert.deepEqual(
    await page.evaluate(() => window.__opened),
    ["review"],
    "点「去裁定」要把人送到审查面板（那张裁定卡在里面），不是在时间线上再摆一套出口",
  );

  // ② 已裁定 → 按钮没了。
  assert.equal(
    await resolved.getByRole("button", { name: "去裁定" }).count(),
    0,
    "裁定完就不该再有按钮：它指向的那张卡已经不在了，只按文本匹配会留下一颗点了白点的按钮",
  );

  assert.equal(await resolved.locator(".turn-footnote-dot").count(), 0, "裁定完了，那一句就是过去的事，不再带点");

  // ③ 没有入口就一颗都不给。
  assert.equal(
    await readonly.getByRole("button", { name: "去裁定" }).count(),
    0,
    "没有 onOpenReviewPanel 的场合（只读会话、团队时间线）不给按钮",
  );

  // 按钮不能摆进那半句自己的键里：那样点一下会连带把原文展开/收起。
  assert.equal(
    await open.locator(":is(summary, button.turn-footnote-part) .system-event-cta").count(),
    0,
    "按钮不能落在那半句自己的键里——点击会被当成展开/收起",
  );
  // 这一句是要你拍板的：是那一回合的尾注，原文点那半句就地摊开。
  const ruling = open.locator(".turn-footnote button.turn-footnote-part").filter({ hasText: "等你裁定" });
  assert.equal(await ruling.count(), 1);
  await ruling.click();
  assert.match(await open.locator(".turn-footnote-detail").innerText(), /现在由你裁定/, "驳回的原文点开再看");
  // 还在等你：最后一个回合上的这一句字前一颗琥珀点；裁定完它就是过去的事。
  assert.equal(await open.locator(".turn-footnote-dot.is-warn").count(), 1, "等你裁定的那一句字前一颗琥珀点");

  // ④ 长什么样也得测。前三条全过、按钮却是竖着的三个字——它被自动排进了旁注左边那条
  //    20px 的头像列（用户 2026-09-24 截图：「这个按钮做的也太儿戏了」）。DOM 断言对这类
  //    事一无所知，所以这里量真实盒子：**同一行、不折行**，四种旁注方案挨个过。
  for (const width of [1000, 390]) {
    await page.setViewportSize({ width, height: 1200 });
    const mode = `${width}px`;
    const cta = await page.locator(".open-fixture .system-event-cta").boundingBox();
    const tail = await page.locator(".open-fixture .turn-footnote-tail").boundingBox();
    const text = await page.locator(".open-fixture .turn-footnote-text").first().evaluate((el) => {
      // 正文可能折成好几行：量最后一行，「去裁定」接在那一行后面。
      const rects = [...el.getClientRects()];
      const last = rects.at(-1);
      return last ? { x: last.x, y: last.y, width: last.width, height: last.height } : null;
    });
    assert(cta && text, `${mode}: 「去裁定」和旁注正文都得能量到`);

    // 竖排的「去裁定」是 30×51：宽不过高，就是被挤成一列字了。
    assert(
      cta.width > cta.height * 1.8,
      `${mode}: 「去裁定」被挤断行了（量到 ${Math.round(cta.width)}×${Math.round(cta.height)}）——三个字的胶囊必须宽远大于高`,
    );
    const button = await page.locator(".open-fixture .system-event-cta").evaluate((el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, color: style.color };
    });
    // 指针可能正停在键上（悬停那一档是深灰），所以只钉「没有颜色、是黑底白字」。
    const [r, g, b] = button.background.match(/\d+/g).map(Number);
    assert(r === g && g === b && r < 60 && button.color === "rgb(255, 255, 255)", `${mode}: 能点的键一律黑白，颜色只留给状态（量到 ${JSON.stringify(button)}）`);
    if (width < 500) continue;
    // 摆在正文下面单独占一行，等于把「要你做的事」从那句话上摘下来扔在旁边。
    const overlap = Math.min(cta.y + cta.height, text.y + text.height) - Math.max(cta.y, text.y);
    assert(
      overlap > cta.height * 0.4,
      `${mode}: 「去裁定」得跟旁注正文在同一行上（竖向重叠只有 ${Math.round(overlap)}px）`,
    );
    assert(
      cta.x >= text.x + text.width - 1,
      `${mode}: 「去裁定」紧跟在那半句后面`,
    );
    assert(tail && tail.x >= cta.x + cta.width - 1, `${mode}: 指到才出的时刻排在键的后面，键不会左右挪`);
  }

  console.log("dispute timeline cta tests passed");
} finally {
  await browser?.close();
  await web.close();
}
