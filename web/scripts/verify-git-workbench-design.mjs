import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const output = process.env.GIT_WORKBENCH_DESIGN_OUTPUT
  || join(tmpdir(), "harness-git-workbench-design-current");
const viewport = { width: 1440, height: 1000 };
const views = {
  changes: "变更",
  history: "历史",
  branches: "分支",
  stash: "贮藏",
  tags: "标签",
  worktrees: "工作树",
  log: "操作日志",
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
    const timer = setTimeout(() => reject(new Error(`fixture startup timeout\n${stderr}\n${stdout}`)), 15_000);
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const value = JSON.parse(line);
          if (value?.port && value?.projectId) {
            clearTimeout(timer);
            resolve(value);
            return;
          }
        } catch { /* wait for the readiness JSON */ }
      }
    });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`fixture exited before readiness (${code})\n${stderr}\n${stdout}`)));
  });
  const close = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once("exit", resolve));
    if (child.connected) child.send({ type: "close" });
    else child.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  return { ready, close };
}

const backend = startBackend();
let vite;
let browser;
try {
  const info = await backend.ready;
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
  const url = new URL(`http://127.0.0.1:${address.port}/scripts/fixtures/git-workbench-shell.html`);
  url.searchParams.set("project", info.projectId);
  url.searchParams.set("view", "git");
  url.searchParams.set("gitView", "changes");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport });
  const firstDiff = page.waitForResponse(response =>
    response.request().method() === "GET" && /\/git\/workbench\/diff/.test(response.url()));
  await page.goto(url.href);
  await page.evaluate(() => document.fonts.ready);
  await page.getByLabel("选择工作树").waitFor();
  await page.getByRole("region", { name: "工作区变更" }).waitFor();
  await firstDiff;
  await page.locator(".changes-list").waitFor();
  await mkdir(output, { recursive: true });

  const navigation = page.getByRole("navigation", { name: "Git 工作台视图" });
  const report = { url: url.href, viewport, output, views: {} };
  for (const [key, label] of Object.entries(views)) {
    await navigation.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    if (key === "history") {
      await page.getByRole("region", { name: "提交历史" }).locator(".commit-row").first().waitFor();
      await page.getByText("正在读取差异…").waitFor({ state: "detached" });
    }
    else if (key === "changes") await page.locator(".changes-list").waitFor();
    else await page.locator(".scroll-col").waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: join(output, `${key}.png`) });
    report.views[key] = await page.evaluate(() => {
      const box = selector => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      };
      return {
        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        workbench: box(".gwb"),
        header: box(".gwb-header"),
        shell: box(".gwb-shell"),
        changesList: box(".changes-list"),
        diffPane: box(".diff-pane"),
        historyList: box(".history-list"),
        detailPane: box(".detail-pane"),
        scrollColumn: box(".scroll-col"),
        workspaceSidebarCount: document.querySelectorAll(".workspace-sidebar").length,
      };
    });
  }

  for (const value of Object.values(report.views)) {
    assert.deepEqual(value.workbench, { x: 0, y: 0, width: 1440, height: 1000 });
    assert.deepEqual(value.header, { x: 0, y: 0, width: 1440, height: 46 });
    assert.deepEqual(value.shell, { x: 0, y: 46, width: 1440, height: 954 });
    assert.equal(value.document.width, viewport.width, "workbench must not overflow horizontally");
    assert.equal(value.workspaceSidebarCount, 0, "Git route must not render the ash task sidebar");
  }
  assert.equal(report.views.changes.changesList.width, 340);
  assert.equal(report.views.changes.diffPane.width, 950);
  assert.equal(report.views.history.historyList.width + report.views.history.detailPane.width, 1290);
  for (const key of ["branches", "stash", "tags", "worktrees", "log"])
    assert.equal(report.views[key].scrollColumn.width, 1290);

  const shellUrl = new URL(`http://127.0.0.1:${address.port}/scripts/fixtures/git-workbench-shell.html`);
  shellUrl.searchParams.set("project", info.projectId);
  await page.goto(shellUrl.href);
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".workspace-sidebar").waitFor();
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  assert.equal(new URL(page.url()).searchParams.get("scope"), "tasks", "G T must switch the real WorkspaceShell scope");
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  assert.equal(new URL(page.url()).searchParams.get("scope"), null, "a second G T must return to project scope");
  await page.locator(".workspace-git-context").click();
  await page.getByRole("button", { name: "打开 Git 工作台 →", exact: true }).click();
  await page.locator(".workspace-git-page").waitFor();
  await page.getByRole("navigation", { name: "Git 工作台视图" }).waitFor();
  const workspacePage = await page.locator(".workspace-git-page").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  assert.deepEqual(workspacePage, { x: 0, y: 0, width: 1440, height: 1000 });
  assert.equal(await page.locator(".workspace-sidebar").count(), 0, "real WorkspaceShell Git route must remove the task sidebar");
  await page.reload();
  await page.locator(".workspace-git-page").waitFor();
  assert.equal(await page.locator(".workspace-sidebar").count(), 0, "refresh must remain on the full-page Git route");
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await page.locator(".workspace-sidebar").waitFor();
  assert.equal(await page.locator(".workspace-git-page").count(), 0, "G T inside Git must close the full-page workbench");
  assert.equal(new URL(page.url()).searchParams.get("scope"), "tasks", "G T inside Git must switch to task scope");
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  assert.equal(new URL(page.url()).searchParams.get("scope"), null, "a second G T must return to project scope");
  await page.locator(".workspace-git-context").click();
  await page.getByRole("button", { name: "打开 Git 工作台 →", exact: true }).click();
  await page.locator(".workspace-git-page").waitFor();
  await page.getByLabel("退出 Git 工作台").click();
  await page.locator(".workspace-sidebar").waitFor();

  await writeFile(join(output, "metrics.json"), JSON.stringify(report, null, 2));
  console.log(`Git workbench design verification passed\nURL: ${url.href}\nScreenshots: ${output}`);
} finally {
  await browser?.close();
  await vite?.close();
  await backend.close();
}
