import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
        } catch { /* wait for readiness */ }
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
    "user.name=Conflict Errors",
    "-c",
    "user.email=conflict-errors@example.test",
    ...args,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const backend = startBackend();
let vite;
let browser;
let page;
let backendDirectory;
const actionKinds = [];
const browserErrors = [];
const requestFailures = [];

const tab = (name) =>
  page
    .getByRole("navigation", { name: "Git 工作台视图" })
    .getByRole("button", { name: new RegExp(`^${name}`) });
const dialog = (name) => page.getByRole("dialog", { name });
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
const refresh = async () => {
  const pending = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    /\/git\/workbench$/.test(new URL(response.url()).pathname));
  void pending.catch(() => undefined);
  await page.getByLabel("刷新 Git 工作台").click();
  assert.equal((await pending).ok(), true);
};
const assertConflictDiagnostic = (message, label) => {
  assert.match(message, /CONFLICT \(content\): Merge conflict in conflict\.txt/, label);
  assert.doesNotMatch(message, /^hint:/m, `${label} should hide Git CLI hints`);
  assert.doesNotMatch(message, /git (rebase|cherry-pick|revert) --(continue|skip|abort)/, label);
};
const assertNoStatusCliGuidance = (message, label) => {
  assert.doesNotMatch(message, /^hint:/m, `${label} should hide Git CLI hints`);
  assert.doesNotMatch(
    message,
    /\([^)]*\bgit (?:restore|add|commit)\b[^)]*\)/i,
    `${label} should hide parenthesized Git status commands`,
  );
};
const emptyCherryPickMessage =
  "当前拣选没有可提交的改动。请选择「跳过」处理后续提交，或「中止操作」恢复操作前状态。";
const emptyRevertMessage =
  "当前反做没有可提交的改动。请选择「跳过」处理后续提交，或「中止操作」恢复操作前状态。";
const directEmptyRevertMessage =
  "本次反做未完成：没有产生可提交的改动，未创建新提交。目标改动可能已经撤销，当前没有待处理的 Git 操作。";
