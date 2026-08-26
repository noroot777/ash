import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeExecutablePath } from "./chrome-path.mjs";
import { createServer } from "vite";

// **嵌套 Git 仓库那一行：看得见，但一个操作都不给。**
//
// `git status -uall` 会把自带 `.git` 的子目录整个当成一条未跟踪项列出来（`? vendor-lib/`），
// 而三个写操作没有一个对它成立：`git add` 要么 exit 128、要么静默建出一条 gitlink 子模块，
// `git clean -f` 一个字节都不删却照样退 0，`git diff --no-index` 以 1 退出而 1 正是「有差异」
// 的正常码——面板于是收到一份空 diff。服务端因此按「列出来、说清楚、不下手」处理
// （`git-workspace-ops.ts` 的 `withoutNested`）。这里钉住界面这一半：
//
//   ① 那一行不出逐条按钮，改摆一句「去哪操作」；行本身也不是按钮（没有 diff 可开）；
//   ② 组级操作照送整份清单，后端跳过的那部分要**跟着成功提示一起说出来**，不能只报
//      「已暂存 1 个文件」而用户点的是 2 行；
//   ③ 「暂存全部并提交（N）」的 N 是真会被提交的份数，不把下不了手的那条算进去。

const root = fileURLToPath(new URL("..", import.meta.url));
const change = (path, kind, nested = false) => ({ path, origPath: null, kind, conflict: null, nested });
const status = {
  branch: { head: "main", detached: false, oid: "abc1234", upstream: null, ahead: null, behind: null },
  merge: [],
  staged: [],
  unstaged: [],
  untracked: [change("notes.txt", "untracked"), change("vendor-lib", "untracked", true)],
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

  browser = await chromium.launch({ executablePath: await chromeExecutablePath(), headless: true });
  const page = await browser.newPage();

  let stagedPaths = null;
  let diffRequests = 0;
  await page.route("**/api/tasks/t1/scm", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(overview) }));
  await page.route("**/api/tasks/t1/scm/diff*", (route) => {
    diffRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      path: "vendor-lib", origPath: null, source: "untracked", diff: "", truncated: false, limitBytes: 1024, binary: false,
    }) });
  });
  await page.route("**/api/tasks/t1/scm/stage", async (route) => {
    stagedPaths = JSON.parse(route.request().postData() ?? "{}").paths ?? null;
    // 后端的真实回法：只处理得了 notes.txt，跳过的那条随成功一起交代。
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      ok: true,
      affected: 1,
      note: "已跳过 1 个嵌套 Git 仓库（只能在它自己的仓库里操作）：vendor-lib",
      status: { ...status, staged: [change("notes.txt", "added")], untracked: [change("vendor-lib", "untracked", true)] },
    }) });
  });

  await page.goto(url);
  await page.getByRole("button", { name: "暂存 notes.txt", exact: true }).waitFor();

  // ① 嵌套仓那一行：没有按钮，只有一句说明；点它也不该去拉 diff。
  assert.equal(await page.getByRole("button", { name: /vendor-lib/ }).count(), 0,
    "嵌套仓不许出现任何逐条按钮——按下去后端一律拒，摆着就是骗点击");
  const nestedRow = page.locator(".scm-row", { hasText: "vendor-lib" });
  assert.match(await nestedRow.innerText(), /嵌套仓库/, "得说清楚它是什么、该去哪操作");
  await nestedRow.click();
  await page.waitForTimeout(200);
  assert.equal(diffRequests, 0, "嵌套仓没有 diff 可预览（后端 409），行本身就不该是按钮");

  // ③ 数字只数真会被提交的那些：两行未跟踪，能提交的只有一个。
  assert.match(await page.locator(".scm-commit__submit").innerText(), /暂存全部并提交（1）/,
    "承诺 2 个、实际进去 1 个，就是在骗用户");

  // ② 组级操作照送整份清单，跳过的那部分要跟着成功提示说出来。
  await page.getByRole("button", { name: "未跟踪：全部暂存" }).click();
  const notice = page.locator("#notice");
  await notice.filter({ hasText: "已暂存" }).waitFor();
  assert.deepEqual(stagedPaths, ["notes.txt", "vendor-lib"], "组级操作送的是用户看见的那份列表");
  assert.match(await notice.innerText(), /已暂存 1 个文件/);
  assert.match(await notice.innerText(), /已跳过 1 个嵌套 Git 仓库.*vendor-lib/,
    "只报「已暂存 1 个」而用户点的是 2 行，差的那个要他自己去数");

  await page.close();
  console.log("scm nested ui test passed");
} finally {
  await browser?.close();
  await server.close();
}
