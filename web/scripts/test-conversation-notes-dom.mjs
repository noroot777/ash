// 系统旁注的实际渲染：不再是横贯会话的分隔线，也不再把同一个会话的发言劈成两半。
// 逻辑层的分类和 continuation 由 test:conversation-notes 钉住，这里钉的是渲染结果。
// 设 SHOT=<路径> 可以顺带截一张图自查版式。
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  chromium.executablePath(),
].filter(Boolean);

async function executablePath() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next local Chrome/Chromium candidate.
    }
  }
  throw new Error("找不到可执行的 Chrome/Chromium；可通过 CHROME_BIN 指定路径");
}

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

  browser = await chromium.launch({ executablePath: await executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/conversation-notes.html`);

  const notes = page.locator(".conversation-note");
  await notes.first().waitFor();
  assert.equal(await notes.count(), 6, "六条时间线通告都该渲染成旁注");

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

  const messages = page.locator(".task-message--agent");
  assert.equal(await messages.count(), 6, "六段发言各自成条（用时和用量还挂在各自那条上）");
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
