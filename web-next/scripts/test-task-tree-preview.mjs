// 任务树「显示另外 N 条 / 收起」：展开后点几条旧任务，收起必须真的收得回去。
// 回归的那个 bug：选中项落在 24h 预览之外时，用 selectedTaskIsHidden 持续顶住展开，
// 点收起只是改了用户自己的展开集合，列表还是全开。
// 跑：npm -w web-next run test:task-tree-preview
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
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/task-tree-preview.html`);

  const recent = page.getByRole("button", { name: "今天刚改过" });
  const oldJia = page.getByRole("button", { name: "很久以前的任务甲" });
  const oldYi = page.getByRole("button", { name: "很久以前的任务乙" });
  const oldBing = page.getByRole("button", { name: "很久以前的任务丙" });
  const expand = page.getByRole("button", { name: "显示另外 3 条" });
  const collapse = page.getByRole("button", { name: "收起", exact: true });

  await recent.waitFor();
  assert.equal(await oldJia.count(), 0, "默认只显示 24 小时内的任务");
  await expand.click();
  await oldJia.waitFor();
  assert.equal(await oldYi.count(), 1);
  assert.equal(await oldBing.count(), 1);

  await oldJia.click();
  await oldYi.click();
  await collapse.click();

  await expand.waitFor();
  assert.equal(await oldJia.count(), 0, "点过旧任务后再点收起，旧任务必须藏回去");
  assert.equal(await oldYi.count(), 0);
  assert.equal(await oldBing.count(), 0);
  assert.equal(await recent.count(), 1);

  console.log("✓ 任务树预览：展开后点旧任务，收起仍能收回去");
} finally {
  await browser?.close();
  await server.close();
}
