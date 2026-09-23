import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 删文件 / 删文件夹这条路。钉三件事：
//
// ① 文件夹在树里点一下仍然只是展开，要看它里面有什么、要删它，走行尾那颗「打开文件夹详情」
//    ——中间栏摊出的统计数字和确认框里说的是同一份 `/file/overview`，不会一边 12 个一边 9 个。
// ② 确认框摆的是**后果**而不是「确定吗」：有人正在写这个目录、git 里有没有备份、删到哪儿去。
//    点错了回不来的那几档（非空文件夹、没有废纸篓）要求抄一遍名字；单个已跟踪文件不折腾。
// ③ 「有任务正在跑」是 409 + needsForce，用户看着那张红卡点的这一下就是 force，不套第二个框；
//    删完树上那一行当场消失（`fileTreeChanged`），不等 5 秒轮询。

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const WORKSPACE = { path: "/tmp/file-entry-delete", branch: "feature/delete", gitRepo: true, source: "session" };

const entry = (path, options = {}) => ({
  name: path.split("/").at(-1),
  path,
  kind: "file",
  size: 128,
  mtime: "2026-09-20T00:00:00.000Z",
  ignored: false,
  symlink: false,
  ...options,
});

// 树上还剩什么。删掉 src 之后它要当场从这里消失。
let rootEntries = [
  entry("src", { kind: "dir", size: 0 }),
  entry("notes.md"),
  entry("scratch.log"),
];

const OVERVIEWS = {
  src: {
    root: WORKSPACE,
    target: { path: "src", name: "src", kind: "dir", size: 0, mtime: "2026-09-20T00:00:00.000Z", absPath: "/tmp/file-entry-delete/src", symlink: false },
    stats: { files: 12, dirs: 3, bytes: 48_000, truncated: false },
    entries: [entry("src/app.ts"), entry("src/draft.ts"), entry("src/lib", { kind: "dir", size: 0 })],
    git: { repo: true, tracked: 9, dirty: 2, untracked: 3, untrackedSamples: ["src/draft.ts", "src/tmp.json"], error: null },
    trash: { available: true, label: "废纸篓", reason: null },
    readOnly: null,
    busy: { running: true, reason: "任务「重构文件树」正在这个目录里跑" },
  },
  "notes.md": {
    root: WORKSPACE,
    target: { path: "notes.md", name: "notes.md", kind: "file", size: 128, mtime: "2026-09-20T00:00:00.000Z", absPath: "/tmp/file-entry-delete/notes.md", symlink: false },
    stats: null,
    entries: null,
    git: { repo: true, tracked: 1, dirty: 0, untracked: 0, untrackedSamples: [], error: null },
    trash: { available: true, label: "废纸篓", reason: null },
    readOnly: null,
    busy: { running: false, reason: null },
  },
  // 这台机器没有废纸篓：只剩永久删除那一档，所以连单个文件也要抄名字。
  "scratch.log": {
    root: WORKSPACE,
    target: { path: "scratch.log", name: "scratch.log", kind: "file", size: 512, mtime: "2026-09-20T00:00:00.000Z", absPath: "/tmp/file-entry-delete/scratch.log", symlink: false },
    stats: null,
    entries: null,
    git: { repo: true, tracked: 0, dirty: 0, untracked: 1, untrackedSamples: ["scratch.log"], error: null },
    trash: { available: false, label: null, reason: "这台机器上没找到可用的废纸篓通道" },
    readOnly: null,
    busy: { running: false, reason: null },
  },
};

