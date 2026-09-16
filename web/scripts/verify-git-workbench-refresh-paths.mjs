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
  write("pick.txt", `${pickBase.join("\n")}\n`);
  write("other.txt", "other base\n");
  write("noise.txt", "noise base\n");
  write("both.txt", `${bothBase.join("\n")}\n`);
  write("gone-a.txt", "gone a\n");
  write("gone-b.txt", "gone b\n");
  write("kept.txt", "kept base\n");
  git(
    "add", "--", "pick.txt", "other.txt", "noise.txt", "both.txt",
    "gone-a.txt", "gone-b.txt", "kept.txt",
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

  let diffControl = null;
  const armDelay = () => {
    let startedResolve;
    let releaseResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const gate = new Promise(resolve => { releaseResolve = resolve; });
    diffControl = { kind: "delay", startedResolve, gate };
    return { started, release: releaseResolve };
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
    diffControl = null;
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

  // An unrelated external change refreshes the same diff. Old content stays readable but disabled.
  const delayedNoise = armDelay();
  write("noise.txt", "noise external one\n");
  await withTimeout(delayedNoise.started, 8_000, "delayed noise diff");
  assert.equal(await selectedA.isVisible(), true, "old diff must remain visible while refreshing");
  assert.equal(await selectedA.isDisabled(), true, "old selected row must be read-only while refreshing");
  assert.equal(
    await page.getByRole("button", { name: "暂存所选改动", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByText("正在读取差异…").count(), 0);
  await page.screenshot({ path: join(output, "same-diff-refresh-disabled.png") });
  delayedNoise.release();
  await page.waitForFunction(() => {
    const selected = document.querySelector('button[aria-pressed="true"].gwb-diff-line');
    return selected && !selected.disabled;
  });
  assert.equal(await selectedA.getAttribute("aria-pressed"), "true");
  assert.match(await selectedCount(), /已选 1 行/);

  // Staging another file through the UI keeps pick.txt active and selected.
  const pickAfterOther = waitForPickDiff();
  const actionAfterOther = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(response.url()),
  );
  const otherRow = rowFor("other.txt", "未暂存");
  await otherRow.hover();
  await otherRow.getByLabel("暂存 other.txt", { exact: true }).click();
  assert.equal((await actionAfterOther).ok(), true);
  await pickAfterOther;
  await page.waitForFunction(() => {
    const selected = document.querySelector('button[aria-pressed="true"].gwb-diff-line');
    return selected && !selected.disabled;
  });
  await rowFor("other.txt", "已暂存").waitFor();
  assert.equal(await page.locator(".diff-path").textContent(), "pick.txt");
  assert.equal(await selectedA.getAttribute("aria-pressed"), "true");
  await page.screenshot({ path: join(output, "selection-after-staging-other.png") });

  // A real change to pick.txt produces a new key and clears the previous line selection.
  const changedPickResponse = waitForPickDiff();
  write("pick.txt", `${pickChanged.join("\n")}\nPICK-C\n`);
  await changedPickResponse;
  const pickC = page.getByRole("button", { name: /选择第 .* 行 \+PICK-C$/ });
  await pickC.waitFor();
  selectedA = page.getByRole("button", { name: /选择第 .* 行 \+PICK-A$/ });
  assert.equal(await selectedA.getAttribute("aria-pressed"), "false");
  assert.match(await selectedCount(), /已选 0 行/);
  await page.screenshot({ path: join(output, "selection-cleared-after-pick-change.png") });

  // Switching files and switching source for the same path never carries old line indices.
  await selectedA.click();
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

  // A delayed response for pick.txt cannot overwrite a newer file selection.
  await rowFor("pick.txt", "未暂存").getByLabel("pick.txt", { exact: true }).click();
  selectedA = page.getByRole("button", { name: /选择第 .* 行 \+PICK-A$/ });
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
  assert.equal(await page.getByRole("button", { name: /\+PICK-A$/ }).count(), 0);

  // A failed refresh must not expose actionable controls for the cached old diff.
  await rowFor("pick.txt", "未暂存").getByLabel("pick.txt", { exact: true }).click();
  await page.getByRole("button", { name: /选择第 .* 行 \+PICK-A$/ }).waitFor();
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
    stagingOtherSelectionPreserved: true,
    changedDiffSelectionCleared: true,
    fileSwitchCleared: true,
    sourceSwitchCleared: true,
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
      "R4-1 diff refresh selection and stale-response regression: passed",
      "R4-2 multi-file history path regression: passed",
      "Cleanup: browser, Vite server, fixture backend, and temporary repositories completed",
      "",
    ].join("\n"),
  );
  console.log(`Git workbench refresh/path verification passed\nEvidence: ${output}`);
}
