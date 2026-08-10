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
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/free-workflow-inspector.html`);

  const reviewOnly = page.locator(".review-only-fixture");
  await reviewOnly.getByText("Codex 审查").first().waitFor();
  await reviewOnly.locator(".free-review-history summary").nth(1).click();
  assert.equal(await reviewOnly.getByRole("heading", { name: "审查结论" }).count(), 1, "报告应按 Markdown 正文渲染");
  assert.equal(await reviewOnly.locator(".free-review-history article > pre").count(), 0, "报告不再退化成原始 pre 文本");

  const shots = reviewOnly.locator(".free-review-screenshots");
  assert.equal(await shots.locator("a").count(), 0, "自由审查截图不应再是新页面链接");
  assert.equal(await shots.locator("img[role=button]").count(), 2, "自由审查截图应接入统一图片预览");

  const pageCount = page.context().pages().length;
  await shots.locator("img[role=button]").first().click();
  const lightbox = page.getByRole("dialog", { name: /图片预览/ });
  await lightbox.waitFor();
  assert.equal(page.context().pages().length, pageCount, "点截图必须留在当前页面");
  assert.equal(await page.getByText("1 / 2", { exact: true }).count(), 1);
  assert.match(await lightbox.locator("img").getAttribute("src"), /free-workflow\/review-file\?run=run-abc&round=1&name=shot-one\.png$/);
  await page.keyboard.press("Escape");
  await lightbox.waitFor({ state: "detached" });

  const workflow = page.locator(".workflow-inspector-fixture");
  const activities = workflow.locator(".free-workflow-generated li");
  assert.deepEqual(await activities.locator("b").allInnerTexts(), [
    "任务执行", "Codex 审查 · 逻辑检查", "任务执行", "Codex 审查 · 逻辑检查",
  ], "任务执行和审查必须按真实时间交替排列，不能合并同名审查");
  assert.match(await activities.nth(0).locator("small").innerText(), /8\/9.*9 分钟/);

  const dock = workflow.locator(".free-review-history.is-docked");
  assert.equal(await dock.getAttribute("class"), "free-review-history is-docked", "审查记录默认整块收在底部");
  await activities.nth(1).getByRole("button").click();
  assert.match(await dock.getAttribute("class"), /is-open/, "点上方审查后整块记录应向上展开");
  assert.equal(await dock.locator("details[open]").getAttribute("open"), "", "对应审查链应默认打开");
  assert.equal(await dock.locator("details[open] article header b").innerText(), "第 1 轮");

  await activities.nth(3).getByRole("button").click();
  assert.equal(await dock.locator("details[open] article p").first().innerText(), "报告尚未生成。", "点第二次审查应切换到对应记录");
  await activities.nth(3).getByRole("button").click();
  assert.equal(await dock.getAttribute("class"), "free-review-history is-docked", "再点同一个审查节点应把整块记录收回底部");

  console.log("free workflow inspector preview test passed");
} finally {
  await browser?.close();
  await server.close();
}
