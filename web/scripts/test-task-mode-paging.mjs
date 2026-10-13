import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object");
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/task-mode-paging.html`);
  await page.locator('[data-task-id="a-live"]').waitFor();
  const group = (name) => page.locator(".workspace-task-project-group").filter({
    has: page.getByRole("button", { name: `折叠项目 ${name}`, exact: true }),
  });
  const first = group("甲项目");
  const second = group("乙项目");
  const pinnedOnly = group("仅置顶项目");
  const ids = () => page.locator(".workspace-task-tree [data-task-id]").evaluateAll((rows) => rows.map((row) => row.dataset.taskId));
  const extras = (container) => container.locator('[data-task-id^="a-extra-"]');
  const clear = async () => {
    await page.getByTestId("clear-selection").click();
    await page.getByTestId("clear-selection").evaluate((button) => button.blur());
    await page.waitForFunction(() => document.querySelector('[data-testid="selected"]').textContent === "");
  };
  const walk = async (expected, key) => {
    for (const id of expected) {
      await page.keyboard.press(key);
      await page.waitForFunction((nextId) => document.querySelector('[data-testid="selected"]').textContent === nextId, id);
    }
  };
  assert.deepEqual(await ids(), ["c-pin", "a-live", "a-question", "b-live"], "默认任务和顺序保持不变");
  assert.equal(await page.getByRole("button", { name: "折叠项目 空闲项目" }).count(), 0);
  await first.getByRole("button", { name: "展开(20/45)", exact: true }).waitFor();
  await second.getByRole("button", { name: "展开(20/22)", exact: true }).waitFor();
  await pinnedOnly.getByRole("button", { name: "展开(2/2)", exact: true }).waitFor();
  const artifacts = fileURLToPath(new URL("../../output/playwright/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: `${artifacts}task-mode-default.png` });

  await first.getByRole("button", { name: "展开(20/45)", exact: true }).click();
  assert.equal(await extras(first).count(), 20);
  assert.equal(await second.locator('[data-task-id^="b-extra-"]').count(), 0, "项目独立分页");
  assert.equal(await first.locator('[data-task-id="archived"]').count(), 0);
  assert.equal(await first.locator('[data-task-id="a-worker-1"]').count(), 0, "执行者不混入项目顶层行");
  assert.equal(await first.locator('[data-task-id="a-extra-2"]').count(), 1, "任务模式展开保留出站任务");
  await first.getByRole("button", { name: "展开 2 个执行者", exact: true }).click();
  await first.locator('[data-task-id="a-worker-2"]').waitFor();
  await page.locator(".workspace-task-tree").evaluate((tree) => { tree.scrollTop = 0; });
  await page.screenshot({ path: `${artifacts}task-mode-expanded.png` });
  const expanded = await ids();
  assert.equal(new Set(expanded).size, expanded.length, "不重复渲染置顶或展开任务");
  await clear();
  await walk(expanded, "j");
  await walk([...expanded].reverse().slice(1), "k");
  await page.keyboard.press("Meta+k");
  assert.equal(await page.getByTestId("palette-count").textContent(), "1", "Cmd+K 命令面板入口保持不变");
  await first.getByRole("button", { name: "折叠执行者", exact: true }).click();
  await clear();
  await first.getByRole("button", { name: "展开(20/25)", exact: true }).click();
  assert.equal(await extras(first).count(), 40);
  await first.getByRole("button", { name: "展开(5/5)", exact: true }).click();
  assert.equal(await extras(first).count(), 45);
  assert.equal(await first.getByRole("button", { name: /^展开\(/ }).count(), 0);
  await page.screenshot({ path: `${artifacts}task-mode-fully-expanded.png` });
  await first.getByRole("button", { name: "收起", exact: true }).click();
  assert.equal(await extras(first).count(), 0);
  assert.deepEqual(await ids(), ["c-pin", "a-live", "a-question", "b-live"]);

  await second.getByRole("button", { name: "展开(20/22)", exact: true }).click();
  assert.equal(await second.locator('[data-task-id^="b-extra-"]').count(), 20);
  await second.getByRole("button", { name: "展开(2/2)", exact: true }).click();
  assert.equal(await second.locator('[data-task-id^="b-extra-"]').count(), 22);
  await pinnedOnly.getByRole("button", { name: "展开(2/2)", exact: true }).click();
  assert.equal(await pinnedOnly.locator('[data-task-id^="c-extra-"]').count(), 2);
  assert.equal(await page.locator('[data-task-id="c-pin"]').count(), 1);
  await second.getByRole("button", { name: "收起", exact: true }).click();
  await pinnedOnly.getByRole("button", { name: "收起", exact: true }).click();

  await page.getByTestId("select-hidden").click();
  await first.locator('[data-task-id="a-extra-45"]').waitFor();
  assert.equal(await extras(first).count(), 45, "选择隐藏任务自动翻到对应页");
  await first.getByRole("button", { name: "收起", exact: true }).click();
  assert.equal(await extras(first).count(), 0, "选中任务不妨碍用户收起列表");
  await clear();
  await page.getByTestId("select-worker").click();
  await first.locator('[data-task-id="a-worker-2"]').waitFor();
  assert.equal(await extras(first).count(), 20, "选择隐藏执行者只揭示调度台所在页");
  await clear();
  const reopened = await ids();
  await walk(reopened, "ArrowDown");
  await walk([...reopened].reverse().slice(1), "ArrowUp");
  await clear();
  await first.getByRole("button", { name: "折叠项目 甲项目", exact: true }).click();
  assert.deepEqual(await ids(), ["c-pin", "b-live"], "折叠项目后跳过整组含展开任务");
  await walk(["c-pin", "b-live"], "j");
  await walk(["c-pin"], "k");
  await clear();
  await page.getByTestId("only-pinned-project").click();
  assert.deepEqual(await ids(), ["c-pin"], "只有置顶任务时默认列表不变");
  await pinnedOnly.getByRole("button", { name: "展开(2/2)", exact: true }).click();
  assert.deepEqual(await ids(), ["c-pin", "c-extra-1", "c-extra-2"], "没有普通任务分节时仍能展开项目");
  await clear();
  await walk(["c-pin", "c-extra-1", "c-extra-2"], "j");
  await walk(["c-extra-1", "c-pin"], "k");
  assert.deepEqual(errors, []);
  console.log("✓ 任务模式每项目分页：默认不变、20/20/余数、独立收起、隐藏选中、团队执行者及 J/K/上下键按 DOM 顺序导航");
} finally {
  await browser?.close();
  await server.close();
}
