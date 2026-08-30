import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 讨论的 G1 收敛门也能粘图（注入意见/提问继续那个输入区）。这条钉住的是：输入区是可以
// 再点一下收起来的，收起来之后在途上传既不能从界面上消失，也不能让「放行结束 / 打回终止」
// 抢在传完之前把这道门关掉——那两下都会让刚粘的图连同这次操作一起没了。
const root = fileURLToPath(new URL("..", import.meta.url));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const paste = (name) => async (page) => page.evaluate(({ name, png }) => {
  const textarea = document.querySelector(".duet-gate-composer textarea");
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  const data = new DataTransfer();
  data.items.add(new File([bytes], name, { type: "image/png" }));
  textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}, { name, png: PNG });

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage();
  const held = new Map();
  const release = async (name) => {
    for (let i = 0; i < 100 && !held.has(name); i++) await page.waitForTimeout(50);
    held.get(name)?.();
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/uploads" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      const name = typeof body.name === "string" ? body.name : "pasted.png";
      await new Promise((resolve) => held.set(name, resolve));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: `up-${name}`,
          path: `/tmp/uploads/${name}`,
          url: `data:image/png;base64,${PNG}`,
          name,
          kind: "image",
        }),
      }).catch(() => {});
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/duet-gate-upload.html`);

  const inject = page.getByRole("button", { name: "注入意见" });
  const approve = page.getByRole("button", { name: "放行结束" });
  const reject = page.getByRole("button", { name: "打回终止" });
  await approve.waitFor();

  // ① 输入区里粘一张，传的过程中这道门不能被放行或打回关掉。
  await inject.click();
  await paste("g1.png")(page);
  await page.getByText("g1.png", { exact: true }).waitFor();
  assert.equal(await page.locator(".task-upload-chip.is-uploading").count(), 1, "上传期间必须有在途卡片");
  assert.equal(await approve.isDisabled(), true, "上传未完成时不能放行结束");
  assert.equal(await reject.isDisabled(), true, "上传未完成时不能打回终止");

  // ② 再点一次「注入意见」把输入区收起来：在途状态必须留在界面上，理由也要写明白，
  //    否则用户只看到两个变灰的按钮，会当成按钮坏了（第 1 轮审查 P1）。
  await inject.click();
  await page.locator(".duet-gate-composer").waitFor({ state: "detached" });
  assert.equal(await page.locator(".task-upload-chip.is-uploading").count(), 1, "收起输入区后在途卡片必须还在");
  assert.match(
    await page.locator(".duet-gate-hold").innerText(),
    /上传中 \d+% · 传完才能放行或打回/,
    "收起输入区后要写明为什么现在放不了行",
  );
  assert.equal(await approve.isDisabled(), true, "收起输入区不该把放行按钮放开");
  await approve.click({ force: true });
  await page.waitForTimeout(300);
  assert.equal(await page.getByText("门禁：approve").count(), 0, "上传中点放行不能真的把门关掉");

  // ③ 传完了但还没提交：approve/reject 这两个 GateAction 带不了附件，这时候放行等于
  //    把刚传好的图扔了，所以照样按住，并指给用户下一步该点哪儿（第 2 轮审查 P1）。
  await release("g1.png");
  await page.locator(".task-upload-chip img").waitFor();
  assert.equal(await page.locator(".task-upload-chip.is-uploading").count(), 0, "传完不该再留在途卡片");
  assert.match(
    await page.locator(".duet-gate-hold").innerText(),
    /1 个附件还没提交 · 点「注入意见 \/ 提问继续」发出去，或先移除/,
    "传完但没提交时要说清楚附件还在手上、怎么才能发出去",
  );
  assert.equal(await approve.isDisabled(), true, "还捏着没提交的附件时不能放行结束");
  await approve.click({ force: true });
  await page.waitForTimeout(300);
  assert.equal(await page.getByText("门禁：approve").count(), 0, "附件没提交时点放行不能把门关掉");

  // ③b 重新展开输入区，把它提交出去：附件跟着 inject 走，门禁恢复。
  await inject.click();
  await page.getByRole("button", { name: "提交并继续" }).click();
  await page.getByText("门禁：inject").waitFor();
  assert.equal(await page.locator(".duet-gate-hold").count(), 0, "提交之后不该还挂着提示");
  assert.equal(await approve.isDisabled(), false, "提交之后必须能放行");

  // ③c 提示里说的另一条出路：不想发了就移除，移除完门禁也要跟着松开。
  await inject.click();
  await paste("drop.png")(page);
  await release("drop.png");
  await page.getByRole("button", { name: "移除 drop.png" }).waitFor();
  await inject.click();
  assert.equal(await approve.isDisabled(), true, "又有没提交的附件时门禁要重新按住");
  await page.getByRole("button", { name: "移除 drop.png" }).click();
  assert.equal(await page.locator(".duet-gate-hold").count(), 0, "移除之后不该还挂着提示");
  assert.equal(await approve.isDisabled(), false, "移除之后必须能放行");

  // ④ 传到一半反悔：取消掉在途的那个，门禁当场恢复。
  await inject.click();
  await paste("later.png")(page);
  await page.getByText("later.png", { exact: true }).waitFor();
  await inject.click();
  assert.equal(await approve.isDisabled(), true, "又有新的在途上传时门禁要重新按住");
  await page.getByRole("button", { name: "取消上传 later.png" }).click();
  await page.getByText("later.png", { exact: true }).waitFor({ state: "detached" });
  assert.equal(await page.locator(".task-upload-error").count(), 0, "用户自己取消的不算上传失败");
  assert.equal(await approve.isDisabled(), false, "取消后应立刻恢复可放行");
  await release("later.png");

  await approve.click();
  await page.getByText("门禁：approve").waitFor();

  console.log("duet gate upload test passed");
} finally {
  await browser?.close();
  await server.close();
}
