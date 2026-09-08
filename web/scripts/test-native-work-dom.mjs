import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = fileURLToPath(new URL("../../output/playwright", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object");
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/native-work.html`);

  assert.equal(await page.getByRole("tab", { name: "子智能体" }).count(), 0, "Inspector starts hidden");
  await page.getByRole("button", { name: "打开子智能体" }).click();
  await page.getByRole("tab", { name: "子智能体" }).waitFor();
  assert.equal(await page.locator(".native-work__row").count(), 6);
  assert.deepEqual((await page.locator(".native-work__status").allInnerTexts()).sort(),
    ["进行中", "待处理", "已完成", "失败", "已停止", "状态未知"].sort());

  const running = page.locator('.native-work__row[data-status="running"]');
  await running.locator("summary").click();
  await page.getByText("核对浏览器状态", { exact: true }).click();
  assert.match(await page.locator(".native-work__detail").filter({ hasText: "所属子智能体" }).innerText(), /运行中的资料搜集/);

  const overflow = await page.locator(".native-work").evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(overflow.scroll <= overflow.width + 1, `narrow Inspector overflowed: ${JSON.stringify(overflow)}`);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/native-work-initial.png`, fullPage: true });

  await page.getByRole("button", { name: "完成运行项" }).click();
  await page.locator('.native-work__row[data-status="completed"] > summary').filter({ hasText: "运行中的资料搜集" }).waitFor();
  assert.equal(await page.locator('.native-work__row[data-status="completed"]').count(), 3);
  assert.match(await page.locator(".native-work__counts").innerText(), /3 已完成/);

  await page.reload();
  await page.getByRole("tab", { name: "子智能体" }).waitFor();
  assert.equal(await page.locator('.native-work__row[data-status="completed"]').count(), 3, "refresh rebuild keeps final states");
  assert.equal(await page.locator(".native-work__title", { hasText: "运行中的资料搜集" }).locator("xpath=ancestor::details[1]").getAttribute("data-status"), "completed");

  await page.getByRole("button", { name: "切换空状态" }).click();
  await page.getByText("暂无子智能体或内部任务").waitFor();
  assert.equal(await page.locator(".native-work__row").count(), 0);
  await page.screenshot({ path: `${output}/native-work-empty.png`, fullPage: true });
  console.log("native work Inspector DOM regression passed");
} finally {
  await browser?.close();
  await server.close();
}