const deleteCalls = [];
// 「overview 说没人在跑，点下去那一刻任务刚起来」——后端 409 + needsForce，前端得自己带 force
// 重试一次（那张红卡本来就该在框里说清楚，不套第二个框）。拿 scratch.log 演这一次竞态。
const racePaths = new Set(["scratch.log"]);
let listingCalls = 0;
let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  await page.route("**/api/tasks/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname.endsWith("/files")) {
      listingCalls += 1;
      const path = url.searchParams.get("path") ?? "";
      return json({
        root: WORKSPACE,
        path,
        entries: path === "" ? rootEntries : [entry(`${path}/app.ts`)],
        truncated: false,
        git: { changes: [], truncated: false, error: null },
      });
    }
    if (url.pathname.endsWith("/file/overview")) {
      const path = url.searchParams.get("path") ?? "";
      const overview = OVERVIEWS[path];
      return overview ? json(overview) : json({ error: `没有 ${path}` }, 404);
    }
    if (url.pathname.endsWith("/file") && request.method() === "DELETE") {
      const body = JSON.parse(request.postData() ?? "{}");
      deleteCalls.push(body);
      if (racePaths.has(body.path) && !body.force) {
        return json({ error: "这个目录上有任务在跑", needsForce: true }, 409);
      }
      rootEntries = rootEntries.filter((item) => item.path !== body.path);
      const overview = OVERVIEWS[body.path];
      return json({
        ok: true,
        mode: body.mode,
        path: body.path,
        name: overview.target.name,
        kind: overview.target.kind,
        absPath: overview.target.absPath,
      });
    }
    if (url.pathname.endsWith("/file")) {
      const path = url.searchParams.get("path");
      return json({
        root: WORKSPACE,
        file: {
          path,
          name: path.split("/").at(-1),
          size: 128,
          mtime: "2026-09-20T00:00:00.000Z",
          kind: "text",
          text: "# notes\n",
          truncated: false,
          absPath: `/tmp/file-entry-delete/${path}`,
          mime: "text/markdown",
        },
      });
    }
    return json({ error: "unhandled" }, 404);
  });

  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/file-entry-delete.html`);
  const center = page.getByTestId("center");
  const row = (name) => page.locator(".file-tree__row-wrap").filter({ has: page.locator(".file-tree__name", { hasText: name }) }).first();
  const dialog = page.getByRole("dialog");
  const confirmButton = () => dialog.locator("footer button").last();

  await page.getByText("feature/delete", { exact: true }).waitFor();
  await page.getByTestId("center-empty").waitFor();

  // ── ① 树里点文件夹只展开；「详情」在行尾那颗按钮上，而且不悬停时不占位 ──────────
  const peek = page.getByRole("button", { name: "打开 src 文件夹详情" });
  assert.equal(await peek.isVisible(), false, "不悬停时行尾那颗按钮不该占着 24px 的行");
  await row("src").locator(".file-tree__row").click();
  await page.locator(".file-tree__name", { hasText: "app.ts" }).first().waitFor();
  assert.equal(await center.getByTestId("center-empty").count(), 1, "点文件夹应当只展开，不该抢走中间栏");

  await row("src").hover();
  await peek.click();
  const folderView = center.locator("[aria-label='文件夹详情']");
  await folderView.waitFor();
  // 详情页的数字来自 /file/overview，确认框待会儿说的是同一份。
  await folderView.getByText("12", { exact: true }).waitFor();
  await folderView.getByText("个未跟踪（git 里没有备份）").waitFor();
  assert.match(await folderView.locator(".folder-viewer__note").innerText(), /12 个文件一起删/);
  assert.equal(
    await row("src").locator(".file-tree__row").getAttribute("class").then((value) => value?.includes("is-active")),
    true,
    "摊的是文件夹详情，文件树里这一行照样要高亮",
  );
  await page.screenshot({ path: "/tmp/ash-file-delete-folder.png", fullPage: true });

  // ── ② 文件夹的确认框：摆后果、要求抄名字 ─────────────────────────────────
  await folderView.getByRole("button", { name: "删除文件夹 src" }).click();
  await dialog.waitFor();
  const dialogText = await dialog.innerText();
  assert.match(dialogText, /有任务正在这个工作目录里运行/, "有人在写这个目录，必须当面说");
  assert.match(dialogText, /任务「重构文件树」正在这个目录里跑/);
  assert.match(dialogText, /有未跟踪内容，git 里没有备份/);
  assert.match(dialogText, /src\/draft\.ts/, "未跟踪的样例文件要列出来");
  assert.match(dialogText, /去向：废纸篓/);
  assert.equal(await confirmButton().innerText(), "仍然删除");
  assert.equal(await confirmButton().isDisabled(), true, "非空文件夹必须抄一遍名字才能点");

  const typed = dialog.locator(".file-delete__type input");
  await typed.fill("sr");
  assert.equal(await confirmButton().isDisabled(), true, "名字没抄全就不能点");
  await typed.fill("src");
  assert.equal(await confirmButton().isDisabled(), false);
  // 等开场动画落定再截图，否则存下来的是半透明的中间帧。
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/ash-file-delete-dialog.png", fullPage: true });

  const listingBefore = listingCalls;
  await confirmButton().click();
  await page.getByTestId("center-empty").waitFor();
  // 框里那张红卡已经把「有人正在写这个目录」说清楚了，所以这一下点击本身就带 force，
  // 不再套第二个「确定要覆盖吗」的框。
  assert.deepEqual(deleteCalls, [{ path: "src", mode: "trash", force: true }]);
  assert.match(await page.getByTestId("notices").innerText(), /已把 src\/（12 个文件） 移到废纸篓/);
  // 删完树上那一行当场消失（轮询间隔 5 秒，这里等 2 秒就超时说明没广播）。
  await page.locator(".file-tree__name", { hasText: "src" }).first().waitFor({ state: "detached", timeout: 2000 });
  assert.ok(listingCalls > listingBefore, "删完没有立刻重读文件树");

  // ── ③ 单个已跟踪文件：不折腾抄名字，但要说清 git 那条后悔药 ────────────────────
  await row("notes.md").locator(".file-tree__row").click();
  await center.locator("[aria-label='文件查看']").waitFor();
  await center.getByRole("button", { name: "删除文件 notes.md" }).click();
  await dialog.waitFor();
  assert.equal(await confirmButton().innerText(), "删除文件");
  assert.equal(await confirmButton().isDisabled(), false, "已跟踪的单个文件不该要求抄名字");
  assert.match(await dialog.innerText(), /被 git 跟踪的部分删掉了也能找回来/);
  assert.equal(await dialog.locator(".file-delete__type").count(), 0);
  await dialog.getByRole("button", { name: "取消" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(deleteCalls.length, 1, "取消不该发出删除请求");

  // ── ④ 这台机器没有废纸篓：默认就是永久删除，连单个文件也要抄名字；
  //      而且删到一半发现「任务刚起来」时，带 force 自己重试一次，用户不用重来 ──────────
  await row("scratch.log").locator(".file-tree__row").click();
  await center.getByRole("button", { name: "删除文件 scratch.log" }).click();
  await dialog.waitFor();
  const noTrashText = await dialog.innerText();
  assert.match(noTrashText, /永久删除，没有兜底/);
  assert.match(noTrashText, /这台机器上没找到可用的废纸篓通道/);
  assert.match(noTrashText, /删掉之后就真没了/);
  assert.equal(await dialog.locator(".file-delete__type").count(), 1, "没有废纸篓时必须抄名字");
  assert.equal(await dialog.locator(".file-delete__fact ul").count(), 0, "单个文件不必再列一遍它自己");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/ash-file-delete-permanent.png", fullPage: true });
  await dialog.locator(".file-delete__type input").fill("scratch.log");
  await confirmButton().click();
  await page.getByTestId("center-empty").waitFor();
  assert.deepEqual(deleteCalls.slice(1), [
    { path: "scratch.log", mode: "permanent", force: false },
    { path: "scratch.log", mode: "permanent", force: true },
  ], "被 409 needsForce 挡回来之后，重试要原样带回同一个 mode/path");
  assert.match(await page.getByTestId("notices").innerText(), /已删除 scratch\.log/);

  console.log("test-file-entry-delete: OK");
} finally {
  await browser?.close();
  await server.close();
}
