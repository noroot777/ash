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
const output = process.env.GIT_WORKBENCH_REFRESH_PATHS_OUTPUT
  || join(tmpdir(), "harness-git-workbench-refresh-paths");

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
const box = locator => locator.evaluate(element => {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
});
const assertInsideViewport = async (locator, width, height, label) => {
  const rect = await box(locator);
  assert(rect.left >= 0 && rect.right <= width, `${label} must fit viewport width: ${JSON.stringify(rect)}`);
  assert(rect.top >= 0 && rect.bottom <= height, `${label} must fit viewport height: ${JSON.stringify(rect)}`);
  return rect;
};
const diffIndex = async locator => {
  const label = await locator.getAttribute("aria-label");
  const index = Number(/选择第 (\d+) 行/.exec(label || "")?.[1]) - 1;
  assert(Number.isInteger(index) && index >= 0, `diff row must expose its index: ${label}`);
  return index;
};
const unstageGuidance = [
  "所选 + 行会从暂存区删除",
  "所选 - 行会恢复到暂存区",
  "修改只选 + 行时，原始行不会恢复到暂存区",
  "该删除会留待提交",
  "只选 - 行时，新增内容仍留在暂存区",
  "完整取消这处修改的暂存需同时勾选对应的 - / + 行",
  "工作区文件保持不变",
];
const assertUnstageGuidance = async locator => {
  const text = await locator.innerText();
  for (const phrase of unstageGuidance) assert(text.includes(phrase), `missing guidance: ${phrase}`);
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
  const lines = prefix => Array.from({ length: 30 }, (_, index) => `${prefix} ${index + 1}`);
  const pickBase = lines("pick");
  const bothBase = lines("both");
  const longBase = Array.from({ length: 60 }, (_, index) => `long ${index + 1}`);
  const longChanged = longBase.map((line, index) => index < 40 ? `${line} EDITED` : line);
  const stagedCases = [
    { path: "unstage-plus.txt", prefix: "plus", mode: "plus" },
    { path: "unstage-minus.txt", prefix: "minus", mode: "minus" },
    { path: "unstage-both.txt", prefix: "both sides", mode: "both" },
  ].map(entry => {
    const base = lines(entry.prefix);
    const changed = [...base];
    changed[11] = `${entry.prefix} 12 EDITED`;
    return { ...entry, base, changed };
  });
  write("pick.txt", `${pickBase.join("\n")}\n`);
  write("long-unstage.txt", `${longBase.join("\n")}\n`);
  write("other.txt", "other base\n");
  write("noise.txt", "noise base\n");
  write("both.txt", `${bothBase.join("\n")}\n`);
  write("gone-a.txt", "gone a\n");
  write("gone-b.txt", "gone b\n");
  write("kept.txt", "kept base\n");
  write("staged-sentinel.txt", "sentinel base\n");
  stagedCases.forEach(entry => write(entry.path, `${entry.base.join("\n")}\n`));
  git(
    "add", "--", "pick.txt", "other.txt", "noise.txt", "both.txt",
    "gone-a.txt", "gone-b.txt", "kept.txt", "staged-sentinel.txt", "long-unstage.txt",
    ...stagedCases.map(entry => entry.path),
  );
  git("commit", "-qm", "add refresh and path fixtures");
  git("rm", "-q", "--", "gone-a.txt", "gone-b.txt");
  write("kept.txt", "kept changed\n");
  write("new.txt", "new file\n");
  git("add", "--", "kept.txt", "new.txt");
  git("commit", "-qm", "history path fixtures");

  const pickChanged = [...pickBase];
  pickChanged[9] = "PICK-A";
  pickChanged[19] = "PICK-B";
  write("pick.txt", `${pickChanged.join("\n")}\n`);
  write("other.txt", "other changed\n");
  const bothStaged = [...bothBase];
  bothStaged[4] = "BOTH-STAGED";
  write("both.txt", `${bothStaged.join("\n")}\n`);
  git("add", "--", "both.txt");
  const bothChanged = [...bothStaged];
  bothChanged[19] = "BOTH-WORKTREE";
  write("both.txt", `${bothChanged.join("\n")}\n`);
  write("staged-sentinel.txt", "sentinel changed\n");
  stagedCases.forEach(entry => write(entry.path, `${entry.changed.join("\n")}\n`));
  write("long-unstage.txt", `${longChanged.join("\n")}\n`);
  git("add", "--", "staged-sentinel.txt", "long-unstage.txt", ...stagedCases.map(entry => entry.path));
  const sentinelCached = git("diff", "--cached", "--", "staged-sentinel.txt");
  const preservedHead = git("rev-parse", "HEAD");

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
  let actionPosts = 0;
  page.on("request", request => {
    if (request.method() === "POST" && /\/git\/workbench\/actions$/.test(request.url())) {
      actionPosts += 1;
    }
  });

  let diffControl = null;
  const armDelay = (persistent = false) => {
    let startedResolve;
    let releaseResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const gate = new Promise(resolve => { releaseResolve = resolve; });
    const control = { kind: "delay", startedResolve, gate, persistent };
    diffControl = control;
    return {
      started,
      release: () => {
        if (diffControl === control) diffControl = null;
        releaseResolve();
      },
    };
  };
  const armFailure = () => {
    let seenResolve;
    const seen = new Promise(resolve => { seenResolve = resolve; });
    diffControl = { kind: "fail", seenResolve };
    return seen;
  };
  await page.route("**/git/workbench/diff?**", async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.searchParams.get("path") !== "pick.txt" || !diffControl) {
      await route.continue();
      return;
    }
    const control = diffControl;
    if (!control.persistent) diffControl = null;
    if (control.kind === "delay") {
      control.startedResolve();
      await control.gate;
      await route.continue();
      return;
    }
    control.seenResolve();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "forced diff failure" }),
    });
  });

  const url = new URL(
    `http://127.0.0.1:${address.port}/scripts/fixtures/git-workbench.html`,
  );
  url.searchParams.set("project", info.projectId);
  url.searchParams.set("view", "git");
  url.searchParams.set("gitView", "changes");
  url.searchParams.set("gitRoot", info.root);
  await page.goto(url.href);
  await page.getByRole("navigation", { name: "Git 工作台视图" }).waitFor();
  const rowFor = (path, group) => page
    .locator(".gwb-file-group", { has: page.locator("header", { hasText: group }) })
    .locator(".gwb-file-row", { has: page.getByLabel(path, { exact: true }) });
  const isState = response => {
    const value = new URL(response.url());
    return response.request().method() === "GET"
      && value.pathname.endsWith("/git/workbench")
      && !value.pathname.endsWith("/diff");
  };
  const waitForResponses = (predicate, count, timeout = 15_000) => withTimeout(
    new Promise(resolve => {
      let seen = 0;
      const handler = response => {
        if (!predicate(response)) return;
        seen += 1;
        if (seen === count) {
          page.off("response", handler);
          resolve();
        }
      };
      page.on("response", handler);
    }),
    timeout,
    `${count} responses`,
  );
  const waitForPickDiff = () => page.waitForResponse(response => {
    const value = new URL(response.url());
    return response.request().method() === "GET"
      && value.pathname.endsWith("/git/workbench/diff")
      && value.searchParams.get("path") === "pick.txt";
  });
  const selectedCount = () => page.getByText(/已选 \d+ 行/).textContent();
  const waitForButtonEnabled = async name => {
    await page.getByRole("button", { name, exact: true }).waitFor();
    await page.waitForFunction(label => [...document.querySelectorAll("button")].some(
      button => button.textContent?.trim() === label && !button.disabled,
    ), name);
  };
  const assertAllDisabled = async (locator, label) => {
    const buttons = await locator.all();
    assert(buttons.length > 0, `${label} buttons must exist`);
    for (const button of buttons) assert.equal(await button.isDisabled(), true, `${label} must be disabled`);
  };

  await rowFor("pick.txt", "未暂存").getByLabel("pick.txt", { exact: true }).click();
  let selectedA = page.getByRole("button", { name: /选择第 .* 行 \+PICK-A$/ });
  await selectedA.waitFor();
  await selectedA.click();
  assert.equal(await selectedA.getAttribute("aria-pressed"), "true");
  assert.match(await selectedCount(), /已选 1 行/);

  // Two unchanged polling cycles do not disturb the local line selection.
  const pollingStarted = Date.now();
  await waitForResponses(isState, 2, 13_000);
  const pollingElapsedMs = Date.now() - pollingStarted;
  assert.equal(await selectedA.getAttribute("aria-pressed"), "true");
  assert.match(await selectedCount(), /已选 1 行/);

  // An unrelated external change refreshes the same diff. Local selection stays interactive,
  // while every write action waits for a fresh diff.
  const delayedNoise = armDelay();
  const postsBeforeRefreshSelection = actionPosts;
  write("noise.txt", "noise external one\n");
  await withTimeout(delayedNoise.started, 8_000, "delayed noise diff");
  assert.equal(await selectedA.isVisible(), true, "old diff must remain visible while refreshing");
  assert.equal(await selectedA.isEnabled(), true, "local row selection must remain interactive");
  const refreshStatus = page.getByRole("status").filter({ hasText: "正在刷新差异；内容变化时需重新勾选" });
  await refreshStatus.waitFor();
  const selectedStage = page.getByRole("button", { name: "暂存所选改动", exact: true });
  const selectedDiscard = page.getByRole("button", { name: "丢弃所选改动", exact: true });
  assert.equal(await selectedStage.isDisabled(), true);
  assert.equal(await selectedDiscard.isDisabled(), true);
  await assertAllDisabled(page.getByRole("button", { name: "暂存此块", exact: true }), "stage hunk");
  await assertAllDisabled(page.getByRole("button", { name: "丢弃此块", exact: true }), "discard hunk");
  assert.equal(await page.getByText("正在读取差异…").count(), 0);
  await selectedA.click();
  assert.equal(await selectedA.getAttribute("aria-pressed"), "false");
  const firstHunk = selectedA.locator("xpath=ancestor::section[contains(@class, 'diff-hunk')]");
  const firstHunkToggle = firstHunk.getByRole("button", { name: /^选择改动块 / });
  await firstHunkToggle.click();
  assert.equal(await firstHunkToggle.getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "清除选择", exact: true }).click();
  assert.match(await selectedCount(), /已选 0 行/);
  const selectedB = page.getByRole("button", { name: /选择第 .* 行 \+PICK-B$/ });
  await selectedB.click();
  assert.equal(await selectedB.getAttribute("aria-pressed"), "true");
  assert.equal(actionPosts, postsBeforeRefreshSelection, "local refresh-time selection must not POST");
  await page.screenshot({ path: join(output, "same-diff-refresh-selection-live.png") });
  const refreshedPickResponse = waitForPickDiff();
  delayedNoise.release();
  await (await refreshedPickResponse).finished();
  await refreshStatus.waitFor({ state: "detached" });
  await waitForButtonEnabled("暂存所选改动");
  assert.equal(await selectedDiscard.isEnabled(), true);
  const secondHunk = selectedB.locator("xpath=ancestor::section[contains(@class, 'diff-hunk')]");
  assert.equal(
    await secondHunk.getByRole("button", { name: "暂存此块", exact: true }).isEnabled(),
    true,
  );
  assert.equal(await selectedB.getAttribute("aria-pressed"), "true");
  assert.match(await selectedCount(), /已选 1 行/);
  await page.getByRole("button", { name: "清除选择", exact: true }).click();
  assert.equal(
    await secondHunk.getByRole("button", { name: "丢弃此块", exact: true }).isEnabled(),
    true,
  );
  await selectedB.click();

  // Staging another file through the UI keeps pick.txt active and selected.
  const delayedAfterWrite = armDelay(true);
  const pickAfterOther = waitForPickDiff();
  const actionAfterOther = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(response.url()),
  );
  const otherRow = rowFor("other.txt", "未暂存");
  await otherRow.hover();
  await otherRow.getByLabel("暂存 other.txt", { exact: true }).click();
  assert.equal((await actionAfterOther).ok(), true);
  await withTimeout(delayedAfterWrite.started, 8_000, "post-write diff refresh");
  await assertAllDisabled(page.getByRole("button", { name: /^选择(第|改动块)/ }), "post-write selection");
  assert.equal(await page.getByRole("button", { name: "清除选择", exact: true }).isDisabled(), true);
  assert.equal(await selectedStage.isDisabled(), true);
  assert.equal(await selectedB.getAttribute("aria-pressed"), "true");
  await refreshStatus.waitFor();
  await page.screenshot({ path: join(output, "post-write-refresh-selection-locked.png") });
  delayedAfterWrite.release();
  await pickAfterOther;
  await waitForButtonEnabled("暂存所选改动");
  await page.getByRole("status").filter({ hasText: "正在刷新差异" }).waitFor({ state: "detached" });
  await rowFor("other.txt", "已暂存").waitFor();
  assert.equal(await page.locator(".diff-path").textContent(), "pick.txt");
  assert.equal(await selectedB.getAttribute("aria-pressed"), "true");
  await page.screenshot({ path: join(output, "selection-after-staging-other.png") });

  // An old row selected during an external refresh disappears in the new diff.
  await page.getByRole("button", { name: "清除选择", exact: true }).click();
  const delayedChange = armDelay();
  const postsBeforeChangedSelection = actionPosts;
  pickChanged[9] = "PICK-A-UPDATED";
  write("pick.txt", `${pickChanged.join("\n")}\nPICK-C\n`);
  await withTimeout(delayedChange.started, 8_000, "changed pick diff");
  await refreshStatus.waitFor();
  await selectedA.click();
  assert.equal(await selectedA.getAttribute("aria-pressed"), "true");
  assert.equal(await selectedStage.isDisabled(), true);
  await page.screenshot({ path: join(output, "changed-diff-refresh-selection.png") });
  const changedPickResponse = waitForPickDiff();
  delayedChange.release();
  await (await changedPickResponse).finished();
  await refreshStatus.waitFor({ state: "detached" });
  await page.getByRole("button", { name: /选择第 .* 行 \+PICK-C$/ }).waitFor();
  assert.equal(await selectedA.count(), 0, "the selected stale row is gone");
  selectedA = page.getByRole("button", { name: /选择第 .* 行 \+PICK-A-UPDATED$/ });
  assert.equal(await selectedB.getAttribute("aria-pressed"), "false");
  assert.equal(await selectedA.getAttribute("aria-pressed"), "false");
  assert.match(await selectedCount(), /已选 0 行/);
  assert.equal(await selectedStage.isDisabled(), true);
  assert.equal(actionPosts, postsBeforeChangedSelection);
  const clearedStatus = page.getByRole("status").filter({ hasText: "差异内容已更新，原有勾选已清除，请重新选择" });
  await clearedStatus.waitFor();
  await assertInsideViewport(clearedStatus, 1200, 760, "selection invalidation notice");
  await page.screenshot({ path: join(output, "selection-cleared-after-pick-change.png") });

  // Switching files and switching source for the same path never carries old line indices.
  await selectedA.click();
  await clearedStatus.waitFor({ state: "detached" });
  await rowFor("other.txt", "已暂存").getByLabel("other.txt", { exact: true }).click();
  await page.getByRole("button", { name: /选择第 .* 行 \+other changed$/ }).waitFor();
  assert.match(await selectedCount(), /已选 0 行/);
  assert.equal(
    await page.getByRole("button", { name: "取消所选暂存", exact: true }).isDisabled(),
    true,
  );
  await rowFor("both.txt", "未暂存").getByLabel("both.txt", { exact: true }).click();
  const bothWorktree = page.getByRole("button", { name: /选择第 .* 行 \+BOTH-WORKTREE$/ });
  await bothWorktree.waitFor();
  await bothWorktree.click();
  await rowFor("both.txt", "已暂存").getByLabel("both.txt", { exact: true }).click();
  await page.getByRole("button", { name: /选择第 .* 行 \+BOTH-STAGED$/ }).waitFor();
  assert.match(await selectedCount(), /已选 0 行/);
  assert.equal(
    await page.getByRole("button", { name: "取消所选暂存", exact: true }).isDisabled(),
    true,
  );

  // Staged modification rows document and preserve the exact reverse-apply semantics.
  const stagedResults = [];
  for (const entry of stagedCases) {
    await rowFor(entry.path, "已暂存").getByLabel(entry.path, { exact: true }).click();
    const oldRow = page.getByRole("button", {
      name: new RegExp(`选择第 .* 行 -${entry.prefix} 12$`),
    });
    const newRow = page.getByRole("button", {
      name: new RegExp(`选择第 .* 行 \\+${entry.prefix} 12 EDITED$`),
    });
    await Promise.all([oldRow.waitFor(), newRow.waitFor()]);
    const oldIndex = await diffIndex(oldRow);
    const newIndex = await diffIndex(newRow);
    const chosenRows = entry.mode === "plus"
      ? [newRow]
      : entry.mode === "minus" ? [oldRow] : [oldRow, newRow];
    const expectedLines = entry.mode === "plus"
      ? [newIndex]
      : entry.mode === "minus" ? [oldIndex] : [oldIndex, newIndex];
    for (const row of chosenRows) await row.click();
    const note = page.getByRole("note");
    await note.waitFor();
    await assertUnstageGuidance(note);
    const apply = page.getByRole("button", { name: "取消所选暂存", exact: true });
    await waitForButtonEnabled("取消所选暂存");
    assert.equal(await apply.isEnabled(), true);
    if (entry.mode === "plus") {
      await assertInsideViewport(apply, 1200, 760, "desktop staged selection button");
      await assertInsideViewport(note, 1200, 760, "desktop staged selection guidance");
      await page.screenshot({ path: join(output, "unstage-plus-guidance-desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await assertInsideViewport(apply, 390, 844, "mobile staged selection button");
      await assertInsideViewport(note, 390, 844, "mobile staged selection guidance");
      await page.screenshot({ path: join(output, "unstage-plus-guidance-mobile.png") });
      await page.setViewportSize({ width: 1200, height: 760 });
    }
    const actionRequest = page.waitForRequest(request =>
      request.method() === "POST" && /\/git\/workbench\/actions$/.test(request.url()),
    );
    const actionResponse = page.waitForResponse(response =>
      response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(response.url()),
    );
    await apply.click();
    const body = (await actionRequest).postDataJSON();
    assert.equal(body.action.kind, "patch");
    assert.equal(body.action.path, entry.path);
    assert.equal(body.action.source, "staged");
    assert.deepEqual(body.action.lines, expectedLines);
    const response = await actionResponse;
    assert.equal(response.ok(), true);
    await response.finished();

    const expectedIndex = entry.mode === "plus"
      ? entry.base.filter((_, index) => index !== 11)
      : entry.mode === "minus"
        ? [...entry.changed.slice(0, 11), entry.base[11], ...entry.changed.slice(11)]
        : entry.base;
    assert.equal(git("show", `:${entry.path}`), expectedIndex.join("\n"));
    assert.equal(git("show", `HEAD:${entry.path}`), entry.base.join("\n"));
    assert.equal(readFileSync(join(info.root, entry.path), "utf8"), `${entry.changed.join("\n")}\n`);
    assert.equal(git("rev-parse", "HEAD"), preservedHead);
    assert.equal(git("diff", "--cached", "--", "staged-sentinel.txt"), sentinelCached);
    const cached = git("diff", "--cached", "--", entry.path);
    if (entry.mode === "plus") {
      assert(cached.includes(`-${entry.base[11]}`));
      assert(!cached.includes(`+${entry.changed[11]}`));
    } else if (entry.mode === "minus") {
      assert(!cached.includes(`-${entry.base[11]}`));
      assert(cached.includes(`+${entry.changed[11]}`));
    } else {
      assert.equal(cached, "");
    }
    stagedResults.push({ path: entry.path, mode: entry.mode, lines: expectedLines });
  }
  await rowFor("staged-sentinel.txt", "已暂存").waitFor();

  // Long staged diffs keep the explanation and action visible without scrolling to the note.
  const longGuidance = [];
  for (const viewport of [{ width: 1200, height: 760 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await rowFor("other.txt", "已暂存").getByLabel("other.txt", { exact: true }).click();
    await rowFor("long-unstage.txt", "已暂存").getByLabel("long-unstage.txt", { exact: true }).click();
    const lastAdded = page.getByRole("button", { name: /选择第 .* 行 \+long 40 EDITED$/ });
    await lastAdded.waitFor();
    assert.equal(await page.getByRole("note").count(), 0);
    const scroll = page.locator(".gwb-diff-shell > .diff-scroll");
    assert(await scroll.evaluate(element => element.scrollHeight > element.clientHeight));
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await lastAdded.click();
    const note = page.getByRole("note");
    await assertUnstageGuidance(note);
    const apply = page.getByRole("button", { name: "取消所选暂存", exact: true });
    const noteBox = await assertInsideViewport(note, viewport.width, viewport.height, "long diff guidance");
    const actionBox = await assertInsideViewport(apply, viewport.width, viewport.height, "long diff unstage button");
    assert(noteBox.bottom <= actionBox.top, "guidance appears above the action");
    longGuidance.push({ viewport, noteBox, actionBox });
    await page.screenshot({ path: join(output, `long-diff-guidance-${viewport.width}.png`) });
  }
  await page.setViewportSize({ width: 1200, height: 760 });
  assert.equal(git("show", ":long-unstage.txt"), longChanged.join("\n"));
  assert.equal(readFileSync(join(info.root, "long-unstage.txt"), "utf8"), `${longChanged.join("\n")}\n`);

  // A delayed response for pick.txt cannot overwrite a newer file selection.
  await rowFor("pick.txt", "未暂存").getByLabel("pick.txt", { exact: true }).click();
  selectedA = page.getByRole("button", { name: /选择第 .* 行 \+PICK-A-UPDATED$/ });
  await selectedA.waitFor();
  await selectedA.click();
  const stalePick = armDelay();
  write("noise.txt", "noise external two\n");
  await withTimeout(stalePick.started, 8_000, "stale pick diff");
  await rowFor("other.txt", "已暂存").getByLabel("other.txt", { exact: true }).click();
  await page.getByRole("button", { name: /选择第 .* 行 \+other changed$/ }).waitFor();
  const stalePickResponse = waitForPickDiff();
  stalePick.release();
  await (await stalePickResponse).finished();
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  assert.equal(await page.locator(".diff-path").textContent(), "other.txt");
  assert.equal(await page.getByRole("button", { name: /\+PICK-A-UPDATED$/ }).count(), 0);

  // A failed refresh must not expose actionable controls for the cached old diff.
  await rowFor("pick.txt", "未暂存").getByLabel("pick.txt", { exact: true }).click();
  await page.getByRole("button", { name: /选择第 .* 行 \+PICK-A-UPDATED$/ }).waitFor();
  const failedPick = armFailure();
  write("noise.txt", "noise external three\n");
  await withTimeout(failedPick, 8_000, "failed pick diff");
  const alert = page.getByRole("alert", { name: "" }).filter({ hasText: "forced diff failure" });
  await alert.waitFor();
  assert.equal(await page.locator(".gwb-diff-line").count(), 0);
  assert.equal(await page.getByRole("button", { name: "暂存所选改动", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "丢弃所选改动", exact: true }).count(), 0);
  await page.screenshot({ path: join(output, "diff-refresh-failure.png") });

  // Deleted, modified, and new files show their real paths in a multi-file history diff.
  const nav = page.getByRole("navigation", { name: "Git 工作台视图" });
  await nav.getByRole("button", { name: /^历史/ }).click();
  const historyRow = page.locator(".gwb-commit-row", { hasText: "history path fixtures" });
  await historyRow.waitFor();
  await historyRow.locator(".gwb-commit-select").click();
  const headings = page.locator(".detail-file-head code");
  await headings.filter({ hasText: "gone-a.txt" }).waitFor();
  const headingTexts = await headings.allTextContents();
  assert.deepEqual(headingTexts, ["gone-a.txt", "gone-b.txt", "kept.txt", "new.txt"]);
  assert(!headingTexts.includes("/dev/null"));
  await page.screenshot({ path: join(output, "history-real-paths.png") });
  assert.equal(git("rev-parse", "HEAD"), preservedHead);

  const metrics = {
    url: url.href,
    pollingElapsedMs,
    sameDiffSelectionPreserved: true,
    refreshSelectionStayedInteractive: true,
    refreshWriteActionsStayedDisabled: true,
    refreshSelectionSentNoActions: true,
    stagingOtherSelectionPreserved: true,
    postWriteRefreshSelectionLocked: true,
    changedDiffSelectionCleared: true,
    changedDiffSelectionExplained: true,
    longGuidance,
    fileSwitchCleared: true,
    sourceSwitchCleared: true,
    stagedPartialUnstage: stagedResults,
    staleResponseIgnored: true,
    failedRefreshHidOldDiff: true,
    historyHeadings: headingTexts,
    head: preservedHead,
  };
  await writeFile(join(output, "metrics.json"), JSON.stringify(metrics, null, 2));
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
  await writeFile(
    join(output, "browser-run.txt"),
    [
      "Browser mode: isolated temporary-profile headless Chromium",
      "R6 stale-selection feedback and long-diff mobile guidance: passed",
      "R5-2 refresh-time local selection and write-action freshness regression: passed",
      "R5-1 staged partial-unstage guidance and exact Git semantics: passed",
      "R4-1 selection preservation and stale-response regression: passed",
      "R4-2 multi-file history path regression: passed",
      "Cleanup: browser, Vite server, fixture backend, and temporary repositories completed",
      "",
    ].join("\n"),
  );
  console.log(`Git workbench refresh/path verification passed\nEvidence: ${output}`);
}
