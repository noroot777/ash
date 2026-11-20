// 文内锚点的回归（components/markdownAnchors.ts）：目录链接、中文锚点、脚注、跨文件 `other.md#section`。
// 跑:npm -w web run test:markdown-anchors
//
// 盯的是 2026-11-20 那一幕：点 `[实现方案](#实现方案)` 在浏览器里新开一页、在 mac 壳里整页
// 重载，文档直接没了；标题本来也没有 id，跳不到任何地方。所以每一次点击之后都要钉三件事：
// 目标真的滚到了滚动容器顶上；页面没导航、没弹新页；跳到的是**这一份**文档里的那一处。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchChrome, viteCacheDir } from "./dom-stage.mjs";
import { createSlugger, fileLinkAnchor, inDocumentAnchor } from "../src/components/markdownAnchors.ts";

// ── slug 口径（GitHub / github-slugger）────────────────────────────────────────
{
  const slug = createSlugger();
  for (const [text, expected] of [
    ["Hello, World!", "hello-world"],
    ["实现方案（第二版）", "实现方案第二版"],
    ["API: fetch() 用法", "api-fetch-用法"],
    ["foo_bar", "foo_bar"],
    ["C++ & Rust", "c--rust"],
    ["🚀 发布", "-发布"],
    ["結論・まとめ", "結論まとめ"],
  ]) assert.equal(slug(text), expected, `「${text}」的 slug`);
  const dup = createSlugger();
  assert.deepEqual(
    ["结论", "结论", "结论", "结论-1"].map(dup),
    ["结论", "结论-1", "结论-2", "结论-1-1"],
    "重名标题依次加 -1、-2，跟 github-slugger 一样",
  );
}
assert.equal(inDocumentAnchor("#%E5%AE%9E%E7%8E%B0%E6%96%B9%E6%A1%88"), "实现方案", "百分号编码的中文锚点要解码");
assert.equal(inDocumentAnchor("#"), null);
assert.equal(inDocumentAnchor("docs/a.md#x"), null, "指着别的文件的不是文内锚点");
assert.equal(fileLinkAnchor("docs/other.md#%E7%AC%AC%E4%BA%8C%E8%8A%82"), "第二节");
assert.equal(fileLinkAnchor("docs/other.md#L12"), null, "#L12 行号后缀照旧只是打开整份文件");
assert.equal(fileLinkAnchor("docs/other.md#L12-L20"), null);
assert.equal(fileLinkAnchor("docs/other.md"), null);
assert.equal(fileLinkAnchor("#x"), null);

