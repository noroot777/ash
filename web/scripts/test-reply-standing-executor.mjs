// 对话框底部那颗胶囊的**归属**回归：点它改的是「这个任务以后都用谁」（写回任务），
// 而正文里 `@` 召唤仍然只作用于一次。两者在同一颗胶囊上，回归价值全在这条分界线：
// 一旦哪次重构把胶囊改回一次性，用户就又得每发一句重选一遍执行器。
// 跑法：npm -w web run test:reply-standing-executor
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

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  // 两个已注册执行器（胶囊的候选来自它们），其余接口在这个 fixture 里不参与判定。
  const PROFILES = [
    { id: "profile-codex", name: "codex@local", type: "codex", isDefault: true },
    { id: "profile-claude", name: "claude@local", type: "claude", isDefault: true },
  ];
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: path.endsWith("/agents") ? JSON.stringify(PROFILES) : "[]",
    });
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/reply-standing-executor.html`);

  const agentTrigger = page.getByRole("button", { name: /智能体：/ });
  const textarea = page.getByRole("textbox", { name: "回复任务" });
  const sendButton = page.getByRole("button", { name: "发送回复" });
  const logLines = async () => page.locator("#log li").allTextContents();

  await agentTrigger.waitFor();
  assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：codex/);

  // ① 点胶囊换智能体 = 改任务常设配置，立刻写回。
  await agentTrigger.click();
  await page.getByRole("option", { name: /@claude/ }).click();
  await page.keyboard.press("Escape"); // 选完智能体会自动向右展开模型段，这里不选模型
  assert.deepEqual(await logLines(), ["standing:claude|model=-|effort=-"]);
  assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：claude/);

  // ② 之后发送的每一条都跟着走：请求里不带一次性覆盖，服务端读任务字段即可。
  await textarea.fill("第一句");
  await sendButton.click();
  await page.locator("#log li").nth(1).waitFor();
  assert.deepEqual(await logLines(), [
    "standing:claude|model=-|effort=-",
    "send:第一句|agent=-|model=-|effort=-",
  ]);
  // 发完不回弹：胶囊上还是刚选的那个，不必为下一句再选一次。
  assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：claude/);

  // ③ 正文里 `@` 召唤仍是一次性：随这一句发出，发完退回常设配置。
  await textarea.fill("第二句 @codex");
  await page.getByRole("option", { name: /@codex/ }).click();
  await page.getByRole("option", { name: /^gpt-5\.6-sol/ }).click();
  assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /智能体：codex/);
  await sendButton.click();
  await page.locator("#log li").nth(2).waitFor();
  assert.deepEqual((await logLines()).slice(2), [
    "send:第二句|agent=codex|model=gpt-5.6-sol|effort=-",
  ]);
  assert.match(
    await agentTrigger.getAttribute("aria-label") ?? "",
    /智能体：claude/,
    "一次性召唤发完应退回任务常设配置，不能把 @ 的那次写成常设",
  );

  console.log("reply standing executor test passed");
} finally {
  await browser?.close();
  await server.close();
}
