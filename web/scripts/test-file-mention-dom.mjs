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
];

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/agents")) return json(PROFILES);
    if (url.pathname.endsWith("/file-search")) {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      const matched = FILES.filter((path) => !query || path.toLowerCase().includes(query));
      return json({
        root: { path: "/repo" },
        hits: matched.map((path) => {
          const at = path.lastIndexOf("/");
          return {
            path,
            name: at < 0 ? path : path.slice(at + 1),
            dir: at < 0 ? "" : path.slice(0, at),
            kind: "file",
          };
        }),
        truncated: false,
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
  const settled = (expected) => page.waitForFunction(
    (want) => {
      const texts = [...document.querySelectorAll('[role="option"]')].map((node) => node.textContent ?? "");
      return texts.length === want.length && want.every((needle, index) => texts[index]?.includes(needle));
    },
    expected,
    { timeout: 5000 },
  );

  // ① 只敲一个 @：两类候选都在，智能体排在文件前面。
  await textarea.fill("");
  await textarea.type("@");
  await settled(["@claude", "@codex", "README.md", "api.ts", "apiClient.ts", "useFileMention.ts", "计划 A.md"]);

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

  console.log("file-mention-dom: ok");
} finally {
  await browser?.close();
  await server.close();
}
