import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 生成物点开之后能一张接一张地翻（左右方向键 + 顶栏那两颗按钮）。
//
// 钉的是四条别处看不出来的：
// ① 翻的那一串是**点开那一刻的那一组**——图片跟图片翻，翻到头绕回去，不会窜到网页组里；
// ② 文件树/文件夹那一层是混着的，给出去的那一串只留同类：看图时按右箭头翻出一份 .txt，
//    键在那儿又不接管，人就被晾在半路（2026-09-28 审查打回的就是这条）；
// ③ 方向键只在图片上接管：文本/网页那一屏横向滚得动，抢了键就等于把人家的滚动掰坏了，
//    所以那儿只留按钮；在输入框里打字更不许翻；
// ④ 一组只有一个的时候整组控件都不出现（「1 / 1」和两颗点不动的箭头是噪音）。

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

// 1×1 透明 png：<img> 得真能加载出来，坏图会退成 alt 文本，看不出翻没翻。
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const artifact = (path, kind) => ({
  path,
  name: path.split("/").at(-1),
  dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  kind,
  size: 2048,
  mtime: "2026-09-28T02:00:00.000Z",
  origin: "ignored",
});

const artifacts = [
  artifact("shots/one.png", "image"),
  artifact("shots/two.png", "image"),
  artifact("shots/three.png", "image"),
  artifact("pages/first.html", "page"),
  artifact("pages/second.html", "page"),
  artifact("clips/only.mp4", "video"),
];

// 文件树那一层：图片和文本混着摆，正是审查里翻出类别的那种目录。
const entry = (path) => ({
  name: path.split("/").at(-1),
  path,
  kind: "file",
  size: 64,
  mtime: "2026-09-28T02:00:00.000Z",
  ignored: false,
  symlink: false,
});

const listing = {
  root: { path: "/tmp/file-reel", branch: "feature/reel", gitRepo: true, source: "session" },
  path: "",
  entries: [entry("keep.png"), entry("notes.txt"), entry("other.png"), entry("readme.md")],
  truncated: false,
  git: { changes: [], truncated: false, error: null },
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
    if (url.pathname.endsWith("/artifacts")) {
      return json({
        root: { path: "/tmp/file-reel", branch: "feature/reel", gitRepo: true, source: "session" },
        artifacts,
        truncated: false,
        since: "2026-09-28T01:00:00.000Z",
        error: null,
      });
    }
    if (url.pathname.endsWith("/files")) return json(listing);
    if (url.pathname.endsWith("/file/raw")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    }
    if (url.pathname.endsWith("/file")) {
      const path = url.searchParams.get("path");
      const image = path.endsWith(".png");
      return json({
        root: null,
        pageUrl: null,
        pageNotice: null,
        file: {
          path,
          name: path.split("/").at(-1),
          size: 2048,
          mtime: "2026-09-28T02:00:00.000Z",
          kind: image ? "image" : "text",
          text: image ? null : `<!doctype html><!-- ${path} -->`,
          truncated: false,
          absPath: `/tmp/file-reel/${path}`,
          mime: image ? "image/png" : "text/html",
        },
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/file-reel.html`);

  const card = (name) => page.locator(".artifacts__card").filter({ hasText: name }).first();
  const title = page.locator(".file-viewer__title b");
  const counter = page.locator(".file-viewer__reel small");
  const shownPath = async () => title.textContent();

  await card("one.png").waitFor();

  // 从中间那一张点进去：计数按它在组里的位置，不是从 1 开始数。
  await card("two.png").click();
  await page.locator("[aria-label='文件查看']").waitFor();
  assert.equal(await counter.textContent(), "2 / 3", "计数该是点开那一张在这一组里的位置");

  // 方向键：往后一张、再往后绕回第一张。
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "three.png");
  assert.equal(await counter.textContent(), "3 / 3");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "one.png");
  assert.equal(await counter.textContent(), "1 / 3", "到头该绕回这一组的第一张");

  // 往前翻：第一张的上一张是最后一张。
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "three.png");
  assert.equal(await counter.textContent(), "3 / 3");

  // 只用鼠标的人走按钮，效果一样。
  await page.getByRole("button", { name: "下一张" }).click();
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "one.png");
  await page.getByRole("button", { name: "上一张" }).click();
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "three.png");

  // 侧栏里正在打字：这两个键是光标在输入框里挪，不许把图翻走。
  await page.locator("#fixture-input").click();
  await page.keyboard.type("abc");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(80);
  assert.equal(await shownPath(), "three.png", "输入框里按方向键不该翻页");

  // 组是分开的：网页那一组翻的是网页，不会窜进图片里。
  await card("first.html").click();
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "first.html");
  assert.equal(await counter.textContent(), "1 / 2", "网页组该按它自己的长度计数");
  await page.getByRole("button", { name: "下一个" }).click();
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "second.html");

  // 非图片不接管方向键：那一屏是横向滚得动的正文，键留给它。
  await page.locator(".file-viewer__body").click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(80);
  assert.equal(await shownPath(), "second.html", "非图片上方向键不该翻页");

  // 一组只有一个：整组控件都不出现。
  await card("only.mp4").click();
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "only.mp4");
  assert.equal(await page.locator(".file-viewer__reel").count(), 0, "只有一个产物的组不该出现翻页控件");

  // 文件树里那一层是混着的：翻页只在同类里走，不会从图片翻出一份 .txt——方向键在文本上
  // 又不接管，翻过去人就被晾在半路。
  const row = (name) => page.locator(".file-tree__row")
    .filter({ has: page.locator(".file-tree__name", { hasText: name }) }).first();
  await row("keep.png").click();
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "keep.png");
  assert.equal(await counter.textContent(), "1 / 2", "混着的一层里只该把图片算进这一串");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "other.png");
  assert.equal(await counter.textContent(), "2 / 2", "下一张该是同层的另一张图，不是中间那份 .txt");

  // 非图片那一串同样成立：它们自成一串，用按钮翻。
  await row("notes.txt").click();
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "notes.txt");
  assert.equal(await counter.textContent(), "1 / 2", "文本该跟文本一串");
  await page.getByRole("button", { name: "下一个" }).click();
  await page.waitForFunction(() => document.querySelector(".file-viewer__title b")?.textContent === "readme.md");

  console.log("file reel test passed");
} finally {
  await browser?.close();
  await server.close();
}
