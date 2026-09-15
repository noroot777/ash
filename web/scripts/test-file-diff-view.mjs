import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 文件树里「有颜色」的文件点开要摊 diff，而不是全文——改过的文件，用户点它是想看改了什么。
// 全文没被拿走：diff 头上有「查看文件全文」，切过去的全文又有「查看改动」，两边能互相回。
// 干净的文件照旧摊全文，并且不该多出一个「查看改动」。

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const FILE_TEXT = "export const value = 2;\n";
const DIFF_TEXT = [
  "diff --git a/changed.ts b/changed.ts",
  "index 1111111..2222222 100644",
  "--- a/changed.ts",
  "+++ b/changed.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "",
].join("\n");

const entry = (path, options = {}) => ({
  name: path.split("/").at(-1),
  path,
  kind: "file",
  size: 64,
  mtime: "2026-09-15T00:00:00.000Z",
  ignored: false,
  symlink: false,
  ...options,
});

const listing = {
  root: { path: "/tmp/file-diff-view", branch: "feature/open-diff", gitRepo: true, source: "session" },
  path: "",
  entries: [entry("changed.ts"), entry("clean.ts")],
  truncated: false,
  git: {
    changes: [{ path: "changed.ts", origPath: null, kind: "modified", source: "unstaged" }],
    truncated: false,
    error: null,
  },
};

const diffCalls = [];
let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1180, height: 700 } });
  await page.route("**/api/tasks/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/files")) return json(listing);
    if (url.pathname.endsWith("/scm/diff")) {
      diffCalls.push({ path: url.searchParams.get("path"), source: url.searchParams.get("source") });
      return json({
        path: url.searchParams.get("path"),
        origPath: null,
        source: url.searchParams.get("source"),
        diff: DIFF_TEXT,
        truncated: false,
        limitBytes: 256 * 1024,
        binary: false,
      });
    }
    if (url.pathname.endsWith("/file")) {
      const path = url.searchParams.get("path");
      return json({
        root: listing.root,
        file: {
          path,
          name: path.split("/").at(-1),
          size: FILE_TEXT.length,
          mtime: "2026-09-15T00:00:00.000Z",
          kind: "text",
          text: FILE_TEXT,
          truncated: false,
          absPath: `/tmp/file-diff-view/${path}`,
          mime: "text/plain",
        },
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/file-diff-view.html`);
  const row = (name) => page.locator(".file-tree__row").filter({ has: page.locator(".file-tree__name", { hasText: name }) }).first();
  const center = page.getByTestId("center");
  const diffView = center.locator("[aria-label='工作区改动']");
  const fileView = center.locator("[aria-label='文件查看']");
  const showFullText = center.getByRole("button", { name: "查看文件全文" });
  const showDiff = center.getByRole("button", { name: "查看改动" });

  await page.getByText("feature/open-diff", { exact: true }).waitFor();
  await page.getByTestId("center-empty").waitFor();

  // 有颜色的文件 → 对比。
  await row("changed.ts").click();
  await diffView.waitFor();
  await center.getByText("export const value = 1;", { exact: false }).waitFor();
  // StrictMode 下 effect 会跑两遍，所以只看「取的是哪一段」和「有没有再取一次」，不数绝对次数。
  assert.deepEqual(diffCalls.at(-1), { path: "changed.ts", source: "unstaged" }, "没有按改动所在的那一侧去取 diff");
  const afterOpen = diffCalls.length;
  assert.equal(await center.locator(".scm-diff__counts i").innerText(), "+1");
  assert.equal(await center.locator(".scm-diff__counts em").innerText(), "−1");
  assert.equal(await fileView.count(), 0, "有改动的文件不该同时摊出全文视图");
  assert.equal(await row("changed.ts").getAttribute("class").then((value) => value?.includes("is-active")), true,
    "摊的是 diff，文件树里这一行照样要高亮");
  await page.screenshot({ path: "/tmp/ash-file-diff-view-diff.png", fullPage: true });

  // diff → 全文 → 再切回 diff。
  await showFullText.click();
  await fileView.waitFor();
  await center.getByText(FILE_TEXT.trim(), { exact: false }).waitFor();
  await page.screenshot({ path: "/tmp/ash-file-diff-view-file.png", fullPage: true });
  assert.equal(await row("changed.ts").getAttribute("class").then((value) => value?.includes("is-active")), true,
    "切到全文后文件树丢了高亮");
  await showDiff.click();
  await diffView.waitFor();
  assert(diffCalls.length > afterOpen, "切回改动没有重新取 diff");
  const afterBack = diffCalls.length;

  // 干净的文件 → 全文，并且没有「查看改动」这个入口。
  await row("clean.ts").click();
  await fileView.waitFor();
  assert.equal(await showDiff.count(), 0, "没有改动的文件不该给「查看改动」");
  assert.equal(diffCalls.length, afterBack, "干净的文件不该去请求 diff");

  // 关掉就回会话，不是回到上一份 diff。
  await center.getByRole("button", { name: "关闭文件，回到会话" }).click();
  await page.getByTestId("center-empty").waitFor();
  await row("changed.ts").click();
  await diffView.waitFor();
  await center.getByRole("button", { name: "关闭 diff，回到会话" }).click();
  await page.getByTestId("center-empty").waitFor();

  console.log("file tree opens changed files as diff: ok");
} finally {
  await browser?.close();
  await server.close();
}
