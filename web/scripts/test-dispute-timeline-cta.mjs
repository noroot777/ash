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
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/dispute-timeline-cta.html`);

  const open = page.locator(".open-fixture");
  const resolved = page.locator(".resolved-fixture");
  const readonly = page.locator(".readonly-fixture");
  await open.locator(".system-event-digest, .system-event-row").first().waitFor();

  // 前置：三份渲染的是同一条旁注，差别只在审查链状态和有没有入口。
  for (const [name, scope] of [["open", open], ["resolved", resolved], ["readonly", readonly]]) {
    assert.match(
      await scope.innerText(),
      /现在由你裁定/,
      `${name}: 旁注本身必须一直在——它是历史记录，不随裁定消失`,
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

  // ③ 没有入口就一颗都不给。
  assert.equal(
    await readonly.getByRole("button", { name: "去裁定" }).count(),
    0,
    "没有 onOpenReviewPanel 的场合（只读会话、团队时间线）不给按钮",
  );

  // 按钮不能摆进 <summary> 里：那样点一下会连带把这段折叠掉。
  assert.equal(
    await open.locator("summary .system-event-cta").count(),
    0,
    "按钮不能落在 summary 内——<details> 会把点击当成展开/收起",
  );

  // ④ 长什么样也得测。前三条全过、按钮却是竖着的三个字——它被自动排进了旁注左边那条
  //    20px 的头像列（用户 2026-09-24 截图：「这个按钮做的也太儿戏了」）。DOM 断言对这类
  //    事一无所知，所以这里量真实盒子：**同一行、不折行**，四种旁注方案挨个过。
  for (const mode of ["aligned", "footnote", "collapsed", "attached"]) {
    await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/dispute-timeline-cta.html?systemNotices=${mode}`);
    const row = page.locator(".open-fixture .system-event-digest, .open-fixture .system-event-row").first();
    await row.waitFor();
    const cta = await page.locator(".open-fixture .system-event-cta").boundingBox();
    const text = await page.locator(".open-fixture :is(summary, .system-event-row > p)").first().boundingBox();
    assert(cta && text, `${mode}: 「去裁定」和旁注正文都得能量到`);

    // 竖排的「去裁定」是 30×51：宽不过高，就是被挤成一列字了。
    assert(
      cta.width > cta.height * 1.8,
      `${mode}: 「去裁定」被挤断行了（量到 ${Math.round(cta.width)}×${Math.round(cta.height)}）——三个字的胶囊必须宽远大于高`,
    );
    // 摆在正文下面单独占一行，等于把「要你做的事」从那句话上摘下来扔在旁边。
    const overlap = Math.min(cta.y + cta.height, text.y + text.height) - Math.max(cta.y, text.y);
    assert(
      overlap > cta.height * 0.6,
      `${mode}: 「去裁定」得跟旁注正文在同一行上（竖向重叠只有 ${Math.round(overlap)}px）`,
    );
    assert(
      cta.x >= text.x + text.width - 1,
      `${mode}: 「去裁定」排在这条旁注的最后，不插在正文和时间之间`,
    );
  }

  console.log("dispute timeline cta tests passed");
} finally {
  await browser?.close();
  await server.close();
}
