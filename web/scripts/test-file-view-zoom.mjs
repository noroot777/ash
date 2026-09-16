import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 中间栏摊开的文件全文 / 单文件 diff 也能放大：跟审查里的分支 diff 同一种层（`.zoom-layer`）
// ——铺满窗口、盖住左边的任务栏、让开右边的 inspector（文件树还要接着点）、Esc 退出。
//
// 放大态挂在 `useFileView` 上而不是各自组件里，所以这里重点钉两条别处测不到的：
// ① 在文件树里换一个文件、在 diff 与全文之间互切，放大都不该掉（组件换了，状态没换地方）；
// ② 关掉这一块内容就退出放大，下次打开是原样。

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const FILE_TEXT = "const keep = 0;\nexport const value = 2;\n";
const DIFF_TEXT = [
  "diff --git a/changed.ts b/changed.ts",
  "index 1111111..2222222 100644",
  "--- a/changed.ts",
  "+++ b/changed.ts",
  "@@ -1,2 +1,2 @@",
  " const keep = 0;",
  "-export const value = 1;",
  "+export const value = 2;",
  "",
].join("\n");

const entry = (path) => ({
  name: path.split("/").at(-1),
  path,
  kind: "file",
  size: 64,
  mtime: "2026-09-15T00:00:00.000Z",
  ignored: false,
  symlink: false,
});

const listing = {
  root: { path: "/tmp/file-view-zoom", branch: "feature/zoom", gitRepo: true, source: "session" },
  path: "",
  entries: [entry("changed.ts"), entry("clean.ts")],
  truncated: false,
  git: {
    changes: [{ path: "changed.ts", origPath: null, kind: "modified", source: "unstaged" }],
    truncated: false,
    error: null,
  },
};

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.route("**/api/tasks/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/files")) return json(listing);
    if (url.pathname.endsWith("/scm/diff")) {
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
          absPath: `/tmp/file-view-zoom/${path}`,
          mime: "text/plain",
        },
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/file-view-zoom.html`);

  const row = (name) => page.locator(".file-tree__row").filter({ has: page.locator(".file-tree__name", { hasText: name }) }).first();
  const zoomLayer = page.locator(".zoom-layer");
  const zoomButton = page.getByRole("button", { name: "放大", exact: true });
  const exitButton = page.getByRole("button", { name: "退出放大 · Esc" });
  const diffView = page.locator("[aria-label='工作区改动']");
  const fileView = page.locator("[aria-label='文件查看']");
  const inspector = page.locator("#fixture-inspector");

  await page.getByText("feature/zoom", { exact: true }).waitFor();
  await row("changed.ts").click();
  await diffView.waitFor();
  assert.equal(await zoomLayer.count(), 0, "默认不该是放大状态");

  await zoomButton.click();
  await zoomLayer.waitFor();

  // 铺满窗口，右边让开 inspector 那一列：放大是把文件铺开来看，文件树得留着继续点。
  const viewport = page.viewportSize();
  const inspectorBox = await inspector.boundingBox();
  assert.ok(
    viewport.width - (inspectorBox.x + inspectorBox.width) >= 8,
    "fixture 该保留右侧内边距，inspector 不能正好贴死窗口右缘",
  );
  const box = await zoomLayer.boundingBox();
  assert.deepEqual(
    { x: box.x, y: box.y, width: box.width, height: box.height },
    { x: 0, y: 0, width: inspectorBox.x, height: viewport.height },
    "放大层该占满 inspector 左边的整块窗口",
  );
  assert.equal(await zoomLayer.locator("[aria-label='工作区改动']").count(), 1, "放大的该是那份 diff 本身");

  // 左边的任务栏必须被盖住（钉住「portal 到 body」这个实现前提：主区自成堆叠上下文）。
  const rail = await page.locator("#fixture-rail").boundingBox();
  const overRail = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".zoom-layer"),
    [rail.x + rail.width / 2, rail.y + rail.height / 2],
  );
  assert.ok(overRail, "放大层该压住左边的任务栏");
  const overInspector = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest("#fixture-inspector"),
    [inspectorBox.x + inspectorBox.width / 2, inspectorBox.y + 20],
  );
  assert.ok(overInspector, "inspector 不该被放大层盖住");

  // 放大态下点「查看文件全文」：换的是同一块内容的另一种读法，放大不该掉。
  await zoomLayer.getByRole("button", { name: "查看文件全文" }).click();
  await zoomLayer.locator("[aria-label='文件查看']").waitFor();
  assert.equal(await zoomLayer.count(), 1, "diff → 全文 切换把放大态弄丢了");
  await zoomLayer.getByRole("button", { name: "查看改动" }).click();
  await zoomLayer.locator("[aria-label='工作区改动']").waitFor();
  assert.equal(await zoomLayer.count(), 1, "全文 → diff 切回来把放大态弄丢了");

  // 放大态下在文件树里换一个文件：inspector 是特意留出来给人点的，点它不算「点了外面」。
  await row("clean.ts").click();
  await zoomLayer.locator("[aria-label='文件查看']").waitFor();
  assert.equal(await zoomLayer.count(), 1, "点文件树换文件不该把放大层关掉");

  // Esc 退出，内容回到原位。
  await page.keyboard.press("Escape");
  await zoomLayer.waitFor({ state: "detached" });
  assert.equal(await page.locator("#fixture-main [aria-label='文件查看']").count(), 1, "退出放大后内容该回到原位");

  // 也能用按钮退出：只用鼠标的用户得有出口。
  await zoomButton.click();
  await zoomLayer.waitFor();
  await exitButton.click();
  await zoomLayer.waitFor({ state: "detached" });

  // 关掉这一块内容就退出放大：下次打开是原样，而不是莫名其妙又铺满一屏。
  await zoomButton.click();
  await zoomLayer.waitFor();
  await zoomLayer.getByRole("button", { name: "关闭文件，回到会话" }).click();
  await zoomLayer.waitFor({ state: "detached" });
  await page.getByTestId("center-empty").waitFor();
  await row("changed.ts").click();
  await diffView.waitFor();
  assert.equal(await zoomLayer.count(), 0, "关掉之后重新打开不该还是放大态");
  assert.equal(await fileView.count(), 0, "有改动的文件该摊 diff");

  console.log("file view zoom test passed");
} finally {
  await browser?.close();
  await server.close();
}
