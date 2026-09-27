import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";

// 侧聊里 Ctrl/⌘V 粘图：跑的是真的 /uploads 路由 + 真的 /chats/:id/messages，所以这条
// 用例同时钉住三段——传上去、拼进 prompt（attachmentsPrompt 那段固定文本）、在气泡里
// 还原成缩略图而不是让用户读一串绝对路径。
const root = fileURLToPath(new URL("..", import.meta.url));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const fixture = spawn(process.execPath, ["--import", "tsx", "server/scripts/side-chat-browser-fixture.ts"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
let browser;
let server;
try {
  const backend = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture startup timeout: ${logs}`)), 20000);
    const consume = (chunk) => { logs += chunk; const match = logs.match(/SIDE_FIXTURE_URL=(http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } };
    fixture.stdout.on("data", consume); fixture.stderr.on("data", consume);
    fixture.once("exit", (code) => { clearTimeout(timer); reject(new Error(`fixture exit ${code}: ${logs}`)); });
  });
  server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: backend } } } });
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/side-chat.html`;
  const state = async () => await (await page.request.get(`${backend}/api/fixture/state`)).json();
  const input = page.getByRole("textbox", { name: "侧聊消息输入" });
  const send = page.getByRole("button", { name: "发送侧聊消息" });
  const openSideChat = async () => {
    await page.getByRole("button", { name: "打开侧聊", exact: true }).click();
    await input.waitFor();
  };
  const paste = async (name) => {
    await input.evaluate((textarea, { name, png }) => {
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: "image/png" }));
      textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, { name, png: PNG });
  };

  await page.goto(url);
  await openSideChat();

  // ① 粘一张图：草稿区当场出现附件卡片，传完变成缩略图。
  await paste("screenshot.png");
  await page.locator(".side-chat-compose .task-upload-chip").waitFor();
  await page.locator(".side-chat-compose .task-upload-chip img").waitFor();
  assert.equal(await page.locator(".side-chat-compose .task-upload-chip.is-uploading").count(), 0, "传完不该再留在途卡片");
  assert.equal(await page.getByRole("button", { name: "移除 screenshot.png" }).count(), 1, "粘进来的图要能撤下");
  assert.equal(await input.inputValue(), "", "粘图不该把文件名之类的东西写进正文");

  // ② 只粘图不打字也能发（服务端按「有附件」放行空正文）。
  assert.equal(await send.isDisabled(), false, "只有附件、没有正文时也该能发");
  await send.click();
  const firstBubble = page.locator(".side-chat-message.is-user").first();
  await firstBubble.locator(".task-message-attachments img").waitFor();
  assert.doesNotMatch(await firstBubble.innerText(), /用户附带的文件|uploads/, "气泡里不该露出附件块原文或绝对路径");
  assert.equal(await page.locator(".side-chat-compose .task-upload-chip").count(), 0, "发完要把草稿里的附件摘掉");
  const firstSource = (await state()).sources.at(-1);
  assert.match(firstSource, /\[用户附带的文件[^\]]*\]/, "prompt 里要带上附件块");
  assert.match(firstSource, /uploads[\\/][^\s]+screenshot\.png/, "附件块里是可以 Read 的绝对路径");

  // ③ 正文 + 附件一起发：两样都要到位，正文不被附件块污染。
  await page.locator(".side-chat-message.is-agent.is-done").first().waitFor();
  await input.fill("这张图里的报错是什么？");
  await paste("error.png");
  await page.locator(".side-chat-compose .task-upload-chip img").waitFor();
  await send.click();
  const second = page.locator(".side-chat-message.is-user").nth(1);
  await second.locator(".task-message-attachments img").waitFor();
  assert.match(await second.innerText(), /这张图里的报错是什么？/);
  assert.doesNotMatch(await second.innerText(), /用户附带的文件|uploads/);
  const secondSource = (await state()).sources.at(-1);
  assert.match(secondSource, /这张图里的报错是什么？[\s\S]*\[用户附带的文件/, "正文在前、附件块缀在末尾");

  // ④ 传到一半：发送按住，房间也不让切——在途那张传完会落进「当时那个侧聊」的草稿。
  await page.locator(".side-chat-message.is-agent.is-done").nth(1).waitFor();
  let release;
  await page.route("**/api/uploads", async (route) => {
    await new Promise((resolve) => { release = resolve; });
    await route.continue();
  });
  await input.fill("等图传完再说");
  await paste("slow.png");
  await page.locator(".side-chat-compose .task-upload-chip.is-uploading").waitFor();
  assert.equal(await send.isDisabled(), true, "还有在途上传时不能发，否则发出去的那条少几张图");
  assert.equal(await page.getByRole("combobox", { name: "切换侧聊" }).isDisabled(), true, "上传中不许切侧聊");
  for (let i = 0; i < 100 && !release; i += 1) await page.waitForTimeout(50);
  release();
  await page.locator(".side-chat-compose .task-upload-chip.is-uploading").waitFor({ state: "detached" });
  await page.unroute("**/api/uploads");
  assert.equal(await send.isDisabled(), false, "传完要立刻放开发送");
  assert.equal(await page.getByRole("combobox", { name: "切换侧聊" }).isDisabled(), false, "传完要放开切换");

  // ⑤ 没发出去的附件跟正文一样是草稿：刷新页面还在原处。
  await page.reload();
  await openSideChat();
  assert.equal(await input.inputValue(), "等图传完再说");
  await page.locator(".side-chat-compose .task-upload-chip img").waitFor();
  assert.equal(await page.getByRole("button", { name: "移除 slow.png" }).count(), 1, "刷新后粘好的图要还在");

  // ⑥ 换到新侧聊：草稿各归各的，切回来还在。
  await page.getByRole("button", { name: "新建侧聊", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".side-chat-compose .task-upload-chip").length === 0);
  assert.equal(await input.inputValue(), "", "新侧聊不该继承上一个的草稿");
  await page.getByRole("combobox", { name: "切换侧聊" }).selectOption({ index: 1 });
  await page.locator(".side-chat-compose .task-upload-chip img").waitFor();
  assert.equal(await page.getByRole("button", { name: "移除 slow.png" }).count(), 1, "切回来附件要回到原来那个侧聊");

  // ⑦ 移除：撤下之后正文空了就又发不出去了（回到「空消息」那一档）。
  await input.fill("");
  await page.getByRole("button", { name: "移除 slow.png" }).click();
  await page.locator(".side-chat-compose .task-upload-chip").waitFor({ state: "detached" });
  assert.equal(await send.isDisabled(), true, "既没正文也没附件时不能发");

  assert.deepEqual(errors, [], "页面不应抛异常");
  console.log("✓ 侧聊粘贴附件：上传、只带图发送、正文+附件、在途门禁、草稿持久化与侧聊隔离、移除");
} finally {
  await browser?.close();
  await server?.close();
  fixture.kill("SIGTERM");
}
