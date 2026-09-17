import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// **SCM 面板的文件清单：平铺 / 目录树两种摆法。**
//
// 钉住的是四件靠读代码看不出来、改坏了也不会报错的事：
//
//   ① 默认仍是平铺（原样），切过去才是树——这是个偏好，不是新默认；
//   ② 树里**单链目录压成一行**（`src/chat` 而不是两行两级缩进），面板就那么窄，
//      每多一级缩进文件名就被切掉一截；
//   ③ 两处切换入口（分支栏、「已提交的改动」标题栏）共用同一份偏好，且刷新后还在——
//      清单在滚动面板下半截，只留顶上一处等于让人先滚回去再切；
//   ④ 目录行上的批量操作**只作用于这个目录下的文件**。这条最要命：它送错一个路径，
//      用户丢弃的就是他没看见的东西。

const root = fileURLToPath(new URL("..", import.meta.url));
const change = (path, kind = "modified") => ({ path, origPath: null, kind, conflict: null, nested: false });
const status = {
  branch: { head: "main", detached: false, oid: "abc1234", upstream: null, ahead: null, behind: null },
  merge: [],
  staged: [],
  unstaged: [
    change("server/src/chat/service.ts"),
    change("server/src/chat/context.ts"),
    change("server/scripts/test-chat.ts"),
    change("README.md"),
  ],
  untracked: [],
  truncated: false,
  operation: null,
};
const overview = {
  root: { path: "/tmp/repo", branch: "main", gitRepo: true, source: "session" },
  taskRunning: false,
  readOnly: null,
  status,
  commits: [],
};
const branchDiff = {
  available: true,
  sourceBranch: "ash/x",
  targetBranch: "main",
  mergeBase: "abc1234",
  diff: "",
  files: [
    { path: "server/src/chat/service.ts", additions: 5, deletions: 2, origPath: null },
    { path: "server/scripts/test-chat-review.ts", additions: 5, deletions: 5, origPath: null },
  ],
  truncated: false,
  limitBytes: 1024 * 1024,
};

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/scm-stale.html`;

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage();

  let stagedPaths = null;
  await page.route("**/api/tasks/t1/scm", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(overview) }));
  await page.route("**/api/tasks/t1/diff", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(branchDiff) }));
  await page.route("**/api/tasks/t1/scm/stage", async (route) => {
    stagedPaths = JSON.parse(route.request().postData() ?? "{}").paths ?? null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      ok: true, affected: stagedPaths?.length ?? 0, status,
    }) });
  });

  await page.goto(url);
  const branchToggle = page.locator(".scm-branch__tools .scm-layout-toggle");
  const committedToggle = page.locator(".scm-committed__layout");
  await branchToggle.waitFor();

  // ① 默认平铺：一行一个文件，所在目录跟在文件名后面，没有目录行。
  assert.equal(await page.locator(".scm-row--dir").count(), 0, "默认应当是平铺，不该冒出目录行");
  assert.equal(
    await page.locator(".scm-group.is-unstaged .scm-row__dir").first().innerText(),
    "server/src/chat",
    "平铺模式下所在目录写在行里——这一截没了就不知道改的是哪个 service.ts",
  );
  assert.equal(await branchToggle.getAttribute("aria-label"), "按目录树展示文件",
    "按钮说的是「按下去会变成什么」，不是「现在是什么」");

  // ② 切到树：单链目录压成一行，公共前缀只写一次。
  await branchToggle.click();
  const dirRows = page.locator(".scm-group.is-unstaged .scm-row--dir");
  await dirRows.first().waitFor();
  assert.deepEqual(
    await dirRows.locator(".scm-row__folder").allInnerTexts(),
    ["server", "scripts", "src/chat"],
    "`server/src/chat` 中间那层既没有别的文件也没有别的兄弟目录，摊开来只是在浪费缩进",
  );
  assert.equal(await page.locator(".scm-group.is-unstaged .scm-row__dir").count(), 0,
    "目录已经由目录行说明了，行里再写一遍就是重复");
  await page.getByRole("button", { name: "service.ts" }).first().waitFor();

  // ③ 两处入口共用一份偏好：顶上切了，下半截那颗也得跟着翻过来。
  assert.equal(await committedToggle.getAttribute("aria-label"), "按平铺列表展示文件",
    "两处切换是同一份偏好，切一处另一处必须跟着变");
  // 「已提交的改动」同样成树，目录行上是这个目录下的加减行数合计。
  const committedDirs = page.locator(".scm-committed .scm-row--dir");
  assert.deepEqual(await committedDirs.locator(".scm-row__folder").allInnerTexts(), ["server", "scripts", "src/chat"]);
  assert.equal(await committedDirs.first().locator(".scm-diff__counts").innerText(), "+10\n−7",
    "目录行的加减是它底下所有文件的合计");

  // ④ 目录行的批量操作只作用于这个目录下的文件——送错一个路径，用户改的就是他没看见的东西。
  await page.getByRole("button", { name: "暂存 src/chat 下的 2 个文件" }).click();
  await page.waitForFunction(() => document.querySelector("#notice")?.textContent?.includes("已暂存"));
  assert.deepEqual(stagedPaths, ["server/src/chat/context.ts", "server/src/chat/service.ts"],
    "只送这个目录下的两个，同分组里 scripts/ 和 README.md 一个都不许跟着走");

  // ⑤ 折叠：目录行按下去，它底下的东西整个收起来，同级的不受影响。
  await page.getByRole("button", { name: "server（3 个文件）" }).click();
  await page.waitForFunction(() =>
    !Array.from(document.querySelectorAll(".scm-group.is-unstaged .scm-row__name"))
      .some((node) => node.textContent?.includes("service.ts")));
  assert.equal(await page.locator(".scm-group.is-unstaged .scm-row__name", { hasText: "README.md" }).count(), 1,
    "折叠的是 server/，根上那个文件跟它没关系");

  // ⑥ 偏好是存下来的：刷新之后还在树上，而不是弹回平铺。
  await page.reload();
  await page.locator(".scm-group.is-unstaged .scm-row--dir").first().waitFor();
  assert.equal(await page.locator(".scm-branch__tools .scm-layout-toggle").getAttribute("aria-label"), "按平铺列表展示文件");

  // ⑦ 切回平铺：回到原来的样子，目录行一个不留。
  await page.locator(".scm-branch__tools .scm-layout-toggle").click();
  await page.waitForFunction(() => document.querySelectorAll(".scm-row--dir").length === 0);
  assert.equal(
    await page.locator(".scm-group.is-unstaged .scm-row__dir").first().innerText(),
    "server/src/chat",
  );

  await page.close();
  console.log("scm file layout test passed");
} finally {
  await browser?.close();
  await server.close();
}
