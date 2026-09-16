import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
const output = process.env.GIT_WORKBENCH_BUSY_DISCARD_OUTPUT
  || join(tmpdir(), "harness-git-workbench-busy-discard");

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
          if (value?.port && value?.root && value?.projectId) {
            clearTimeout(timer);
            resolve(value);
            return;
          }
        } catch { /* wait for readiness JSON */ }
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
  return { ready, close, diagnostics: () => ({ stdout, stderr }) };
}

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
]);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const diffIndex = async locator => {
  const label = await locator.getAttribute("aria-label");
  const index = Number(/选择第 (\d+) 行/.exec(label || "")?.[1]) - 1;
  assert(Number.isInteger(index) && index >= 0, `diff row must expose its index: ${label}`);
  return index;
};

const backend = startBackend();
let browser;
let vite;
let fixtureDirectory;
let passed = false;
try {
  const info = await backend.ready;
  fixtureDirectory = info.directory;
  const gitOptions = {
    cwd: info.root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(info.directory, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    },
  };
  const git = (...args) => execFileSync("git", args, gitOptions).trim();
  const write = (path, value) => writeFileSync(join(info.root, path), value);
  write("slow.txt", "slow base\n");
  write("read.txt", "read base\n");
  write("discard-success.txt", "success base\n");
  write("discard-race.txt", "race base\n");
  git("add", "--", "slow.txt", "read.txt", "discard-success.txt", "discard-race.txt");
  git("commit", "-qm", "add busy and discard fixtures");
  write("slow.txt", "slow changed\n");
  write("read.txt", "read base\nREAD-CHANGED\n");
  write("discard-success.txt", "success base\nSUCCESS-CHANGED\nSUCCESS-FAST\nSUCCESS-KEEP\n");
  write("discard-race.txt", "race base\nRACE-ONE\n");

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
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });

  let slowAction = null;
  let readDiff = null;
  let failNextAction = false;
  let holdSuccessfulDiscardDiff = null;
  await page.route("**/git/workbench/actions", async route => {
    if (failNextAction) {
      failNextAction = false;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced discard failure" }),
      });
      return;
    }
    if (!slowAction) {
      await route.continue();
      return;
    }
    const control = slowAction;
    slowAction = null;
    control.started.resolve();
    await control.release.promise;
    await route.continue();
  });
  await page.route("**/git/workbench/diff?**", async route => {
    const requestUrl = new URL(route.request().url());
    if (
      requestUrl.searchParams.get("path") === "discard-success.txt"
      && holdSuccessfulDiscardDiff
    ) {
      const response = await route.fetch();
      const body = await response.text();
      if (!body.includes("SUCCESS-CHANGED")) {
        const control = holdSuccessfulDiscardDiff;
        control.started.resolve();
        await control.release.promise;
        await route.fulfill({ response, body });
        return;
      }
      await route.fulfill({ response, body });
      return;
    }
    if (requestUrl.searchParams.get("path") !== "read.txt" || !readDiff) {
      await route.continue();
      return;
    }
    const control = readDiff;
    if (!control.persistent) readDiff = null;
    control.started.resolve();
    if (control.release) await control.release.promise;
    await route.continue();
  });

  const url = new URL(`http://127.0.0.1:${address.port}/scripts/fixtures/git-workbench.html`);
  url.searchParams.set("project", info.projectId);
  url.searchParams.set("view", "git");
  url.searchParams.set("gitView", "changes");
  url.searchParams.set("gitRoot", info.root);
  await page.goto(url.href);
  await page.getByRole("navigation", { name: "Git 工作台视图" }).waitFor();
  const rowFor = (path, group = "未暂存") => page
    .locator(".gwb-file-group", { has: page.locator("header", { hasText: group }) })
    .locator(".gwb-file-row", { has: page.getByLabel(path, { exact: true }) });
  const clearedStatus = page.getByRole("status").filter({
    hasText: "差异内容已更新，原有勾选已清除，请重新选择",
  });
  const assertSelectionLocked = async label => {
    const controls = await page.getByRole("button", { name: /^选择(第|改动块)/ }).all();
    assert(controls.length > 0, `${label}: selection controls must exist`);
    for (const control of controls) {
      assert.equal(await control.isDisabled(), true, `${label}: selection must stay disabled`);
    }
    assert.equal(
      await page.getByRole("button", { name: "暂存所选改动", exact: true }).isDisabled(),
      true,
      `${label}: selected write must stay disabled`,
    );
    const hunkWrites = await page.getByRole("button", { name: /^(暂存|丢弃)此块$/ }).all();
    for (const control of hunkWrites) {
      assert.equal(await control.isDisabled(), true, `${label}: hunk writes must stay disabled`);
    }
  };
  const selectAdded = async text => {
    const locator = page.getByRole("button", { name: new RegExp(`选择第 .* 行 \\+${text}$`) });
    await locator.waitFor();
    await locator.click();
    assert.equal(await locator.getAttribute("aria-pressed"), "true");
    return locator;
  };
  const openDiscard = async () => {
    await page.getByRole("button", { name: "丢弃所选改动", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "丢弃所选改动" });
    await dialog.waitFor();
    return dialog;
  };

  // R7-1: a slow write must not block real diff reads for another file.
  const actionStarted = deferred();
  const actionRelease = deferred();
  slowAction = { started: actionStarted, release: actionRelease };
  const slowRow = rowFor("slow.txt");
  await slowRow.hover();
  await slowRow.getByLabel("暂存 slow.txt", { exact: true }).click();
  await withTimeout(actionStarted.promise, 5_000, "slow action request");
  const busyReadStarted = deferred();
  readDiff = { started: busyReadStarted };
  await rowFor("read.txt").getByLabel("read.txt", { exact: true }).click();
  await withTimeout(busyReadStarted.promise, 5_000, "busy diff request");
  const readLine = page.getByRole("button", { name: /选择第 .* 行 \+READ-CHANGED$/ });
  await readLine.waitFor({ timeout: 5_000 });
  assert.equal(await page.getByText("正在读取差异…", { exact: true }).count(), 0);
  await assertSelectionLocked("busy diff result");
  await page.screenshot({ path: join(output, "busy-read-real-diff-locked.png") });

  const freshReadStarted = deferred();
  const freshReadRelease = deferred();
  readDiff = { started: freshReadStarted, release: freshReadRelease, persistent: true };
  const slowActionResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(response.url()),
  );
  actionRelease.resolve();
  assert.equal((await slowActionResponse).ok(), true);
  await withTimeout(freshReadStarted.promise, 8_000, "post-write fresh diff request");
  await page.getByLabel("选择工作树", { exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const trigger = document.querySelector('[aria-label="选择工作树"]');
    return trigger instanceof HTMLButtonElement && !trigger.disabled;
  });
  assert.equal(await readLine.isVisible(), true, "busy result remains visible during final reread");
  await assertSelectionLocked("post-write fresh diff pending");
  await page.screenshot({ path: join(output, "post-write-reread-locked.png") });
  freshReadRelease.resolve();
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll("button")].find(button =>
      button.getAttribute("aria-label")?.endsWith("+READ-CHANGED"));
    return row && !row.disabled;
  });
  assert.equal(await readLine.isEnabled(), true);
  readDiff = null;
  const discardHead = git("rev-parse", "HEAD");
  const discardIndex = git("write-tree");
  const protectedReadFile = readFileSync(join(info.root, "read.txt"), "utf8");

  // R7-2: cancelling a discard keeps selection, success clears it without a false invalidation notice.
  await rowFor("discard-success.txt").getByLabel("discard-success.txt", { exact: true }).click();
  let successLine = await selectAdded("SUCCESS-CHANGED");
  const successIndex = await diffIndex(successLine);
  let dialog = await openDiscard();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await successLine.getAttribute("aria-pressed"), "true", "cancel preserves selection");
  assert.equal(await clearedStatus.count(), 0, "cancel must not invent invalidation feedback");
  dialog = await openDiscard();
  await dialog.getByLabel("输入目标以确认").fill("丢弃");
  failNextAction = true;
  const forcedFailure = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(response.url()),
  );
  await dialog.getByRole("button", { name: "丢弃所选改动", exact: true }).click();
  assert.equal((await forcedFailure).status(), 500);
  await dialog.getByRole("alert").waitFor();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await successLine.getAttribute("aria-pressed"), "true", "failed discard preserves selection");

  dialog = await openDiscard();
  await dialog.getByLabel("输入目标以确认").fill("丢弃");
  const successfulDiffStarted = deferred();
  const successfulDiffRelease = deferred();
  holdSuccessfulDiscardDiff = {
    started: successfulDiffStarted,
    release: successfulDiffRelease,
  };
  const successRequest = page.waitForRequest(request =>
    request.method() === "POST" && /\/git\/workbench\/actions$/.test(request.url()),
  );
  const successResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(response.url()),
  );
  await dialog.getByRole("button", { name: "丢弃所选改动", exact: true }).click();
  assert.deepEqual((await successRequest).postDataJSON().action.lines, [successIndex]);
  assert.equal((await successResponse).ok(), true);
  await dialog.waitFor({ state: "detached" });
  await withTimeout(successfulDiffStarted.promise, 8_000, "successful discard fresh diff");
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].some(button =>
    button.getAttribute("aria-pressed") === "true"),
  );
  assert.equal(await clearedStatus.count(), 0, "success callback clears selection without false notice");
  await page.screenshot({ path: join(output, "successful-discard-refresh-delayed.png") });
  successfulDiffRelease.resolve();
  await successLine.waitFor({ state: "detached" });
  await page.getByRole("button", { name: /选择第 .* 行 \+SUCCESS-KEEP$/ }).waitFor();
  holdSuccessfulDiscardDiff = null;
  await page.waitForTimeout(250);
  assert.equal(await clearedStatus.count(), 0, "own successful discard must not report stale selection");
  assert.equal(
    readFileSync(join(info.root, "discard-success.txt"), "utf8"),
    "success base\nSUCCESS-FAST\nSUCCESS-KEEP\n",
  );
  await page.screenshot({ path: join(output, "successful-discard-no-false-notice.png") });

  // The ordinary response order must follow the same semantics while the same file remains dirty.
  const fastLine = await selectAdded("SUCCESS-FAST");
  const fastIndex = await diffIndex(fastLine);
  dialog = await openDiscard();
  await dialog.getByLabel("输入目标以确认").fill("丢弃");
  const fastRequest = page.waitForRequest(request =>
    request.method() === "POST" && /\/git\/workbench\/actions$/.test(request.url()),
  );
  const fastResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(response.url()),
  );
  await dialog.getByRole("button", { name: "丢弃所选改动", exact: true }).click();
  assert.deepEqual((await fastRequest).postDataJSON().action.lines, [fastIndex]);
  assert.equal((await fastResponse).ok(), true);
  await dialog.waitFor({ state: "detached" });
  await fastLine.waitFor({ state: "detached" });
  await page.getByRole("button", { name: /选择第 .* 行 \+SUCCESS-KEEP$/ }).waitFor();
  assert.equal(await clearedStatus.count(), 0, "ordinary successful discard must not report stale selection");
  assert.equal(
    readFileSync(join(info.root, "discard-success.txt"), "utf8"),
    "success base\nSUCCESS-KEEP\n",
  );

  // A real external update while the dialog is open invalidates the snapshot. The 409 must
  // preserve disk contents and the external-update feedback must survive the failed confirmation.
  await rowFor("discard-race.txt").getByLabel("discard-race.txt", { exact: true }).click();
  await selectAdded("RACE-ONE");
  dialog = await openDiscard();
  write("discard-race.txt", "race base\nRACE-TWO\n");
  await clearedStatus.waitFor({ timeout: 12_000 });
  await page.getByRole("button", { name: /选择第 .* 行 \+RACE-TWO$/ }).waitFor();
  await dialog.getByLabel("输入目标以确认").fill("丢弃");
  const failedResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(response.url()),
  );
  await dialog.getByRole("button", { name: "丢弃所选改动", exact: true }).click();
  assert.equal((await failedResponse).status(), 409);
  await dialog.getByRole("alert").waitFor();
  assert.equal(await clearedStatus.isVisible(), true, "failed action must preserve external-update feedback");
  assert.equal(readFileSync(join(info.root, "discard-race.txt"), "utf8"), "race base\nRACE-TWO\n");
  assert.equal(git("status", "--porcelain", "--", "discard-race.txt"), "M discard-race.txt");
  assert.equal(git("rev-parse", "HEAD"), discardHead);
  assert.equal(git("write-tree"), discardIndex, "discard paths must preserve the staged tree");
  assert.equal(readFileSync(join(info.root, "read.txt"), "utf8"), protectedReadFile);
  await page.screenshot({ path: join(output, "failed-discard-preserves-update-notice.png") });

  await writeFile(join(output, "metrics.json"), JSON.stringify({
    busyReadReturnedBeforeWrite: true,
    busyReadSelectionLocked: true,
    postWriteRereadLocked: true,
    cancelPreservedSelection: true,
    failurePreservedSelection: true,
    successRefreshDelayCovered: true,
    ordinarySuccessCovered: true,
    successClearedWithoutFalseNotice: true,
    failedDiscardPreservedDiskAndNotice: true,
  }, null, 2));
  passed = true;
} catch (error) {
  const diagnostics = backend.diagnostics();
  throw new Error(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n${diagnostics.stderr}\n${diagnostics.stdout}`,
  );
} finally {
  await browser?.close();
  await vite?.close();
  await backend.close();
  if (fixtureDirectory) assert.equal(existsSync(fixtureDirectory), false);
}
if (passed) {
  await writeFile(join(output, "browser-run.txt"), [
    "Browser mode: isolated temporary-profile headless Chromium",
    "R7-1 busy read and post-write freshness gates: passed",
    "R7-2 discard success/cancel/failure feedback semantics: passed",
    "Cleanup: browser, Vite server, fixture backend, and temporary repository completed",
    "",
  ].join("\n"));
  console.log(`Git workbench busy/discard verification passed\nEvidence: ${output}`);
}
