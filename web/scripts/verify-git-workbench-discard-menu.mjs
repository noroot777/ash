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
const output = process.env.GIT_WORKBENCH_DISCARD_MENU_OUTPUT
  || join(tmpdir(), "harness-git-workbench-discard-menu");

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
const discardGuidance = [
  "所选＋行会从文件中删除",
  "所选−行会恢复",
  "修改只选＋行时，被替换的原始行不会恢复",
  "只选−行时，新增内容会保留",
  "完整还原修改需同时勾选对应的 − / + 行",
];
const assertGuidance = async locator => {
  const text = await locator.innerText();
  for (const phrase of discardGuidance) assert(text.includes(phrase), `missing guidance: ${phrase}`);
};
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
  const baseLines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const basePair = `${baseLines.join("\n")}\n`;
  const pairPath = join(info.root, "pair.txt");
  const plusOnlyPath = join(info.root, "modify-plus.txt");
  const minusOnlyPath = join(info.root, "modify-minus.txt");
  const pairedPath = join(info.root, "modify-paired.txt");
  const stagedPath = join(info.root, "staged.txt");
  const otherPath = join(info.root, "other.txt");
  const modificationBase = prefix => Array.from(
    { length: 30 },
    (_, index) => `${prefix} ${index + 1}`,
  );
  const plusOnlyBase = modificationBase("plus");
  const minusOnlyBase = modificationBase("minus");
  const pairedBase = modificationBase("paired");
  writeFileSync(pairPath, basePair);
  writeFileSync(plusOnlyPath, `${plusOnlyBase.join("\n")}\n`);
  writeFileSync(minusOnlyPath, `${minusOnlyBase.join("\n")}\n`);
  writeFileSync(pairedPath, `${pairedBase.join("\n")}\n`);
  writeFileSync(stagedPath, "staged base\n");
  writeFileSync(otherPath, "other base\n");
  git(
    "add", "--",
    "pair.txt", "modify-plus.txt", "modify-minus.txt", "modify-paired.txt",
    "staged.txt", "other.txt",
  );
  git("commit", "-qm", "add discard browser fixtures");
  const changedLines = [...baseLines];
  changedLines.splice(10, 0, "CHANGE-A");
  changedLines.splice(14, 0, "CHANGE-B");
  writeFileSync(pairPath, `${changedLines.join("\n")}\n`);
  const plusOnlyChanged = [...plusOnlyBase];
  plusOnlyChanged[19] = "plus 20 EDITED";
  writeFileSync(plusOnlyPath, `${plusOnlyChanged.join("\n")}\n`);
  const minusOnlyChanged = [...minusOnlyBase];
  minusOnlyChanged[19] = "minus 20 EDITED";
  writeFileSync(minusOnlyPath, `${minusOnlyChanged.join("\n")}\n`);
  const pairedChanged = [...pairedBase];
  pairedChanged[19] = "paired 20 EDITED";
  writeFileSync(pairedPath, `${pairedChanged.join("\n")}\n`);
  writeFileSync(stagedPath, "staged change\n");
  git("add", "--", "staged.txt");
  writeFileSync(otherPath, "other worktree change\n");
  const preserved = {
    head: git("rev-parse", "HEAD"),
    index: git("write-tree"),
    cached: git("diff", "--cached", "--binary"),
    other: readFileSync(otherPath, "utf8"),
  };
  const fingerprint = () => ({
    pair: readFileSync(pairPath, "utf8"),
    head: git("rev-parse", "HEAD"),
    index: git("write-tree"),
    cached: git("diff", "--cached", "--binary"),
    other: readFileSync(otherPath, "utf8"),
  });

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
  let actionPosts = 0;
  page.on("request", request => {
    if (request.method() === "POST" && /\/git\/workbench\/actions$/.test(request.url())) {
      actionPosts += 1;
    }
  });
  await page.goto(url.href);
  await page.getByRole("navigation", { name: "Git 工作台视图" }).waitFor();
  const submitSelectionDiscard = async (currentDialog, expectedLines) => {
    await currentDialog.getByLabel("输入目标以确认").fill("丢弃");
    const actionRequest = page.waitForRequest(request =>
      request.method() === "POST" && /\/git\/workbench\/actions$/.test(request.url()),
    );
    const actionResponse = page.waitForResponse(response =>
      response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(response.url()),
    );
    await currentDialog.getByRole("button", { name: "丢弃所选改动", exact: true }).click();
    const body = (await actionRequest).postDataJSON();
    assert.equal(body.action.kind, "discard-patch");
    assert.deepEqual(body.action.lines, expectedLines);
    assert.equal((await actionResponse).ok(), true);
    await currentDialog.waitFor({ state: "detached" });
    return body;
  };
  await page.getByLabel("pair.txt", { exact: true }).click();
  await page.getByLabel("Git 差异").waitFor();

  const selectedA = page.getByRole("button", { name: /选择第 .* 行 \+CHANGE-A$/ });
  await selectedA.waitFor();
  const selectedLine = await diffIndex(selectedA);
  await selectedA.click();
  const hunkDiscard = page.getByRole("button", { name: "丢弃此块", exact: true });
  assert.equal(await hunkDiscard.count(), 1, "A and B must share one hunk");
  assert.equal(await hunkDiscard.isDisabled(), true, "hunk discard must disable while any row is selected");
  await page.getByText("已选 1 行", { exact: false }).waitFor();
  await assertGuidance(page.getByRole("note"));

  const beforeConfirm = fingerprint();
  await page.getByRole("button", { name: "丢弃所选改动", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "丢弃所选改动" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /逐行撤销勾选的 1 行差异/);
  await assertGuidance(dialog);
  await assertInsideViewport(dialog, 1200, 760, "desktop selection confirmation");
  await page.screenshot({ path: join(output, "discard-selection-confirm.png") });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(fingerprint(), beforeConfirm, "cancel must preserve every Git surface");
  assert.equal(await selectedA.getAttribute("aria-pressed"), "true", "cancel must preserve selection");
  assert.equal(await hunkDiscard.isDisabled(), true, "cancelled selection must keep hunk discard disabled");

  const postsBeforeWrong = actionPosts;
  await page.getByRole("button", { name: "丢弃所选改动", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "丢弃所选改动" });
  await dialog.getByLabel("输入目标以确认").fill("错误确认");
  const selectionConfirm = dialog.getByRole("button", { name: "丢弃所选改动", exact: true });
  assert.equal(await selectionConfirm.isDisabled(), true, "wrong confirmation must not be actionable");
  await dialog.getByLabel("输入目标以确认").press("Enter");
  await page.waitForTimeout(150);
  assert.equal(actionPosts, postsBeforeWrong, "wrong confirmation must not send an action");
  assert.deepEqual(fingerprint(), beforeConfirm, "wrong confirmation must not change files or Git state");
  await dialog.getByLabel("输入目标以确认").fill("丢弃");
  const selectedRequest = page.waitForRequest(request =>
    request.method() === "POST" && /\/git\/workbench\/actions$/.test(request.url()),
  );
  const selectedResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(response.url()),
  );
  await selectionConfirm.click();
  const request = await selectedRequest;
  const body = request.postDataJSON();
  assert.equal(body.action.kind, "discard-patch");
  assert.deepEqual(body.action.lines, [selectedLine], "selection discard must send only the selected diff row");
  assert.equal((await selectedResponse).ok(), true);
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: /选择第 .* 行 \+CHANGE-A$/ }).waitFor({ state: "detached" });
  const selectedB = page.getByRole("button", { name: /选择第 .* 行 \+CHANGE-B$/ });
  await selectedB.waitFor();
  const afterSelected = readFileSync(pairPath, "utf8");
  assert(!afterSelected.includes("CHANGE-A"), "selected A must be discarded");
  assert(afterSelected.includes("CHANGE-B"), "unselected B in the same hunk must survive");
  assert.equal(git("rev-parse", "HEAD"), preserved.head);
  assert.equal(git("write-tree"), preserved.index);
  assert.equal(git("diff", "--cached", "--binary"), preserved.cached);
  assert.equal(readFileSync(otherPath, "utf8"), preserved.other);
  await page.screenshot({ path: join(output, "discard-selection-result.png") });

  await selectedB.click();
  assert.equal(await hunkDiscard.isDisabled(), true);
  await page.getByRole("button", { name: "清除选择", exact: true }).click();
  assert.equal(await hunkDiscard.isEnabled(), true, "clear selection must restore hunk discard");
  await hunkDiscard.click();
  dialog = page.getByRole("dialog", { name: "丢弃这个改动块" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /还原这个改动块内的全部改动/);
  await dialog.getByLabel("输入目标以确认").fill("丢弃");
  const hunkResponse = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/git\/workbench\/actions$/.test(response.url()),
  );
  await dialog.getByRole("button", { name: "丢弃这个改动块", exact: true }).click();
  assert.equal((await hunkResponse).ok(), true);
  await dialog.waitFor({ state: "detached" });
  assert.equal(readFileSync(pairPath, "utf8"), basePair, "hunk discard must remove the remaining B change");
  assert.equal(git("rev-parse", "HEAD"), preserved.head);
  assert.equal(git("write-tree"), preserved.index);
  assert.equal(git("diff", "--cached", "--binary"), preserved.cached);
  assert.equal(readFileSync(otherPath, "utf8"), preserved.other);

  // 修改型差异只选 +：逐行撤销会删除新行，但不会恢复未选中的原始行。
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.getByLabel("modify-plus.txt", { exact: true }).click();
  const plusOld = page.getByRole("button", { name: /选择第 .* 行 -plus 20$/ });
  const plusNew = page.getByRole("button", { name: /选择第 .* 行 \+plus 20 EDITED$/ });
  await Promise.all([plusOld.waitFor(), plusNew.waitFor()]);
  const plusIndex = await diffIndex(plusNew);
  await plusNew.click();
  let guidance = page.getByRole("note");
  await guidance.waitFor();
  await assertGuidance(guidance);
  await guidance.scrollIntoViewIfNeeded();
  await assertInsideViewport(guidance, 1200, 760, "desktop discard guidance");
  await page.screenshot({ path: join(output, "modify-plus-selected-desktop.png") });
  await page.getByRole("button", { name: "丢弃所选改动", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "丢弃所选改动" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /逐行撤销勾选的 1 行差异/);
  await assertGuidance(dialog);
  const plusDialogRect = await assertInsideViewport(
    dialog, 1200, 760, "desktop modification confirmation",
  );
  await page.screenshot({ path: join(output, "modify-plus-confirm-desktop.png") });
  const plusBody = await submitSelectionDiscard(dialog, [plusIndex]);
  const plusExpected = plusOnlyBase.filter((_, index) => index !== 19);
  assert.equal(
    readFileSync(plusOnlyPath, "utf8"),
    `${plusExpected.join("\n")}\n`,
    "selecting only + must delete the edited line without restoring the unselected original",
  );
  assert.equal(git("status", "--porcelain", "--", "modify-plus.txt"), "M modify-plus.txt");
  assert.equal(git("rev-parse", "HEAD"), preserved.head);
  assert.equal(git("write-tree"), preserved.index);
  assert.equal(git("diff", "--cached", "--binary"), preserved.cached);
  assert.equal(readFileSync(otherPath, "utf8"), preserved.other);
  await page.screenshot({ path: join(output, "modify-plus-result.png") });

  // 修改型差异只选 -：恢复原始行，同时保留未选中的新增内容。
  await page.getByLabel("modify-minus.txt", { exact: true }).click();
  const minusOld = page.getByRole("button", { name: /选择第 .* 行 -minus 20$/ });
  const minusNew = page.getByRole("button", { name: /选择第 .* 行 \+minus 20 EDITED$/ });
  await Promise.all([minusOld.waitFor(), minusNew.waitFor()]);
  const minusIndex = await diffIndex(minusOld);
  await minusOld.click();
  guidance = page.getByRole("note");
  await assertGuidance(guidance);
  await page.getByRole("button", { name: "丢弃所选改动", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "丢弃所选改动" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /逐行撤销勾选的 1 行差异/);
  await assertGuidance(dialog);
  const minusBody = await submitSelectionDiscard(dialog, [minusIndex]);
  const minusExpected = [...minusOnlyChanged];
  minusExpected.splice(19, 0, "minus 20");
  assert.equal(
    readFileSync(minusOnlyPath, "utf8"),
    `${minusExpected.join("\n")}\n`,
    "selecting only - must restore the original and preserve the unselected edited line",
  );
  assert.equal(git("status", "--porcelain", "--", "modify-minus.txt"), "M modify-minus.txt");
  assert.equal(git("write-tree"), preserved.index, "line discard must not change staged content");

  // 修改型差异同时选择 -/+：在 390px 下完整还原，提示和确认框均不得裁切。
  await page.getByLabel("modify-paired.txt", { exact: true }).click();
  const pairedOld = page.getByRole("button", { name: /选择第 .* 行 -paired 20$/ });
  const pairedNew = page.getByRole("button", { name: /选择第 .* 行 \+paired 20 EDITED$/ });
  await Promise.all([pairedOld.waitFor(), pairedNew.waitFor()]);
  const pairedIndices = [await diffIndex(pairedOld), await diffIndex(pairedNew)];
  await page.setViewportSize({ width: 390, height: 844 });
  await pairedOld.click();
  await pairedNew.click();
  guidance = page.getByRole("note");
  await guidance.waitFor();
  await assertGuidance(guidance);
  await guidance.scrollIntoViewIfNeeded();
  const narrowGuidanceRect = await assertInsideViewport(
    guidance, 390, 844, "390px discard guidance",
  );
  const narrowLayout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.equal(narrowLayout.scrollWidth, narrowLayout.clientWidth, "390px selection must not overflow horizontally");
  await page.screenshot({ path: join(output, "modify-paired-selected-390.png") });
  await page.getByRole("button", { name: "丢弃所选改动", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "丢弃所选改动" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /逐行撤销勾选的 2 行差异/);
  await assertGuidance(dialog);
  const narrowDialogRect = await assertInsideViewport(
    dialog, 390, 844, "390px modification confirmation",
  );
  await page.screenshot({ path: join(output, "modify-paired-confirm-390.png") });
  const pairedBody = await submitSelectionDiscard(dialog, pairedIndices);
  assert.equal(
    readFileSync(pairedPath, "utf8"),
    `${pairedBase.join("\n")}\n`,
    "selecting both sides of a modification must restore the original file",
  );
  assert.equal(git("status", "--porcelain", "--", "modify-paired.txt"), "");
  assert.equal(git("rev-parse", "HEAD"), preserved.head);
  assert.equal(git("write-tree"), preserved.index);
  assert.equal(git("diff", "--cached", "--binary"), preserved.cached);
  assert.equal(readFileSync(otherPath, "utf8"), preserved.other);

  await page.setViewportSize({ width: 1200, height: 460 });
  const worktreeTrigger = page.getByLabel("选择工作树", { exact: true });
  await worktreeTrigger.click();
  const worktreeMenu = page.getByRole("menu", { name: "选择工作树" });
  await worktreeMenu.waitFor();
  assert.equal(await worktreeMenu.getByRole("menuitem").count(), 1);
  assert.equal(
    await worktreeMenu.evaluate(element => element === document.activeElement),
    true,
    "the panel must hold focus when the only item is the disabled current worktree",
  );
  const initialMenu = await box(worktreeMenu);
  const worktrees = [];
  for (let index = 1; index <= 8; index += 1) {
    const path = join(info.directory, `dynamic-worktree-${index}`);
    const branch = `browser/dynamic-worktree-${String(index).padStart(2, "0")}`;
    git("worktree", "add", "-q", "-b", branch, path, "HEAD");
    worktrees.push(path);
  }
  const pollingStarted = Date.now();
  await worktreeMenu.getByRole("menuitem").nth(8).waitFor({ timeout: 12_000 });
  await page.waitForFunction(() => {
    const menu = document.querySelector('[role="menu"][aria-label="选择工作树"]');
    return menu && menu.getBoundingClientRect().bottom <= window.innerHeight - 8;
  });
  const grownMenu = await box(worktreeMenu);
  const grownItems = await worktreeMenu.getByRole("menuitem").count();
  assert.equal(grownItems, 9, "the open picker must receive eight new worktrees from polling");
  assert(grownMenu.bottom <= 452, `grown picker bottom ${grownMenu.bottom} must stay inside 460px viewport`);
  assert(grownMenu.top < initialMenu.top, "a taller picker must move upward while remaining open");
  assert.equal(
    await worktreeMenu.evaluate(element => element === document.activeElement),
    true,
    "ResizeObserver repositioning must not reset focus to a newly enabled item",
  );
  const list = worktreeMenu.locator(".gwb-picker-list");
  const scroll = await list.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  assert(scroll.scrollHeight > scroll.clientHeight, "grown picker must have an internal scroll range");
  assert(scroll.scrollTop > 0, "internal picker scrolling must move the list");
  await worktreeMenu.waitFor();
  await page.screenshot({ path: join(output, "worktree-picker-grown.png") });

  await worktreeMenu.focus();
  for (const path of worktrees.slice(2)) git("worktree", "remove", "--force", path);
  await page.waitForFunction(() =>
    document.querySelectorAll('[role="menu"][aria-label="选择工作树"] [role="menuitem"]').length === 3,
  undefined, { timeout: 12_000 });
  await page.waitForFunction(() => {
    const menu = document.querySelector('[role="menu"][aria-label="选择工作树"]');
    return menu && menu.getBoundingClientRect().bottom <= window.innerHeight - 8;
  });
  const shrunkMenu = await box(worktreeMenu);
  assert(shrunkMenu.bottom <= 452, "shrunk picker must remain inside the viewport");
  assert(shrunkMenu.top > grownMenu.top + 20, "a shorter picker must move back toward its trigger");
  assert.equal(
    await worktreeMenu.evaluate(element => element === document.activeElement),
    true,
    "shrinking an open picker must not reset focus",
  );
  await page.screenshot({ path: join(output, "worktree-picker-shrunk.png") });

  const metrics = {
    url: url.href,
    discard: {
      selectedLine,
      selectedRequestLines: body.action.lines,
      head: preserved.head,
      index: preserved.index,
      cachedDiffPreserved: git("diff", "--cached", "--binary") === preserved.cached,
      otherFilePreserved: readFileSync(otherPath, "utf8") === preserved.other,
      modificationPlusOnly: {
        selectedLines: plusBody.action.lines,
        originalRestored: readFileSync(plusOnlyPath, "utf8").includes("plus 20\n"),
        editedPresent: readFileSync(plusOnlyPath, "utf8").includes("plus 20 EDITED"),
        lineCount: readFileSync(plusOnlyPath, "utf8").trimEnd().split("\n").length,
        dialog: plusDialogRect,
      },
      modificationMinusOnly: {
        selectedLines: minusBody.action.lines,
        originalPresent: readFileSync(minusOnlyPath, "utf8").includes("minus 20\n"),
        editedPresent: readFileSync(minusOnlyPath, "utf8").includes("minus 20 EDITED"),
        lineCount: readFileSync(minusOnlyPath, "utf8").trimEnd().split("\n").length,
      },
      modificationPaired: {
        selectedLines: pairedBody.action.lines,
        clean: git("status", "--porcelain", "--", "modify-paired.txt") === "",
        narrowGuidance: narrowGuidanceRect,
        narrowDialog: narrowDialogRect,
        narrowLayout,
      },
    },
    picker: {
      viewport: { width: 1200, height: 460 },
      initialItems: 1,
      grownItems,
      shrunkItems: 3,
      pollingObservedMs: Date.now() - pollingStarted,
      initialMenu,
      grownMenu,
      shrunkMenu,
      scroll,
    },
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
      "R2-1 line-discard guidance and modification semantics regression: passed",
      "F2 selected-row and restored hunk browser regression: passed",
      "F3 live worktree growth/shrink picker regression: passed",
      "Cleanup: browser, Vite server, fixture backend, and temporary repositories completed",
      "",
    ].join("\n"),
  );
  console.log(`Git workbench discard/menu verification passed\nEvidence: ${output}`);
}
