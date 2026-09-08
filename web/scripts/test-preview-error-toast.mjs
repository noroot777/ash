// 预览起不来那一句**等用户自己收**，不自己走、也不被别的提示顶掉。
// 跑：npm -w web run test:preview-error-toast
//
// 钉四条：
//   ① 起失败的那一句显示出来后，**过了自动消失的窗口（2.6s）依然在**——它是一段要照着
//      抄进「预览命令」的说明，两秒多等于没说。
//   ② **期间来一条普通提示，它照样在。** notify 是 WorkspaceShell 的全局通道，用户读报错
//      时项目列表读取失败、复制反馈、分组创建随时可能插一句进来；第一版只有一个槽位，
//      那一句会把报错顶掉，再由它自己的 2.6s 定时器把整个 toast 清空——用户一次关闭都
//      没点，要照抄的命令就没了。
//   ③ 它能点：有一颗关闭按钮，按下去才收掉。
//   ④ 常规提示没被带着一起改：「已复制」这类照旧自己走。
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

/** 两个槽位此刻各自在显示什么（没挂上去就是 null）。 */
const readSlots = () => {
  const slot = (testId) => {
    const node = document.querySelector(`[data-testid=${testId}]`);
    if (!node || !node.classList.contains("is-visible")) return null;
    return {
      text: node.querySelector(".workspace-toast-text")?.textContent ?? "",
      // 收不掉的提示等于没有：常驻那句必须能点（否则关闭按钮点不着、文字也选不中）。
      clickable: getComputedStyle(node).pointerEvents !== "none",
      closers: node.querySelectorAll(".workspace-toast-close").length,
    };
  };
  return { pinned: slot("workspace-toast-pinned"), transient: slot("workspace-toast-transient") };
};

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/preview-error-toast.html`);

  // ① 起预览 —— 后端 409 回来一整份「认出了哪几个、各自怎么起」。
  await page.getByRole("button", { name: "打开预览" }).click();
  await page.getByTestId("workspace-toast-pinned").waitFor({ timeout: 5000 });
  const expected = await page.evaluate(() => window.__ambiguous);
  const shown = await page.evaluate(readSlots);
  assert.equal(shown.pinned?.text, expected, "报错被截断或换了内容");
  assert.equal(shown.pinned?.clickable, true, "常驻提示 pointer-events 是 none，关不掉也选不中");
  assert.equal(shown.pinned?.closers, 1, "常驻提示没给关闭按钮");

  // 自动消失的窗口是 2.6s，多等一截再看。
  await page.waitForTimeout(4000);
  assert.equal((await page.evaluate(readSlots)).pinned?.text, expected, "预览起不来那一句自己消失了——用户只看见红了一下");

  // ② 用户还在读报错，别处插进来一条普通提示：两句并存，报错不许被顶掉。
  await page.getByTestId("plain-notice").click();
  await page.getByTestId("workspace-toast-transient").waitFor({ timeout: 5000 });
  const both = await page.evaluate(readSlots);
  assert.equal(both.pinned?.text, expected, "一条普通提示就把常驻的预览报错顶掉了");
  assert.equal(both.transient?.text, "已复制", "普通提示没显示出来");
  assert.equal(both.transient?.closers, 0, "常规提示也长出了关闭按钮");
  // 普通提示自己走之后，报错**依然**在（老实现里正是这个定时器把整个 toast 清空的）。
  await page.waitForTimeout(3200);
  const after = await page.evaluate(readSlots);
  assert.equal(after.transient, null, "常规提示被一起改成了常驻");
  assert.equal(after.pinned?.text, expected, "普通提示的定时器把常驻的预览报错扫掉了");

  // ③ 按那颗关闭才收得掉。
  await page.getByRole("button", { name: "关闭提示" }).click();
  await page.waitForTimeout(400);
  assert.equal((await page.evaluate(readSlots)).pinned, null, "点了关闭，提示还赖着");
  assert.equal(
    await page.evaluate(() => document.querySelectorAll(".workspace-toast-close").length), 0,
    "提示收掉了，关闭按钮还留着",
  );

  console.log("preview error toast: ok");
} finally {
  await browser?.close();
  await server.close();
}
