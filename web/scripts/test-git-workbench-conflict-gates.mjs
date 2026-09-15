import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = join(repo, "server/scripts/fixtures/git-workbench-server.ts");

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
        } catch { /* wait for the readiness JSON */ }
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      fail(`Fixture exited before readiness (${code ?? signal})`));
    setTimeout(() => fail("Fixture did not become ready"), 15_000).unref();
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    if (child.connected) {
      child.send({ type: "close" }, (error) => {
        if (error && child.exitCode === null) child.kill("SIGTERM");
      });
    } else child.kill("SIGTERM");
    const didExit = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!didExit && child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  };
  return { ready, close, diagnostics: () => ({ stdout, stderr }) };
}

const git = (root, ...args) =>
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Conflict Gate",
    "-c",
    "user.email=conflict-gate@example.test",
    ...args,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const mergeConflict = (root) => {
  const result = spawnSync(
    "git",
    ["-C", root, "merge", "--no-edit", "feature/conflict"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "fixture merge should produce a conflict");
};
const abortMerge = (root) =>
  spawnSync("git", ["-C", root, "merge", "--abort"], { stdio: "ignore" });

const backend = startBackend();
let vite;
let browser;
let page;
let backendDirectory;
const actionPosts = [];
const browserErrors = [];
const requestFailures = [];

const tab = (name) =>
  page
    .getByRole("navigation", { name: "Git 工作台视图" })
    .getByRole("button", { name: new RegExp(`^${name}`) });
const dialog = (name) => page.getByRole("dialog", { name });
const expectDisabled = async (locator, label) => {
  await locator.waitFor();
  assert.equal(await locator.isDisabled(), true, `${label} should be disabled`);
};
const expectEnabled = async (locator, label) => {
  await locator.waitFor();
  assert.equal(await locator.isEnabled(), true, `${label} should be enabled`);
};
const expectAllDisabled = async (locator, label) => {
  const count = await locator.count();
  assert(count > 0, `${label} should exist`);
  for (let index = 0; index < count; index += 1)
    await expectDisabled(locator.nth(index), `${label} ${index + 1}`);
};
const performAction = async (trigger, expectedOk = true) => {
  let received = false;
  const action = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/git\/workbench\/actions$/.test(new URL(response.url()).pathname));
  const state = page.waitForResponse((response) =>
    received && response.request().method() === "GET" &&
    /\/git\/workbench$/.test(new URL(response.url()).pathname));
  void action.catch(() => undefined);
  void state.catch(() => undefined);
  await trigger();
  const response = await action;
  received = true;
  const body = await response.json().catch(() => null);
  assert.equal(
    response.ok(),
    expectedOk,
    `action HTTP ${response.status()}: ${JSON.stringify(body)}`,
  );
  await state;
  await page.getByLabel("选择工作树").waitFor({ state: "visible" });
  return body;
};
const submitDialog = async (title) => {
  const box = dialog(title);
  await performAction(() =>
    box.getByRole("button", { name: title, exact: true }).click());
  await box.waitFor({ state: "detached" });
};
const refresh = async (throughDialog = false) => {
  const pending = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    /\/git\/workbench$/.test(new URL(response.url()).pathname));
  void pending.catch(() => undefined);
  const button = page.getByLabel("刷新 Git 工作台");
  if (throughDialog) await button.evaluate((element) => element.click());
  else await button.click();
  const response = await pending;
  assert.equal(response.ok(), true, `refresh failed with ${response.status()}`);
  await page.getByLabel("选择工作树").waitFor({ state: "visible" });
};
const cleanAfterConflictEdits = (root) => {
  git(root, "restore", "--", "history-1.txt");
  const scratch = join(root, "conflict-scratch.txt");
  if (existsSync(scratch)) unlinkSync(scratch);
};

