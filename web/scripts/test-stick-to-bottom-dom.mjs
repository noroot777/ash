// 贴底跟随：什么算「末尾多了要看的东西」，什么只是界面闪了一下。
//
// 钉两头，缺一头都出过事：
//
// 一头是**不该跟的别跟**。读到快见底时停住，复制按钮点一下变「已复制」、1600ms 后又变
// 回来，账目数字刷新，图标换一张 —— 正文一个字没动，人却被一次次拽到底。栽过的那一版
// 是拿「最后一屏内出现了 DOM 变化」当新内容的判据：几何位置证明不了语义。
//
// 另一头是**该跟的必须跟**。群聊/侧聊/助手只留最近 500 条，追加一条的同时最老那条被挤
// 掉，条数和总高可能纹丝不动 —— 拿「总高涨没涨」当判据就会把新回复漏在屏幕下面。
//
// 所以信号由拿着会话数据的人算（chatTailKey / conversationTailKey），不让贴底逻辑自己
// 去 DOM 上猜。这份测试钉的就是「产品算的那个数，在真实 DOM 更新里管不管用」——
// 纯函数断言预设标记已经正确，挡不住这一类。
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
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/stick-to-bottom.html`);
  await page.locator("#feed").waitFor();

  const feed = page.locator("#feed");
  // 跟随/补滚都落在 rAF 里；「不该动」这类负向断言没法 waitFor，等两帧再量。
  const flush = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const metrics = () => feed.evaluate((element) => ({
    top: Math.round(element.scrollTop),
    distance: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
    height: element.scrollHeight,
  }));
  const press = async (testId) => { await page.getByTestId(testId).click(); await flush(); };
  /* 停在离底 gap 像素，且**仍在跟随状态**——必须用真实的「向下滚」走到那儿。
     方向是关键：向上滚是「我要读历史」，会主动脱离跟随，那样停下来测到的是另一回事
     （不跟随当然也不会被拽，断言会假通过）。向下滚进最后 80px 才是用户快读到底的样子，
     也正是复制反馈曾经把人拽走的那个状态。 */
  const parkByWheel = async (gap) => {
    await feed.evaluate((element) => element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 400));
    await flush();
    await feed.hover();
    let guard = 0;
    while ((await metrics()).distance > gap && guard++ < 80) {
      await page.mouse.wheel(0, 20);
      await flush();
    }
    return metrics();
  };

  // 首屏：打开就该落在最新一条。
  await flush();
  assert.equal((await metrics()).distance, 0, "首屏没有落到最新一条");

  // ① 贴底时来新消息 —— 跟过去。
  await press("append");
  assert.equal((await metrics()).distance, 0, "贴底时来了新消息却没跟过去");

  // ② 贴底时最后一条在逐字长（流式输出）—— 跟过去。
  await press("stream");
  assert.equal((await metrics()).distance, 0, "最后一条在长，视口没跟着走");

  // ③ 停在离底几十像素（仍在跟随区间内），翻转复制反馈 —— 一个像素都不许动。
  //    这是审查 F2 复现的那一类：正文没变，只有按钮的文字和图标在换。
  const parked = await parkByWheel(40);
  assert.ok(parked.distance > 2 && parked.distance <= 40, `没能停在离底一小段：${parked.distance}`);
  await press("copy-feedback");
  const afterCopy = await metrics();
  assert.equal(afterCopy.top, parked.top, "复制反馈把人拽走了");
  assert.equal(afterCopy.height, parked.height, "夹具假设有误：复制反馈改变了内容高度");
  // 反馈恢复（1600ms 后变回「复制这条回复」）同样不许动。
  await press("copy-feedback");
  assert.equal((await metrics()).top, parked.top, "复制反馈恢复时把人拽走了");

  // ④ 还停在原处：这时来一条真消息 —— 该跟。跟随状态没有被上一步误伤。
  await press("append");
  assert.equal((await metrics()).distance, 0, "反馈变化之后，真消息反而不跟了");

  // ⑤ 最近 N 条轮换：追加一条 + 挤掉最老一条，条数和总高都不变 —— 仍要跟（审查 F1）。
  const beforeRoll = await parkByWheel(40);
  await press("rollover");
  const afterRoll = await metrics();
  assert.equal(afterRoll.height, beforeRoll.height, "夹具假设有误：轮换改变了内容高度");
  assert.equal(afterRoll.distance, 0, "等高轮换时新回复被漏在屏幕下面");

  /* ⑥ 新内容不一定在最后一行：末尾压着一条旁注（「审查已预约」那类），正在飞的那一轮
     在它**前面**，新文字被追加回前面那条气泡。最后一行一个字没动、总高也没变，但屏幕
     上确实多了要看的东西 —— 必须跟（审查第 3 轮 F1）。 */
  await press("pin-aside");
  const beforeBehind = await parkByWheel(40);
  await press("stream-behind-aside");
  const afterBehind = await metrics();
  assert.equal(afterBehind.height, beforeBehind.height, "夹具假设有误：非末条续写改变了内容高度");
  assert.equal(afterBehind.distance, 0, "被旁注挡在后面的回复在长，视口却没跟");

  // ⑦ 旁注还压在末尾时，复制反馈仍然不许动位置（别为了修 ⑥ 把 F2 放回来）。
  const beforeAsideCopy = await parkByWheel(40);
  await press("copy-feedback");
  assert.equal((await metrics()).top, beforeAsideCopy.top, "末尾有旁注时，复制反馈又把人拽走了");
  await press("copy-feedback");
  assert.equal((await metrics()).top, beforeAsideCopy.top, "末尾有旁注时，反馈恢复又把人拽走了");

  /* ⑧ 新内容也不一定是「正文」：展开的执行过程里，思考原文在同一行里接着写 ——
     真实 producer 把增量拼进**已有那条** event 的 detail（appendExecutionEvent），
     条数、正文长度、段落个数、总高全都一动不动。仍要跟（审查第 4 轮 F1）。 */
  const beforeThinking = await parkByWheel(40);
  await press("stream-thinking");
  const afterThinking = await metrics();
  assert.equal(afterThinking.height, beforeThinking.height, "夹具假设有误：思考续写改变了内容高度");
  assert.equal(afterThinking.distance, 0, "执行过程里的思考在长，视口却没跟");

  // ⑨ 人往上读历史：新消息一律不许打扰。
  await feed.hover();
  for (let index = 0; index < 6; index++) await page.mouse.wheel(0, -120);
  await flush();
  const reading = await metrics();
  assert.ok(reading.distance > 200, `没能滚到历史位置：${reading.distance}`);
  await press("append");
  assert.equal((await metrics()).top, reading.top, "读历史时被新消息拽走");
  await press("copy-feedback");
  assert.equal((await metrics()).top, reading.top, "读历史时被复制反馈拽走");

  // ⑩ 显式「回到底部」之后，跟随恢复。
  await press("resume");
  await feed.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "auto" }));
  await flush();
  await press("append");
  assert.equal((await metrics()).distance, 0, "显式回到底部后，跟随没有恢复");

  assert.deepEqual(errors, [], "页面抛了异常");
  console.log("stick-to-bottom DOM regression passed");
} finally {
  if (browser) await browser.close();
  await server.close();
}