// ── DOM ─────────────────────────────────────────────────────────────────────────
const filler = (label, count) => Array.from({ length: count }, (_, i) => `${label}第 ${i + 1} 段。`).join("\n\n");
const FILES = {
  "docs/other.md": [
    "# 其它文档", "", "[回到开头](#其它文档)", "", filler("开头", 20), "",
    "## 第二节", "", filler("第二节", 20), "", "[回到开头](#其它文档)", "",
    "## 第三节", "", filler("第三节", 20),
  ].join("\n"),
  "docs/plain.md": filler("普通", 60),
};
const reads = new Map();

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  cacheDir: viteCacheDir("markdown-anchors"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "fixture-files",
    configureServer(vite) {
      vite.middlewares.use("/api/tasks/T1/file", (req, res) => {
        const url = new URL(req.url ?? "/", "http://fixture.invalid");
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/locate") {
          let body = "";
          req.on("data", (chunk) => { body += chunk; });
          req.on("end", () => {
            const { paths } = JSON.parse(body || "{}");
            res.end(JSON.stringify({
              entries: Object.fromEntries((paths ?? []).map((path) => [path, FILES[path] ? { path, kind: "file" } : null])),
            }));
          });
          return;
        }
        const path = url.searchParams.get("path") ?? "";
        if (url.pathname !== "/" || !FILES[path]) {
          res.statusCode = 404;
          res.end('{"error":"没有这个文件"}');
          return;
        }
        reads.set(path, (reads.get(path) ?? 0) + 1);
        const text = FILES[path];
        res.end(JSON.stringify({
          root: "worktree",
          file: {
            path, name: path.split("/").pop(), size: text.length, mtime: null, kind: "text",
            text, truncated: false, absPath: `/work/${path}`, mime: "text/markdown",
          },
          pageUrl: null,
          pageNotice: null,
        }));
      });
      vite.middlewares.use("/api", (_req, res) => {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end('{"error":"fixture"}');
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let popups = 0;
  page.on("popup", () => { popups += 1; });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/markdown-anchors.html`);
  await page.locator(".doc-fixture .task-markdown h2").first().waitFor();
  const home = page.url();
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });

  /** 第 `nth` 个文字为 `text` 的元素，离它的滚动容器上沿多远（px）；容器滚了多少。 */
  const placement = (container, selector, text, nth = 0) => page.evaluate(({ container, selector, text, nth }) => {
    const box = document.querySelector(container);
    const target = [...box.querySelectorAll(selector)].filter((node) => node.textContent.trim().startsWith(text))[nth];
    if (!target) return null;
    return { offset: target.getBoundingClientRect().top - box.getBoundingClientRect().top, scrollTop: box.scrollTop };
  }, { container, selector, text, nth });
  const assertAtTop = async (container, selector, text, nth, message) => {
    // 滚动是同步的；再等一帧只是为了布局落定。
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    const at = await placement(container, selector, text, nth);
    assert(at, `${message}：找不到目标元素`);
    assert(at.scrollTop > 0, `${message}：容器根本没滚（scrollTop=${at.scrollTop}）`);
    assert(at.offset >= -2 && at.offset <= 40, `${message}：目标离容器上沿 ${at.offset}px，没滚到位`);
  };
  const assertStayed = (message) => {
    assert.equal(page.url(), home, `${message}：地址变了（改了 hash 或整页跳走）`);
    assert.equal(navigations, 0, `${message}：页面发生了导航（mac 壳里就是整页重载）`);
    assert.equal(popups, 0, `${message}：新开了一页`);
  };
  const resetScroll = (container) => page.evaluate((container) => { document.querySelector(container).scrollTop = 0; }, container);

  // ── ① 同一份文档里的目录链接 ─────────────────────────────────────────────────
  const doc = ".doc-fixture";
  for (const [label, heading, nth] of [
    ["实现方案", "实现方案", 0],
    ["Hello World!", "Hello, World!", 0],
    ["第二个结论", "结论", 1],
    ["大小写不一致", "Hello, World!", 0],
  ]) {
    await resetScroll(doc);
    await page.locator(doc).getByRole("link", { name: label, exact: true }).click();
    await assertAtTop(doc, "h2", heading, nth, `目录链接「${label}」`);
    assertStayed(`目录链接「${label}」`);
  }
  await resetScroll(doc);
  await page.locator(doc).getByRole("link", { name: "不存在的一节" }).click();
  assertStayed("指着不存在的一节");
  assert.equal(await page.locator(doc).evaluate((node) => node.scrollTop), 0, "找不到那一节就原地不动");
  assert.equal(
    await page.locator(`${doc} a[target="_blank"]`).count(),
    0,
    "文内锚点一个都不许带 target=_blank",
  );

  // ── ② 会话里两条消息的脚注：各跳各的 ────────────────────────────────────────
  const conversation = ".conversation-fixture";
  const ids = await page.evaluate(() => [...document.querySelectorAll("[id]")].map((node) => node.id));
  assert.equal(new Set(ids).size, ids.length, `页面上的 id 不许重复：${ids.join(", ")}`);
  await page.locator(`${conversation} .message-2 a[data-footnote-ref]`).click();
  await assertAtTop(conversation, "li", "第二条消息的脚注正文", 0, "第二条消息的脚注角标");
  assertStayed("脚注角标");
  await page.locator(`${conversation} .message-2 a[data-footnote-backref]`).click();
  const back = await page.evaluate((container) => {
    const box = document.querySelector(container).getBoundingClientRect();
    const ref = document.querySelector(`${container} .message-2 a[data-footnote-ref]`).getBoundingClientRect();
    return ref.top >= box.top - 1 && ref.bottom <= box.bottom + 1;
  }, conversation);
  assert(back, "脚注的回跳要回到第二条消息自己的角标那里");
  await resetScroll(conversation);
  await page.locator(`${conversation} .message-1 a[data-footnote-ref]`).click();
  await assertAtTop(conversation, "li", "第一条消息的脚注正文", 0, "第一条消息的脚注角标");
  assertStayed("脚注回跳");

  // ── ③ 跨文件锚点：右侧查看器里打开并滚到那一节 ──────────────────────────────
  const pane = ".cross-pane .file-viewer__body";
  const cross = page.locator(".cross-conversation");
  // 链接要等「工作区里真有这个文件」问回来才画成文件链接；点下去时还没问到也会当场问。
  await cross.getByRole("link", { name: "第二节" }).click();
  await page.locator(`${pane} .file-viewer__doc h2`).first().waitFor();
  await assertAtTop(pane, "h2", "第二节", 0, "跨文件锚点 docs/other.md#第二节");
  assertStayed("跨文件锚点");
  // StrictMode 下开发版会把读取的 effect 跑两遍，所以比的是「再点一次有没有多读」，不是绝对次数。
  const opened = reads.get("docs/other.md");
  assert(opened >= 1, "docs/other.md 应该被读过");

  await cross.getByRole("link", { name: "第三节" }).click();
  await assertAtTop(pane, "h2", "第三节", 0, "同一份文件里的另一节（百分号编码写法）");
  assert.equal(reads.get("docs/other.md"), opened, "已经摊着的同一份文件不重读，直接滚过去");

  // 人滚走之后再点同一个锚点，还要再滚回去。
  await resetScroll(pane);
  await cross.getByRole("link", { name: "第三节" }).click();
  await assertAtTop(pane, "h2", "第三节", 0, "再点一次同一个锚点");

  // 查看器里那份文档自己的目录链接也在查看器里跳。
  await page.locator(pane).getByRole("link", { name: "回到开头" }).nth(1).click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  const title = await placement(pane, "h1", "其它文档");
  assert(title && title.offset >= -2 && title.offset <= 40, "查看器里的文内锚点要跳回文档开头");
  assertStayed("查看器里的文内锚点");

  // `#L3` 行号后缀：打开整份文件，停在开头。
  await cross.getByRole("link", { name: "第 3 行" }).click();
  await page.locator(`${pane} .file-viewer__doc`).getByText("普通第 1 段。").waitFor();
  assert.equal(await page.locator(pane).evaluate((node) => node.scrollTop), 0, "#L3 只是打开整份文件");
  assertStayed("行号后缀");

  assert.deepEqual(errors, [], "页面不许抛错");
  console.log("markdown anchors: ok");
} finally {
  await browser?.close();
  await server.close();
}
