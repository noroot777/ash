import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = join(repo, "server/scripts/fixtures/git-workbench-server.ts");
const output = process.env.GIT_WORKBENCH_REVIEW_FIX_OUTPUT
  || join(tmpdir(), "git-workbench-review-fixes");

function startBackend() {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture timeout\n${stderr}\n${stdout}`)), 15_000);
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

const backend = startBackend();
let browser;
let vite;
let fixtureDirectory;
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
  const baseLines = ["a", "b", "c", "last-no-eol"];
  writeFileSync(join(info.root, "noeol.txt"), baseLines.join("\n"));
  const regularBase = Array.from({ length: 40 }, (_, i) => `regular ${i + 1}`);
  writeFileSync(join(info.root, "regular.txt"), `${regularBase.join("\n")}\n`);
  git("add", "--", "noeol.txt", "regular.txt");
  git("commit", "-qm", "add review fix fixtures");
  writeFileSync(join(info.root, "noeol.txt"), ["a", "B", "c", "last-no-eol"].join("\n"));
  const regularChanged = [...regularBase];
  regularChanged[3] = "REGULAR FOUR";
  regularChanged[33] = "REGULAR THIRTY FOUR";
  writeFileSync(join(info.root, "regular.txt"), `${regularChanged.join("\n")}\n`);
  for (let i = 1; i <= 66; i += 1) {
    writeFileSync(join(info.root, "scroll-history.txt"), `history ${i}\n`);
    git("add", "--", "scroll-history.txt");
    git("commit", "-qm", `滚动提交 ${String(i).padStart(2, "0")}`);
  }
  for (let i = 1; i <= 30; i += 1) {
    const suffix = String(i).padStart(2, "0");
    git("branch", `menu/branch-${suffix}`, `HEAD~${i}`);
    git("tag", `menu-tag-${suffix}`, `HEAD~${i}`);
  }

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
  const url = new URL(`http://127.0.0.1:${address.port}/scripts/fixtures/git-workbench.html`);
  url.searchParams.set("project", info.projectId);
  url.searchParams.set("view", "git");
  url.searchParams.set("gitView", "changes");
  url.searchParams.set("gitRoot", info.root);
  await mkdir(output, { recursive: true });
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(url.href);
  await page.getByRole("navigation", { name: "Git 工作台视图" }).waitFor();
  const refresh = async () => {
    const response = page.waitForResponse(r => r.request().method() === "GET" && /\/git\/workbench\?/.test(r.url()));
    await page.getByLabel("工作台选项").click();
    await page.getByRole("menu", { name: "工作台选项" }).getByRole("menuitem", { name: "刷新 Git 工作台" }).click();
    await response;
  };
  const rowFor = (path, group) => page
    .locator(".gwb-file-group", { has: page.locator("header", { hasText: group }) })
    .locator(".gwb-file-row", { has: page.getByLabel(path, { exact: true }) });
  const submitTyped = async (title, word) => {
    const box = page.getByRole("dialog", { name: title });
    await box.getByLabel("输入目标以确认").fill(word);
    const response = page.waitForResponse(r => r.request().method() === "POST" && /\/git\/workbench\/actions$/.test(r.url()));
    await box.getByRole("button", { name: title, exact: true }).click();
    assert.equal((await response).ok(), true);
    await box.waitFor({ state: "detached" });
  };

  // 无尾换行：未暂存与已暂存都只允许整文件动作。
  await page.getByLabel("noeol.txt", { exact: true }).click();
  await page.getByLabel("Git 差异").waitFor();
  await page.locator(".gwb-diff-shell .gwb-banner", { hasText: "无末尾换行" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "丢弃此块", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "暂存此块", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /选择第 .* 行/ }).count(), 0);
  assert.match(await page.locator(".gwb-diff-shell").innerText(), /「暂存」.*「丢弃改动」.*整个文件/s);
  await page.screenshot({ path: join(output, "noeol-unstaged-whole-file-guidance.png") });
  const noeolRow = rowFor("noeol.txt", "未暂存");
  await noeolRow.hover();
  await noeolRow.getByLabel("暂存 noeol.txt").click();
  const stagedNoeol = rowFor("noeol.txt", "已暂存");
  await stagedNoeol.waitFor();
  await stagedNoeol.getByLabel("noeol.txt", { exact: true }).click();
  await page.locator(".gwb-diff-shell .gwb-banner", { hasText: "取消暂存" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "取消暂存此块", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /选择第 .* 行/ }).count(), 0);
  assert.match(await page.locator(".gwb-diff-shell").innerText(), /「取消暂存」.*整个文件/s);
  await page.screenshot({ path: join(output, "noeol-staged-whole-file-guidance.png") });
  await stagedNoeol.hover();
  await stagedNoeol.getByLabel("取消暂存 noeol.txt").click();
  const unstagedNoeol = rowFor("noeol.txt", "未暂存");
  await unstagedNoeol.waitFor();
  await unstagedNoeol.getByLabel("noeol.txt", { exact: true }).click();
  await page.locator(".gwb-diff-shell .gwb-banner", { hasText: "丢弃改动" }).waitFor();
  await page.getByRole("button", { name: "丢弃改动", exact: true }).click();
  await submitTyped("丢弃未暂存改动", "丢弃");
  assert.equal(readFileSync(join(info.root, "noeol.txt"), "utf8"), baseLines.join("\n"));

  // 常规双 hunk 的块丢弃仍准确保留另一块。
  await page.getByLabel("regular.txt", { exact: true }).click();
  const discardHunks = page.getByRole("button", { name: "丢弃此块", exact: true });
  await discardHunks.first().waitFor();
  assert.equal(await discardHunks.count(), 2);
  await discardHunks.first().click();
  await submitTyped("丢弃这个改动块", "丢弃");
  const regularAfter = readFileSync(join(info.root, "regular.txt"), "utf8");
  assert.match(regularAfter, /\nregular 4\n/);
  assert.match(regularAfter, /\nREGULAR THIRTY FOUR\n/);
  await page.screenshot({ path: join(output, "noeol-and-regular-actions.png") });

  const nav = page.getByRole("navigation", { name: "Git 工作台视图" });
  const assertExternalScrollCloses = async (view, scrollSelector, rowSelector, menuLabel, screenshot) => {
    await nav.getByRole("button", { name: new RegExp(`^${view}`) }).click();
    const row = rowSelector();
    await row.scrollIntoViewIfNeeded();
    const trigger = row.getByLabel(menuLabel);
    await trigger.click();
    const menu = page.getByRole("menu", { name: menuLabel });
    await menu.waitFor();
    await page.screenshot({ path: join(output, `${screenshot}-open.png`) });
    const scroll = page.locator(scrollSelector);
    const before = await scroll.evaluate(node => node.scrollTop);
    await scroll.evaluate(node => node.scrollBy(0, 500));
    assert((await scroll.evaluate(node => node.scrollTop)) > before, `${view} list must actually scroll`);
    await menu.waitFor({ state: "detached" });
    await page.screenshot({ path: join(output, `${screenshot}-closed.png`) });
  };
  await assertExternalScrollCloses(
    "历史",
    ".history-rows",
    () => page.locator(".gwb-commit-row", { hasText: "滚动提交 63" }),
    /提交操作$/,
    "history-menu-scroll",
  );
  await assertExternalScrollCloses(
    "分支",
    ".scroll-col",
    () => page.locator(".gwb-ref-row", { hasText: "menu/branch-04" }),
    "menu/branch-04 分支操作",
    "branch-menu-scroll",
  );
  await assertExternalScrollCloses(
    "标签",
    ".scroll-col",
    () => page.locator(".gwb-ref-row", { hasText: "menu-tag-04" }),
    "删除远端标签 menu-tag-04",
    "tag-menu-scroll",
  );

  // 菜单自身滚动不关闭；点击和键盘都保留原目标。
  await page.getByLabel("当前分支").click();
  let branchMenu = page.getByRole("menu", { name: "当前分支" });
  await branchMenu.evaluate(node => node.scrollBy(0, 500));
  assert((await branchMenu.evaluate(node => node.scrollTop)) > 0, "branch menu must actually scroll internally");
  await branchMenu.waitFor();
  await branchMenu.getByRole("menuitem", { name: "menu/branch-29", exact: true }).click();
  let checkout = page.getByRole("dialog", { name: "切换到 menu/branch-29" });
  await checkout.waitFor();
  await checkout.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByLabel("当前分支").click();
  branchMenu = page.getByRole("menu", { name: "当前分支" });
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  const keyboardTarget = await page.evaluate(() => document.activeElement?.textContent?.trim() || "");
  await page.keyboard.press("Enter");
  checkout = page.getByRole("dialog", { name: `切换到 ${keyboardTarget}` });
  await checkout.waitFor();
  await checkout.getByRole("button", { name: "取消", exact: true }).click();
  await page.screenshot({ path: join(output, "menu-internal-scroll-and-keyboard.png") });

  console.log(`Git workbench review fixes passed\nEvidence: ${output}`);
} catch (error) {
  const diagnostics = backend.diagnostics();
  throw new Error(`${error instanceof Error ? error.stack || error.message : String(error)}\n${diagnostics.stderr}\n${diagnostics.stdout}`);
} finally {
  await browser?.close();
  await vite?.close();
  await backend.close();
  if (fixtureDirectory) assert.equal(existsSync(fixtureDirectory), false);
}