try {
  const info = await backend.ready;
  backendDirectory = info.directory;
  git(info.root, "config", "core.autocrlf", "false");
  const manualRoot = join(info.directory, "manual-worktree");
  git(
    info.root,
    "worktree",
    "add",
    "-q",
    "-b",
    "browser/gate-worktree",
    manualRoot,
    "feature/clean",
  );

  vite = await createServer({
    root: webRoot,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: { "/api": { target: `http://127.0.0.1:${info.port}` } },
    },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert(address && typeof address === "object", "Vite did not expose a port");
  browser = await chromium.launch(await chromeLaunchOptions());
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:"))
      browserErrors.push(message.text());
  });
  page.on("requestfailed", (request) =>
    requestFailures.push(`${request.method()} ${request.url()} · ${request.failure()?.errorText}`));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/git\/workbench\/actions$/.test(new URL(request.url()).pathname)
    ) actionPosts.push(request.postDataJSON()?.action?.kind || "unknown");
  });

  const url = new URL(`http://127.0.0.1:${address.port}/scripts/fixtures/git-workbench.html`);
  url.searchParams.set("project", info.projectId);
  url.searchParams.set("view", "git");
  url.searchParams.set("gitView", "changes");
  url.searchParams.set("gitRoot", info.root);
  await page.goto(url.href);
  await page.getByRole("heading", { name: /Git 工作台/ }).waitFor();

  // 用真实工作台动作留下自有贮藏和带备份的可撤销日志。
  await tab("贮藏").click();
  await page.getByRole("button", { name: "贮藏改动", exact: true }).click();
  await dialog("贮藏当前改动").getByRole("textbox").fill("conflict gate stash");
  await submitDialog("贮藏当前改动");
  await tab("历史").click();
  await page.getByRole("button", { name: /历史提交 2/ }).click();
  await page.getByLabel("提交操作").selectOption("reset");
  const resetDialog = dialog("重置当前分支");
  await resetDialog.locator("select").selectOption("hard");
  await resetDialog.getByLabel("输入目标以确认").fill("main");
  await submitDialog("重置当前分支");

  // 普通动作弹窗打开后，仓库从外部进入冲突；弹窗必须立刻失效且不能 POST。
  await tab("分支").click();
  await page.getByRole("button", { name: "新建分支", exact: true }).click();
  const staleDialog = dialog("新建分支");
  await staleDialog.getByRole("textbox").fill("must-not-be-created");
  const staleConfirm = staleDialog.getByRole("button", { name: "新建分支", exact: true });
  await expectEnabled(staleConfirm, "clean-state dialog confirmation");
  const externalRefresh = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    /\/git\/workbench$/.test(new URL(response.url()).pathname),
  );
  mergeConflict(info.root);
  await externalRefresh;
  await page.locator(".gwb-operation").waitFor();
  await expectDisabled(staleConfirm, "stale dialog confirmation after conflict");
  const beforeStaleClick = actionPosts.length;
  await staleConfirm.evaluate((element) => element.click());
  assert.equal(actionPosts.length, beforeStaleClick, "blocked stale dialog must not POST");
  await staleDialog.getByRole("button", { name: "关闭新建分支" }).click();

  await tab("变更").click();
  const mergeOnlyChanges = await page.getByRole("region", { name: "工作区变更" }).innerText();
  assert.match(mergeOnlyChanges, /1 个冲突待解决 · 请在上方冲突面板处理/);
  assert.doesNotMatch(mergeOnlyChanges, /所有改动已提交/);
  await expectEnabled(page.getByRole("button", { name: "中止操作", exact: true }), "abort regular merge");
  assert.equal(
    await page.getByRole("button", { name: "放弃冲突改动", exact: true }).count(),
    0,
    "regular merge must keep its abort path instead of discard-conflicts",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <= 390,
    "mobile conflict summary should not overflow horizontally",
  );
  await page.screenshot({
    path: join(info.directory, "conflict-summary-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 960 });

  writeFileSync(join(info.root, "history-1.txt"), "history 1\nconflict gate edit\n");
  writeFileSync(join(info.root, "conflict-scratch.txt"), "untracked during conflict\n");
  await refresh();
  const conflictActionStart = actionPosts.length;

  // 七个视图的导航和只读入口保持可用；服务端会拒绝的写入口全部禁用。
  for (const name of ["变更", "历史", "分支", "贮藏", "标签", "工作树", "操作日志"])
    await expectEnabled(tab(name), `${name} view tab`);
  const sync = page.locator(".gwb-sync");
  for (const name of ["获取", "拉取", "推送"])
    await expectDisabled(sync.getByRole("button", { name, exact: true }), `top ${name}`);
  await expectDisabled(page.getByRole("button", { name: "保护强推…", exact: true }), "force push");

  await tab("变更").click();
  const changedFile = page.getByRole("button", { name: "history-1.txt modified", exact: true });
  await expectEnabled(changedFile, "open file diff");
  await changedFile.click();
  await page.getByLabel("Git 差异").waitFor();
  await expectAllDisabled(page.getByRole("button", { name: /选择改动块/ }), "partial patch line");
  await expectDisabled(page.getByRole("button", { name: "暂存所选改动", exact: true }), "apply partial patch");
  await expectAllDisabled(page.getByRole("button", { name: /^丢弃/ }), "discard controls");
  await expectDisabled(page.getByLabel("提交信息").locator("..").getByRole("button"), "commit");
  const stageFile = page.getByRole("button", { name: "暂存 history-1.txt", exact: true });
  await expectEnabled(stageFile, "stage during conflict");
  await performAction(() => stageFile.click());
  assert.equal(git(info.root, "diff", "--cached", "--name-only", "--", "history-1.txt"), "history-1.txt");
  const unstageFile = page.getByRole("button", { name: "取消暂存 history-1.txt", exact: true });
  await expectEnabled(unstageFile, "unstage during conflict");
  await performAction(() => unstageFile.click());
  assert.equal(git(info.root, "diff", "--cached", "--name-only", "--", "history-1.txt"), "");

  await tab("历史").click();
  await page.getByRole("region", { name: "提交历史" }).waitFor();
  const historyCommit = page.getByRole("button", { name: /历史提交 2/ });
  await expectEnabled(historyCommit, "history commit details");
  await historyCommit.click();
  await page.getByLabel("Git 差异").waitFor();
  await expectDisabled(page.getByLabel("提交操作"), "history action menu");

  await tab("分支").click();
  await expectDisabled(page.getByRole("button", { name: "新建分支", exact: true }), "new branch");
  const cleanBranch = page.locator(".gwb-ref-row", { hasText: "feature/clean" });
  await expectDisabled(cleanBranch.getByRole("button", { name: "切换", exact: true }), "checkout branch");
  await expectAllDisabled(page.getByLabel(/分支操作$/), "branch action menus");
  await expectEnabled(cleanBranch.getByRole("button", { name: "历史", exact: true }), "branch history");
  await cleanBranch.getByRole("button", { name: "历史", exact: true }).click();
  await page.getByRole("region", { name: "提交历史" }).waitFor();
  await tab("分支").click();
  const remotes = page.locator(".gwb-ref-section", { has: page.getByRole("heading", { name: /远端配置/ }) });
  for (const name of ["添加远端", "获取", "修改地址", "移除"])
    await expectAllDisabled(remotes.getByRole("button", { name, exact: true }), `remote ${name}`);

  await tab("贮藏").click();
  await expectDisabled(page.getByRole("button", { name: "贮藏改动", exact: true }), "save stash");
  const stashRow = page.locator(".gwb-ref-row", { hasText: "conflict gate stash" });
  await expectEnabled(stashRow.getByRole("button", { name: "查看差异", exact: true }), "stash diff");
  for (const name of ["应用", "弹出", "删除"])
    await expectDisabled(stashRow.getByRole("button", { name, exact: true }), `stash ${name}`);
  await stashRow.getByRole("button", { name: "查看差异", exact: true }).click();
  await page.getByText(/贮藏差异/).waitFor();
  await page.getByLabel("Git 差异").waitFor();

  await tab("标签").click();
  await expectDisabled(page.getByRole("button", { name: "新建标签", exact: true }), "new tag");
  const tagRow = page.locator(".gwb-ref-row", { hasText: "v0.1" });
  await expectEnabled(tagRow.getByRole("button", { name: "历史", exact: true }), "tag history");
  for (const name of ["推送", "删除"])
    await expectDisabled(tagRow.getByRole("button", { name, exact: true }), `tag ${name}`);
  await expectDisabled(tagRow.getByLabel("删除远端标签 v0.1"), "remote tag delete");
  await tagRow.getByRole("button", { name: "历史", exact: true }).click();
  await page.getByRole("region", { name: "提交历史" }).waitFor();
  await tab("标签").click();

  await tab("工作树").click();
  await expectDisabled(page.getByRole("button", { name: "新建工作树", exact: true }), "new worktree");
  const worktree = page.locator(".gwb-worktree-card", { hasText: "browser/gate-worktree" });
  await expectEnabled(worktree.getByRole("button", { name: "打开工作树", exact: true }), "open worktree");
  await expectDisabled(worktree.getByRole("button", { name: "锁定", exact: true }), "lock worktree");
  await expectDisabled(worktree.getByRole("button", { name: "移除", exact: true }), "remove worktree");

  await tab("操作日志").click();
  const backups = page.getByRole("region", { name: "历史备份" });
  await backups.getByRole("heading", { name: /历史备份 · [1-9]/ }).waitFor();
  await expectDisabled(backups.getByRole("button", { name: "清理变基辅助文件", exact: true }), "cleanup helpers");
  await expectAllDisabled(page.getByRole("button", { name: "恢复为新分支", exact: true }), "restore backup");
  await expectDisabled(backups.getByRole("button", { name: "删除备份", exact: true }).first(), "delete backup");
  await expectAllDisabled(page.getByRole("button", { name: "撤销", exact: true }), "journal undo");
  assert.deepEqual(
    actionPosts.slice(conflictActionStart),
    ["stage", "unstage"],
    "only conflict-safe actions may POST while traversing views",
  );

  // 中止也是白名单动作；结束后各视图的代表性写入口恢复。
  cleanAfterConflictEdits(info.root);
  await refresh();
  await expectEnabled(page.getByRole("button", { name: "中止操作", exact: true }), "abort operation");
  await page.getByRole("button", { name: "中止操作", exact: true }).click();
  await expectEnabled(dialog("中止 Git 操作").getByRole("button", { name: "中止 Git 操作", exact: true }), "abort confirmation");
  await submitDialog("中止 Git 操作");
  await page.locator(".gwb-operation").waitFor({ state: "detached" });
  await expectEnabled(sync.getByRole("button", { name: "获取", exact: true }), "fetch after abort");
  await tab("分支").click();
  await expectEnabled(page.getByRole("button", { name: "新建分支", exact: true }), "branch after abort");
  await tab("贮藏").click();
  await expectEnabled(page.getByRole("button", { name: "贮藏改动", exact: true }), "stash after abort");
  await tab("标签").click();
  await expectEnabled(page.getByRole("button", { name: "新建标签", exact: true }), "tag after abort");
  await tab("工作树").click();
  await expectEnabled(page.getByRole("button", { name: "新建工作树", exact: true }), "worktree after abort");

  // 再造一次冲突，真实保存选边结果并继续合并。
  git(info.root, "reset", "--hard", "HEAD");
  git(info.root, "clean", "-fd");
  await refresh();
  await tab("分支").click();
  const conflictBranch = page.locator(".gwb-ref-row", { hasText: "feature/conflict" });
  await conflictBranch.getByLabel("feature/conflict 分支操作").selectOption("merge");
  const mergeDialog = dialog("合并 feature/conflict");
  const mergeFailure = await performAction(
    () => mergeDialog.getByRole("button", { name: "合并 feature/conflict", exact: true }).click(),
    false,
  );
  assert.match(
    String(mergeFailure?.error || ""),
    /CONFLICT \(content\): Merge conflict in conflict\.txt/,
  );
  assert.doesNotMatch(String(mergeFailure?.error || ""), /Command failed: git -C/);
  assert.match(
    await page.locator(".gwb-result").innerText(),
    /CONFLICT \(content\): Merge conflict in conflict\.txt/,
  );
  await mergeDialog.getByRole("button", { name: "关闭合并 feature/conflict" }).click();
  await page.getByRole("button", { name: /conflict\.txt/ }).click();
  const conflictDialog = dialog(/解决冲突/);
  await expectEnabled(conflictDialog.getByRole("button", { name: "采用我方", exact: true }), "choose conflict side");
  await conflictDialog.getByRole("button", { name: "采用我方", exact: true }).click();
  await expectEnabled(conflictDialog.getByRole("button", { name: "保存结果并暂存", exact: true }), "save conflict result");
  await performAction(() =>
    conflictDialog.getByRole("button", { name: "保存结果并暂存", exact: true }).click());
  await conflictDialog.waitFor({ state: "detached" });
  await tab("变更").click();
  const pendingMergeChanges = await page.getByRole("region", { name: "工作区变更" }).innerText();
  assert.match(pendingMergeChanges, /Git 操作尚未完成 · 请在上方继续或中止/);
  assert.doesNotMatch(pendingMergeChanges, /所有改动已提交/);
  const continueButton = page.getByRole("button", { name: "继续操作", exact: true });
  await expectEnabled(continueButton, "continue after resolving conflicts");
  await performAction(() => continueButton.click());
  await page.locator(".gwb-operation").waitFor({ state: "detached" });
  await expectEnabled(sync.getByRole("button", { name: "获取", exact: true }), "fetch after continue");
  assert.equal(git(info.root, "status", "--porcelain"), "", "continued merge should leave a clean worktree");
  assert.match(
    await page.getByRole("region", { name: "工作区变更" }).innerText(),
    /所有改动已提交/,
  );

  // rebase 冲突里的跳过按钮也走白名单弹窗，确认后真实结束操作。
  git(info.root, "checkout", "-qb", "browser/rebase-target");
  writeFileSync(join(info.root, "conflict.txt"), "rebase target\n");
  git(info.root, "add", "--", "conflict.txt");
  git(info.root, "commit", "-qm", "rebase target change");
  git(info.root, "checkout", "-q", "main");
  writeFileSync(join(info.root, "conflict.txt"), "rebase current\n");
  git(info.root, "add", "--", "conflict.txt");
  git(info.root, "commit", "-qm", "rebase commit to skip");
  const rebase = spawnSync(
    "git",
    ["-C", info.root, "rebase", "browser/rebase-target"],
    { encoding: "utf8" },
  );
  assert.notEqual(rebase.status, 0, "fixture rebase should produce a conflict");
  await refresh();
  const skipButton = page.getByRole("button", { name: "跳过", exact: true });
  await expectEnabled(skipButton, "skip during rebase conflict");
  await skipButton.click();
  await expectEnabled(dialog("跳过当前提交").getByRole("button", { name: "跳过当前提交", exact: true }), "skip confirmation");
  await submitDialog("跳过当前提交");
  await page.locator(".gwb-operation").waitFor({ state: "detached" });
  assert.equal(git(info.root, "status", "--porcelain"), "", "skipped rebase should leave a clean worktree");
  assert.deepEqual(
    actionPosts.slice(conflictActionStart),
    ["stage", "unstage", "abort", "merge", "resolve", "continue", "skip"],
    "conflict periods should only POST allow-list actions after the clean-state merge trigger",
  );

  // stash pop 冲突没有 operation；变更视图仍须指向上方冲突面板，解决并提交后才显示干净。
  writeFileSync(join(info.root, "conflict.txt"), "stash conflict version\n");
  await refresh();
  await tab("贮藏").click();
  await page.getByRole("button", { name: "贮藏改动", exact: true }).click();
  await dialog("贮藏当前改动").getByRole("textbox").fill("wording conflict stash");
  await submitDialog("贮藏当前改动");
  writeFileSync(join(info.root, "conflict.txt"), "committed after stash\n");
  git(info.root, "add", "--", "conflict.txt");
  git(info.root, "commit", "-qm", "conflict against saved stash");
  await refresh();
  const wordingStash = page.locator(".gwb-ref-row", { hasText: "wording conflict stash" });
  await wordingStash.getByRole("button", { name: "弹出", exact: true }).click();
  const popDialog = dialog("弹出贮藏");
  const popFailure = await performAction(
    () => popDialog.getByRole("button", { name: "弹出贮藏", exact: true }).click(),
    false,
  );
  const popMessage = String(popFailure?.error || "");
  assert.match(
    popMessage,
    /CONFLICT \(content\): Merge conflict in conflict\.txt/,
  );
  assert.doesNotMatch(popMessage, /Command failed: git -C/);
  assert.doesNotMatch(
    popMessage,
    /\([^)]*\bgit (?:restore|add|commit)\b[^)]*\)/i,
    "stash pop response should hide parenthesized Git status commands",
  );
  const popPageResult = await page.locator(".gwb-result").innerText();
  assert.match(popPageResult, /CONFLICT \(content\): Merge conflict in conflict\.txt/);
  assert.doesNotMatch(
    popPageResult,
    /\([^)]*\bgit (?:restore|add|commit)\b[^)]*\)/i,
    "stash pop page result should hide parenthesized Git status commands",
  );
  await popDialog.getByRole("button", { name: "关闭弹出贮藏" }).click();
  await page.getByText("还有未解决的冲突", { exact: true }).waitFor();
  await tab("变更").click();
  const stashConflictChanges = await page.getByRole("region", { name: "工作区变更" }).innerText();
  assert.match(stashConflictChanges, /1 个冲突待解决 · 请在上方冲突面板处理/);
  assert.doesNotMatch(stashConflictChanges, /所有改动已提交/);
  await page.getByRole("button", { name: /conflict\.txt/ }).click();
  const stashConflictDialog = dialog(/解决冲突/);
  await stashConflictDialog.getByRole("button", { name: "采用对方", exact: true }).click();
  await performAction(() =>
    stashConflictDialog.getByRole("button", { name: "保存结果并暂存", exact: true }).click());
  await stashConflictDialog.waitFor({ state: "detached" });
  await page.getByLabel("提交信息").fill("commit resolved stash conflict");
  await performAction(() =>
    page.getByRole("button", { name: /提交已暂存/ }).click());
  assert.equal(git(info.root, "status", "--porcelain"), "", "committed stash resolution should be clean");
  assert.match(
    await page.getByRole("region", { name: "工作区变更" }).innerText(),
    /所有改动已提交/,
  );

  // squash merge 冲突没有 MERGE_HEAD，必须提供带打字确认的独立放弃入口。
  git(info.root, "checkout", "-qb", "browser/squash-side");
  writeFileSync(join(info.root, "conflict.txt"), "squash side\n");
  git(info.root, "add", "--", "conflict.txt");
  git(info.root, "commit", "-qm", "squash side conflict");
  git(info.root, "checkout", "-q", "main");
  writeFileSync(join(info.root, "conflict.txt"), "squash main\n");
  git(info.root, "add", "--", "conflict.txt");
  git(info.root, "commit", "-qm", "squash main conflict");
  await refresh();
  await tab("分支").click();
  const squashBranch = page.locator(".gwb-ref-row", { hasText: "browser/squash-side" });
  await squashBranch.getByLabel("browser/squash-side 分支操作").selectOption("merge");
  const squashDialog = dialog("合并 browser/squash-side");
  await squashDialog.locator("select").selectOption("squash");
  const squashFailure = await performAction(
    () => squashDialog.getByRole("button", { name: "合并 browser/squash-side", exact: true }).click(),
    false,
  );
  assert.match(
    String(squashFailure?.error || ""),
    /CONFLICT \(content\): Merge conflict in conflict\.txt/,
  );
  assert.doesNotMatch(String(squashFailure?.error || ""), /Command failed: git -C/);
  assert.match(
    await page.locator(".gwb-result").innerText(),
    /CONFLICT \(content\): Merge conflict in conflict\.txt/,
  );
  await squashDialog.getByRole("button", { name: "关闭合并 browser/squash-side" }).click();
  await page.getByText("还有未解决的冲突", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "中止操作", exact: true }).count(),
    0,
    "squash conflict must not offer merge --abort",
  );
  const discardConflicts = page.getByRole("button", { name: "放弃冲突改动", exact: true });
  await expectEnabled(discardConflicts, "discard squash conflict");
  assert.doesNotMatch(await page.locator(".gwb-operation").innerText(), /贮藏等操作/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <= 390,
    "mobile squash conflict actions should not overflow horizontally",
  );
  await page.screenshot({
    path: join(info.directory, "squash-conflict-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await discardConflicts.click();
  let discardDialog = dialog("放弃冲突改动");
  let discardConfirm = discardDialog.getByRole("button", { name: "放弃冲突改动", exact: true });
  await expectDisabled(discardConfirm, "discard confirmation before typed phrase");
  await discardDialog.getByLabel("输入目标以确认").fill("错误确认");
  await expectDisabled(discardConfirm, "discard confirmation with wrong phrase");
  await discardDialog.getByRole("button", { name: "取消", exact: true }).click();
  await discardDialog.waitFor({ state: "detached" });
  await page.getByText("还有未解决的冲突", { exact: true }).waitFor();
  assert.match(git(info.root, "status", "--porcelain"), /^UU conflict\.txt$/m);
  await discardConflicts.click();
  discardDialog = dialog("放弃冲突改动");
  discardConfirm = discardDialog.getByRole("button", { name: "放弃冲突改动", exact: true });
  await discardDialog.getByLabel("输入目标以确认").fill("放弃冲突改动");
  await expectEnabled(discardConfirm, "discard confirmation with exact phrase");
  await performAction(() => discardConfirm.click());
  await discardDialog.waitFor({ state: "detached" });
  await page.locator(".gwb-operation").waitFor({ state: "detached" });
  assert.equal(git(info.root, "status", "--porcelain"), "", "discarded squash conflict should be clean");
  await tab("分支").click();
  await expectEnabled(page.getByRole("button", { name: "新建分支", exact: true }), "normal actions after discard");
  assert.notEqual(
    spawnSync("git", ["-C", info.root, "show-ref", "--verify", "refs/heads/must-not-be-created"]).status,
    0,
    "stale dialog branch must not be created",
  );
  assert.deepEqual(browserErrors, [], `browser errors:\n${browserErrors.join("\n")}`);
  assert.deepEqual(requestFailures, [], `failed requests:\n${requestFailures.join("\n")}`);
  console.log("Git workbench conflict gate browser test passed");
} catch (error) {
  const diagnostics = backend.diagnostics();
  throw new Error(
    `${error instanceof Error ? error.stack || error.message : String(error)}\naction POSTs: ${JSON.stringify(actionPosts)}\nbackend stderr:\n${diagnostics.stderr}\nbackend stdout:\n${diagnostics.stdout}`,
  );
} finally {
  if (backendDirectory) abortMerge((await backend.ready).root);
  await browser?.close();
  await vite?.close();
  await backend.close();
  if (backendDirectory)
    assert.equal(existsSync(backendDirectory), false, `fixture did not clean up ${backendDirectory}`);
}
