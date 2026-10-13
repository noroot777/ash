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
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/task-mode-paging.html`;
  await page.goto(url);
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
  assert.equal(await first.locator(".workspace-task-project-head em").textContent(), "2", "项目计数保持任务模式口径");
  assert.equal(await second.locator(".workspace-task-project-head em").textContent(), "1");
  assert.equal(await page.getByRole("button", { name: "折叠项目 空闲项目" }).count(), 0);
  await first.getByRole("button", { name: "展开(20/45)", exact: true }).waitFor();
  await second.getByRole("button", { name: "展开(20/22)", exact: true }).waitFor();
  await pinnedOnly.getByRole("button", { name: "展开(2/2)", exact: true }).waitFor();
  const artifacts = fileURLToPath(new URL("../../output/playwright/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: `${artifacts}task-mode-default.png` });

  await first.getByRole("button", { name: "展开(20/45)", exact: true }).click();
  assert.equal(await extras(first).count(), 20);
  assert.equal(await first.locator(".workspace-task-project-head em").textContent(), "2", "展开历史任务不改变项目计数");
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
  await page.waitForFunction(() => document.querySelector('[data-testid="selected"]').textContent === "a-extra-45");
  assert.equal(await extras(first).count(), 0, "选择历史任务不会自动展开项目历史");
  await first.getByRole("button", { name: "展开(20/45)", exact: true }).click();
  assert.equal(await extras(first).count(), 20, "手动展开一页后选中的历史任务也不会触发更多页");
  await first.getByRole("button", { name: "收起", exact: true }).click();
  assert.equal(await extras(first).count(), 0, "选中任务不妨碍用户收起列表");
  await clear();
  await page.getByTestId("select-worker").click();
  assert.equal(await extras(first).count(), 0, "选择历史团队的执行者不会自动展开历史");
  await first.getByRole("button", { name: "展开(20/45)", exact: true }).click();
  await first.locator('[data-task-id="a-worker-2"]').waitFor();
  assert.equal(await extras(first).count(), 20, "手动揭示团队后选中的执行者正常显示");
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

  await page.goto(`${url}?regressions=1&scope=tasks&task=a-extra-420`);
  await first.getByRole("button", { name: "展开(20/424)", exact: true }).waitFor();
  assert.deepEqual(await ids(), ["c-pin", "a-live", "a-question", "b-live"], "深链到第 420 条历史任务时默认列表保持短列表");
  assert.equal(await first.locator(".workspace-task-project-head em").textContent(), "6", "项目只统计两条可见任务及四条年龄闸任务");
  await page.screenshot({ path: `${artifacts}task-mode-history-deeplink.png` });
  await first.getByRole("button", { name: "展开(20/424)", exact: true }).click();
  const agedIds = ["a-aged-1", "a-aged-2", "a-aged-3", "a-aged-4"];
  const firstHistoryIds = Array.from({ length: 16 }, (_, index) => `a-extra-${index + 1}`);
  assert.deepEqual(await first.locator("[data-task-id]").evaluateAll((rows) => rows.map((row) => row.dataset.taskId)), [
    "a-live", "a-question", ...agedIds, ...firstHistoryIds,
  ], "第一页先放回四条在跑任务，再放历史任务；不会被 420 条历史挤到末尾");
  assert.equal(await first.locator(".workspace-task-project-head em").textContent(), "6", "展开后任务模式计数不变");
  await clear();
  const ageExpanded = await ids();
  await walk(ageExpanded, "j");
  await walk([...ageExpanded].reverse().slice(1), "k");
  await first.getByRole("button", { name: "收起", exact: true }).click();
  await clear();
  await page.getByTestId("select-aged").click();
  await first.locator('[data-task-id="a-aged-4"]').waitFor();
  assert.equal(await first.locator('[data-task-id^="a-aged-"]').count(), 4, "自动揭示仍保留任务模式的年龄闸任务");
  assert.equal(await extras(first).count(), 0, "自动揭示只到年龄闸末尾，不顺带补满一页历史");
  await page.screenshot({ path: `${artifacts}task-mode-aged-reveal.png` });
  await first.getByRole("button", { name: "收起", exact: true }).click();
  assert.equal(await first.locator('[data-task-id^="a-aged-"]').count(), 0, "选中年龄闸任务时也允许用户收起");

  await page.goto(`${url}?regressions=1&scope=project&task=a-extra-420`);
  await page.locator('[data-task-id="a-extra-420"]').waitFor();
  assert.ok((await ids()).length > 400, "先在单项目态选中历史任务");
  await page.getByTestId("toggle-mode").click();
  await first.getByRole("button", { name: "展开(20/424)", exact: true }).waitFor();
  assert.deepEqual(await ids(), ["c-pin", "a-live", "a-question", "b-live"], "带历史任务选中项切进任务模式也不会自动展开历史");
  assert.deepEqual(errors, []);
  console.log("✓ 任务模式分页：独立 20 条展开、历史深链/切模式不自动展开、年龄闸优先且自动揭示不带历史、计数口径不变、J/K/上下键按可见顺序导航");
} finally {
  await browser?.close();
  await server.close();
}
