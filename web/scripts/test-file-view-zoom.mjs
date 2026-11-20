import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

// 点开的文件全文 / 单文件 diff / 文件夹详情摊在右侧面板「查看」那一格（宽格），会话和回复框
// 一直留着；放大时从面板里铺开，盖满整块工作区（连 inspector 一起，只让开底下的坞）、Esc 退出。
//
// 这里钉别处测不到的几条：
// ① 打开不替换会话：中间那一栏原样在，右侧多出一格宽格、切过去；
// ② 放大态挂在 `useFileView` 上：diff 与全文互切（组件换了一个）放大不掉；
// ③ 放大铺满工作区——内容本身就长在 inspector 里，再让开它就只剩左边半块；
// ④ 关掉这一块内容这一格就没了，回到点开之前看的那一格；点开前面板收着的，关掉再收起来；
// ⑤ 下次打开是原样，不是莫名其妙又铺满一屏；
// ⑥ 摊着的 Markdown 里再点别的文件在同一格换内容；窄屏下那一格盖在内容上，照样关得掉。

const root = fileURLToPath(new URL("..", import.meta.url));
const web = await startWebServer();

const FILE_TEXT = "const keep = 0;\nexport const value = 2;\n";
const MD_TEXT = "# 指南\n\n先看 [干净的那份](clean.ts)。\n";
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

const dirEntry = (path) => ({ ...entry(path), kind: "dir", size: 0 });

