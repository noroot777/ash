// 预览起不来那一句**等用户自己收**，不自己走。跑：npm -w web run test:preview-error-toast
//
// 钉三条：
//   ① 起失败的那一句显示出来后，**过了自动消失的窗口（2.6s）依然在**——它是一段要照着
//      抄进「预览命令」的说明，两秒多等于没说。
//   ② 它能点：有一颗关闭按钮，按下去才收掉。
//   ③ 常规提示没被带着一起改：「已复制」这类照旧自己走。
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/preview-error-toast.html`);

  // ① 起预览 —— 后端 409 回来一整份「认出了哪几个、各自怎么起」。
  await page.getByRole("button", { name: "打开预览" }).click();
  const toastText = page.getByTestId("workspace-toast-text");
  await toastText.filter({ hasText: "ash 不替你挑" }).waitFor({ timeout: 5000 });
  const expected = await page.evaluate(() => window.__ambiguous);
  assert.equal(await toastText.textContent(), expected, "报错被截断或换了内容");

  // 自动消失的窗口是 2.6s，多等一截再看。
  await page.waitForTimeout(4000);
  const stillThere = await page.evaluate(() => {
    const toast = document.querySelector(".workspace-toast");
    return {
      visible: !!toast?.classList.contains("is-visible"),
      text: toast?.querySelector("[data-testid=workspace-toast-text]")?.textContent ?? "",
      // 收不掉的提示等于没有：它必须能点（否则关闭按钮点不着）。
      clickable: toast ? getComputedStyle(toast).pointerEvents !== "none" : false,
    };
  });
  assert.equal(stillThere.visible, true, "预览起不来那一句自己消失了——用户只看见红了一下");
  assert.equal(stillThere.text, expected, "常驻期间报错内容变了");
  assert.equal(stillThere.clickable, true, "常驻提示 pointer-events 是 none，关不掉也选不中");

  // ② 按那颗关闭才收得掉。
  await page.getByRole("button", { name: "关闭提示" }).click();
  await page.waitForTimeout(300);
  const afterClose = await page.evaluate(() => ({
    visible: !!document.querySelector(".workspace-toast")?.classList.contains("is-visible"),
    closers: document.querySelectorAll(".workspace-toast-close").length,
  }));
  assert.equal(afterClose.visible, false, "点了关闭，提示还赖着");
  assert.equal(afterClose.closers, 0, "提示收掉了，关闭按钮还留着");

  // ③ 常规提示照旧自己走。
  await page.getByTestId("plain-notice").click();
  await toastText.filter({ hasText: "已复制" }).waitFor({ timeout: 5000 });
  assert.equal(
    await page.evaluate(() => document.querySelectorAll(".workspace-toast-close").length), 0,
    "常规提示也长出了关闭按钮",
  );
  await page.waitForTimeout(3200);
  assert.equal(
    await page.evaluate(() => !!document.querySelector(".workspace-toast")?.classList.contains("is-visible")),
    false,
    "常规提示被一起改成了常驻",
  );

  console.log("preview error toast: ok");
} finally {
  await browser?.close();
  await server.close();
}
