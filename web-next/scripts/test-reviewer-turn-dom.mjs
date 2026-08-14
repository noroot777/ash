// 审查者身份在会话里的实际渲染：盾形头像 + 一颗徽标 + 验证段旁注的竖条颜色。
// 判定逻辑由 test:reviewer-turn 钉住，这里钉的是「看得出来」和「没动别的」两件事。
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/reviewer-turn.html`);

  const messages = page.locator(".task-message--agent");
  await messages.first().waitFor();
  assert.equal(await messages.count(), 4, "三段就地验证前后的发言 + 一段自由派审");

  // 只有审查者那两条挂 is-reviewer：中间那段就地验证，最后那段是 reviewer 会话。
  const reviewer = page.locator(".task-message--agent.is-reviewer");
  assert.equal(await reviewer.count(), 2);
  assert.equal(await messages.nth(0).evaluate((el) => el.classList.contains("is-reviewer")), false);
  assert.equal(await messages.nth(1).evaluate((el) => el.classList.contains("is-reviewer")), true);
  assert.equal(await messages.nth(2).evaluate((el) => el.classList.contains("is-reviewer")), false);
  assert.equal(await messages.nth(3).evaluate((el) => el.classList.contains("is-reviewer")), true);

  // 徽标要说清是第几轮，两种审查各有各的轮次来源。
  const badges = page.locator(".verify-badge");
  assert.equal(await badges.count(), 2);
  assert.match(await badges.nth(0).innerText(), /审查者\s*·\s*第 2 轮/);
  // 自由派审的轮次只写在时间线旁注里、从不进 run 事件，靠区间补上。
  assert.match(await badges.nth(1).innerText(), /审查者\s*·\s*第 1 轮/);

  // 换身份是断点：验证回合和它后面的修复回合都得重新报执行器名，
  // 否则读者只看见「同一个人一口气说了三段」。
  for (const index of [0, 1, 2, 3]) {
    assert.equal(
      await messages.nth(index).locator(".agent-run-identity").count(),
      1,
      `第 ${index + 1} 段该报身份`,
    );
  }

  // 验证段的起止旁注跟审查者同一套颜色；打回那条仍归红。
  const verifyNotes = page.locator(".conversation-note.is-verify");
  assert.equal(await verifyNotes.count(), 3, "就地验证的起止两条 + 自由派审的开始那条");
  assert.match(await verifyNotes.nth(0).innerText(), /第 2 轮验证开始/);
  assert.equal(await verifyNotes.nth(1).evaluate((el) => el.classList.contains("is-error")), true);
  const noteColors = await verifyNotes.evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).borderLeftColor));
  assert.notEqual(noteColors[0], noteColors[1], "开始是青的、打回是红的，两条不能同色");

  // 徽标是加出来的，不是挤出来的：气泡本体的左边界和宽度一律不动。
  const boxes = await messages.evaluateAll((els) =>
    els.map((el) => {
      const body = el.querySelector(".task-message-content");
      const rect = body.getBoundingClientRect();
      return { x: Math.round(rect.x), width: Math.round(rect.width) };
    }));
  assert.equal(boxes[1].x, boxes[0].x, "审查者的气泡不该被推进去");
  assert.equal(boxes[1].width, boxes[0].width, "审查者的气泡不该被挤窄");

  // 头像换了个东西（盾形图标而不是首字母），但盘子本身大小不变。
  const avatars = await page.locator(".task-message-avatar").evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect();
      return { size: `${Math.round(rect.width)}x${Math.round(rect.height)}`, svg: !!el.querySelector("svg") };
    }));
  assert.equal(avatars[0].svg, false, "普通回合还是首字母");
  assert.equal(avatars[1].svg, true, "审查者换成盾形");
  assert.equal(avatars[1].size, avatars[0].size, "头像盘子大小不变");

  // 新增的这几处小字承载的正是本功能的全部信息（谁在说话 / 哪一轮 / 验证段的边界），
  // 淡一点就等于没做。按 WCAG 相对亮度实测，普通小号文本至少要 4.5:1。
  const contrasts = await page.evaluate(() => {
    // 这套配色写的是 lch()/color-mix()，getComputedStyle 原样返回 `lch(55 30 232)`，
    // 按 rgb 去解会把 L/C/H 当成三个通道。过一遍画布，拿真正落到屏幕上的 sRGB。
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const channel = (value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = (color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return 0.2126 * channel(r / 255) + 0.7152 * channel(g / 255) + 0.0722 * channel(b / 255);
    };
    // 背景要一层层往上找：多数元素自己是透明的，实际衬在下面的是祖先那层。
    const backdrop = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor;
        if (color && color !== "transparent" && !/,\s*0\s*\)$/.test(color)) return color;
      }
      return "#fff";
    };
    const ratio = (el) => {
      const front = luminance(getComputedStyle(el).color);
      const back = luminance(backdrop(el));
      return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
    };
    return {
      badge: ratio(document.querySelector(".verify-badge")),
      note: ratio(document.querySelector(".conversation-note.is-verify:not(.is-error)")),
      failNote: ratio(document.querySelector(".conversation-note.is-verify.is-error")),
    };
  });
  for (const [name, value] of Object.entries(contrasts)) {
    assert.ok(value >= 4.5, `${name} 的对比度只有 ${value.toFixed(2)}:1，低于 WCAG AA 的 4.5:1`);
  }

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  console.log("reviewer-turn-dom ok");
} finally {
  await browser?.close();
  await server.close();
}
