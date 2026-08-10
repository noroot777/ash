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
  const reviewRounds = reviewOnly.locator(".review-inspector__targets button");
  await reviewRounds.first().waitFor();
  assert.deepEqual(await reviewRounds.locator("b").allInnerTexts(), ["第 1 轮", "第 1 轮"], "自由审查 inspector 应和普通任务一样按轮列出记录");
  assert.equal(await page.locator(".review-evidence-drawer").count(), 0, "审查正文默认不弹出");
  await reviewRounds.first().click();

  const drawer = page.locator(".review-evidence-drawer");
  await drawer.waitFor();
  assert.equal(await drawer.getByRole("heading", { name: "审查结论" }).count(), 1, "报告应在左侧抽屉按 Markdown 正文渲染");
  assert.equal(await drawer.locator("pre").count(), 0, "报告不再退化成原始 pre 文本");

  const shots = drawer.locator(".review-screenshot-strip");
  assert.equal(await shots.locator("a").count(), 0, "自由审查截图不应再是新页面链接");
  assert.equal(await shots.locator("img[role=button]").count(), 6, "自由审查截图应接入统一图片预览");
  const railOverflow = await shots.locator(".review-screenshot-strip__rail").evaluate((node) => node.scrollWidth > node.clientWidth);
  assert.equal(railOverflow, true, "多图应限制为底部单行横向滚动，不能纵向铺满抽屉");

  await drawer.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const drawerBox = await drawer.boundingBox();
  const footerBox = await drawer.locator(".review-evidence-drawer__footer").boundingBox();
  assert.ok(Math.abs(footerBox.y + footerBox.height - (drawerBox.y + drawerBox.height)) <= 1, "图片区应固定贴住抽屉底边");

  const pageCount = page.context().pages().length;
  await shots.locator("img[role=button]").first().click();
  const lightbox = page.getByRole("dialog", { name: /图片预览/ });
  await lightbox.waitFor();
  assert.equal(page.context().pages().length, pageCount, "点截图必须留在当前页面");
  assert.equal(await page.getByText("1 / 6", { exact: true }).count(), 1);
  assert.match(await lightbox.locator("img").getAttribute("src"), /free-workflow\/review-file\?run=run-abc&round=1&name=shot-one\.png$/);
  await page.keyboard.press("Escape");
  await lightbox.waitFor({ state: "detached" });
  assert.equal(await drawer.count(), 1, "关闭大图时审查抽屉应保留");
  await reviewRounds.first().click();
  await drawer.waitFor({ state: "detached" });

  const workflow = page.locator(".workflow-inspector-fixture");
  const activities = workflow.locator(".free-workflow-generated li");
  assert.deepEqual(await activities.locator("b").allInnerTexts(), [
    "任务执行", "Codex 审查 · 逻辑检查", "任务执行", "Codex 审查 · 逻辑检查",
    "合并&清理",
  ], "任务执行和审查必须按真实时间交替排列，不能合并同名审查");
  assert.match(await activities.nth(0).locator("small").innerText(), /8\/9.*9 分钟/);
  assert.equal(await activities.last().locator("svg.is-spinning").count(), 1, "合并处理中应和其它运行中节点一样显示旋转图标");

  assert.equal(await drawer.count(), 0, "工作流中的审查正文默认也不弹出");
  await activities.nth(1).getByRole("button").click();
  await drawer.waitFor();
  assert.equal(await drawer.locator("header b").innerText(), "第 1 轮审查", "点时间线审查节点应复用左侧抽屉");
  assert.equal(await drawer.getByRole("heading", { name: "审查结论" }).count(), 1);

  await activities.nth(3).getByRole("button").click();
  assert.equal(await drawer.locator(".review-round-body p").first().innerText(), "报告尚未生成。", "点第二次审查应在同一抽屉切换记录");
  assert.equal(await drawer.locator(".review-evidence-drawer__footer").count(), 0, "没有截图的轮次不应留下空白底栏");
  await activities.nth(3).getByRole("button").click();
  await drawer.waitFor({ state: "detached" });

  console.log("free workflow inspector preview test passed");
} finally {
  await browser?.close();
  await server.close();
}
