// 任务树「显示另外 N 条 / 收起」：展开后点几条旧任务，收起必须真的收得回去。
// 回归的那个 bug：选中项落在 24h 预览之外时，用 selectedTaskIsHidden 持续顶住展开，
// 点收起只是改了用户自己的展开集合，列表还是全开。
// 跑：npm -w web run test:task-tree-preview
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
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/task-tree-preview.html`);

  const recent = page.getByRole("button", { name: "今天刚改过" });
  const handoffOutRow = page.getByRole("button", { name: "已经转出的接力任务" });
  const handoffInRow = page.getByRole("button", { name: "刚刚转入的接力任务" });
  const handoffOutMark = page.locator('[aria-label="接力转出"]');
  const handoffInMark = page.locator('[aria-label="接力转入"]');
  const oldJia = page.getByRole("button", { name: "很久以前的任务甲" });
  const oldYi = page.getByRole("button", { name: "很久以前的任务乙" });
  const oldBing = page.getByRole("button", { name: "很久以前的任务丙" });
  const oldStarred = page.getByRole("button", { name: "很久以前但加了星" });
  const oldUnaccepted = page.getByRole("button", { name: "很久以前但没验收" });
  const expand = page.getByRole("button", { name: "显示另外 3 条" });
  const collapse = page.getByRole("button", { name: "收起", exact: true });

  await recent.waitFor();
  assert.equal(await handoffOutMark.count(), 1, "转出任务应带小飞机标记");
  assert.equal(await handoffInMark.count(), 1, "转入任务应带小飞机标记");
  assert.equal(await handoffOutMark.locator("..").evaluate((node) => getComputedStyle(node).opacity), "0");
  await handoffOutRow.hover();
  await page.waitForTimeout(180);
  assert.equal(await handoffOutMark.locator("..").evaluate((node) => getComputedStyle(node).opacity), "1", "指向转出任务时标记应显示");
  await handoffInRow.hover();
  await page.waitForTimeout(180);
  assert.equal(await handoffInMark.locator("..").evaluate((node) => getComputedStyle(node).opacity), "1", "指向转入任务时标记应显示");
  assert.equal(await oldJia.count(), 0, "默认只显示 24 小时内的任务");
  assert.equal(await oldStarred.count(), 1, "星标的任务再旧也不进折叠");
  assert.equal(await oldUnaccepted.count(), 1, "还没验收的任务再旧也不进折叠");
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
  assert.equal(await oldStarred.count(), 1, "收起之后星标的仍然在");
  assert.equal(await oldUnaccepted.count(), 1, "收起之后未验收的仍然在");

  console.log("✓ 任务树预览：展开后点旧任务，收起仍能收回去");
} finally {
  await browser?.close();
  await server.close();
}
