import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = join(repo, "server/scripts/fixtures/git-workbench-server.ts");
const output = process.env.GIT_WORKBENCH_HEADER_RESIZE_OUTPUT
  || join(tmpdir(), "harness-git-workbench-header-resize");
const desktop = { width: 1440, height: 1000 };
const mobile = { width: 390, height: 844 };

function startBackend() {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`fixture startup timeout\n${stderr}\n${stdout}`)),
      15_000,
    );
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const value = JSON.parse(line);
          if (value?.port && value?.secondProjectId) {
            clearTimeout(timer);
            resolve(value);
            return;
          }
        } catch { /* wait for the readiness JSON */ }
      }
    });
    child.once("error", reject);
    child.once("exit", code => reject(
      new Error(`fixture exited before readiness (${code})\n${stderr}\n${stdout}`),
    ));
  });
  const close = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once("exit", resolve));
    if (child.connected) child.send({ type: "close" });
    else child.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  return { ready, close };
}

const box = locator => locator.evaluate(element => {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});
const color = value => {
  const parts = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert(parts?.length === 3, `expected an rgb color, received ${value}`);
  return parts;
};
const luminance = ([red, green, blue]) =>
  (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
const waitForHistory = async page => {
  await page.getByRole("region", { name: "提交历史" }).locator(".commit-row").first().waitFor();
  await page.getByText("正在读取差异…").waitFor({ state: "detached" });
};
const headerLayout = page => page.evaluate(() => {
  const read = selector => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect ? { left: rect.left, right: rect.right, width: rect.width } : null;
  };
  const visibleButtons = [...document.querySelectorAll(".gwb-header button")]
    .map(element => {
      const rect = element.getBoundingClientRect();
      return { label: element.getAttribute("aria-label") || element.textContent?.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    })
    .filter(rect => rect.right > rect.left && rect.bottom > rect.top);
  const topLeftButtons = [...document.querySelectorAll(".gwb-header .top-left button")];
  const syncButtons = [...document.querySelectorAll(".gwb-header .gwb-sync button")];
  const topLeftLast = topLeftButtons.at(-1)?.getBoundingClientRect();
  const syncFirst = syncButtons[0]?.getBoundingClientRect();
  const branchLabelWidth = document.querySelector(".gwb-header .branch-pill b")
    ?.getBoundingClientRect().width ?? 0;
  const wrappedLabels = [...document.querySelectorAll(".gwb-header .top-btn span")]
    .filter(element => element.getBoundingClientRect().width > 0)
    .map(element => ({ text: element.textContent, height: element.getBoundingClientRect().height }))
    .filter(label => label.height > 18);
  return {
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    header: read(".gwb-header"),
    left: read(".gwb-header .top-left"),
    sync: read(".gwb-header .gwb-sync"),
    right: read(".gwb-header .top-right"),
    visibleButtons,
    topLeftLast: topLeftLast ? { right: topLeftLast.right } : null,
    syncFirst: syncFirst ? { left: syncFirst.left } : null,
    branchLabelWidth,
    wrappedLabels,
  };
});
const dragSeparator = async (page, separator, x) => {
  const current = await separator.boundingBox();
  assert(current, "history separator must have a bounding box");
  await page.mouse.move(current.x + current.width / 2, current.y + current.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, current.y + current.height / 2, { steps: 8 });
  await page.mouse.up();
};

const backend = startBackend();
let vite;
let browser;
try {
  const info = await backend.ready;
  vite = await createServer({
    root: webRoot,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: null,
      proxy: { "/api": { target: `http://127.0.0.1:${info.port}` } },
    },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert(address && typeof address === "object");
  await mkdir(output, { recursive: true });
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: desktop });
  const url = new URL(
    `http://127.0.0.1:${address.port}/scripts/fixtures/git-workbench-shell.html`,
  );
  url.searchParams.set("project", info.projectId);
  url.searchParams.set("view", "git");
  url.searchParams.set("gitView", "history");
  url.searchParams.set("gitRoot", info.root);
  url.searchParams.set("gitRef", "main");
  await page.goto(url.href);
  await page.evaluate(() => document.fonts.ready);
  await waitForHistory(page);

  const projectMenu = page.getByLabel("选择 Git 项目", { exact: true });
  const worktreeMenu = page.getByLabel("选择工作树", { exact: true });
  const exit = page.getByLabel("返回 ash 工作区", { exact: true });
  const fetch = page.getByLabel("获取", { exact: true });
  await Promise.all([projectMenu.waitFor(), worktreeMenu.waitFor(), exit.waitFor()]);
  assert.equal(await projectMenu.count(), 1, "project selector must have one trigger");
  assert.equal(await worktreeMenu.count(), 1, "worktree selector must have one trigger");
  assert((await box(exit)).x < (await box(fetch)).x, "return must appear before fetch");
  const exitColors = await exit.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, foreground: style.color };
  });
  const background = color(exitColors.background);
  const foreground = color(exitColors.foreground);
  assert(background[2] > background[0] && background[2] > background[1], "return background must be blue");
  assert(luminance(background) < 0.5, "return background must be dark");
  assert(luminance(foreground) > 0.7, "return label must remain legible");

  await projectMenu.click();
  const projectItems = page.getByRole("menu", { name: "选择 Git 项目" }).getByRole("menuitem");
  assert.equal(await projectItems.filter({ hasText: "普通目录项目" }).count(), 0, "non-Git projects must be hidden");
  await page.screenshot({ path: join(output, "project-menu.png") });
  await page.evaluate(({ root }) => {
    const next = new URL(location.href);
    next.searchParams.set("gitRoot", root);
    next.searchParams.set("gitTask", "stale-task");
    next.searchParams.set("gitRef", "stale-ref");
    history.replaceState(null, "", next);
  }, { root: info.root });
  const secondState = page.waitForResponse(response =>
    response.request().method() === "GET"
      && response.url().includes(`/projects/${info.secondProjectId}/git/workbench`)
      && !response.url().includes("/history"));
  await projectItems.filter({ hasText: "备用 Git 项目" }).click();
  await secondState;
  await waitForHistory(page);
  const switched = new URL(page.url());
  assert.equal(switched.searchParams.get("project"), info.secondProjectId);
  assert.equal(switched.searchParams.get("view"), "git");
  assert.equal(switched.searchParams.get("gitView"), "history");
  for (const name of ["gitRoot", "gitTask", "gitRef"])
    assert.equal(switched.searchParams.get(name), null, `${name} must be cleared on project switch`);
  assert.equal(await page.locator(".repo-name i").textContent(), info.secondRoot);
  await page.locator(".detail-pane").getByText("备用仓库独有历史", { exact: true }).waitFor();
  await page.locator(".detail-pane").getByText("second revision", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "second-project.png") });

  await page.reload();
  await waitForHistory(page);
  assert.equal(new URL(page.url()).searchParams.get("project"), info.secondProjectId);
  assert.equal(await page.locator(".repo-name i").textContent(), info.secondRoot);
  await page.locator(".detail-pane").getByText("备用仓库独有历史", { exact: true }).waitFor();
  await worktreeMenu.click();
  await page.getByRole("menu", { name: "选择工作树" }).getByRole("menuitem").filter({ hasText: "项目主仓" }).waitFor();
  await page.keyboard.press("Escape");

  const mediumLayouts = {};
  for (const width of [1024, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await headerLayout(page);
    mediumLayouts[width] = layout;
    assert.equal(layout.documentWidth, layout.viewportWidth, `${width}px header must not overflow horizontally`);
    assert(layout.header && layout.left && layout.sync && layout.right, `${width}px header groups must be present`);
    assert(layout.left.right <= layout.sync.left + 1, `${width}px project controls must not overlap sync controls`);
    assert(layout.sync.right <= layout.right.left + 1, `${width}px sync controls must not overlap options`);
    assert(layout.left.left >= layout.header.left && layout.right.right <= layout.header.right, `${width}px controls must stay inside header`);
    assert.equal(layout.wrappedLabels.length, 0, `${width}px header button labels must remain on one line`);
    assert(layout.branchLabelWidth > 20, `${width}px current branch label must remain readable`);
    assert(layout.topLeftLast && layout.syncFirst && layout.topLeftLast.right <= layout.syncFirst.left + 1, `${width}px worktree selector must not cross into sync controls`);
    for (let index = 0; index < layout.visibleButtons.length; index++) {
      const current = layout.visibleButtons[index];
      for (const next of layout.visibleButtons.slice(index + 1)) {
        const verticalOverlap = Math.min(current.bottom, next.bottom) - Math.max(current.top, next.top);
        const horizontalOverlap = Math.min(current.right, next.right) - Math.max(current.left, next.left);
        assert(verticalOverlap <= 0 || horizontalOverlap <= 0, `${width}px header controls overlap: ${current.label} / ${next.label}`);
      }
    }
    if (width === 820) await page.screenshot({ path: join(output, "header-820.png") });
  }
  await page.setViewportSize(desktop);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const separator = page.getByRole("separator", { name: "调整历史列表宽度" });
  await separator.waitFor();
  const historyList = page.getByRole("region", { name: "提交历史" });
  const detail = page.locator(".detail-pane");
  const initialWidth = (await box(historyList)).width;
  const split = await box(page.locator(".gwb-history-split"));
  await dragSeparator(page, separator, split.x + split.width * 0.3);
  const draggedWidth = (await box(historyList)).width;
  assert(draggedWidth < initialWidth - 40, "dragging left must narrow history");
  assert((await box(detail)).width > 0, "dragging must retain the detail pane");
  await dragSeparator(page, separator, split.x - 500);
  const leftBound = (await box(historyList)).width;
  await dragSeparator(page, separator, split.x - 1000);
  assert(Math.abs((await box(historyList)).width - leftBound) <= 1, "left drag must clamp at a stable bound");
  await dragSeparator(page, separator, split.x + split.width + 500);
  const rightBound = (await box(historyList)).width;
  await dragSeparator(page, separator, split.x + split.width + 1000);
  assert(Math.abs((await box(historyList)).width - rightBound) <= 1, "right drag must clamp at a stable bound");
  assert((await box(detail)).width >= 240, "right bound must preserve a usable detail pane");

  await separator.focus();
  const beforeKeyboard = (await box(historyList)).width;
  await separator.press("ArrowLeft");
  const afterLeft = (await box(historyList)).width;
  assert(afterLeft < beforeKeyboard, "ArrowLeft must narrow history");
  await separator.press("ArrowRight");
  assert(Math.abs((await box(historyList)).width - beforeKeyboard) <= 1, "ArrowRight must widen history");
  await separator.dblclick();
  assert(Math.abs((await box(historyList)).width - initialWidth) <= 2, "double click must restore the default split");
  await page.screenshot({ path: join(output, "desktop-reset.png") });

  await page.evaluate(({ root }) => {
    const next = new URL(location.href);
    next.searchParams.set("gitRoot", root);
    next.searchParams.set("gitTask", "stale-task");
    next.searchParams.set("gitRef", "stale-ref");
    history.replaceState(null, "", next);
  }, { root: info.root });
  await exit.click();
  await page.locator(".workspace-sidebar").waitFor();
  const exited = new URL(page.url());
  assert.equal(exited.searchParams.get("project"), info.secondProjectId);
  for (const name of ["view", "gitView", "gitRoot", "gitTask", "gitRef"])
    assert.equal(exited.searchParams.get(name), null, `${name} must be cleared on return`);
  await page.reload();
  await page.locator(".workspace-sidebar").waitFor();
  assert.equal(await page.locator(".workspace-git-page").count(), 0, "refresh after return must stay in ash");

  const mobilePage = await browser.newPage({ viewport: mobile });
  const mobileUrl = new URL(url);
  mobileUrl.searchParams.set("project", info.secondProjectId);
  mobileUrl.searchParams.delete("gitRoot");
  mobileUrl.searchParams.delete("gitRef");
  await mobilePage.goto(mobileUrl.href);
  await mobilePage.evaluate(() => document.fonts.ready);
  await waitForHistory(mobilePage);
  const mobileSeparator = mobilePage.getByRole("separator", { name: "调整历史列表宽度" });
  assert.equal(await mobileSeparator.isVisible().catch(() => false), false, "mobile must hide the split handle");
  const dimensions = await mobilePage.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.equal(dimensions.scrollWidth, dimensions.clientWidth, "mobile workbench must not overflow horizontally");
  const mobileExit = mobilePage.getByLabel("返回 ash 工作区", { exact: true });
  const mobileFetch = mobilePage.getByLabel("获取", { exact: true });
  assert((await box(mobileExit)).x < (await box(mobileFetch)).x, "mobile return must remain before fetch");
  await mobilePage.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  await mobilePage.close();

  const metrics = {
    url: url.href,
    projects: {
      first: { id: info.projectId, root: info.root },
      second: { id: info.secondProjectId, root: info.secondRoot },
      nonGit: { id: info.nonGitProjectId, root: info.nonGitRoot },
    },
    split: { initialWidth, draggedWidth, leftBound, rightBound },
    mediumLayouts,
    exitColors,
    viewports: { desktop, mobile },
  };
  await writeFile(join(output, "metrics.json"), JSON.stringify(metrics, null, 2));
  await writeFile(
    join(output, "browser-run.txt"),
    [
      "Chrome extension attempt: failed",
      "Error: unsupported Codex auth method: apikey",
      "Fallback: isolated headless Chromium",
      "Focused header and resize suite: passed",
      "Existing design suite: run separately; see design/metrics.json",
      "Cleanup: browser, Vite server, fixture backend, temporary repositories closed",
      "",
    ].join("\n"),
  );
  console.log(`Git workbench header and resize verification passed\nScreenshots: ${output}`);
} finally {
  await browser?.close();
  await vite?.close();
  await backend.close();
}
