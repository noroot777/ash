// 系统旁注的实际渲染：不再是横贯会话的分隔线，也不再把同一个会话的发言劈成两半。
// 逻辑层的分类和 continuation 由 test:conversation-notes 钉住，这里钉的是渲染结果。
// 设 SHOT=<路径> 可以顺带截一张图自查版式。
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/conversation-notes.html`);

  const notes = page.locator(".conversation-note");
  await notes.first().waitFor();
  assert.equal(await notes.count(), 8, "八条时间线通告都该渲染成旁注");

  // 通告不再借用回合边界那条横贯的分隔线；边界事件本身仍然是那条线。
  const boundary = page.locator(".task-event-line");
  assert.equal(await boundary.count(), 1);
  assert.match(await boundary.innerText(), /本轮执行结束/);
  // 两档要看得出是两种东西：一条横贯，一条只在左边立一道竖线。
  const noteBox = await notes.first().boundingBox();
  const boundaryBox = await boundary.boundingBox();
  assert.ok(boundaryBox.width > noteBox.width, "回合边界横贯得比旁注宽");
  // 「没办成」的那条要看得出来不一样。
  assert.equal(await page.locator(".conversation-note.is-error").count(), 1);
  assert.match(await page.locator(".conversation-note.is-error").innerText(), /审查未通过/);

  // 会话轮换旁注是中性事实：一个 exit 0 的成功回合、甚至用户自己点的「停止全组」都会带
  // 一句。它既不该是红的，也不该把 Markdown 标记原样露给用户（旁注是纯文本渲染）。
  const rotation = notes.filter({ hasText: "ash 已经把这个失效的 id 清掉" });
  assert.equal(await rotation.count(), 1, "会话轮换旁注没渲染出来");
  assert.equal(
    await rotation.evaluate((el) => el.classList.contains("is-error")),
    false,
    "会话轮换旁注被渲染成红色执行异常 —— 用户会以为这一回合失败了",
  );
  assert.doesNotMatch(await rotation.innerText(), /\*\*/, "旁注是纯文本，Markdown 标记会原样露给用户");

  const messages = page.locator(".task-message--agent");
  assert.equal(await messages.count(), 6, "实时旁注后的工具应并回当前回合，不另拆第七段");
  // 第一段照常报身份；被旁注隔开的后几段接着上一段排版，不重报执行器名。
  assert.equal(await messages.nth(0).locator(".agent-run-identity").count(), 1);
  assert.equal(await messages.nth(1).locator(".agent-run-identity").count(), 0, "旁注不该让会话重报身份");
  assert.equal(await messages.nth(2).locator(".agent-run-identity").count(), 0);
  assert.equal(await messages.nth(3).locator(".agent-run-identity").count(), 0);
  assert.equal(
    await page.locator(".task-message--agent.is-continuation header time").count(),
    0,
    "旁注已经显示同一时间时，续写段不该再重复",
  );
  assert.equal(
    await page.locator('.task-message--agent button[aria-label="复制这条回复"]').count(),
    await messages.count(),
    "每段回复都必须保留复制入口",
  );
  // 真人插过话之后是新的一段，身份要回来；回合边界之后同理。
  assert.equal(await messages.nth(4).locator(".agent-run-identity").count(), 1, "真人插话后必须重新报身份");
  assert.equal(await messages.nth(5).locator(".agent-run-identity").count(), 1, "回合边界之后必须重新报身份");
  assert.match(await notes.last().innerText(), /已预约完成后审查.*08\/10 15:02/, "实时旁注应在自身行内显示精确时间");
  assert.equal(await messages.last().locator(".task-tool-line").count(), 1, "旁注后到达的工具应显示在旁注之前的当前回合里");
  assert.equal(await messages.last().locator(".task-message-footer").count(), 1, "会话统计条应留在旁注之前的当前回合里");
  assert.equal(await notes.last().evaluate((note) => note === note.parentElement?.lastElementChild), true, "实时旁注应稳定留在当前回合与统计条之后");

  await page.setViewportSize({ width: 390, height: 1000 });
  const narrowTime = await notes.last().locator("time").evaluate((time) => {
    const range = document.createRange();
    range.selectNodeContents(time);
    return { whiteSpace: getComputedStyle(time).whiteSpace, lineCount: range.getClientRects().length };
  });
  assert.deepEqual(narrowTime, { whiteSpace: "nowrap", lineCount: 1 }, "窄屏日期与时分不能从中间拆成两行");
  await page.setViewportSize({ width: 1000, height: 1400 });

  // agent 输出里的引用块（「正在压缩上下文…」这类 ash 注记）跟旁注是同一档，
  // 字号行高得对上，前面那道竖线的高度才会一样。
  const quote = page.locator(".task-markdown blockquote").first();
  await quote.waitFor();
  const metrics = await quote.evaluate((el) => {
    const note = document.querySelector(".conversation-note");
    const read = (node) => {
      const s = getComputedStyle(node);
      return { size: s.fontSize, line: s.lineHeight, height: node.getBoundingClientRect().height };
    };
    return { quote: read(el), note: read(note) };
  });
  assert.equal(metrics.quote.size, metrics.note.size, "引用块字号该跟旁注一样");
  assert.equal(metrics.quote.line, metrics.note.line, "引用块行高该跟旁注一样");
  assert.ok(
    Math.abs(metrics.quote.height - metrics.note.height) < 1,
    `引用块竖线高度该跟旁注一样（${metrics.quote.height} vs ${metrics.note.height}）`,
  );

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  console.log("conversation-notes-dom ok");
} finally {
  await browser?.close();
  await server.close();
}
