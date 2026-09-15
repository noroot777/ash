import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const entry = (path, kind = "file", options = {}) => ({
  name: path.split("/").at(-1),
  path,
  kind,
  size: kind === "file" ? 128 : 0,
  mtime: "2026-09-14T00:00:00.000Z",
  ignored: false,
  symlink: false,
  ...options,
});
const change = (path, kind, source, origPath = null) => ({ path, origPath, kind, source });
const treeA = {
  root: [
    entry("src", "dir"),
    entry("staged.ts"),
    entry("new-note.md"),
    entry("conflict.txt"),
    entry("plain", "dir"),
    entry("temporary.txt"),
    entry("ignored.log", "file", { ignored: true }),
  ],
  src: [entry("src/features", "dir"), entry("src/clean.ts")],
  "src/features": [entry("src/features/deep", "dir"), entry("src/features/neighbor.ts")],
  "src/features/deep": [entry("src/features/deep/changed.ts")],
  plain: [entry("plain/untouched.txt")],
};
const treeB = {
  root: [entry("only-b.txt"), entry("b-folder", "dir")],
  "b-folder": [entry("b-folder/nested.txt")],
};
let treeAVersion = 0;
let gitA = {
  changes: [
    change("src/features/deep/changed.ts", "modified", "unstaged"),
    change("staged.ts", "added", "staged"),
    change("new-note.md", "untracked", "untracked"),
    change("conflict.txt", "unmerged", "unstaged"),
  ],
  truncated: false,
  error: null,
};
let rootError = null;
let delayNextARoot = false;
let resolveDelayedA;
let resolveDelayedAStarted;
const calls = [];

