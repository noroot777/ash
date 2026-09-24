// 驳回卡上第三个出口（转为独立任务）的 DOM 回归。
//
// 盯的是**出口的存在条件和它与另外两个的差别**，不是措辞细节：
// ① 只有执行者逐条写明了越界依据（deferReason 非空）时这颗按钮才出现——凭空给它，
//    它就成了谁都能按的免修开关；
// ② 只提转出时标题不能还写「驳回了意见」：执行者说的恰恰是「报告是对的，只是不该
//    在这儿修」；
// ③ 两段理由同时给时，两块都得摆出来，四个出口并存（不逼执行者三选一）；
// ④ 按下去发的是 resolution=deferred，回报里带着建出来的那个任务。
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
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/free-review-defer.html`);

  const deferOnly = page.locator(".defer-only-fixture");
  const reasonOnly = page.locator(".reason-only-fixture");
  const mixed = page.locator(".mixed-fixture");
  await deferOnly.locator(".free-review-dispute-card").waitFor();

  // ② 只提转出：标题换说法，「驳回理由」那块整块不出现。
  assert.match(
    await deferOnly.locator("header b").innerText(),
    /超出本任务边界/,
    "只提转出时标题不能写成「驳回了意见」——执行者说的是报告对、只是不该在这儿修",
  );
  assert.equal(
    await deferOnly.locator(".free-review-dispute-card__reason:not(.is-defer)").count(),
    0,
    "只提转出时不该摆出空的「驳回理由」块",
  );
  assert.match(
    await deferOnly.locator(".free-review-dispute-card__reason.is-defer").innerText(),
    /超出原任务边界/,
    "转出理由要原样摆出来给用户看",
  );

  // ① 出口的存在条件：没写越界依据就没有这颗按钮。
  assert.equal(
    await reasonOnly.getByRole("button", { name: "转为独立任务" }).count(),
    0,
    "执行者没提越界依据时不给「转为独立任务」出口（后端同样拒绝，这里不是唯一防线）",
  );
  assert.equal(
    await reasonOnly.getByRole("button", { name: "采纳执行者说法" }).count(),
    1,
    "现有两个出口一个都不许少",
  );
  assert.equal(await reasonOnly.getByRole("button", { name: "维持意见并修复" }).count(), 1);
  assert.match(await reasonOnly.locator("header b").innerText(), /驳回了第 1 轮意见/);

  // ③ 混合形态：两块理由 + 四个出口并存。
  assert.equal(
    await mixed.locator(".free-review-dispute-card__reason").count(),
    2,
    "两段理由同时给时两块都要摆出来（一次交接里表达「不成立」和「成立但越界」共存）",
  );
  for (const name of ["让双方辩论", "转为独立任务", "采纳执行者说法", "维持意见并修复"]) {
    assert.equal(await mixed.getByRole("button", { name }).count(), 1, `混合形态下「${name}」出口要在`);
  }

  // ④ 按下去：确认框讲清「没有作废、只是换个地方修」，确认后发 deferred 并回报那个任务。
  await deferOnly.getByRole("button", { name: "转为独立任务" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const message = await dialog.innerText();
  assert.match(message, /待办、不起跑/, "确认框必须说清建出来的是待办任务，不会自己起跑");
  assert.match(message, /没有作废/, "确认框必须把它和「采纳执行者说法」的差别说死");
  // 转出之后这条链就停住了，可执行者在提驳回之前已经把在边界内的那几条改掉了——那部分
  // 代码一轮都没审过。不说一句，用户按完只会以为「处理完了」，改动就这么没人看地留着。
  assert.match(
    message,
    /还没审过.*再派一轮审查/,
    "确认框要说清：执行者已经改掉的那部分还没审过，要继续推进得再派一轮",
  );
  await dialog.getByRole("button", { name: "建任务并转走这几条" }).click();

  await page.waitForFunction(() => (window.__resolutions ?? []).length === 1);
  assert.deepEqual(
    await page.evaluate(() => window.__resolutions),
    ["deferred"],
    "点下去发的裁定必须是 deferred",
  );
  await page.waitForFunction(() => (window.__notices ?? []).length === 1);
  assert.match(
    (await page.evaluate(() => window.__notices))[0],
    /已转为独立任务：承接第 1 轮审查的越界意见/,
    "提示里要带上建出来的那个任务，否则用户不知道东西落到哪儿去了",
  );

  console.log("free review defer dom tests passed");
} finally {
  await browser?.close();
  await server.close();
}
