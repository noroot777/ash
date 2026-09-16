import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = join(repo, "server/scripts/fixtures/git-workbench-server.ts");

const until = async (probe, hint, attempts = 160) => {
  for (let i = 0; i < attempts; i += 1) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等不到：${hint}`);
};

function startBackend() {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const fail = (message) => reject(new Error(`${message}\n${stderr}\n${stdout}`));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const value = JSON.parse(line);
          if (value?.port && value?.projectId && value?.root) return resolve(value);
        } catch { /* wait for the JSON readiness line */ }
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => fail(`Git workbench fixture exited before readiness (${code ?? signal})`));
    setTimeout(() => fail("Git workbench fixture did not become ready"), 15_000).unref();
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    if (child.connected) {
      child.send({ type: "close" }, (error) => {
        if (error && child.exitCode === null) child.kill("SIGTERM");
      });
    } else {
      child.kill("SIGTERM");
    }
    const didExit = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!didExit && child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  };
  return { child, ready, close, diagnostics: () => ({ stdout, stderr }) };
}

const backend = startBackend();
let vite;
let browser;
let page;
let backendDirectory;
const browserErrors = [];
const requestFailures = [];
const actionResults = [];
let screenshotDirectory;
const persistentScreenshots = process.env.GIT_WORKBENCH_EVIDENCE_OUTPUT || "";

const tab = (name) => page.getByRole("navigation", { name: "Git 工作台视图" }).getByRole("button", { name: new RegExp(`^${name}`) });
const dialog = (name) => page.getByRole("dialog", { name });
const chooseMenuItem = async (trigger, item) => {
  const label = await trigger.getAttribute("aria-label");
  assert(label, "Workbench menu trigger must have an accessible label");
  await trigger.click();
  await page.getByRole("menu", { name: label }).getByRole("menuitem", { name: item, exact: true }).click();
};
const currentView = async () => new URL(page.url()).searchParams.get("gitView");
const waitIdle = () => until(async () => page.getByLabel("选择工作树").isEnabled(), "Git 工作台操作结束");
const performAction = async (trigger, expectedOk = true) => {
  let actionReceived = false;
  const pending = page.waitForResponse((response) => response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(new URL(response.url()).pathname));
  const refreshed = page.waitForResponse((response) => actionReceived && response.request().method() === "GET" && /\/git\/workbench$/.test(new URL(response.url()).pathname));
  void pending.catch(() => undefined);
  void refreshed.catch(() => undefined);
  await trigger();
  const response = await pending;
  actionReceived = true;
  const body = await response.json().catch(() => null);
  const requestBody = response.request().postDataJSON();
  actionResults.push({
    kind: requestBody?.action?.kind || "unknown",
    status: response.status(),
    body,
  });
  assert.equal(response.ok(), expectedOk, `Git action HTTP ${response.status()}: ${JSON.stringify(body)}`);
  await refreshed;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await waitIdle();
  return body;
};
const waitMessage = async (pattern) => {
  await until(async () => pattern.test(await page.getByTestId("fixture-notice").innerText()), pattern.toString());
};
const submitDialog = async (title, button = title) => {
  const box = dialog(title);
  await performAction(() => box.getByRole("button", { name: button, exact: true }).click());
  await box.waitFor({ state: "detached" });
};

try {
  const info = await backend.ready;
  backendDirectory = info.directory;
  const discardPath = join(info.root, "partial-discard.txt");
  const discardBase = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const discardModified = discardBase.replace("line 2\n", "LINE TWO\n").replace("line 25\n", "LINE TWENTY FIVE\n");
  const isolatedGit = {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(info.directory, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    },
  };
  writeFileSync(discardPath, discardBase);
  execFileSync("git", ["-C", info.root, "add", "--", "partial-discard.txt"], isolatedGit);
  execFileSync("git", ["-C", info.root, "commit", "-qm", "add partial discard fixture"], isolatedGit);
  writeFileSync(discardPath, discardModified);
  vite = await createServer({
    root: webRoot,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: { "/api": { target: `http://127.0.0.1:${info.port}` } },
    },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/git-workbench.html?project=${encodeURIComponent(info.projectId)}`;

  browser = await chromium.launch(await chromeLaunchOptions());
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) browserErrors.push(message.text());
  });
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} · ${request.failure()?.errorText}`));
  await page.goto(url);

  // 项目侧栏分支胶囊是工作台入口；进入后 URL 成为可后退、可刷新的真实路由。
  const pill = page.locator(".workspace-git-context");
  await pill.waitFor();
  assert.match(await pill.getAttribute("aria-label"), /分支 main.*有未提交改动/);
  await pill.click();
  await page.getByRole("button", { name: "打开 Git 工作台 →", exact: true }).click();
  await page.getByRole("navigation", { name: "Git 工作台视图" }).waitFor();
  if (persistentScreenshots) {
    screenshotDirectory = persistentScreenshots;
    await mkdir(screenshotDirectory, { recursive: true });
  }
  assert.equal(await currentView(), "changes");
  for (const name of ["变更", "历史", "分支", "贮藏", "标签", "工作树", "操作日志"]) {
    await tab(name).waitFor();
  }

  await tab("历史").click();
  assert.equal(await currentView(), "history");
  await page.goBack();
  await page.getByRole("region", { name: "工作区变更" }).waitFor();
  assert.equal(await currentView(), "changes");
  await page.reload();
  await page.getByRole("region", { name: "工作区变更" }).waitFor();
  assert.equal(await currentView(), "changes", "刷新保留 Git 工作台视图");

  // 从任务进入已有工作树后，同一工作树内的视图和引用跳转必须保留返回任务。
  const taskContextUrl = new URL(page.url());
  taskContextUrl.searchParams.set("gitRoot", info.root);
  taskContextUrl.searchParams.set("gitTask", "browser-origin");
  await page.goto(taskContextUrl.href);
  await page.getByRole("region", { name: "工作区变更" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("gitTask"), "browser-origin");
  await tab("历史").click();
  assert.equal(new URL(page.url()).searchParams.get("gitTask"), "browser-origin");
  await page.goBack();
  await page.getByRole("region", { name: "工作区变更" }).waitFor();

  // 同一文件两处修改：先按单行暂存 BETA，再按剩余块暂存 IOTA；新增文件按整文件暂存。
  await page.getByRole("button", { name: /partial-discard\.txt/ }).first().click();
  const firstHunkDiscard = page.getByRole("button", { name: "丢弃此块", exact: true }).first();
  await firstHunkDiscard.click();
  const discardDialog = dialog("丢弃这个改动块");
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, "partial-discard-cancel.png") });
  await discardDialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(readFileSync(discardPath, "utf8"), discardModified, "取消丢弃必须保留文件");
  await firstHunkDiscard.click();
  const discardConfirm = discardDialog.getByRole("button", { name: "丢弃这个改动块", exact: true });
  assert.equal(await discardConfirm.isDisabled(), true);
  await discardDialog.getByLabel("输入目标以确认").fill("错误");
  assert.equal(await discardConfirm.isDisabled(), true);
  await discardDialog.getByLabel("输入目标以确认").fill("丢弃");
  assert.equal(await discardConfirm.isEnabled(), true);
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, "partial-discard-confirm.png") });
  await submitDialog("丢弃这个改动块");
  const fileAfterDiscard = readFileSync(discardPath, "utf8");
  assert.match(fileAfterDiscard, /\nline 2\n/, "选中块应恢复为原内容");
  assert.match(fileAfterDiscard, /\nLINE TWENTY FIVE\n/, "未选中的块必须保留");
  execFileSync("git", ["-C", info.root, "checkout", "--", "partial-discard.txt"], isolatedGit);
  await chooseMenuItem(page.getByLabel("工作台选项"), "刷新 Git 工作台");
  await page.getByRole("button", { name: /sample\.txt/ }).first().click();
  const betaRemoved = page.getByRole("button", { name: /行 .*-beta$/ });
  const betaAdded = page.getByRole("button", { name: /行 .*\+BETA$/ });
  await betaRemoved.waitFor();
  await betaRemoved.click();
  await betaAdded.click();
  let releaseHeldRefresh;
  let markRefreshHeld;
  const heldRefresh = new Promise((resolve) => { releaseHeldRefresh = resolve; });
  const refreshHeld = new Promise((resolve) => { markRefreshHeld = resolve; });
  let holdAfterAction = false;
  const stateRequest = /\/api\/projects\/[^/]+\/git\/workbench\?/;
  const actionRequest = /\/api\/projects\/[^/]+\/git\/workbench\/actions$/;
  await page.route(stateRequest, async (route) => {
    if (!holdAfterAction || route.request().method() !== "GET") return route.continue();
    holdAfterAction = false;
    markRefreshHeld();
    await heldRefresh;
    await route.continue();
  });
  await page.route(actionRequest, async (route) => {
    const response = await route.fetch();
    holdAfterAction = true;
    await route.fulfill({ response });
  }, { times: 1 });
  const stageSelected = performAction(() => page.getByRole("button", { name: "暂存所选改动", exact: true }).click());
  try {
    await refreshHeld;
    assert.equal(await page.getByLabel("选择工作树").isDisabled(), true, "写后状态刷新完成前保持操作锁定");
  } finally {
    releaseHeldRefresh();
  }
  await stageSelected;
  await page.unroute(stateRequest);
  await waitMessage(/已暂存所选改动/);

  const unstagedGroup = page.locator(".gwb-file-group", { has: page.locator("header", { hasText: "未暂存" }) });
  await unstagedGroup.getByRole("button", { name: /sample\.txt/ }).click();
  const hunk = page.getByRole("button", { name: /选择改动块/ }).last();
  await hunk.waitFor();
  await hunk.click();
  await performAction(() => page.getByRole("button", { name: "暂存所选改动", exact: true }).click());
  await waitMessage(/已暂存所选改动/);

  const untrackedGroup = page.locator(".gwb-file-group", { has: page.locator("header", { hasText: "未跟踪" }) });
  const untrackedRow = untrackedGroup.getByRole("button", { name: /新增文件\.txt/ }).first();
  await untrackedRow.hover();
  await performAction(() => untrackedGroup.getByLabel("暂存 新增文件.txt").click());
  const stagedGroup = page.locator(".gwb-file-group", { has: page.locator("header", { hasText: "已暂存" }) });
  await stagedGroup.getByRole("button", { name: /新增文件\.txt/ }).first().waitFor();
  await page.getByLabel("提交信息").fill("浏览器提交");
  await performAction(() => page.getByRole("button", { name: /^提交（\d+ 个文件）$/ }).click());
  await waitMessage(/已提交暂存区内容/);
  await waitIdle();
  assert.match(await page.getByRole("region", { name: "工作区变更" }).innerText(), /所有改动已提交/);

  // 历史详情可建分支和标签；历史筛选、详情和路由都来自真实 Git。
  await tab("历史").click();
  const browserCommit = page.getByRole("button", { name: /浏览器提交/ });
  await browserCommit.waitFor();
  await browserCommit.click();
  await chooseMenuItem(page.getByLabel("提交操作", { exact: true }), "从这里建分支");
  await dialog("从提交新建分支").getByText("分支名").locator("..").getByRole("textbox").fill("browser/history-branch");
  await submitDialog("从提交新建分支");
  await waitMessage(/操作已完成/);

  await browserCommit.click();
  await chooseMenuItem(page.getByLabel("提交操作", { exact: true }), "打标签");
  const tagDialog = dialog("为提交打标签");
  await tagDialog.getByText("标签名").locator("..").getByRole("textbox").fill("browser-v1");
  await tagDialog.getByRole("textbox").nth(1).fill("浏览器标签");
  await submitDialog("为提交打标签");

  // 制造一份新的真实改动，从 UI 贮藏并查看差异。
  await writeFile(join(info.root, "stash-browser.txt"), "stash from browser test\n");
  await chooseMenuItem(page.getByLabel("工作台选项"), "刷新 Git 工作台");
  await until(async () => /1/.test(await tab("变更").innerText()), "刷新后看到新改动");
  await tab("贮藏").click();
  await page.getByRole("button", { name: "贮藏改动", exact: true }).click();
  const stashDialog = dialog("贮藏当前改动");
  await stashDialog.getByText("说明").locator("..").getByRole("textbox").fill("browser stash");
  await submitDialog("贮藏当前改动");
  const stashRow = page.locator(".gwb-ref-row", { hasText: "browser stash" });
  await stashRow.waitFor();
  await stashRow.getByRole("button", { name: /^查看差异 stash@/ }).click();
  const stashDiff = stashRow.locator(".gwb-stash-diff");
  await stashDiff.waitFor();
  await until(async () => /stash-browser\.txt|stash from browser test/.test(await stashDiff.innerText()), "贮藏差异内容");
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, "stash-non-empty.png") });

  // 一次必然失败的删除留进日志，刷新后仍在；随后进入真实 merge 冲突。
  await tab("分支").click();
  const conflictBranch = page.locator(".gwb-ref-row", { hasText: "feature/conflict" });
  await conflictBranch.getByRole("button", { name: "历史", exact: true }).click();
  await page.getByRole("region", { name: "提交历史" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("gitTask"), "browser-origin");
  await page.goBack();
  await conflictBranch.waitFor();
  await chooseMenuItem(conflictBranch.getByLabel("feature/conflict 分支操作"), "删除已合并分支");
  await performAction(() => dialog("删除已合并分支").getByRole("button", { name: "删除已合并分支", exact: true }).click(), false);
  await dialog("删除已合并分支").getByRole("alert").waitFor();
  await dialog("删除已合并分支").getByRole("button", { name: "关闭删除已合并分支" }).click();
  await tab("操作日志").click();
  await page.locator(".gwb-journal-entry.is-failed").filter({ hasText: "删除分支" }).waitFor();
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, "operation-log-non-empty.png") });
  await page.reload();
  await page.locator(".gwb-journal-entry.is-failed").filter({ hasText: "删除分支" }).waitFor();

  await tab("分支").click();
  await chooseMenuItem(conflictBranch.getByLabel("feature/conflict 分支操作"), "合入当前分支");
  const mergeDialog = dialog("合并 feature/conflict");
  const mergeFailure = await performAction(() => mergeDialog.getByRole("button", { name: "合并 feature/conflict", exact: true }).click(), false);
  assert.match(String(mergeFailure?.error || ""), /CONFLICT|冲突/i);
  await mergeDialog.getByRole("alert").waitFor();
  await mergeDialog.getByRole("button", { name: "关闭合并 feature/conflict" }).click();
  await waitIdle();
  await page.locator(".gwb-operation").waitFor();
  await page.getByRole("button", { name: "打开冲突解决器", exact: true }).click();
  const conflictDialog = dialog(/解决冲突/);
  await conflictDialog.getByText("冲突块 1").waitFor();
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, "merge-conflict-overlay.png") });
  await conflictDialog.getByRole("button", { name: "采用我方", exact: true }).click();
  const conflictEditor = conflictDialog.getByLabel("冲突解决结果");
  await conflictEditor.fill(`${await conflictEditor.inputValue()}resolved in browser\n`);
  await performAction(() => conflictDialog.getByRole("button", { name: "保存结果并暂存", exact: true }).click());
  await conflictDialog.locator("strong", { hasText: "所有冲突文件已解决" }).waitFor();
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, "merge-conflict-saved.png") });
  await conflictDialog.getByRole("button", { name: "返回工作台", exact: true }).click();
  await conflictDialog.waitFor({ state: "detached" });
  await performAction(() => page.getByRole("button", { name: "继续操作", exact: true }).click());
  await waitMessage(/Git 已继续执行/);
  await page.locator(".gwb-operation").waitFor({ state: "detached" });

  // 通过带 typed 确认的 hard reset 回到合并前，再造同一冲突并中止。
  await tab("历史").click();
  await page.getByRole("button", { name: /浏览器提交/ }).click();
  await chooseMenuItem(page.getByLabel("提交操作", { exact: true }), "重置到这里…");
  const resetDialog = dialog("重置当前分支");
  await resetDialog.locator("select").selectOption("hard");
  const resetConfirm = resetDialog.getByRole("button", { name: "重置当前分支", exact: true });
  assert.equal(await resetConfirm.isDisabled(), true);
  await resetDialog.getByLabel("输入目标以确认").fill("wrong");
  assert.equal(await resetConfirm.isDisabled(), true);
  await resetDialog.getByLabel("输入目标以确认").fill("main");
  assert.equal(await resetConfirm.isEnabled(), true);
  await submitDialog("重置当前分支");
  await tab("分支").click();
  await chooseMenuItem(conflictBranch.getByLabel("feature/conflict 分支操作"), "合入当前分支");
  const mergeAgain = dialog("合并 feature/conflict");
  const secondMergeFailure = await performAction(() => mergeAgain.getByRole("button", { name: "合并 feature/conflict", exact: true }).click(), false);
  assert.match(String(secondMergeFailure?.error || ""), /CONFLICT|冲突/i);
  await mergeAgain.getByRole("alert").waitFor();
  await mergeAgain.getByRole("button", { name: "关闭合并 feature/conflict" }).click();
  await waitIdle();
  await page.locator(".gwb-operation").waitFor();
  await page.getByRole("button", { name: "中止操作", exact: true }).click();
  await submitDialog("中止 Git 操作");
  await page.locator(".gwb-operation").waitFor({ state: "detached" });

  // 编辑线性历史：一条 fixup，一条 reword，最终结果仍能正常刷新。
  await tab("历史").click();
  await page.getByRole("button", { name: /历史提交 1/ }).click();
  await chooseMenuItem(page.getByLabel("提交操作", { exact: true }), "编辑此提交之后的历史…");
  const rebaseDialog = dialog("交互式变基");
  await rebaseDialog.getByLabel("提交 1 的动作").waitFor();
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, "rebase-dialog-720px.png") });
  assert.equal(Math.round((await rebaseDialog.boundingBox())?.width || 0), 720, "desktop rebase dialog width");
  assert.equal(await rebaseDialog.locator(".task-confirm-header h2").evaluate((node) => getComputedStyle(node).fontSize), "13px");
  assert.equal(await rebaseDialog.locator(".task-confirm-header > span").evaluate((node) => getComputedStyle(node).display), "none");
  assert.equal(Math.round((await rebaseDialog.getByRole("button", { name: "执行变基计划", exact: true }).boundingBox())?.height || 0), 28);
  await rebaseDialog.getByLabel("提交 2 的动作").selectOption("fixup");
  await rebaseDialog.getByLabel("提交 3 的动作").selectOption("reword");
  await rebaseDialog.getByLabel("提交 3 的信息").fill("浏览器改写提交");
  await performAction(() => rebaseDialog.getByRole("button", { name: "执行变基计划", exact: true }).click());
  await rebaseDialog.waitFor({ state: "detached" });
  await waitMessage(/交互式变基完成/);
  await page.getByRole("button", { name: /浏览器改写提交/ }).waitFor();

  // 创建独立工作树，打开它后 URL 带根路径；浏览器后退回到工作树列表。
  await tab("工作树").click();
  await page.getByRole("button", { name: "新建工作树", exact: true }).click();
  const worktreeDialog = dialog("新建手动工作树");
  await worktreeDialog.getByText("新分支名").locator("..").getByRole("textbox").fill("browser/manual-worktree");
  await submitDialog("新建手动工作树");
  const worktreeRow = page.locator(".gwb-worktree-card", { hasText: "browser/manual-worktree" });
  await worktreeRow.waitFor();
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, "worktree-real-data.png") });
  await worktreeRow.getByRole("button", { name: "打开工作树", exact: true }).click();
  await until(async () => new URL(page.url()).searchParams.has("gitRoot"), "工作树路径写入 URL");
  const openedRoot = new URL(page.url()).searchParams.get("gitRoot");
  assert(openedRoot && openedRoot !== info.root, "打开工作树必须切换根路径");
  assert.equal(new URL(page.url()).searchParams.has("gitTask"), false, "切换工作树清除返回任务");
  await page.goBack();
  await page.getByRole("heading", { name: "工作树" }).waitFor();

  // 移动布局保持单列可操作，临时截图随测试结束清理。
  await page.setViewportSize({ width: 390, height: 844 });
  await tab("变更").click();
  await page.getByRole("region", { name: "工作区变更" }).waitFor();
  const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert(bodyWidth <= 390, `移动布局横向溢出：${bodyWidth}px`);
  const mobileHeader = await page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
    };
    return { repo: box(".repo-name"), sync: box(".gwb-sync") };
  });
  assert(mobileHeader.repo && mobileHeader.sync);
  assert(
    mobileHeader.repo.right <= mobileHeader.sync.left ||
      mobileHeader.repo.bottom <= mobileHeader.sync.top ||
      mobileHeader.sync.bottom <= mobileHeader.repo.top,
    "mobile repository selector and sync controls must not overlap",
  );
  if (!screenshotDirectory) screenshotDirectory = await mkdtemp(join(tmpdir(), "ash-git-workbench-browser-"));
  await page.screenshot({ path: join(screenshotDirectory, "mobile.png"), fullPage: true });

  assert.deepEqual(browserErrors, [], `浏览器控制台错误：\n${browserErrors.join("\n")}`);
  assert.deepEqual(requestFailures, [], `失败请求：\n${requestFailures.join("\n")}`);
  console.log("Git workbench browser test passed");
} catch (error) {
  const diagnostics = backend.diagnostics();
  throw new Error(`${error instanceof Error ? error.stack || error.message : String(error)}\nactions:\n${JSON.stringify(actionResults, null, 2)}\nbackend stderr:\n${diagnostics.stderr}\nbackend stdout:\n${diagnostics.stdout}`);
} finally {
  await browser?.close();
  await vite?.close();
  await backend.close();
  if (screenshotDirectory && !persistentScreenshots)
    rmSync(screenshotDirectory, { recursive: true, force: true });
  if (backendDirectory) {
    assert.equal(
      existsSync(backendDirectory),
      false,
      `Git workbench fixture did not clean up ${backendDirectory}`,
    );
  }
}