const listing = (taskId, path) => {
  const isA = taskId === "tree-a";
  const source = isA ? treeA : treeB;
  let entries = source[path || "root"] ?? [];
  if (isA && !path && treeAVersion > 0) {
    entries = entries.filter((item) => item.path !== "temporary.txt").concat(entry("generated.txt"));
  }
  return {
    root: {
      path: isA ? "/tmp/file-tree-a" : "/tmp/file-tree-b",
      branch: isA ? "feature/file-colors" : "feature/other-task",
      gitRepo: true,
      source: "session",
    },
    path,
    entries,
    truncated: false,
    ...(path === "" ? { git: isA ? gitA : { changes: [], truncated: false, error: null } } : {}),
  };
};

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
  await page.route("**/api/tasks/*/files?*", async (route) => {
    const url = new URL(route.request().url());
    const match = /^\/api\/tasks\/([^/]+)\/files$/.exec(url.pathname);
    assert(match, `unexpected file route: ${url.pathname}`);
    const taskId = decodeURIComponent(match[1]);
    const path = url.searchParams.get("path") ?? "";
    calls.push({ taskId, path });
    if (taskId === "tree-a" && path === "" && delayNextARoot) {
      delayNextARoot = false;
      resolveDelayedAStarted?.();
      await new Promise((resolve) => { resolveDelayedA = resolve; });
    }
    if (taskId === "tree-a" && path === "" && rootError) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: rootError }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(listing(taskId, path)) });
  });

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/file-tree-git.html`);
  const row = (name) => page.locator(".file-tree__row", { has: page.locator(".file-tree__name", { hasText: name }) });
  const exactRow = (name) => page.locator(".file-tree__row").filter({ has: page.locator(".file-tree__name", { hasText: name }) }).first();
  const gitKind = async (name) => exactRow(name).getAttribute("data-git-kind");
  const badge = (name) => exactRow(name).locator(".file-tree__git-badge");
  const nameColor = (name) => exactRow(name).locator(".file-tree__name").evaluate((node) => getComputedStyle(node).color);
  const elementColor = (locator) => locator.evaluate((node) => getComputedStyle(node).color);
  const tokenColor = (token) => page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${value})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
  const waitForARootResponse = () => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/tasks/tree-a/files" && url.searchParams.get("path") === "";
  });
  const waitForAPathResponse = (path) => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/tasks/tree-a/files" && url.searchParams.get("path") === path;
  });
  const refreshVisibleA = async () => {
    const response = waitForARootResponse();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await response;
  };

  await page.getByText("feature/file-colors", { exact: true }).waitFor();

  // 工作区根和折叠的目录都要承接最高优先级的深层改动；无关兄弟不能被误染。
  const head = page.locator(".file-tree__head");
  const branch = head.locator(".file-tree__where b");
  const branchIcon = branch.locator("svg");
  assert.equal(await head.getAttribute("data-git-kind"), "unmerged", "工作区根没有承接最高优先级的冲突色");
  assert.equal(await elementColor(branch), await tokenColor("--red"), "工作区分支名没有跟随根改动变色");
  assert.equal(await elementColor(branchIcon), await tokenColor("--red"), "工作区图标没有跟随根改动变色");
  assert.equal(await exactRow("src").getAttribute("aria-expanded"), "false");
  assert.equal(await gitKind("src"), "modified", "折叠的顶层祖先没有承接深层文件的改动色");
  assert.equal(await badge("src").innerText(), "●", "目录用圆点提示后代有改动");
  assert.equal(await gitKind("plain"), null, "无关兄弟目录被误染");
  assert.equal(await badge("plain").count(), 0, "无关兄弟目录不该有 Git 徽章");
  assert.equal(await row("ignored.log").count(), 0, "被忽略文件默认必须隐藏");

  // 新增、未跟踪、冲突分别保持种类、颜色和徽章。
  const green = await tokenColor("--green");
  const red = await tokenColor("--red");
  assert.equal(await gitKind("staged.ts"), "added");
  assert.equal(await badge("staged.ts").innerText(), "A");
  assert.equal(await nameColor("staged.ts"), green, "已暂存新增文件应使用绿色");
  assert.equal(await gitKind("new-note.md"), "untracked");
  assert.equal(await badge("new-note.md").innerText(), "U");
  assert.equal(await nameColor("new-note.md"), green, "未跟踪文件应使用绿色");
  assert.equal(await gitKind("conflict.txt"), "unmerged");
  assert.equal(await badge("conflict.txt").innerText(), "!");
  assert.equal(await nameColor("conflict.txt"), red, "冲突文件应使用红色");

  // Git 返回的降级状态也必须可见，并在下一次成功刷新后自行恢复。
  const decoratedGit = gitA;
  gitA = { ...decoratedGit, truncated: true };
  await refreshVisibleA();
  await page.getByText("Git 改动过多，部分文件和目录的标识未显示", { exact: true }).waitFor();
  gitA = { changes: [], truncated: false, error: "git status 暂时失败" };
  await refreshVisibleA();
  await page.getByText("Git 状态读取失败，改动标识暂不可用：git status 暂时失败", { exact: true }).waitFor();
  assert.equal(await head.getAttribute("data-git-kind"), null, "Git 错误时不应保留上一轮根颜色");
  gitA = decoratedGit;
  await refreshVisibleA();
  await page.getByText("git status 暂时失败", { exact: false }).waitFor({ state: "detached" });
  await page.getByText("Git 改动过多，部分文件和目录的标识未显示", { exact: true }).waitFor({ state: "detached" });
  assert.equal(await head.getAttribute("data-git-kind"), "unmerged", "Git 状态恢复后根颜色没有回来");

  // 展开多层后，每层祖先和最终文件都要保色；选中态也不能盖掉 Git 色。
  await exactRow("src").click();
  await exactRow("features").waitFor();
  await exactRow("features").click();
  await exactRow("deep").waitFor();
  await exactRow("deep").click();
  await exactRow("changed.ts").waitFor();
  for (const name of ["src", "features", "deep", "changed.ts"]) {
    assert.equal(await gitKind(name), "modified", `${name} 没有保持修改色`);
  }
  await exactRow("changed.ts").click();
  await page.getByTestId("active-path").filter({ hasText: "src/features/deep/changed.ts" }).waitFor();
  assert.equal(await exactRow("changed.ts").getAttribute("class").then((value) => value?.includes("is-active")), true);
  assert.equal(await nameColor("changed.ts"), await tokenColor("--amber"), "选中背景盖掉了文件的 Git 色");

  // 有颜色的文件点开走对比；改动在哪一侧就比哪一侧。干净的文件仍然摊全文。
  const openedAs = () => page.getByTestId("opened-as").innerText();
  assert.equal(await openedAs(), "diff:unstaged", "工作区改动的文件没有用对比打开");
  await exactRow("staged.ts").click();
  await page.getByTestId("active-path").filter({ hasText: "staged.ts" }).waitFor();
  assert.equal(await openedAs(), "diff:staged", "已暂存的文件没有比暂存那一侧");
  await exactRow("new-note.md").click();
  await page.getByTestId("active-path").filter({ hasText: "new-note.md" }).waitFor();
  assert.equal(await openedAs(), "diff:untracked", "未跟踪文件没有用对比打开");
  await exactRow("conflict.txt").click();
  await page.getByTestId("active-path").filter({ hasText: "conflict.txt" }).waitFor();
  assert.equal(await openedAs(), "diff:unstaged", "冲突文件应当比工作树那一侧");
  await exactRow("clean.ts").click();
  await page.getByTestId("active-path").filter({ hasText: "src/clean.ts" }).waitFor();
  assert.equal(await openedAs(), "file", "没有改动的文件不该被当成对比打开");
  await exactRow("changed.ts").click();
  await page.getByTestId("active-path").filter({ hasText: "src/features/deep/changed.ts" }).waitFor();

  // 手动刷新会刷新根和所有展开层，并保留展开状态。
  const beforeManual = calls.length;
  const manualResponses = Promise.all(["", "src", "src/features", "src/features/deep"].map(waitForAPathResponse));
  await page.getByRole("button", { name: "重新读取文件列表" }).click();
  await manualResponses;
  await page.waitForFunction(() => !document.querySelector('button[aria-label="重新读取文件列表"]')?.hasAttribute("disabled"));
  await exactRow("changed.ts").waitFor();
  assert(calls.slice(beforeManual).some((call) => call.path === ""), "手动刷新没有重拉根目录");
  assert(calls.slice(beforeManual).some((call) => call.path === "src/features/deep"), "手动刷新没有重拉展开层");

  // 模拟提交和磁盘文件增删。等真实 5 秒轮询，不点刷新：装饰消失、列表同步变化。
  gitA = { changes: [], truncated: false, error: null };
  treeAVersion = 1;
  await page.waitForTimeout(5300);
  await page.locator(".file-tree__row[data-git-kind]").waitFor({ state: "detached" });
  assert.equal(await head.getAttribute("data-git-kind"), null, "提交后工作区根仍残留 Git 颜色");
  assert.equal(await elementColor(branch), await tokenColor("--ink"), "提交后分支名没有恢复普通颜色");
  assert.equal(await elementColor(branchIcon), await tokenColor("--accent"), "提交后工作区图标没有恢复普通颜色");
  assert.equal(await page.getByText("temporary.txt", { exact: true }).count(), 0, "已删除的目录项没有被轮询移除");
  await page.getByText("generated.txt", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "重新读取文件列表" }).getAttribute("disabled"), null);
  assert.equal(await row("ignored.log").count(), 0, "自动刷新后 ignored 文件漏了出来");

  // 根列表失败要给出持久错误；下一次可见性刷新成功后自动恢复。
  rootError = "文件树暂时不可读";
  await refreshVisibleA();
  await page.getByText("文件树暂时不可读", { exact: true }).waitFor();
  rootError = null;
  await refreshVisibleA();
  await page.getByText("文件树暂时不可读", { exact: true }).waitFor({ state: "detached" });
  await page.getByText("generated.txt", { exact: true }).waitFor();

  // A 的刷新挂起时切到 B；A 的旧响应晚到后不能覆盖 B 的根、分支或文件。
  delayNextARoot = true;
  const delayedAStarted = new Promise((resolve) => { resolveDelayedAStarted = resolve; });
  await page.getByRole("button", { name: "重新读取文件列表" }).click();
  await delayedAStarted;
  await page.getByTestId("task-b").click();
  await page.getByText("feature/other-task", { exact: true }).waitFor();
  await page.getByText("only-b.txt", { exact: true }).waitFor();
  resolveDelayedA?.();
  await page.waitForTimeout(250);
  assert.equal(await page.getByText("feature/file-colors", { exact: true }).count(), 0, "旧任务分支污染了新任务");
  assert.equal(await page.getByText("generated.txt", { exact: true }).count(), 0, "旧任务文件污染了新任务");
  assert.equal(await page.getByText("only-b.txt", { exact: true }).count(), 1);

  // 回到有装饰的 A，深浅主题都检查布局边界并保存可审阅截图。
  gitA = {
    changes: [
      change("src/features/deep/changed.ts", "modified", "unstaged"),
      change("staged.ts", "added", "staged"),
      change("new-note.md", "untracked", "untracked"),
      change("conflict.txt", "unmerged", "unstaged"),
    ],
    truncated: false,
    error: null,
  };
  await page.getByTestId("task-a").click();
  await page.getByText("feature/file-colors", { exact: true }).waitFor();
  await exactRow("src").click();
  await exactRow("features").waitFor();
  await exactRow("features").click();
  await exactRow("deep").waitFor();
  await exactRow("deep").click();
  await exactRow("changed.ts").waitFor();
  await exactRow("changed.ts").click();
  await page.getByTestId("active-path").filter({ hasText: "src/features/deep/changed.ts" }).waitFor();
  await page.getByTestId("theme-light").click();
  const host = page.getByTestId("file-tree-host");
  const lightBox = await host.boundingBox();
  assert(lightBox && lightBox.width === 390 && lightBox.height === 570, "浅色主题破坏了文件树布局尺寸");
  const widths = await host.evaluate((container) => ({
    content: container.clientWidth,
    tree: container.querySelector(".file-tree")?.getBoundingClientRect().width ?? 0,
  }));
  assert.equal(widths.tree, widths.content, "文件树本体没有占满容器内容区，fixture 可能误套了双栏布局类");
  await page.screenshot({ path: "/tmp/ash-file-tree-git-light.png", fullPage: true });

  await page.getByTestId("theme-dark").click();
  await page.getByTestId("fixture-state").filter({ hasText: "dark" }).waitFor();
  const darkBox = await host.boundingBox();
  assert.deepEqual(darkBox, lightBox, "深色主题切换导致文件树布局漂移");
  assert.notEqual(await nameColor("staged.ts"), green, "深色主题没有换用自己的 Git 颜色令牌");
  await page.screenshot({ path: "/tmp/ash-file-tree-git-dark.png", fullPage: true });

  console.log("file tree git decorations: ok");
} finally {
  await browser?.close();
  await server.close();
}
