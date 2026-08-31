// 审查者身份在会话里的实际渲染：盾形头像 + 一颗徽标 + 验证段旁注的竖条颜色。
// 判定逻辑由 test:reviewer-turn 钉住，这里钉的是「看得出来」和「没动别的」两件事。
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  await page.route(/\/api\/tasks\/t1\/review\/file/, async (route) => {
    const round = new URL(route.request().url()).searchParams.get("round") ?? "?";
    await route.fulfill({
      status: 200,
      contentType: "text/markdown; charset=utf-8",
      body: `# 第 ${round} 轮审查报告\n\n报告已在应用内打开。`,
    });
  });
  // 自由派审的报告是另一条路由，多带一个 runId —— 拼错的话点开就是 404。
  await page.route(/\/api\/tasks\/t1\/free-workflow\/review-file/, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({
      status: 200,
      contentType: "text/markdown; charset=utf-8",
      body: `# 自由派审报告 ${params.get("run")} 第 ${params.get("round")} 轮`,
    });
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/reviewer-turn.html`);

  const messages = page.locator(".task-message--agent");
  await messages.first().waitFor();
  assert.equal(await messages.count(), 5, "四段就地验证前后的发言 + 一段自由派审");

  // 两轮就地验证 + 最后一段 reviewer 会话挂 is-reviewer，修复正文仍是普通执行者。
  const reviewer = page.locator(".task-message--agent.is-reviewer");
  assert.equal(await reviewer.count(), 3);
  assert.equal(await messages.nth(0).evaluate((el) => el.classList.contains("is-reviewer")), false);
  assert.equal(await messages.nth(1).evaluate((el) => el.classList.contains("is-reviewer")), true);
  assert.equal(await messages.nth(2).evaluate((el) => el.classList.contains("is-reviewer")), false);
  assert.equal(await messages.nth(3).evaluate((el) => el.classList.contains("is-reviewer")), true);
  assert.equal(await messages.nth(4).evaluate((el) => el.classList.contains("is-reviewer")), true);

  // 徽标要说清是第几轮，两种审查各有各的轮次来源。
  const badges = page.locator(".verify-badge");
  assert.equal(await badges.count(), 3);
  assert.match(await badges.nth(0).innerText(), /审查者\s*·\s*第 2 轮/);
  assert.match(await badges.nth(1).innerText(), /审查者\s*·\s*第 3 轮/);
  // 自由派审的轮次只写在时间线旁注里、从不进 run 事件，靠区间补上。
  assert.match(await badges.nth(2).innerText(), /审查者\s*·\s*第 1 轮/);

  // D：有后续轮次且已有结论的历史卡默认折叠，最新一张展开。自由派审启动失败后重跑
  // 仍是同一 round，但要分成旧失败卡 + 新结果卡；报告只能挂到后者。
  const lanes = page.locator(".verify-lane");
  assert.equal(await lanes.count(), 4, "两轮就地验证 + 自由派审失败旧卡 / 重跑结果卡");
  assert.deepEqual(
    await lanes.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))),
    ["第 2 轮验证", "第 3 轮验证", "第 1/5 轮审查", "第 1/5 轮审查"],
    "自由派审的卡不能沿用就地验证的「第 N 轮验证」标题；拿得到 run 就要带上总轮数",
  );
  assert.equal(await lanes.nth(0).evaluate((el) => el.classList.contains("is-collapsed")), true);
  assert.equal(await lanes.nth(1).evaluate((el) => el.classList.contains("is-collapsed")), true);
  assert.equal(await lanes.nth(2).evaluate((el) => el.classList.contains("is-collapsed")), true);
  assert.equal(await lanes.nth(3).evaluate((el) => el.classList.contains("is-collapsed")), false);
  assert.equal(await lanes.nth(0).locator(".verify-lane-body").isHidden(), true);
  assert.equal(await lanes.nth(3).locator(".verify-lane-body").isVisible(), true);
  assert.deepEqual(
    await lanes.nth(0).locator(".verify-lane-actions > button").allInnerTexts(),
    ["审查报告", "展开"],
    "审查报告必须在展开按钮左边",
  );
  assert.deepEqual(
    await lanes.nth(2).locator(".verify-lane-actions > button").allInnerTexts(),
    ["展开"],
    "启动失败旧卡不能占用后来重跑生成的报告",
  );
  assert.deepEqual(
    await lanes.nth(3).locator(".verify-lane-actions > button").allInnerTexts(),
    ["审查报告", "收起"],
  );
  assert.equal(
    await messages.nth(4).evaluate((el) => el.closest(".verify-lane")?.getAttribute("aria-label")),
    "第 1/5 轮审查",
    "自由派审的正文归它自己那张卡",
  );

  // 折叠状态不妨碍直接看报告；报告沿用现有应用内 Markdown 弹层，不另开标签页。
  const pageCount = page.context().pages().length;
  await lanes.nth(0).getByRole("button", { name: "审查报告" }).click();
  const reportDialog = page.getByRole("dialog", { name: /report\.md/ });
  await reportDialog.waitFor();
  await reportDialog.getByText(/第 2 轮审查报告/).waitFor();
  assert.match(await reportDialog.innerText(), /第 2 轮审查报告/);
  assert.equal(page.context().pages().length, pageCount);
  assert.equal(await lanes.nth(0).evaluate((el) => el.classList.contains("is-collapsed")), true);
  await reportDialog.getByRole("button", { name: "关闭审查报告" }).click();

  // 自由派审走的是另一条带 runId 的路由，报告内容必须是它自己那份。
  await lanes.nth(3).getByRole("button", { name: "审查报告" }).click();
  const freeDialog = page.getByRole("dialog", { name: /report\.md/ });
  await freeDialog.waitFor();
  await freeDialog.getByText(/自由派审报告 fr1 第 1 轮/).waitFor();
  assert.match(await freeDialog.innerText(), /自由派审报告 fr1 第 1 轮/);
  await freeDialog.getByRole("button", { name: "关闭审查报告" }).click();

  await lanes.nth(0).getByRole("button", { name: "展开" }).click();
  assert.equal(await lanes.nth(0).locator(".verify-lane-body").isVisible(), true);
  assert.equal(await lanes.nth(0).getByRole("button", { name: "收起" }).count(), 1);
  // 下面量版式，三张卡都得摊开。
  await lanes.nth(1).getByRole("button", { name: "展开" }).click();

  // 换身份是断点：验证回合和它后面的修复回合都得重新报执行器名，
  // 否则读者只看见「同一个人一口气说了三段」。
  for (const index of [0, 1, 2, 3, 4]) {
    assert.equal(
      await messages.nth(index).locator(".agent-run-identity").count(),
      1,
      `第 ${index + 1} 段该报身份`,
    );
  }

  // 验证段的起止旁注跟审查者同一套颜色；打回那条仍归红。
  const verifyNotes = page.locator(".conversation-note.is-verify");
  assert.equal(await verifyNotes.count(), 8, "两轮就地验证四条 + 自由派审失败 / 重跑四条");
  assert.match(await verifyNotes.nth(0).innerText(), /第 2 轮验证开始/);
  assert.equal(await verifyNotes.nth(1).evaluate((el) => el.classList.contains("is-error")), true);
  const noteColors = await verifyNotes.evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).borderLeftColor));
  assert.notEqual(noteColors[0], noteColors[1], "开始是青的、打回是红的，两条不能同色");

  // D 的正文统一收进同一层泳道内边距 —— 自由派审现在也是一张卡，同样对齐。
  const boxes = await messages.evaluateAll((els) =>
    els.map((el) => {
      const body = el.querySelector(".task-message-content");
      const rect = body.getBoundingClientRect();
      return { x: Math.round(rect.x), width: Math.round(rect.width) };
    }));
  assert.equal(boxes[3].x, boxes[1].x, "两轮验证正文应使用同一条泳道内边距");
  assert.equal(boxes[3].width, boxes[1].width, "两轮验证正文宽度应一致");
  assert.equal(boxes[4].x, boxes[1].x, "自由派审的正文也在泳道里，跟就地验证同一条内边距");
  assert.equal(boxes[4].width, boxes[1].width);
  assert.notEqual(boxes[4].x, boxes[0].x, "卡内正文比卡外窄，不然折叠卡的边界看不出来");

  // 头像换了个东西（盾形图标而不是首字母），但盘子本身大小不变。
  const avatars = await page.locator(".task-message-avatar").evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect();
      return { size: `${Math.round(rect.width)}x${Math.round(rect.height)}`, svg: !!el.querySelector("svg") };
    }));
  assert.equal(avatars[0].svg, false, "普通回合还是首字母");
  assert.equal(avatars[3].svg, true, "审查者换成盾形");
  assert.equal(avatars[3].size, avatars[2].size, "头像盘子大小不变");

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
