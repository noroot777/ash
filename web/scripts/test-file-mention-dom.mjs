// 对话框里 `@` 的回归：同一个 `@` 既能召唤智能体、又能引用工作区文件，两类候选混在
// 一张列表里走同一条上下键。
//
// 回归价值在这条**分界线**上：`@cl` 这样的纯字母 token 两边都可能命中（智能体在前），
// 而一旦 token 里出现 `/` 或 `.`，智能体那段必须整个让位 —— 否则用户敲着路径，回车
// 却把这一回合派给了别的 CLI，这是「看起来只是插了个路径」最贵的那种误触。
// 跑法：npm -w web run test:file-mention-dom
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

const PROFILES = [
  { id: "profile-codex", name: "codex@local", type: "codex", isDefault: true },
  { id: "profile-claude", name: "claude@local", type: "claude", isDefault: true },
];

// 服务端那一半的替身：一个固定的文件表，按子串过滤。排序口径由 server 的
// test:file-search 钉，这里只关心「候选怎么进菜单、选完正文变成什么」。
const FILES = [
  "README.md",
  "src/api.ts",
  "src/lib/apiClient.ts",
  "src/lib/useFileMention.ts",
  "docs/计划 A.md",
  "dist/api.js",
];
// .gitignore 挡着的：照样能搜到、能选，只是排在最后并标出来（空查询时不给）。
const IGNORED = new Set(["dist/api.js"]);

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  // 让某一个查询慢下来：验「旧候选不许被新 token 的回车选中」那一条时打开。
  let slowQuery = null;
  // 让某一个查询报「还有更多没列出来」：验那句提示有没有接上。
  let moreQuery = null;
  // 装成没更新过的服务端（不认 `dir`、回平铺清单且不报 mode）。
  let legacyServer = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/agents")) return json(PROFILES);
    if (url.pathname.endsWith("/file-search")) {
      // `dir` = 树里展开一层：只回这个目录的直接子项，跟服务端一个口径。
      const dir = url.searchParams.get("dir");
      if (dir !== null) {
        const prefix = dir ? `${dir}/` : "";
        const dirs = new Set();
        const plain = [];
        for (const path of FILES) {
          if (prefix && !path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const at = rest.indexOf("/");
          if (at < 0) plain.push(rest);
          else dirs.add(rest.slice(0, at));
        }
        if (legacyServer) {
          // 旧服务端不认 `dir`，把它当搜索处理：回一张平铺清单，而且没有 mode。
          return json({ root: { path: "/repo" }, truncated: false, more: false, hits: FILES.map(hit) });
        }
        return json({
          root: { path: "/repo" },
          mode: "dir",
          truncated: false,
          more: false,
          hits: [
            ...[...dirs].sort().map((name) => ({ path: prefix + name, name, dir, kind: "dir" })),
            ...plain.sort().map((name) => ({
              path: prefix + name,
              name,
              dir,
              kind: "file",
              ...(IGNORED.has(prefix + name) ? { ignored: true } : {}),
            })),
          ],
        });
      }
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      if (slowQuery && query.includes(slowQuery)) {
        await new Promise((resolve) => { setTimeout(resolve, 1500); });
      }
      const matched = FILES
        .filter((path) => (query ? path.toLowerCase().includes(query) : !IGNORED.has(path)))
        .sort((a, b) => Number(IGNORED.has(a)) - Number(IGNORED.has(b)));
      return json({
        root: { path: "/repo" },
        mode: "search",
        hits: matched.map((path) => {
          const at = path.lastIndexOf("/");
          return {
            path,
            name: at < 0 ? path : path.slice(at + 1),
            dir: at < 0 ? "" : path.slice(0, at),
            kind: "file",
            ...(IGNORED.has(path) ? { ignored: true } : {}),
          };
        }),
        truncated: false,
        more: !!moreQuery && query.includes(moreQuery),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/file-mention.html`);

  const textarea = page.getByRole("textbox", { name: "回复任务" });
  const menu = page.getByRole("listbox", { name: "召唤智能体或引用文件" });
  const options = menu.getByRole("option");
  await textarea.waitFor();

  // 边打边搜会连着发好几趟（`s` → `sr` → `src`…），中间那几趟的结果同样会进菜单。
  // 所以每次判定前都等到列表**正好**是最后那趟该有的样子，否则上下键走的是一张
  // 过期列表 —— 这不是产品 bug，是夹具自己的观测偏差。
  const hit = (path) => {
    const at = path.lastIndexOf("/");
    return { path, name: at < 0 ? path : path.slice(at + 1), dir: at < 0 ? "" : path.slice(0, at), kind: "file" };
  };
  const settled = (expected) => page.waitForFunction(
    (want) => {
      const texts = [...document.querySelectorAll('[role="option"]')].map((node) => node.textContent ?? "");
      return texts.length === want.length && want.every((needle, index) => texts[index]?.includes(needle));
    },
    expected,
    { timeout: 5000 },
  );

  // ① 只敲一个 @：两类候选都在，文件那半边是**根这一层**（目录 + 根下的文件），
  //    深处的文件一条都不该平铺出来 —— 那正是「一屏四十条读不过来」的老样子。
  await textarea.fill("");
  await textarea.type("@");
  await settled(["@claude", "@codex", "dist/", "docs/", "src/", "README.md"]);

  // ② token 里出现 `/`：智能体整个让位，只剩文件。
  await textarea.fill("");
  await textarea.type("看看 @src/lib/");
  await settled(["apiClient.ts", "useFileMention.ts"]);
  const pathRound = await options.allTextContents();
  assert.ok(
    pathRound.every((text) => !/^@(claude|codex)/.test(text.trim())),
    `敲路径时不该再列智能体：${JSON.stringify(pathRound)}`,
  );

  // ③ 上下键走的是这张合并列表；回车把路径插进正文，前面的字一个不动。
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await textarea.inputValue(), "看看 @src/lib/useFileMention.ts ");

  // ④ 带空格的路径要加引号（不然 agent 只拿到第一个空格前那截）。
  await textarea.fill("");
  await textarea.type("读 @计划");
  await settled(["计划 A.md"]);
  await page.keyboard.press("Enter");
  assert.equal(await textarea.inputValue(), '读 @"docs/计划 A.md" ');

  // ⑤ 选中文件**不该**改这一回合的执行器：胶囊仍然是任务自己的那个，
  //    也不该冒出「取消召唤」那颗按钮。
  assert.equal(await page.getByRole("button", { name: /取消召唤/ }).count(), 0);
  const agentChip = page.getByRole("button", { name: /智能体：/ });
  assert.match(await agentChip.getAttribute("aria-label") ?? "", /智能体：codex/);

  // ⑥ 发出去的就是带 @ 路径的那行字（不摘走、不转附件）。
  await page.getByRole("button", { name: "发送回复" }).click();
  await page.locator("#log li").first().waitFor();
  assert.deepEqual(await page.locator("#log li").allTextContents(), ['send:读 @"docs/计划 A.md"']);

  // ⑦ Esc 只收菜单，正文原样留着。
  await textarea.fill("");
  await textarea.type("@src");
  await options.first().waitFor();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal(await textarea.inputValue(), "@src");

  // ⑧ 改了 token、新结果还在路上时，**上一轮的候选一条都不许被选中**。
  //    （第 1 轮审查复现：敲 `@src/lib/` 看到候选后改成 `@README` 立刻回车，
  //      插进正文的是上一轮的 apiClient.ts。）
  await textarea.fill("");
  await textarea.type("看 @src/lib/");
  await settled(["apiClient.ts", "useFileMention.ts"]);
  slowQuery = "readme";
  await textarea.fill("");
  await textarea.type("读 @README");
  // 新查询还没回来：菜单只该说「正在搜索」，一条旧候选都不该留着。
  await page.waitForFunction(
    () => document.querySelector(".mention-menu p")?.textContent?.includes("正在搜索"),
    null,
    { timeout: 4000 },
  );
  assert.equal(await options.count(), 0, "新 token 还没出结果时不许留着上一轮的候选");
  await page.keyboard.press("Enter");
  assert.equal(
    await textarea.inputValue(),
    "读 @README",
    "候选还没到货时回车既不能插旧路径，也不能插换行把 token 顶走",
  );
  // 到货之后照常能选。
  await settled(["README.md"]);
  await page.keyboard.press("Enter");
  assert.equal(await textarea.inputValue(), "读 @README.md ");
  slowQuery = null;

  // ⑨ 菜单开着时 `⌘↵` 仍然是发送：光标那条回车归菜单，带修饰键的那条不归。
  await textarea.fill("");
  await textarea.type("看 @src");
  await options.first().waitFor();
  await page.keyboard.press("Meta+Enter");
  await page.locator("#log li").nth(1).waitFor();
  assert.deepEqual(
    (await page.locator("#log li").allTextContents()).at(-1),
    "send:看 @src",
    "菜单开着也不能把 ⌘↵ 吃掉",
  );

  // ⑩ 被 .gitignore 挡着的文件：排在最后、标着「已忽略」，但照样选得中。
  //    （改之前它们压根搜不出来 —— `data/`、`dist/` 里的产物一个都 @ 不到。）
  await textarea.fill("");
  await textarea.type("看 @api");
  await settled(["api.ts", "apiClient.ts", "api.js"]);
  const ignoredRow = options.nth(2);
  assert.match(await ignoredRow.textContent() ?? "", /已忽略/, "忽略项要标出来，否则用户看不懂它为什么在最后");
  await ignoredRow.click();
  assert.equal(await textarea.inputValue(), "看 @dist/api.js ", "忽略项也得能选中");

  // ⑪ 候选被条数上限截了要说一声，不然用户以为「就这几个」。
  // 用一个前面没搜过的 token：搜过的那几个还躺在 hook 的缓存里，不会再问服务端。
  moreQuery = "usef";
  await textarea.fill("");
  await textarea.type("再看 @useF");
  await page.waitForFunction(
    () => document.querySelector(".mention-menu p")?.textContent?.includes("再敲几个字"),
    null,
    { timeout: 4000 },
  );
  moreQuery = null;

  // ⑫ 树：目录能就地展开，子项缩进挂在下面，回车插的是子项自己的完整路径。
  //    （改之前这里是一张平铺的全量路径清单，深处的文件和门面文件混在一起。）
  await textarea.fill("");
  await textarea.type("@");
  await settled(["@claude", "@codex", "dist/", "docs/", "src/", "README.md"]);
  const srcRow = options.filter({ hasText: "src/" }).first();
  await srcRow.click(); // 点目录 = 展开，不是插入
  await settled(["@claude", "@codex", "dist/", "docs/", "src/", "lib/", "api.ts", "README.md"]);
  assert.equal(await textarea.inputValue(), "@", "点一个收着的目录只该展开，不该往正文里插东西");
  assert.equal(await srcRow.getAttribute("aria-expanded"), "true");
  // 子项缩进比它爹深
  const pad = (row) => row.evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft));
  assert.ok(
    await pad(options.filter({ hasText: "api.ts" }).first()) > await pad(srcRow),
    "展开出来的子项必须看得出缩进，否则跟平铺没区别",
  );
  await options.filter({ hasText: "api.ts" }).first().click();
  assert.equal(await textarea.inputValue(), "@src/api.ts ", "插进正文的是完整路径，不是那一层的短名字");

  // ⑬ 搜索态按目录归堆：目录头只是标签，上下键和回车都不该落在它身上。
  await textarea.fill("");
  await textarea.type("看 @useFile");
  await settled(["useFileMention.ts"]);
  const groups = menu.locator(".mention-menu-group");
  assert.equal(await groups.count(), 1, "同一目录的命中要有个目录头");
  assert.match(await groups.first().textContent() ?? "", /src\/lib/);
  await page.keyboard.press("Enter");
  assert.equal(
    await textarea.inputValue(),
    "看 @src/lib/useFileMention.ts ",
    "回车选的是文件，不是那一行目录头",
  );

  // ⑭ 服务端还没更新时**必须说出来**。不说的话界面就是一列没有层级的文件，看着像
  //    树压根没做 —— 这一条正是这么被误判过一次的（前端新、:4317 还是旧进程）。
  legacyServer = true;
  await textarea.fill("");
  // 换一个这一轮没浏览过的目录：浏览过的那几层还在 hook 的缓存里，不会再问服务端。
  await textarea.type("@docs/");
  await page.waitForFunction(
    () => document.querySelector(".mention-menu p")?.textContent?.includes("重启 ash 服务"),
    null,
    { timeout: 4000 },
  );
  assert.equal(
    await menu.getByRole("option").filter({ hasText: "README.md" }).count(),
    1,
    "退化了也得能用：平铺清单照样能选",
  );
  legacyServer = false;

  console.log("file-mention-dom: ok");
} finally {
  await browser?.close();
  await server.close();
}
