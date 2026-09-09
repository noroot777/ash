// 侧栏三处「显示另外 N 条」都是**分页**的：一次放 20 条，不够再点一下，不是一把梭全展开。
// 主列表的年龄闸 / 团队行底下的执行者 / 「其他项目」那一叠 —— 三处共用 TaskReveal，
// 所以一个用例把三处都走一遍，免得改一处漏两处。
// 跑：npm -w web run test:task-tree-paging
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
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/task-tree-paging.html`);

  // —— 一、主列表：45 条旧任务被年龄闸折起来。
  const mainList = page.locator(".workspace-task-section");
  const oldRows = mainList.locator('.workspace-task-row:has-text("旧任务")');
  const mainMore = mainList.locator(".workspace-task-more-row");
  const mainCollapse = mainMore.getByRole("button", { name: "收起", exact: true });
  const firstPage = mainMore.getByRole("button", { name: "显示另外 20 条（未显示 45 条）" });

  await page.getByRole("button", { name: "今天刚改过" }).waitFor();
  assert.equal(await oldRows.count(), 0, "默认只显示 24 小时内的任务");
  assert.equal(await mainCollapse.count(), 0, "一条都没展开时没有收起");
  await firstPage.waitFor();

  await firstPage.click();
  await page.getByRole("button", { name: "旧任务 20" }).waitFor();
  assert.equal(await oldRows.count(), 20, "点一下只展开一页");
  assert.equal(await page.getByRole("button", { name: "旧任务 21" }).count(), 0, "第二页还没放出来");
  // 展开到一半也得能收回去：分页之后「全展开」不再是必经的一站。
  assert.equal(await mainCollapse.count(), 1, "翻了一页就要有收起");

  // 按钮上的「还剩多少」跟着走。
  await mainMore.getByRole("button", { name: "显示另外 20 条（未显示 25 条）" }).click();
  await page.getByRole("button", { name: "旧任务 40" }).waitFor();
  assert.equal(await oldRows.count(), 40);
  assert.equal(await page.getByRole("button", { name: "旧任务 41" }).count(), 0);

  // 最后一页不足 20 条时按剩下的说。
  await mainMore.getByRole("button", { name: "显示另外 5 条" }).click();
  await page.getByRole("button", { name: "旧任务 45" }).waitFor();
  assert.equal(await oldRows.count(), 45, "最后一页把剩下的放完");
  assert.equal(await mainMore.getByRole("button", { name: /^显示另外/ }).count(), 0, "放完了就不再有展开按钮");
  assert.equal(await mainCollapse.count(), 1);

  // 收起回到起点，且能从头再翻一次。
  await mainCollapse.click();
  await firstPage.waitFor();
  assert.equal(await oldRows.count(), 0, "收起把展开过的页数清零");

  // —— 二、团队行底下的执行者：30 个，先摆 12 个，再一页一页放。
  await page.getByRole("button", { name: "展开 30 个执行者" }).click();
  const workerList = page.locator(".workspace-worker-list");
  const workerRows = workerList.locator(".workspace-task-row");
  await workerList.waitFor();
  assert.equal(await workerRows.count(), 12, "执行者先只摆一屏");
  const workerMore = workerList.locator(".workspace-task-more-row");
  await workerMore.getByRole("button", { name: "显示另外 18 条" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-worker-list .workspace-task-row').length === 30);
  assert.equal(await workerMore.getByRole("button", { name: /^显示另外/ }).count(), 0);
  await workerMore.getByRole("button", { name: "收起", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-worker-list .workspace-task-row').length === 12);

  // —— 三、「其他项目」那一叠：40 条，同样一次一页。
  await page.getByRole("button", { name: "隔壁项目" }).click();
  const otherList = page.locator(".workspace-other-project-tasks");
  const otherRows = otherList.locator(".workspace-task-row");
  await otherList.waitFor();
  assert.equal(await otherRows.count(), 12, "别家项目也先只摆一屏");
  const otherMore = otherList.locator(".workspace-task-more-row");
  await otherMore.getByRole("button", { name: "显示另外 20 条（未显示 28 条）" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-other-project-tasks .workspace-task-row').length === 32);
  await otherMore.getByRole("button", { name: "显示另外 8 条" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-other-project-tasks .workspace-task-row').length === 40);
  await otherMore.getByRole("button", { name: "收起", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-other-project-tasks .workspace-task-row').length === 12);

  console.log("✓ 任务树分页展开：主列表 / 执行者 / 其他项目都是一次 20 条，收起随时可用");
} finally {
  await browser?.close();
  await server.close();
}
