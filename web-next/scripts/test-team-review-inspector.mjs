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

  // 审查记录只挂在被审任务身上，所以被审过的执行者不再单列——它由「审查:」那条代表。
  const titles = await targets.locator("b").allInnerTexts();
  assert.deepEqual(titles, ["团队：随手记全屏", "改图标", "审查:做搜索", "审查:做弹窗"]);
  assert.equal(titles.includes("做搜索"), false, "被审过的执行者不该再单列一条空记录");

  // 编号跟着被审执行者走，且过滤之后不重排。
  const roles = await targets.locator("small").allInnerTexts();
  assert.deepEqual(roles, ["调度台", "执行者 3", "审查 · 执行者 1", "审查 · 执行者 2"]);

  // 结论读的是被审任务的 stage：w1 verified、w2 verify_failed。
  const labels = await targets.locator("em").allInnerTexts();
  assert.deepEqual(labels, ["待命", "完成", "已验证", "未通过验证"]);
  assert.equal(await page.getByText("1 项未通过", { exact: true }).count(), 1);
  assert.equal(await page.getByText("1 项已验证 · 3 个审查对象", { exact: true }).count(), 1);

  // 默认落在最该看的那条：w2 验证未通过 → 选中代表它的「审查:做弹窗」，证据读 w2。
  const asked = () => page.evaluate(() => window.__reviewFetches);
  await page.waitForFunction(() => window.__reviewFetches.length > 0);
  assert.equal((await asked()).at(-1), "w2", "默认选中未通过那条，读的是被审任务的记录");
  assert.equal(await page.getByText("w2 的验证报告").count(), 1);

  await targets.nth(2).click();
  await page.waitForFunction(() => window.__reviewFetches.at(-1) === "w1");
  // 请求发出到渲染出来之间还隔一次 setState，所以等元素而不是立刻数个数。
  await page.getByText("w1 的验证报告").first().waitFor();
  assert.equal(await page.getByText("审查 · 执行者 1审查记录").count(), 1);

  console.log("team review inspector test passed");
} finally {
  await browser?.close();
  await server.close();
}