const listing = {
  root: { path: "/tmp/file-view-zoom", branch: "feature/zoom", gitRepo: true, source: "session" },
  path: "",
  entries: [dirEntry("nested"), entry("changed.ts"), entry("clean.ts")],
  truncated: false,
  git: {
    changes: [{ path: "changed.ts", origPath: null, kind: "modified", source: "unstaged" }],
    truncated: false,
    error: null,
  },
};

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.route("**/api/tasks/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/files")) return json(listing);
    if (url.pathname.endsWith("/file/overview")) {
      const path = url.searchParams.get("path");
      return json({
        root: listing.root,
        target: { path, name: path.split("/").at(-1), kind: "dir", size: 0, mtime: "2026-09-15T00:00:00.000Z", absPath: `/tmp/file-view-zoom/${path}`, symlink: false },
        stats: { files: 2, dirs: 0, bytes: 128, truncated: false },
        entries: [entry(`${path}/inner.ts`)],
        git: { repo: true, tracked: 2, dirty: 0, untracked: 0, untrackedSamples: [], error: null },
        trash: { available: true, label: "废纸篓", reason: null },
        readOnly: null,
        busy: { running: false, reason: null },
      });
    }
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
    if (url.pathname.endsWith("/file/locate")) {
      const { paths } = JSON.parse(route.request().postData() ?? "{}");
      return json({ entries: Object.fromEntries(paths.map((path) => [path, { path, kind: "file" }])) });
    }
    if (url.pathname.endsWith("/file")) {
      const path = url.searchParams.get("path");
      const text = path.endsWith(".md") ? MD_TEXT : FILE_TEXT;
      return json({
        root: listing.root,
        file: {
          path,
          name: path.split("/").at(-1),
          size: text.length,
          mtime: "2026-09-15T00:00:00.000Z",
          kind: "text",
          text,
          truncated: false,
          absPath: `/tmp/file-view-zoom/${path}`,
          mime: "text/plain",
        },
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`${web.origin}/scripts/fixtures/file-view-zoom.html`);

  const row = (name) => page.locator(".file-tree__row").filter({ has: page.locator(".file-tree__name", { hasText: name }) }).first();
  const zoomLayer = page.locator(".zoom-layer");
  const zoomButton = page.getByRole("button", { name: "放大", exact: true });
  const exitButton = page.getByRole("button", { name: "退出放大 · Esc" });
  const inspector = page.locator(".inspector-host");
  const diffView = inspector.locator("[aria-label='工作区改动']");
  const fileView = inspector.locator("[aria-label='文件查看']");
  const folderView = inspector.locator("[aria-label='文件夹详情']");
  const conversation = page.getByTestId("conversation");
  const reply = page.getByRole("textbox", { name: "回复框" });
  const dock = page.locator("#fixture-dock");
  const viewTab = page.locator(".inspector-rail__tab[aria-controls$='-panel-file-view']");
  const activeTabLabel = () => page.locator(".inspector-rail__tab.is-active").getAttribute("aria-label");

  await page.getByText("feature/zoom", { exact: true }).waitFor();
  assert.equal(await viewTab.count(), 0, "没打开过东西时「查看」这一格不该在竖轨上");
  const narrowWidth = (await inspector.boundingBox()).width;

  // ① 点开一份有改动的文件：摊在右侧那一格，会话和回复框都还在。
  await row("changed.ts").click();
  await diffView.waitFor();
  assert.equal(await viewTab.count(), 1, "打开之后竖轨上该多出「查看」这一格");
  assert.equal(await activeTabLabel(), "changed.ts", "该切到「查看」那一格，竖轨上报的是摊着的那份");
  assert.ok(await conversation.isVisible(), "会话不该被替换掉");
  assert.ok(await reply.isVisible(), "回复框不该被替换掉");
  // 宽度有 160ms 的过渡，等它走完再量。
  await page.waitForFunction((width) => document.querySelector(".inspector-host").getBoundingClientRect().width > width + 100, narrowWidth);
  await page.waitForTimeout(250);
  const wideBox = await inspector.boundingBox();
  const layoutBox = await page.locator(".inspector-layout").boundingBox();
  assert.ok(wideBox.width > narrowWidth + 100, `「查看」该是宽格：${wideBox.width} vs 普通格 ${narrowWidth}`);
  assert.ok(Math.abs(wideBox.width / layoutBox.width - 0.5) < 0.05, "宽格默认跟会话大约五五开");
  assert.equal(await inspector.locator(".inspector-host__panel-head").count(), 0, "查看器自带头带，宿主不该再叠一条标题");
  assert.equal(await zoomLayer.count(), 0, "默认不该是放大状态");

  // ② ③ 放大：铺满工作区（左边任务栏、中间会话、右边面板一起盖住），只让开底下的坞。
  await zoomButton.click();
  await zoomLayer.waitFor();
  const viewport = page.viewportSize();
  const dockBox = await dock.boundingBox();
  await page.waitForFunction((bottom) => {
    const layer = document.querySelector(".zoom-layer")?.getBoundingClientRect();
    return !!layer && Math.round(layer.right) === window.innerWidth && Math.round(layer.bottom) === Math.round(bottom);
  }, dockBox.y);
  const box = await zoomLayer.boundingBox();
  assert.deepEqual(
    { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    { x: 0, y: 0, width: viewport.width, height: Math.round(dockBox.y) },
    "放大层该占满底部坞上边的整块窗口",
  );
  assert.equal(await zoomLayer.locator("[aria-label='工作区改动']").count(), 1, "放大的该是那份 diff 本身");
  const covered = async (selector) => {
    const target = await page.locator(selector).boundingBox();
    return page.evaluate(
      ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".zoom-layer"),
      [target.x + target.width / 2, target.y + Math.min(20, target.height / 2)],
    );
  };
  assert.ok(await covered("#fixture-rail"), "放大层该压住左边的任务栏");
  assert.ok(await covered(".inspector-host"), "内容就长在面板里，放大层该连面板一起盖住");
  const overDock = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest("#fixture-dock"),
    [40, dockBox.y + dockBox.height / 2],
  );
  assert.ok(overDock, "底部坞不该被放大层盖住");

  // 放大态下点「查看文件全文」：换的是同一块内容的另一种读法，放大不该掉。
  await zoomLayer.getByRole("button", { name: "查看文件全文" }).click();
  await zoomLayer.locator("[aria-label='文件查看']").waitFor();
  assert.equal(await zoomLayer.count(), 1, "diff → 全文 切换把放大态弄丢了");
  await zoomLayer.getByRole("button", { name: "查看改动" }).click();
  await zoomLayer.locator("[aria-label='工作区改动']").waitFor();
  assert.equal(await zoomLayer.count(), 1, "全文 → diff 切回来把放大态弄丢了");

  // Esc 退出，内容回到那一格里。
  await page.keyboard.press("Escape");
  await zoomLayer.waitFor({ state: "detached" });
  await diffView.waitFor();

  // 切去文件树点开文件夹详情：跟全文、diff 抢同一格，切回「查看」并换内容。
  await page.locator(".inspector-rail__tab[aria-label^='文件']").click();
  await row("nested").hover();
  await inspector.getByRole("button", { name: "打开 nested 文件夹详情" }).click();
  await folderView.waitFor();
  assert.equal(await activeTabLabel(), "nested", "点开文件夹详情该切回「查看」那一格");
  assert.equal(await viewTab.count(), 1, "文件、文件夹、diff 共用一格，不该多出第二格");

  // 文件夹详情也共用同一个放大层，按钮也能退出（只用鼠标的用户得有出口）。
  await zoomButton.click();
  await zoomLayer.locator("[aria-label='文件夹详情']").waitFor();
  await exitButton.click();
  await zoomLayer.waitFor({ state: "detached" });

  // ④ 放大着关掉这一块内容：放大退出、这一格消失，回到点开之前看的「文件」那一格。
  await zoomButton.click();
  await zoomLayer.waitFor();
  await zoomLayer.getByRole("button", { name: "关闭文件夹详情" }).click();
  await zoomLayer.waitFor({ state: "detached" });
  await viewTab.waitFor({ state: "detached" });
  assert.match(await activeTabLabel(), /^文件/, "关掉之后该回到点开之前的那一格");
  await page.waitForFunction((width) => Math.round(document.querySelector(".inspector-host").getBoundingClientRect().width) === Math.round(width), narrowWidth);

  // ⑤ 重新打开不该还是放大态；有改动的文件照旧摊 diff。
  await row("changed.ts").click();
  await diffView.waitFor();
  assert.equal(await zoomLayer.count(), 0, "关掉之后重新打开不该还是放大态");
  assert.equal(await fileView.count(), 0, "有改动的文件该摊 diff");
  await inspector.getByRole("button", { name: "关闭 diff 查看" }).click();
  await viewTab.waitFor({ state: "detached" });

  // 面板收着时点正文里的路径：面板展开到「查看」；关掉它，面板照原样收起来。
  await dock.getByRole("button", { name: "开合右侧面板" }).click();
  await inspector.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "正文里的 clean.ts" }).click();
  await fileView.waitFor();
  assert.equal(await activeTabLabel(), "clean.ts");
  assert.ok(await conversation.isVisible(), "面板展开后会话照旧在");
  await inspector.getByRole("button", { name: "关闭文件查看" }).click();
  await inspector.waitFor({ state: "detached" });

  // 摊着的 Markdown 里再点别的文件：在同一格里换内容，不另开一格、不动中间那一栏。
  await page.getByRole("button", { name: "正文里的 guide.md" }).click();
  await inspector.getByRole("heading", { name: "指南" }).waitFor();
  await inspector.getByRole("link", { name: /干净的那份/ }).click();
  await page.waitForFunction(() => document.querySelector(".inspector-host .file-viewer__title b")?.textContent === "clean.ts");
  assert.equal(await viewTab.count(), 1, "文档里点开别的文件该在同一格换内容");
  assert.equal(await activeTabLabel(), "clean.ts");
  assert.ok(await conversation.isVisible(), "文档里跳转不该动中间的会话");

  // 窄屏：右侧面板本来就盖在内容上。点开文件时盖上来，查看器的关闭键点得到，关掉回到内容。
  await page.setViewportSize({ width: 600, height: 720 });
  await page.reload();
  await page.getByRole("button", { name: "正文里的 clean.ts" }).click();
  await fileView.waitFor();
  const cover = await inspector.boundingBox();
  assert.ok(cover.width >= 600 - 230 - 2, `窄屏下那一格该盖满内容区：${cover.width}`);
  const close = inspector.getByRole("button", { name: "关闭文件查看" });
  const closeBox = await close.boundingBox();
  assert.ok(closeBox.x + closeBox.width <= cover.x + cover.width + 0.5, "窄屏下关闭键不该被挤出那一格");
  await close.click();
  await inspector.waitFor({ state: "detached" });
  assert.ok(await conversation.isVisible(), "关掉之后回到内容");

  console.log("file view zoom test passed");
} finally {
  await browser?.close();
  await web.close();
}
