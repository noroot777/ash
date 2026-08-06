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
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/team-review-inspector.html`);

  const targets = page.locator(".team-review-inspector__targets button");
  await targets.first().waitFor();

  // 审查记录只挂在被审任务身上，所以被审过的执行者不再单列——它由「审查:」那条代表，
  // 同一个执行者被审多轮也只留一条（后派的那一轮）。
  const titles = await targets.locator("b").allInnerTexts();
  assert.deepEqual(titles, ["团队：随手记全屏", "改图标", "审查:做搜索(复审)", "审查:做弹窗"]);
  assert.equal(titles.includes("做搜索"), false, "被审过的执行者不该再单列一条空记录");
  assert.equal(titles.includes("审查:做搜索"), false, "同一个被审对象的多轮审查该收敛成一条");

  // 编号跟着被审执行者走，且过滤之后不重排。
  const roles = await targets.locator("small").allInnerTexts();
  assert.deepEqual(roles, ["调度台", "执行者 3", "审查 · 执行者 1", "审查 · 执行者 2"]);

  // 结论读的是被审任务的 stage：w1 verified、w2 verify_failed。
  const labels = await targets.locator("em").allInnerTexts();
  assert.deepEqual(labels, ["待命", "完成", "已验证", "未通过验证"]);
  assert.equal(await page.getByText("1 项未通过", { exact: true }).count(), 1);
  assert.equal(await page.getByText("1 项已验证 · 3 个审查对象", { exact: true }).count(), 1);

  // 抽屉默认不弹，也就不该为任何对象预拉记录。
  const drawer = page.locator(".review-evidence-drawer");
  const asked = () => page.evaluate(() => window.__reviewFetches);
  assert.equal(await drawer.count(), 0, "进来时不该自动弹出审查内容");
  assert.deepEqual(await asked(), [], "没打开就不该请求审查记录");

  // 点审查执行者 → 左侧弹屉，内容读的是它审的那个任务。
  await targets.nth(2).click();
  await drawer.waitFor();
  await page.waitForFunction(() => window.__reviewFetches.at(-1) === "w1");
  await drawer.getByText("w1 的验证报告").first().waitFor();
  assert.equal(await page.locator(".review-evidence-drawer > header b").innerText(), "做搜索");
  assert.equal(await page.locator(".review-evidence-drawer > header small").innerText(), "审查 · 执行者 1");

  // 抽屉贴在侧边栏左边缘，不盖住列表（等滑入动画落定再量）。
  await drawer.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const host = await page.locator(".inspector-host").boundingBox();
  const box = await drawer.boundingBox();
  assert.ok(Math.abs(box.x + box.width - host.x) <= 1, `抽屉右边缘该贴着侧边栏左边缘，实测 ${box.x + box.width} vs ${host.x}`);
  assert.ok(Math.abs(box.height - host.height) <= 1, "抽屉该和侧边栏一样高");
  assert.equal(box.width, host.width, "抽屉与侧边栏等宽");

  // 点列表里另一条只换内容，不关抽屉。
  await targets.nth(3).click();
  await page.waitForFunction(() => window.__reviewFetches.at(-1) === "w2");
  await drawer.getByText("w2 的验证报告").first().waitFor();
  assert.equal(await drawer.count(), 1);

  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });

  console.log("team review inspector test passed");
} finally {
  await browser?.close();
  await server.close();
}
