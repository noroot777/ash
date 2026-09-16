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
const output = process.env.GIT_WORKBENCH_DIFF_PREFIX_OUTPUT
  || join(tmpdir(), "harness-git-workbench-diff-prefixes");

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

const diffIndex = async locator => {
  const label = await locator.getAttribute("aria-label");
  const index = Number(/选择第 (\d+) 行/.exec(label || "")?.[1]) - 1;
  assert(Number.isInteger(index) && index >= 0, `missing diff index: ${label}`);
  return index;
};
const assertRow = async (locator, { sign, text, className, selectable = true }) => {
  await locator.waitFor();
  assert.equal((await locator.evaluate(element => element.tagName)).toLowerCase(), selectable ? "button" : "div");
  assert((await locator.getAttribute("class"))?.includes(className), `${text} must have ${className}`);
  assert.equal(await locator.locator(".diff-sign").textContent(), sign);
  assert.equal(await locator.locator(".diff-code").textContent(), text);
  if (selectable) assert.equal(await locator.isEnabled(), true);
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
  const numbered = prefix => Array.from({ length: 24 }, (_, index) => `${prefix} ${index + 1}`);
  const deletedBase = numbered("deleted");
  deletedBase.splice(9, 0, "---", "-- comment");
  const addedBase = numbered("added");
  const historyDeletedBase = numbered("history deleted");
  historyDeletedBase.splice(9, 0, "---");
  const historyAddedBase = numbered("history added");
  write("deleted-prefix.md", `${deletedBase.join("\n")}\n`);
  write("added-prefix.js", `${addedBase.join("\n")}\n`);
  write("history-deleted.md", `${historyDeletedBase.join("\n")}\n`);
  write("history-added.js", `${historyAddedBase.join("\n")}\n`);
  write("sentinel.txt", "sentinel base\n");
  write("other.txt", "other base\n");
  git(
    "add", "--", "deleted-prefix.md", "added-prefix.js",
    "history-deleted.md", "history-added.js", "sentinel.txt", "other.txt",
  );
  git("commit", "-qm", "add prefix browser fixtures");

  const historyDeletedChanged = historyDeletedBase.filter(line => line !== "---");
  const historyAddedChanged = [...historyAddedBase];
  historyAddedChanged.splice(10, 0, "++history;", "++ b/history");
  write("history-deleted.md", `${historyDeletedChanged.join("\n")}\n`);
  write("history-added.js", `${historyAddedChanged.join("\n")}\n`);
  git("add", "--", "history-deleted.md", "history-added.js");
  git("commit", "-qm", "history special prefixes");

  const deletedChanged = deletedBase.filter(line => line !== "---" && line !== "-- comment");
  const addedChanged = [...addedBase];
  addedChanged.splice(10, 0, "++counter;", "++ b/foo");
  write("deleted-prefix.md", `${deletedChanged.join("\n")}\n`);
  write("added-prefix.js", `${addedChanged.join("\n")}\n`);
  write("sentinel.txt", "sentinel staged\n");
  git("add", "--", "sentinel.txt");
  write("other.txt", "other unstaged\n");
  const preserved = {
    head: git("rev-parse", "HEAD"),
    index: git("write-tree"),
    sentinel: git("show", ":sentinel.txt"),
    other: readFileSync(join(info.root, "other.txt"), "utf8"),
  };
  const assertPreserved = (exactIndex = false) => {
    assert.equal(git("rev-parse", "HEAD"), preserved.head);
    assert.equal(git("show", ":sentinel.txt"), preserved.sentinel);
    assert.equal(readFileSync(join(info.root, "other.txt"), "utf8"), preserved.other);
    if (exactIndex) assert.equal(git("write-tree"), preserved.index);
  };

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
  const runAction = async button => {
    const request = page.waitForRequest(value =>
      value.method() === "POST" && /\/git\/workbench\/actions$/.test(value.url()),
    );
    const response = page.waitForResponse(value =>
      value.request().method() === "POST" && /\/git\/workbench\/actions$/.test(value.url()),
    );
    await button.click();
    const body = (await request).postDataJSON();
    assert.equal((await response).ok(), true);
    return body;
  };
  const discardHunk = async expectedLines => {
    await page.getByRole("button", { name: "丢弃此块", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "丢弃这个改动块" });
    await dialog.getByLabel("输入目标以确认").fill("丢弃");
    const body = await runAction(
      dialog.getByRole("button", { name: "丢弃这个改动块", exact: true }),
    );
    assert.equal(body.action.kind, "discard-patch");
    assert.deepEqual(body.action.lines, expectedLines);
    await dialog.waitFor({ state: "detached" });
    return body;
  };

  // Deleted prefixes render as selectable removals. Exercise one exact line through the backend.
  await rowFor("deleted-prefix.md", "未暂存").getByLabel("deleted-prefix.md", { exact: true }).click();
  let separator = page.getByRole("button", { name: /选择第 .* 行 ----$/ });
  let comment = page.getByRole("button", { name: /选择第 .* 行 --- comment$/ });
  await assertRow(separator, { sign: "-", text: "---", className: "is-remove" });
  await assertRow(comment, { sign: "-", text: "-- comment", className: "is-remove" });
  const commentIndex = await diffIndex(comment);
  await comment.click();
  assert.equal(await comment.getAttribute("aria-pressed"), "true");
  const selectedStage = await runAction(
    page.getByRole("button", { name: "暂存所选改动", exact: true }),
  );
  assert.equal(selectedStage.action.kind, "patch");
  assert.deepEqual(selectedStage.action.lines, [commentIndex]);
  await rowFor("deleted-prefix.md", "已暂存").getByLabel("deleted-prefix.md", { exact: true }).click();
  comment = page.getByRole("button", { name: /选择第 .* 行 --- comment$/ });
  await assertRow(comment, { sign: "-", text: "-- comment", className: "is-remove" });
  const stagedCommentIndex = await diffIndex(comment);
  await comment.click();
  const selectedUnstage = await runAction(
    page.getByRole("button", { name: "取消所选暂存", exact: true }),
  );
  assert.equal(selectedUnstage.action.kind, "patch");
  assert.deepEqual(selectedUnstage.action.lines, [stagedCommentIndex]);
  await rowFor("deleted-prefix.md", "未暂存").waitFor();
  assertPreserved(true);

  // Deleted --- and -- comment both participate in stage, unstage, and discard hunk actions.
  await rowFor("deleted-prefix.md", "未暂存").getByLabel("deleted-prefix.md", { exact: true }).click();
  separator = page.getByRole("button", { name: /选择第 .* 行 ----$/ });
  comment = page.getByRole("button", { name: /选择第 .* 行 --- comment$/ });
  const deletedLines = [await diffIndex(separator), await diffIndex(comment)];
  await page.screenshot({ path: join(output, "deleted-prefix-render.png") });
  const deletedStage = await runAction(
    page.getByRole("button", { name: "暂存此块", exact: true }),
  );
  assert.deepEqual(deletedStage.action.lines, deletedLines);
  assert.match(git("diff", "--cached", "--", "deleted-prefix.md"), /^----$\n^--- comment$/m);
  assert.equal(git("diff", "--", "deleted-prefix.md"), "");
  assertPreserved();
  await rowFor("deleted-prefix.md", "已暂存").getByLabel("deleted-prefix.md", { exact: true }).click();
  separator = page.getByRole("button", { name: /选择第 .* 行 ----$/ });
  comment = page.getByRole("button", { name: /选择第 .* 行 --- comment$/ });
  const stagedDeletedLines = [await diffIndex(separator), await diffIndex(comment)];
  const deletedUnstage = await runAction(
    page.getByRole("button", { name: "取消暂存此块", exact: true }),
  );
  assert.deepEqual(deletedUnstage.action.lines, stagedDeletedLines);
  assert.equal(git("diff", "--cached", "--", "deleted-prefix.md"), "");
  assert.match(git("diff", "--", "deleted-prefix.md"), /^----$\n^--- comment$/m);
  assertPreserved(true);
  await rowFor("deleted-prefix.md", "未暂存").getByLabel("deleted-prefix.md", { exact: true }).click();
  separator = page.getByRole("button", { name: /选择第 .* 行 ----$/ });
  comment = page.getByRole("button", { name: /选择第 .* 行 --- comment$/ });
  const discardDeletedLines = [await diffIndex(separator), await diffIndex(comment)];
  await discardHunk(discardDeletedLines);
  assert.equal(readFileSync(join(info.root, "deleted-prefix.md"), "utf8"), `${deletedBase.join("\n")}\n`);
  assert.equal(git("status", "--porcelain", "--", "deleted-prefix.md"), "");
  assertPreserved(true);

  // Added ++counter and path-like ++ b/foo remain content rows through the full hunk cycle.
  await rowFor("added-prefix.js", "未暂存").getByLabel("added-prefix.js", { exact: true }).click();
  let counter = page.getByRole("button", { name: /选择第 .* 行 \+\+\+counter;$/ });
  let pathLike = page.getByRole("button", { name: /选择第 .* 行 \+\+\+ b\/foo$/ });
  await assertRow(counter, { sign: "+", text: "++counter;", className: "is-add" });
  await assertRow(pathLike, { sign: "+", text: "++ b/foo", className: "is-add" });
  const addedLines = [await diffIndex(counter), await diffIndex(pathLike)];
  await counter.click();
  assert.equal(await counter.getAttribute("aria-pressed"), "true");
  await counter.click();
  assert.equal(await counter.getAttribute("aria-pressed"), "false");
  await page.screenshot({ path: join(output, "added-prefix-render.png") });
  const addedStage = await runAction(
    page.getByRole("button", { name: "暂存此块", exact: true }),
  );
  assert.deepEqual(addedStage.action.lines, addedLines);
  assert.match(git("diff", "--cached", "--", "added-prefix.js"), /^\+\+\+counter;$\n^\+\+\+ b\/foo$/m);
  assert.equal(git("diff", "--", "added-prefix.js"), "");
  assertPreserved();
  await rowFor("added-prefix.js", "已暂存").getByLabel("added-prefix.js", { exact: true }).click();
  counter = page.getByRole("button", { name: /选择第 .* 行 \+\+\+counter;$/ });
  pathLike = page.getByRole("button", { name: /选择第 .* 行 \+\+\+ b\/foo$/ });
  const stagedAddedLines = [await diffIndex(counter), await diffIndex(pathLike)];
  const addedUnstage = await runAction(
    page.getByRole("button", { name: "取消暂存此块", exact: true }),
  );
  assert.deepEqual(addedUnstage.action.lines, stagedAddedLines);
  assert.equal(git("diff", "--cached", "--", "added-prefix.js"), "");
  assert.match(git("diff", "--", "added-prefix.js"), /^\+\+\+counter;$\n^\+\+\+ b\/foo$/m);
  assertPreserved(true);
  await rowFor("added-prefix.js", "未暂存").getByLabel("added-prefix.js", { exact: true }).click();
  counter = page.getByRole("button", { name: /选择第 .* 行 \+\+\+counter;$/ });
  pathLike = page.getByRole("button", { name: /选择第 .* 行 \+\+\+ b\/foo$/ });
  const discardAddedLines = [await diffIndex(counter), await diffIndex(pathLike)];
  await discardHunk(discardAddedLines);
  assert.equal(readFileSync(join(info.root, "added-prefix.js"), "utf8"), `${addedBase.join("\n")}\n`);
  assert.equal(git("status", "--porcelain", "--", "added-prefix.js"), "");
  assertPreserved(true);

  // The same prefixes render with correct signs and colors in read-only history details.
  const nav = page.getByRole("navigation", { name: "Git 工作台视图" });
  await nav.getByRole("button", { name: /^历史/ }).click();
  const historyRow = page.locator(".gwb-commit-row", { hasText: "history special prefixes" });
  await historyRow.waitFor();
  await historyRow.locator(".gwb-commit-select").click();
  const historyDeleted = page.locator(".diff-line", {
    has: page.locator(".diff-code", { hasText: /^---$/ }),
  });
  const historyAdded = page.locator(".diff-line", {
    has: page.locator(".diff-code", { hasText: /^\+\+history;$/ }),
  });
  const historyPathLike = page.locator(".diff-line", {
    has: page.locator(".diff-code", { hasText: /^\+\+ b\/history$/ }),
  });
  await assertRow(historyDeleted, { sign: "-", text: "---", className: "is-remove", selectable: false });
  await assertRow(historyAdded, { sign: "+", text: "++history;", className: "is-add", selectable: false });
  await assertRow(historyPathLike, { sign: "+", text: "++ b/history", className: "is-add", selectable: false });
  await page.screenshot({ path: join(output, "history-prefix-render.png") });

  const metrics = {
    url: url.href,
    head: preserved.head,
    indexRestored: git("write-tree") === preserved.index,
    sentinelPreserved: git("show", ":sentinel.txt") === preserved.sentinel,
    otherPreserved: readFileSync(join(info.root, "other.txt"), "utf8") === preserved.other,
    selectedSpecial: {
      stage: selectedStage.action.lines,
      unstage: selectedUnstage.action.lines,
    },
    deleted: {
      stage: deletedStage.action.lines,
      unstage: deletedUnstage.action.lines,
      discard: discardDeletedLines,
      restored: readFileSync(join(info.root, "deleted-prefix.md"), "utf8") === `${deletedBase.join("\n")}\n`,
    },
    added: {
      stage: addedStage.action.lines,
      unstage: addedUnstage.action.lines,
      discard: discardAddedLines,
      restored: readFileSync(join(info.root, "added-prefix.js"), "utf8") === `${addedBase.join("\n")}\n`,
    },
    history: { deleted: "---", added: ["++history;", "++ b/history"] },
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
      "R3-1 special diff prefix rendering and actions: passed",
      "Cleanup: browser, Vite server, fixture backend, and temporary repositories completed",
      "",
    ].join("\n"),
  );
  console.log(`Git workbench diff-prefix verification passed\nEvidence: ${output}`);
}
