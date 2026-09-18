import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 文件树里「有颜色」的文件点开要摊 diff，而不是全文——改过的文件，用户点它是想看改了什么。
// 全文没被拿走：diff 头上有「查看文件全文」，切过去的全文又有「查看改动」，两边能互相回。
// 干净的文件照旧摊全文，并且不该多出一个「查看改动」。
//
// diff 本身还能在「单栏（统一视图）」和「并排（左右分栏）」之间切，选择记在 localStorage
// 里跨刷新保留；并排时连续的删除和新增要按位置对齐，一侧没有对应行时补空格。

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const FILE_TEXT = "const keep = 0;\nexport const value = 2;\n";
// 删 2 行、加 3 行：并排视图要把它们对齐成 3 行，最后一行左边补空。
// 中间那条 `" "` 是**文件里真有的空行**（上下文），它必须留着——跟末尾那个由 stdout
// 结尾换行产生的空 token 是两回事，后者不该变成一行。
const DIFF_TEXT = [
  "diff --git a/changed.ts b/changed.ts",
  "index 1111111..2222222 100644",
  "--- a/changed.ts",
  "+++ b/changed.ts",
  "@@ -1,5 +1,6 @@",
  " const keep = 0;",
  "-export const value = 1;",
  "-export const gone = 3;",
  "+export const value = 2;",
  "+export const added = 4;",
  "+export const extra = 5;",
  " ",
  " const tail = 9;",
  "",
].join("\n");

// 无尾换行文件的一次替换：git 会在旧行和新行后面各插一条 `\ No newline`，它们不该把
// 这一处替换在并排视图里顶成上下两行。
const NO_NEWLINE_DIFF = [
  "diff --git a/nonl.ts b/nonl.ts",
  "index 3333333..4444444 100644",
  "--- a/nonl.ts",
  "+++ b/nonl.ts",
  "@@ -1 +1 @@",
  "-old value",
  "\\ No newline at end of file",
  "+new value",
  "\\ No newline at end of file",
  "",
].join("\n");

// 两个 hunk 的 diff：第一个开在文件第一行（它不指示任何断开，不该摆分隔条），第二个在
// 中间（摆一条分隔条，只写 git 给的上下文，不印 `@@ -20,4 +20,4 @@` 这串区间）。
const TWO_HUNK_DIFF = [
  "diff --git a/twohunks.ts b/twohunks.ts",
  "index 5555555..6666666 100644",
  "--- a/twohunks.ts",
  "+++ b/twohunks.ts",
  "@@ -1,3 +1,3 @@",
  " const head = 0;",
  "-const first = 1;",
  "+const first = 2;",
  "@@ -20,4 +20,4 @@ function tail() {",
  "   const inner = 0;",
  "-  return inner + 1;",
  "+  return inner + 2;",
  " }",
  "",
].join("\n");