const assertEmptyCherryPickGuidance = (message, label) => {
  assert.match(message, new RegExp(emptyCherryPickMessage), `${label} should explain the empty pick`);
  assert.doesNotMatch(message, /CONFLICT \(/, `${label} should not invent a file conflict`);
  assert.doesNotMatch(message, /allow-empty/i, `${label} should hide unsupported allow-empty advice`);
  assert.doesNotMatch(
    message,
    /git (?:cherry-pick|commit)\s+--(?:continue|skip|abort|allow-empty)/i,
    `${label} should hide sequencer CLI commands`,
  );
  assertNoStatusCliGuidance(message, label);
};
const assertDirectEmptyRevertGuidance = (message, label) => {
  assert.equal(
    message.includes(directEmptyRevertMessage),
    true,
    `${label} should explain the direct empty revert`,
  );
  assert.doesNotMatch(message, /跳过/, `${label} should not suggest skip without an operation`);
  assert.doesNotMatch(message, /git revert --/i, `${label} should hide revert CLI commands`);
  assertNoStatusCliGuidance(message, label);
};
const assertDiscardGuidance = (message, label) => {
  assert.match(message, /incoming\.txt/, `${label} should name the blocking file`);
  assert.match(
    message,
    /复制[\s\S]*需要保留的未提交内容/,
    `${label} should suggest copying uncommitted content`,
  );
  assert.match(
    message,
    /变更视图暂存该文件[\s\S]*重试「放弃冲突改动」/,
    `${label} should explain the discard retry route`,
  );
  assert.match(message, /这些内容会被丢弃/, `${label} should warn about data loss`);
  assert.match(message, /解决并暂存[\s\S]*提交/, `${label} should explain the commit route`);
};

try {
  const info = await backend.ready;
  backendDirectory = info.directory;
  git(info.root, "config", "core.autocrlf", "false");
  git(info.root, "reset", "--hard", "HEAD");
  git(info.root, "clean", "-fd");

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
    ) actionKinds.push(request.postDataJSON()?.action?.kind || "unknown");
  });

  const url = new URL(`http://127.0.0.1:${address.port}/scripts/fixtures/git-workbench.html`);
  url.searchParams.set("project", info.projectId);
  url.searchParams.set("view", "git");
  url.searchParams.set("gitView", "branches");
  url.searchParams.set("gitRoot", info.root);
  await page.goto(url.href);
  await page.getByRole("heading", { name: /Git 工作台/ }).waitFor();

  // 真实 UI rebase 冲突保留 stdout 的文件诊断，隐藏命令行 hint，并原样写入日志。
  const conflictBranch = page.locator(".gwb-ref-row", { hasText: "feature/conflict" });
  await conflictBranch.getByLabel("feature/conflict 分支操作").selectOption("rebase");
  const rebaseDialog = dialog("变基到 feature/conflict");
  const rebaseFailure = await performAction(
    () => rebaseDialog.getByRole("button", { name: "变基到 feature/conflict", exact: true }).click(),
    false,
  );
  const rebaseMessage = String(rebaseFailure?.error || "");
  assertConflictDiagnostic(rebaseMessage, "rebase response");
  assert.match(rebaseMessage, /error: could not apply/);
  assertConflictDiagnostic(await page.locator(".gwb-result").innerText(), "rebase page result");
  await rebaseDialog.getByRole("button", { name: "关闭变基到 feature/conflict" }).click();
  assert.equal(
    await page.getByRole("button", { name: "放弃冲突改动", exact: true }).count(),
    0,
    "rebase must only use continue, skip, or abort",
  );
  await tab("操作日志").click();
  const rebaseLog = page.locator(".gwb-journal-entry.is-conflict").first();
  await rebaseLog.waitFor();
  assertConflictDiagnostic(await rebaseLog.innerText(), "rebase journal");
  await page.getByRole("button", { name: "中止操作", exact: true }).click();
  await submitDialog("中止 Git 操作");
  await page.locator(".gwb-operation").waitFor({ state: "detached" });

  // 拣选当前 HEAD 会留下无文件冲突的空序列；页面应指向跳过或中止，而不是 CLI。
  const cherryPickHead = git(info.root, "rev-parse", "HEAD");
  const triggerEmptyCherryPick = async () => {
    await tab("历史").click();
    await page.getByRole("button", { name: /历史提交 3/ }).click();
    await page.getByLabel("提交操作").selectOption("cherry-pick");
    const pickDialog = dialog("拣选提交到当前分支");
    const failure = await performAction(
      () => pickDialog.getByRole("button", { name: "拣选提交到当前分支", exact: true }).click(),
      false,
    );
    const message = String(failure?.error || "");
    assertEmptyCherryPickGuidance(message, "empty cherry-pick response");
    assertEmptyCherryPickGuidance(
      await page.locator(".gwb-result").innerText(),
      "empty cherry-pick page result",
    );
    await pickDialog.getByRole("button", { name: "关闭拣选提交到当前分支" }).click();
    assert.equal(git(info.root, "rev-parse", "--verify", "CHERRY_PICK_HEAD"), cherryPickHead);
    assert.equal(git(info.root, "status", "--porcelain"), "");
    const operation = page.locator(".gwb-operation");
    assert.match(await operation.innerText(), /cherry-pick 尚未完成[\s\S]*没有可提交的改动/);
    assert.match(await operation.innerText(), new RegExp(emptyCherryPickMessage));
    const continueButton = operation.getByRole("button", { name: "继续操作", exact: true });
    if (await continueButton.count())
      assert.equal(await continueButton.isDisabled(), true, "empty cherry-pick continue must be disabled");
    const skipButton = operation.getByRole("button", { name: "跳过", exact: true });
    assert.equal(await skipButton.isEnabled(), true, "empty cherry-pick skip must be enabled");
    assert.equal(
      await skipButton.evaluate((button) => button.classList.contains("gwb-primary")),
      true,
      "empty cherry-pick skip must be the primary action",
    );
    return { operation, skipButton };
  };

  let emptyPick = await triggerEmptyCherryPick();
  await refresh();
  assert.match(await emptyPick.operation.innerText(), new RegExp(emptyCherryPickMessage));
  await tab("变更").click();
  const emptyPickChanges = await page.getByRole("region", { name: "工作区变更" }).innerText();
  assert.match(emptyPickChanges, /当前拣选没有可提交的改动 · 请在上方跳过或中止/);
  assert.doesNotMatch(emptyPickChanges, /继续/);
  await tab("操作日志").click();
  const emptyPickLog = page.locator(".gwb-journal-entry.is-conflict", { hasText: "拣选" }).first();
  await emptyPickLog.waitFor();
  assertEmptyCherryPickGuidance(await emptyPickLog.innerText(), "empty cherry-pick journal");
  await emptyPick.skipButton.click();
  await submitDialog("跳过当前提交");
  await page.locator(".gwb-operation").waitFor({ state: "detached" });
  assert.equal(git(info.root, "rev-parse", "HEAD"), cherryPickHead);
  assert.equal(git(info.root, "status", "--porcelain"), "");

  // 反做冲突选择整份采用我方后会变为空序列；跳过是唯一主路径，中止也应可恢复。
  writeFileSync(join(info.root, "conflict.txt"), "browser revert target\n");
  git(info.root, "add", "--", "conflict.txt");
  git(info.root, "commit", "-qm", "browser revert target");
  const revertTarget = git(info.root, "rev-parse", "HEAD");
  writeFileSync(join(info.root, "conflict.txt"), "browser revert later\n");
  git(info.root, "add", "--", "conflict.txt");
  git(info.root, "commit", "-qm", "browser revert later");
  const revertHead = git(info.root, "rev-parse", "HEAD");
  await refresh();

  const triggerEmptyRevert = async () => {
    await tab("历史").click();
    await page.locator(".gwb-commit-row", { hasText: "browser revert target" }).click();
    await page.getByLabel("提交操作").selectOption("revert");
    const revertDialog = dialog("反做此提交");
    const failure = await performAction(
      () => revertDialog.getByRole("button", { name: "反做此提交", exact: true }).click(),
      false,
    );
    assertConflictDiagnostic(String(failure?.error || ""), "revert conflict response");
    await revertDialog.getByRole("button", { name: "关闭反做此提交" }).click();
    await page.getByRole("button", { name: /conflict\.txt/ }).click();
    const conflictDialog = dialog(/解决冲突/);
    await conflictDialog.getByRole("button", { name: "整份采用我方", exact: true }).click();
    await performAction(() =>
      conflictDialog.getByRole("button", { name: "保存结果并暂存", exact: true }).click());
    await conflictDialog.waitFor({ state: "detached" });
    assert.equal(git(info.root, "rev-parse", "--verify", "REVERT_HEAD"), revertTarget);
    assert.equal(git(info.root, "status", "--porcelain"), "");
    const operation = page.locator(".gwb-operation");
    assert.match(await operation.innerText(), /revert 尚未完成[\s\S]*没有可提交的改动/);
    assert.match(await operation.innerText(), new RegExp(emptyRevertMessage));
    assert.equal(
      await operation.getByRole("button", { name: "继续操作", exact: true }).count(),
      0,
      "empty revert must hide continue",
    );
    const skipButton = operation.getByRole("button", { name: "跳过", exact: true });
    assert.equal(await skipButton.isEnabled(), true, "empty revert skip must be enabled");
    assert.equal(
      await skipButton.evaluate((button) => button.classList.contains("gwb-primary")),
      true,
      "empty revert skip must be the primary action",
    );
    return { operation, skipButton };
  };

  let emptyRevert = await triggerEmptyRevert();
  await refresh();
  assert.match(await emptyRevert.operation.innerText(), new RegExp(emptyRevertMessage));
  await tab("变更").click();
  const emptyRevertChanges = await page.getByRole("region", { name: "工作区变更" }).innerText();
  assert.match(emptyRevertChanges, /当前反做没有可提交的改动 · 请在上方跳过或中止/);
  assert.doesNotMatch(emptyRevertChanges, /继续/);
  await emptyRevert.skipButton.click();
  await submitDialog("跳过当前提交");
  await page.locator(".gwb-operation").waitFor({ state: "detached" });
  assert.equal(git(info.root, "rev-parse", "HEAD"), revertHead);
  assert.equal(git(info.root, "status", "--porcelain"), "");

  emptyRevert = await triggerEmptyRevert();
  await refresh();
  await emptyRevert.operation.getByRole("button", { name: "中止操作", exact: true }).click();
  await submitDialog("中止 Git 操作");
  await page.locator(".gwb-operation").waitFor({ state: "detached" });
  assert.equal(git(info.root, "rev-parse", "HEAD"), revertHead);
  assert.equal(git(info.root, "status", "--porcelain"), "");

  // 直接反做已被后续提交手动撤销的内容不会创建 operation，应明确失败而不建议跳过。
  writeFileSync(join(info.root, "direct-empty-revert.txt"), "added then manually removed\n");
  git(info.root, "add", "--", "direct-empty-revert.txt");
  git(info.root, "commit", "-qm", "browser direct empty revert target");
  const directRevertTarget = git(info.root, "rev-parse", "HEAD");
  git(info.root, "rm", "-q", "--", "direct-empty-revert.txt");
  git(info.root, "commit", "-qm", "browser manually undo revert target");
  const directRevertHead = git(info.root, "rev-parse", "HEAD");
  await refresh();
  await tab("历史").click();
  await page.locator(".gwb-commit-row", { hasText: "browser direct empty revert target" }).click();
  await page.getByLabel("提交操作").selectOption("revert");
  const directRevertDialog = dialog("反做此提交");
  const directRevertFailure = await performAction(
    () => directRevertDialog.getByRole("button", { name: "反做此提交", exact: true }).click(),
    false,
  );
  const directRevertMessage = String(directRevertFailure?.error || "");
  assertDirectEmptyRevertGuidance(directRevertMessage, "direct empty revert response");
  assertDirectEmptyRevertGuidance(
    await page.locator(".gwb-result").innerText(),
    "direct empty revert page result",
  );
  await directRevertDialog.getByRole("button", { name: "关闭反做此提交" }).click();
  assert.equal(await page.locator(".gwb-operation").count(), 0);
  assert.throws(() => git(info.root, "rev-parse", "--verify", "REVERT_HEAD"));
  assert.equal(git(info.root, "rev-parse", "HEAD"), directRevertHead);
  assert.equal(git(info.root, "status", "--porcelain"), "");
  await tab("操作日志").click();
  const directRevertLog = page.locator(".gwb-journal-entry.is-failed", { hasText: "反做" }).first();
  await directRevertLog.waitFor();
  assertDirectEmptyRevertGuidance(await directRevertLog.innerText(), "direct empty revert journal");
  assert.equal(git(info.root, "cat-file", "-e", `${directRevertTarget}^{commit}`), "");

  // 同一持久状态也必须能从页面中止，覆盖两条有效出口。
  emptyPick = await triggerEmptyCherryPick();
  await refresh();
  await emptyPick.operation.getByRole("button", { name: "中止操作", exact: true }).click();
  await submitDialog("中止 Git 操作");
  await page.locator(".gwb-operation").waitFor({ state: "detached" });
  assert.equal(git(info.root, "rev-parse", "HEAD"), directRevertHead);
  assert.equal(git(info.root, "status", "--porcelain"), "");

  // squash 合入新增文件后再改成 AM，安全放弃应失败且完整保留现场。
  git(info.root, "checkout", "-qb", "browser/squash-am");
  writeFileSync(join(info.root, "conflict.txt"), "squash side\n");
  writeFileSync(join(info.root, "incoming.txt"), "incoming from side\n");
  git(info.root, "add", "--", "conflict.txt", "incoming.txt");
  git(info.root, "commit", "-qm", "squash side with incoming file");
  git(info.root, "checkout", "-q", "main");
  writeFileSync(join(info.root, "conflict.txt"), "squash main\n");
  git(info.root, "add", "--", "conflict.txt");
  git(info.root, "commit", "-qm", "squash main conflict");
  await refresh();
  await tab("分支").click();
  const squashBranch = page.locator(".gwb-ref-row", { hasText: "browser/squash-am" });
  await squashBranch.getByLabel("browser/squash-am 分支操作").selectOption("merge");
  const squashDialog = dialog("合并 browser/squash-am");
  await squashDialog.locator("select").selectOption("squash");
  const squashFailure = await performAction(
    () => squashDialog.getByRole("button", { name: "合并 browser/squash-am", exact: true }).click(),
    false,
  );
  assertConflictDiagnostic(String(squashFailure?.error || ""), "squash response");
  await squashDialog.getByRole("button", { name: "关闭合并 browser/squash-am" }).click();
  writeFileSync(join(info.root, "incoming.txt"), "edited after squash conflict\n");
  await refresh();
  const before = {
    head: git(info.root, "rev-parse", "HEAD"),
    status: git(info.root, "status", "--porcelain"),
    conflict: readFileSync(join(info.root, "conflict.txt"), "utf8"),
    incoming: readFileSync(join(info.root, "incoming.txt"), "utf8"),
    incomingIndex: git(info.root, "show", ":incoming.txt"),
  };
  assert.match(before.status, /^UU conflict\.txt$/m);
  assert.match(before.status, /^AM incoming\.txt$/m);

  const discard = page.getByRole("button", { name: "放弃冲突改动", exact: true });
  await discard.click();
  let discardDialog = dialog("放弃冲突改动");
  await discardDialog.getByLabel("输入目标以确认").fill("放弃冲突改动");
  const discardFailure = await performAction(
    () => discardDialog.getByRole("button", { name: "放弃冲突改动", exact: true }).click(),
    false,
  );
  const discardMessage = String(discardFailure?.error || "");
  assert.match(discardMessage, /Entry 'incoming\.txt' not uptodate/);
  assertDiscardGuidance(discardMessage, "discard response");
  assertDiscardGuidance(await page.locator(".gwb-result").innerText(), "discard page result");
  await discardDialog.getByRole("button", { name: "关闭放弃冲突改动" }).click();
  assert.deepEqual(
    {
      head: git(info.root, "rev-parse", "HEAD"),
      status: git(info.root, "status", "--porcelain"),
      conflict: readFileSync(join(info.root, "conflict.txt"), "utf8"),
      incoming: readFileSync(join(info.root, "incoming.txt"), "utf8"),
      incomingIndex: git(info.root, "show", ":incoming.txt"),
    },
    before,
    "failed discard must preserve HEAD, index, and files",
  );
  await tab("操作日志").click();
  const discardLog = page.locator(".gwb-journal-entry.is-failed").first();
  await discardLog.waitFor();
  assertDiscardGuidance(await discardLog.innerText(), "discard journal");

  // 按失败指引在变更视图暂存拦截文件，再从冲突面板重试安全放弃。
  await tab("变更").click();
  const stageIncoming = page.getByRole("button", { name: "暂存 incoming.txt", exact: true });
  await stageIncoming.waitFor();
  await performAction(() => stageIncoming.click());
  assert.equal(
    git(info.root, "show", ":incoming.txt"),
    "edited after squash conflict",
    "UI stage should preserve the edited incoming file in the index before discard",
  );
  await page.getByRole("button", { name: "放弃冲突改动", exact: true }).click();
  discardDialog = dialog("放弃冲突改动");
  await discardDialog.getByLabel("输入目标以确认").fill("放弃冲突改动");
  await submitDialog("放弃冲突改动");
  await page.locator(".gwb-operation").waitFor({ state: "detached" });
  assert.equal(git(info.root, "rev-parse", "HEAD"), before.head);
  assert.equal(git(info.root, "status", "--porcelain"), "");
  assert.equal(existsSync(join(info.root, "incoming.txt")), false);
  assert.equal(readFileSync(join(info.root, "conflict.txt"), "utf8"), "squash main\n");

  // stash apply 冲突保留文件诊断和中文页面指引，但隐藏 Git status 的括号命令。
  writeFileSync(join(info.root, "conflict.txt"), "stash apply version\n");
  await refresh();
  await tab("贮藏").click();
  await page.getByRole("button", { name: "贮藏改动", exact: true }).click();
  await dialog("贮藏当前改动").getByRole("textbox").fill("status hints apply stash");
  await submitDialog("贮藏当前改动");
  writeFileSync(join(info.root, "conflict.txt"), "committed against stash apply\n");
  git(info.root, "add", "--", "conflict.txt");
  git(info.root, "commit", "-qm", "conflict against stash apply");
  await refresh();
  const applyStash = page.locator(".gwb-ref-row", { hasText: "status hints apply stash" });
  await applyStash.getByRole("button", { name: "应用", exact: true }).click();
  const applyDialog = dialog("应用贮藏");
  const applyFailure = await performAction(
    () => applyDialog.getByRole("button", { name: "应用贮藏", exact: true }).click(),
    false,
  );
  const applyMessage = String(applyFailure?.error || "");
  assertConflictDiagnostic(applyMessage, "stash apply response");
  assertNoStatusCliGuidance(applyMessage, "stash apply response");
  const applyPageResult = await page.locator(".gwb-result").innerText();
  assertConflictDiagnostic(applyPageResult, "stash apply page result");
  assertNoStatusCliGuidance(applyPageResult, "stash apply page result");
  await applyDialog.getByRole("button", { name: "关闭应用贮藏" }).click();
  await tab("操作日志").click();
  const applyLog = page.locator(".gwb-journal-entry.is-conflict", { hasText: "应用贮藏" }).first();
  await applyLog.waitFor();
  assertNoStatusCliGuidance(await applyLog.innerText(), "stash apply journal");
  await page.getByRole("button", { name: "放弃冲突改动", exact: true }).click();
  discardDialog = dialog("放弃冲突改动");
  await discardDialog.getByLabel("输入目标以确认").fill("放弃冲突改动");
  await submitDialog("放弃冲突改动");
  await page.locator(".gwb-operation").waitFor({ state: "detached" });
  assert.equal(git(info.root, "status", "--porcelain"), "");
  assert.deepEqual(
    actionKinds,
    [
      "rebase", "abort",
      "cherry-pick", "skip",
      "revert", "resolve", "skip", "revert", "resolve", "abort", "revert",
      "cherry-pick", "abort",
      "merge", "discard-conflicts", "stage", "discard-conflicts",
      "stash-save", "stash-apply", "discard-conflicts",
    ],
  );
  assert.deepEqual(browserErrors, [], `browser errors:\n${browserErrors.join("\n")}`);
  assert.deepEqual(requestFailures, [], `failed requests:\n${requestFailures.join("\n")}`);
  console.log("Git workbench conflict error browser test passed");
} catch (error) {
  const diagnostics = backend.diagnostics();
  throw new Error(
    `${error instanceof Error ? error.stack || error.message : String(error)}\nactions: ${JSON.stringify(actionKinds)}\nbackend stderr:\n${diagnostics.stderr}\nbackend stdout:\n${diagnostics.stdout}`,
  );
} finally {
  await browser?.close();
  await vite?.close();
  await backend.close();
  if (backendDirectory)
    assert.equal(existsSync(backendDirectory), false, `fixture did not clean up ${backendDirectory}`);
}
