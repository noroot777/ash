import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = fileURLToPath(new URL("../../output/playwright/", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
const messages = Array.from({ length: 10 }, (_, index) => ({
  id: `monitor-${index}`, taskId: "task-a", text: `【哨兵结束】检查 ${index}，退出码 0。命令自己跑完了。`,
  attachments: [], agent: "codex", executorId: null, model: null, reasoningEffort: null, sessionRole: null,
  origin: `monitor:${index}`, mode: "queued", sendAt: "2026-10-24T10:00:00.000Z", status: "pending",
  createdAt: "2026-10-24T10:00:00.000Z", sentAt: null,
}));
let browser;
try {
  await mkdir(artifacts, { recursive: true });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch(await chromeLaunchOptions());
  for (const variant of ["single", "team"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 400 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", (route) => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/scheduled-messages") ? messages : [] }));
    try {
      await page.goto(`${base}/scripts/fixtures/scheduled-message-reply.html?variant=${variant}`);
      const input = page.locator(variant === "single" ? ".task-reply-box textarea" : ".team-reply-box textarea");
      const send = page.getByRole("button", { name: variant === "single" ? "排队发送，任务跑完自动发出" : "发送给调度者", exact: true });
      const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const visibleSend = async (label) => {
        const result = await send.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return { top: box.top, bottom: box.bottom, height: innerHeight, hit: element.contains(hit), scrollTop: document.scrollingElement.scrollTop };
        });
        assert.ok(result.top >= 0 && result.bottom <= result.height, `${variant} ${label}: ${JSON.stringify(result)}`);
        assert.equal(result.hit, true, `${variant} ${label}: 发送按钮不能被裁剪或覆盖`);
        assert.equal(result.scrollTop, 0, `${variant} ${label}: 不能依赖页面滚动找回发送按钮`);
        return result;
      };
      await page.getByRole("button", { name: "展开全部 10 条" }).waitFor();
      await input.fill("要发送的草稿");
      const before = await visibleSend("短窗口折叠");
      await page.getByRole("button", { name: "展开全部 10 条" }).click();
      await settle();
      const after = await visibleSend("短窗口展开");
      assert.ok(Math.abs(after.bottom - before.bottom) < 1, `${variant}: 展开不将发送区向下推`);
      await page.screenshot({ path: `${artifacts}scheduled-message-reply-${variant}-short.png` });
      await page.setViewportSize({ width: 390, height: 700 });
      await page.getByRole("separator").focus();
      await page.keyboard.press("End");
      await settle();
      await visibleSend("拉到最大高度");
      await input.fill(Array.from({ length: 80 }, (_, index) => `保留草稿第 ${index} 行`).join("\n"));
      assert.equal(await input.evaluate((element) => getComputedStyle(element).overflowY), "auto");
      assert.equal(await input.evaluate((element) => element.scrollHeight > element.clientHeight), true);
      await page.screenshot({ path: `${artifacts}scheduled-message-reply-${variant}-resized.png` });
      await page.getByRole("button", { name: "加入附件", exact: true }).click();
      await page.locator(".task-upload-chip").first().waitFor();
      for (const [width, height] of [[320, 320], [390, 400], [1024, 500], [390, 700]]) {
        await page.setViewportSize({ width, height });
        await settle();
        await visibleSend(`${width}×${height}，拉高且有附件`);
        assert.equal(await page.locator(".reply-context").evaluate((element) => element.scrollHeight > element.clientHeight), true, "辅助内容在共同预算内滚动");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      assert.equal(await input.inputValue(), Array.from({ length: 80 }, (_, index) => `保留草稿第 ${index} 行`).join("\n"), "调整布局不改动草稿");
      await page.getByRole("separator").press("Home");
      await page.getByRole("button", { name: "收起列表", exact: true }).click();
      await settle();
      await visibleSend("收起后");
      assert.deepEqual(errors, []);
      console.log(`✓ ${variant} 真实回复框：短视口、最大拉高、附件/操作栏、窗口变化和收起均保持发送按钮可见`);
    } catch (error) {
      await page.screenshot({ path: `${artifacts}scheduled-message-reply-${variant}-failure.png`, fullPage: true });
      throw error;
    } finally {
      await context.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const demo = fileURLToPath(new URL("../../docs/demos/pending-input-demo.html", import.meta.url));
  await page.goto(`${base}/@fs${demo}`);
  await page.getByRole("button", { name: "展开全部 10 条", exact: true }).click();
  const footer = await page.locator(".composer-footer").boundingBox();
  const frame = await page.locator(".app-window").boundingBox();
  assert.ok(footer.y + footer.height <= frame.y + frame.height, "原型同类边界也不能挤出发送区");
  assert.match(await page.locator("#cancel-dialog").textContent(), /不执行停止哨兵操作/);
  console.log("✓ 原型共用高度边界与中性取消说明通过");
} finally {
  await browser?.close();
  await server.close();
}