// 纯重命名：整段 diff 只有文件头，格式行摘掉之后一行内容都不剩——得摆一句话，不能留白。
const RENAME_DIFF = [
  "diff --git a/old-name.ts b/renamed.ts",
  "similarity index 100%",
  "rename from old-name.ts",
  "rename to renamed.ts",
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
  entries: [entry("changed.ts"), entry("nonl.ts"), entry("twohunks.ts"), entry("renamed.ts"), entry("clean.ts")],
  truncated: false,
  git: {
    changes: [
      { path: "changed.ts", origPath: null, kind: "modified", source: "unstaged" },
      { path: "nonl.ts", origPath: null, kind: "modified", source: "unstaged" },
      { path: "twohunks.ts", origPath: null, kind: "modified", source: "unstaged" },
      { path: "renamed.ts", origPath: "old-name.ts", kind: "renamed", source: "unstaged" },
    ],
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
        diff: url.searchParams.get("path") === "nonl.ts"
          ? NO_NEWLINE_DIFF
          : url.searchParams.get("path") === "twohunks.ts"
            ? TWO_HUNK_DIFF
            : url.searchParams.get("path") === "renamed.ts" ? RENAME_DIFF : DIFF_TEXT,
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
  await center.getByText("-export const value = 1;", { exact: false }).waitFor();
  // StrictMode 下 effect 会跑两遍，所以只看「取的是哪一段」和「有没有再取一次」，不数绝对次数。
  assert.deepEqual(diffCalls.at(-1), { path: "changed.ts", source: "unstaged" }, "没有按改动所在的那一侧去取 diff");
  const afterOpen = diffCalls.length;
  assert.equal(await center.locator(".scm-diff__counts i").innerText(), "+3");
  assert.equal(await center.locator(".scm-diff__counts em").innerText(), "−2");
  assert.equal(await fileView.count(), 0, "有改动的文件不该同时摊出全文视图");
  assert.equal(await row("changed.ts").getAttribute("class").then((value) => value?.includes("is-active")), true,
    "摊的是 diff，文件树里这一行照样要高亮");
  await page.screenshot({ path: "/tmp/ash-file-diff-view-diff.png", fullPage: true });

  // 单栏 ↔ 并排。默认单栏（统一视图），切过去左右各一栏。
  const code = center.locator(".single-review-code");
  const toSplit = center.getByRole("button", { name: "并排对比（左右分栏）" });
  const toUnified = center.getByRole("button", { name: "单栏对比（统一视图）" });
  assert.equal(await code.getAttribute("class").then((value) => value?.includes("is-split")), false, "默认应当是单栏");
  assert.equal(await toUnified.getAttribute("aria-pressed"), "true");
  await toSplit.click();
  await center.locator(".single-review-code.is-split").waitFor();
  assert.equal(await toSplit.getAttribute("aria-pressed"), "true");

  const pairs = center.locator(".single-review-line.is-pair");
  const sideText = async (index, side) => (await pairs.nth(index).locator(".single-review-side").nth(side).locator("code").innerText()).trim();
  const sideLine = async (index, side) => (await pairs.nth(index).locator(".single-review-side").nth(side).locator("span").innerText()).trim();
  // 上下文 1 行 + 配对后的 3 行改动 + 文件里真有的那条空行 + 上下文 1 行。diff 文本末尾
  // 那个换行是行分隔符的尾巴，不该再变成第 7 行。
  assert.equal(await pairs.count(), 6, "删 2 加 3 没有被对齐成 3 行，或末尾多出了不存在的空行");
  assert.equal(await sideText(0, 0), "const keep = 0;");
  assert.equal(await sideText(0, 1), "const keep = 0;");
  assert.equal(await sideText(1, 0), "export const value = 1;", "左栏应当是改之前那一份");
  assert.equal(await sideText(1, 1), "export const value = 2;", "右栏应当是改之后那一份");
  assert.equal(await sideText(3, 0), "", "删除比新增少的那一行，左边补空");
  assert.equal(await sideText(3, 1), "export const extra = 5;");
  assert.equal(await pairs.nth(3).locator(".single-review-side").first().getAttribute("class").then((v) => v?.includes("is-empty")), true,
    "补出来的空位没有标成 is-empty");
  assert.equal(await sideLine(1, 0), "2", "左栏行号应当按旧文件数");
  assert.equal(await sideLine(5, 1), "6", "右栏行号应当按新文件数");
  // 文件里真有的空行照常占一行、两侧都有行号，不能被「丢掉结尾空 token」顺手吞掉。
  assert.equal(await sideText(4, 0), "", "真实的空上下文行不见了");
  assert.equal(await sideLine(4, 0), "4");
  assert.equal(await sideLine(4, 1), "5");
  assert.equal(await pairs.nth(4).locator(".single-review-side").first().getAttribute("class").then((v) => v?.includes("is-empty")), false,
    "真实的空上下文行被当成了补出来的空位");
  // diff 的**格式行**不摆出来：`diff --git` / `index` / `---` / `+++` 是传输格式而不是
  // 文件内容（路径和增删数在标题栏上已经有了），开在第一行的那个段头也不指示任何断开。
  assert.equal(await center.locator(".single-review-line.is-hunk").count(), 0,
    "开在文件第一行的段头不该再摆一条分隔条");
  const splitText = await code.innerText();
  for (const noise of ["@@", "diff --git", "index 1111111", "--- a/", "+++ b/"]) {
    assert(!splitText.includes(noise), `diff 的格式行还印在正文里：${noise}`);
  }
  await page.screenshot({ path: "/tmp/ash-file-diff-view-split.png", fullPage: true });

  // 中间的段头 → 一条分隔条：只写 git 给的上下文（所在函数），不印 `@@ -20,4 +20,4 @@`。
  await row("twohunks.ts").click();
  await center.getByText("const first = 2;", { exact: false }).waitFor();
  const splitDividers = center.locator(".single-review-line.is-span.is-hunk");
  assert.equal(await splitDividers.count(), 1, "两个 hunk 里只有中间那个该摆分隔条");
  assert.equal(await splitDividers.locator("code").innerText(), "⋯ function tail() {");
  assert(!(await code.innerText()).includes("@@"), "分隔条上还印着 `@@` 区间");
  await page.screenshot({ path: "/tmp/ash-file-diff-view-hunk-split.png", fullPage: true });
  await row("changed.ts").click();
  await center.getByText("export const gone = 3;", { exact: false }).waitFor();

  // 无尾换行的文件：`\ No newline` 是上一行的属性，不能把同一处替换顶成上下两行。
  await row("nonl.ts").click();
  await center.getByText("old value", { exact: false }).waitFor();
  assert.equal(await pairs.count(), 1, "`\\ No newline` 把同一处替换拆成了两行，或末尾多出了不存在的空行");
  // innerText 不给 margin 留空格，所以标记是紧跟在正文后面的。
  assert.equal(await sideText(0, 0), "old value无尾换行", "左栏丢了改之前那一行或它的无尾换行标记");
  assert.equal(await sideText(0, 1), "new value无尾换行", "右栏丢了改之后那一行或它的无尾换行标记");
  assert.equal(await center.locator(".single-review-line.is-span.is-meta code")
    .filter({ hasText: "No newline" }).count(), 0, "无尾换行标记不该再单独占一行");
  await page.screenshot({ path: "/tmp/ash-file-diff-view-no-newline.png", fullPage: true });
  await row("changed.ts").click();
  await center.getByText("const keep = 0;", { exact: false }).first().waitFor();

  // 选择跨刷新保留，是「我习惯怎么读 diff」而不是某个文件的属性。
  await page.reload();
  await row("changed.ts").click();
  await center.locator(".single-review-code.is-split").waitFor();
  await toUnified.click();
  await center.locator(".single-review-code.is-split").waitFor({ state: "detached" });
  await center.getByText("-export const gone = 3;", { exact: false }).waitFor();
  // 单栏里 `\ No newline` 仍旧是独立的一行——并排只是把它换了个挂法，不是把它吞掉。
  await row("nonl.ts").click();
  await center.getByText("No newline at end of file", { exact: false }).first().waitFor();
  await row("changed.ts").click();
  await center.getByText("-export const gone = 3;", { exact: false }).waitFor();

  // 单栏里的分隔条：行号栏摆一个「⋯」，正文位置只有上下文。
  await row("twohunks.ts").click();
  await center.getByText("-  return inner + 1;", { exact: false }).waitFor();
  const unifiedDividers = center.locator(".single-review-line.is-hunk");
  assert.equal(await unifiedDividers.count(), 1, "单栏里也只有中间那个段头该摆分隔条");
  assert.equal((await unifiedDividers.locator("code").innerText()).trim(), "function tail() {");
  assert.equal((await unifiedDividers.locator("span").first().innerText()).trim(), "⋯");
  assert(!(await code.innerText()).includes("@@"), "单栏的分隔条上还印着 `@@` 区间");
  await page.screenshot({ path: "/tmp/ash-file-diff-view-hunk-unified.png", fullPage: true });

  // 只有文件头的 diff（纯重命名）：摘掉格式行就空了，得摆一句话而不是留白。
  await row("renamed.ts").click();
  await center.getByText("没有内容改动", { exact: false }).waitFor();
  assert.equal(await center.locator(".single-review-line").count(), 0, "纯重命名不该摆出任何 diff 行");
  await row("changed.ts").click();
  await center.getByText("-export const gone = 3;", { exact: false }).waitFor();

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
