import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 撤回一条待发送消息 = 把它从队列上取下来 + 原样放回对话框（正文、图片、文件）。
// 这条用真浏览器点那颗按钮，钉住两件事：取消成功才回填、取消失败一个字都不动。

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const message = (id, text, attachments) => ({
  id,
  taskId: "task-a",
  text,
  attachments,
  agent: null,
  executorId: null,
  model: null,
  reasoningEffort: null,
  sessionRole: null,
  mode: "queued",
  sendAt: id === "msg-fail" ? "2026-08-25T10:00:00.000Z" : "2026-08-25T10:00:01.000Z",
  status: "pending",
  createdAt: "2026-08-25T10:00:00.000Z",
  sentAt: null,
});

const PENDING = [
  message("msg-fail", "撤不掉的那条", []),
  message("msg-ok", "排队里的原话", ["data/uploads/abcdefghijkl-shot.png", "/tmp/spec.pdf"]),
  message("msg-late", "迟到的原话", ["/tmp/late.pdf"]),
];

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage();
  let deleted = [];
  let remaining = PENDING;
  // 发送请求按住不放，好在「请求在途」这段时间里去点另一条消息的撤回。
  let releaseReply;
  let replyHeld;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/tasks/task-a/scheduled-messages") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(remaining) });
      return;
    }
    if (path === "/api/tasks/task-a/reply" && route.request().method() === "POST") {
      if (replyHeld) await replyHeld;
      const sent = JSON.parse(route.request().postData() ?? "{}");
      const queued = message("msg-sent", sent.text ?? "", sent.attachments ?? []);
      remaining = [...remaining, queued];
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ scheduled: true, message: queued }),
      });
      return;
    }
    const canceled = /^\/api\/scheduled-messages\/([^/]+)$/.exec(path);
    if (canceled && route.request().method() === "DELETE") {
      const id = canceled[1];
      deleted.push(id);
      if (id === "msg-fail") {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "消息已经发出去了" }) });
        return;
      }
      remaining = remaining.filter((item) => item.id !== id);
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/withdraw-scheduled.html`);

  const input = page.getByRole("textbox", { name: "回复任务" });
  await page.getByText("排队里的原话", { exact: true }).waitFor();
  await input.fill("我后来又写的草稿");

  // ① 取消失败：消息还挂在队列上，输入框一个字都不能变（否则同一句话会发两遍）。
  await page.getByRole("button", { name: /撤回.*撤不掉的那条/ }).click();
  await page.getByText("消息已经发出去了").waitFor();
  assert.equal(await input.inputValue(), "我后来又写的草稿", "撤回失败不得改动草稿");
  assert.equal(await page.getByText("撤不掉的那条", { exact: true }).count(), 1, "撤回失败的消息必须留在托盘上");

  // ② 取消成功：正文接回草稿前面，图片和文件都变回可再次发送的附件卡片。
  await page.getByRole("button", { name: /撤回.*排队里的原话/ }).click();
  await page.getByText("shot.png", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "排队里的原话\n\n我后来又写的草稿", "撤回的正文应排在已有草稿前面");
  assert.equal(await page.getByText("spec.pdf", { exact: true }).count(), 1, "非图片附件也要放回对话框");
  assert.equal(await page.locator(".task-upload-chip img").count(), 1, "图片附件应还原成可预览的缩略图");
  assert.equal(await page.getByText("排队里的原话", { exact: true }).count(), 0, "撤回成功后托盘上不该再留这一行");
  assert.deepEqual(deleted, ["msg-fail", "msg-ok"], "每次撤回都必须真的调用取消端点");
  const sendButton = page.getByRole("button", { name: "排队发送，任务跑完自动发出" });
  assert.equal(await sendButton.isEnabled(), true, "撤回回来的内容应能直接再排一次队");

  // ③ 交错：发送请求在途时撤回另一条消息。撤回排在发送结算之后——发送先清掉它自己那份
  //    草稿，撤回的正文和附件再并进来，最后框里只剩撤回来的这份，谁也没被谁清掉。
  let release;
  replyHeld = new Promise((resolve) => { release = resolve; });
  await sendButton.click();
  await page.getByRole("button", { name: /撤回.*迟到的原话/ }).click();
  await page.waitForTimeout(400);
  assert.deepEqual(deleted, ["msg-fail", "msg-ok", "msg-late"], "在途期间的撤回要立刻真的取消掉，不必等发送");
  release();
  for (let i = 0; i < 100 && await input.inputValue() !== "迟到的原话"; i++) await page.waitForTimeout(100);

  assert.equal(await input.inputValue(), "迟到的原话", "发送结算后撤回来的正文必须原样落在草稿里");
  await page.getByText("late.pdf", { exact: true }).waitFor();
  assert.equal(await page.locator(".task-upload-chip").count(), 1, "发出去的附件摘掉，撤回来的那个留下");

  // ④ 审查实测过的那条路：发送在途时把草稿整个重写。发出去的是「方案」，用户改成
  //    「新方案细节」——里面碰巧包含「方案」两个字，任何子串减法都会把它切成「新细节」。
  await input.fill("方案");
  replyHeld = new Promise((resolve) => { release = resolve; });
  await sendButton.click();
  await input.fill("新方案细节");
  release();
  await page.waitForTimeout(1500);
  assert.equal(await input.inputValue(), "新方案细节", "在途重写的新草稿必须一个字都不动");

  console.log("withdraw scheduled message test passed");
} finally {
  await browser?.close();
  await server.close();
}
