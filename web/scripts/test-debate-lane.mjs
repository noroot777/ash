// 时间线上的辩论：一整场折成一行，展开列的是双方交卷的 statement。
//
// 用户 2026-09-24 看到的那一版：`开始辩论…` + 七条「辩论第 i/7 段：轮到 X 发言」+ 七颗
// 气泡 + `辩论结束…`，十六行讲一件事；而且气泡里根本不是辩论记录——真发言走 debate_reply
// 落库，气泡只是各自随口的交代（codex 一句「本段发言已提交」，claude 把整段又讲一遍），
// 于是看上去像**只有一方在讨论**。这份回归盯四件事：
// ① 那一整段收成一张 .debate-lane，七条段间流水一条不留；
// ② 展开后能读到 codex（审查者）那七段里真正的话，尤其是最后的收尾立场；
// ③ 卡头把「谁跟谁、几段、什么立场」一次说清，且七段发言 = 七个色块；
// ④ 「全宽阅读」开出来的读面，比面板那一栏宽出一大截——这条卡的毛病一半是宽度（面板栏
//    542px 里那七段是一根一万像素高的细条）。
// 外加一条兜底：拿不到 reviews（只读会话视图）时，原始行必须原样还在，不能凭空少掉。
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/debate-lane.html`);

  const folded = page.locator(".folded-fixture");
  const fallback = page.locator(".fallback-fixture");
  const lane = folded.locator(".debate-lane");
  await lane.waitFor();

  // ① 一场辩论一行，段间流水全部收走。
  assert.equal(await lane.count(), 1, "一场辩论就该是一行");
  const foldedText = await folded.innerText();
  assert.doesNotMatch(
    foldedText,
    /轮到(审查者|执行者)发言/,
    "七条「轮到 X 发言」讲的是进度不是内容，折起来之后一条都不该留",
  );
  assert.doesNotMatch(foldedText, /^开始辩论第/m, "起止两句已经由卡头表达，不再单独占一行");

  // ② 折叠态不该把正文摊在外面；展开后读到的必须是 statement，两方都有。
  assert.equal(await lane.locator(".debate-lane-body").isHidden(), true, "默认折叠");
  await lane.getByRole("button", { name: "展开" }).click();
  const body = lane.locator(".debate-lane-body");
  await body.locator(".free-review-debate").waitFor();
  const bodyText = await body.innerText();
  assert.match(
    bodyText,
    /我的最终立场是 upheld/,
    "审查者的收尾立场必须读得到——用户报的就是「codex 这一方所有的结论我都看不到」",
  );
  assert.match(bodyText, /本段没有实际可回应的技术驳回/, "审查者第 1 段的原文");
  assert.match(bodyText, /这一段我没有要坚持的分歧/, "执行者第 2 段的原文（statement，不是气泡里那句交代）");
  assert.doesNotMatch(
    bodyText,
    /第 2 段已交卷/,
    "气泡里那句随口的交代不是辩论记录，展开后不该跟 statement 混在一起",
  );
  assert.equal(await body.locator(".free-review-debate > ol > li").count(), 7, "七段发言，一段一条");

  // ③ 卡头一行说清谁跟谁、几段、什么立场；色块数 = 段数。
  const head = await lane.locator(".debate-lane-head").innerText();
  assert.match(head, /审查意见辩论/, "卡头得标明这是什么");
  assert.match(head, /7 段 · 审查者 ↔ 执行者/, "谁跟谁、几段");
  assert.match(head, /维持原意见/, "审查者自述的收尾立场（只是它的立场，裁定权仍在用户）");
  assert.equal(await lane.locator(".debate-lane-strip i").count(), 7, "一格一段发言");
  assert.equal(
    await lane.locator(".debate-lane-strip i.is-reviewer.is-done").count(),
    4,
    "奇数段是审查者：1/3/5/7 共四段",
  );

  // 卡头别散架：一顶高不过两行，且「全宽阅读」和「收起」是横着的胶囊不是竖排的字。
  const headBox = await lane.locator(".debate-lane-head").boundingBox();
  assert(headBox && headBox.height < 76, `卡头应当收在一两行内（量到 ${Math.round(headBox?.height ?? 0)}px）`);
  for (const name of ["全宽阅读", "收起"]) {
    const box = await lane.getByRole("button", { name }).boundingBox();
    assert(
      box && box.width > box.height,
      `${name}：按钮被挤断行了（量到 ${Math.round(box?.width ?? 0)}×${Math.round(box?.height ?? 0)}）`,
    );
  }

  // ④ 全宽阅读：读面显著宽于时间线上那张卡，Esc 能退出去。
  await lane.getByRole("button", { name: "全宽阅读" }).click();
  const sheet = page.locator(".debate-reader__sheet");
  await sheet.waitFor();
  const sheetBox = await sheet.boundingBox();
  const laneBox = await lane.boundingBox();
  assert(sheetBox && laneBox, "读面和卡片都得能量到");
  assert(
    sheetBox.width > laneBox.width * 1.1,
    `全宽阅读得真的更宽（读面 ${Math.round(sheetBox.width)}px vs 卡片 ${Math.round(laneBox.width)}px）`,
  );
  assert.match(
    await sheet.innerText(),
    /我的最终立场是 upheld/,
    "读面里是同一份 statement，不是另一套摘要",
  );
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });

  // 兜底：配不到落盘记录时（只读视图没传 reviews），原始行一条都不能少。
  const fallbackLane = fallback.locator(".debate-lane");
  assert.equal(await fallbackLane.count(), 1, "没有 reviews 也照样折成一行");
  await fallbackLane.getByRole("button", { name: "展开" }).click();
  const fallbackBody = await fallbackLane.locator(".debate-lane-body").innerText();
  assert.match(
    fallbackBody,
    /轮到审查者发言/,
    "配不到 statement 时段间流水要留着——宁可啰嗦，也不凭空少掉一段",
  );
  assert.match(fallbackBody, /第 2 段已交卷/, "兜底时原始气泡原样摆出来");
  assert.match(fallbackBody, /辩论结束/, "收口那句还在");

  // 辩到一半：没有收口那句，卡片也得自己知道还没结束，并且把「说到第几段」摆在头上。
  const running = page.locator(".running-fixture .debate-lane");
  assert.equal(await running.count(), 1, "辩论进行中同样折成一行");
  const runningHead = await running.locator(".debate-lane-head").innerText();
  assert.match(runningHead, /执行者发言中 · 第 2 \/ 3 段/, "进行中要报到第几段，不用自己去数");
  assert.equal(await running.locator(".debate-lane-strip i").count(), 3, "1 个来回 = 3 段");
  assert.equal(await running.locator(".debate-lane-strip i.is-speaking").count(), 1, "正在说的那格只有一个");
  assert.equal(
    await running.locator(".debate-lane-strip i:not(.is-done):not(.is-speaking)").count(),
    1,
    "还没轮到的那格留空",
  );
  assert.equal(
    await running.locator(".debate-lane-verdict.is-verdict").count(),
    0,
    "还没结束就不该摆立场——审查者要到收尾那段才给",
  );

  console.log("debate lane tests passed");
} finally {
  await browser?.close();
  await server.close();
}
