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
  assert.deepEqual(
    actionKinds,
    ["rebase", "abort", "merge", "discard-conflicts", "stage", "discard-conflicts"],
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
