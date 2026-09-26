// 「AI 协助填写」这块面板的浏览器回归。
//
// 要钉的是**四种结局在界面上都留得下痕迹**，因为这颗按钮要跑几分钟，而用户在这几分钟里
// 会换页面、会刷新、会碰上 ash 重启：
//   ① 点下去 → 看得见第几轮、看得见「停止」；
//   ② 点停止 → 留下「已取消」（不是悄悄退回初始按钮）；
//   ③ ash 重启把内存态吞了 → 摆出「已随 ash 重启中断」，而且**刷新之后还在**
//      （项目约定：停止/中断必须留下持久可见的状态，判据就是刷新后还看得见）；
//   ④ 真起来了 → 脚本自己落进上面的启动脚本输入框，并说清下一步还得点保存。
//
// 服务端那份是假的（fixture 里一个模块级变量），这里测的是前端这一侧的判断：什么时候轮询、
// null 该读成「中断」还是「没点过」、填一次还是填两次。
// 跑法：npm -w web run test:preview-assist-ui
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const editorText = async (editor) => editor.locator(".cm-line").evaluateAll((lines) =>
  lines.map((line) => (line.querySelector(".cm-placeholder") ? "" : line.textContent)).join("\n"));

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
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const caseId = `assist-${process.pid}-${Date.now()}`;
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/project-settings-draft.html?case=${caseId}`;
  await page.goto(url);

  const script = page.getByRole("textbox", { name: "启动脚本", exact: true });
  const startAssist = page.getByRole("button", { name: "AI 协助填写" });
  // 跑起来之后这颗按钮改叫「AI 正在判断…」，所以「它现在什么状态」得按位置取，不能按名字。
  const assistButton = page.locator(".preview-assist-actions > button").first();
  const stopAssist = page.getByRole("button", { name: "停止" });
  const progress = page.locator(".preview-assist-progress");
  await script.waitFor();
  await startAssist.waitFor();
  assert.equal(await progress.count(), 0, "没点过的时候不该有进度卡");
  // 「让谁来判断」那颗胶囊必须真的渲染出来 —— 它读的是 /api/agents，回了个非数组就整页白屏。
  assert.equal(await page.locator(".preview-assist-executor").count(), 1, "执行器选择应随面板一起出现");

  // ① 点下去
  await startAssist.click();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  await stopAssist.waitFor();
  assert.match(await progress.innerText(), /1\/3/, "进度卡要说清跑到第几轮");
  assert.equal(await assistButton.isDisabled(), true, "跑着的时候不能再点一次");
  assert.match(await assistButton.innerText(), /AI 正在判断/, "按钮自己也要说明它在跑");

  // ② 停止留下痕迹
  await stopAssist.click();
  await progress.locator(".preview-assist-step").getByText("已取消", { exact: false }).waitFor();
  await stopAssist.waitFor({ state: "detached" });
  assert.equal(await assistButton.isDisabled(), false, "停下来之后要能重新点");

  // ③ ash 重启：服务端只回 job: null，界面不能装作没点过
  await startAssist.click();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  await page.getByTestId("assist-restart").click();
  await progress.getByText("已随 ash 重启中断", { exact: false }).waitFor();
  await page.reload();
  await script.waitFor();
  await progress.getByText("已随 ash 重启中断", { exact: false }).waitFor();
  assert.match(await progress.innerText(), /再点一次/, "中断之后要说清下一步怎么办");
  // 这张卡是本地记录推出来的，服务端没有对应的东西可轮询，所以必须给它一个出口。
  await progress.getByRole("button", { name: "知道了" }).click();
  await progress.waitFor({ state: "detached" });
  await page.reload();
  await script.waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await progress.count(), 0, "收掉的中断提示不该在刷新后又冒出来");

  // ④ 真起来了：脚本自己落进输入框
  await startAssist.click();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  await page.getByTestId("assist-succeed").click();
  await progress.getByText("真的起来过一次", { exact: false }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n").includes("npm run dev -- --port $PORT"));
  assert.equal(await editorText(script), "npm run dev -- --port $PORT", "起来过的那条脚本要填进输入框");
  assert.match(await progress.innerText(), /保存预览设置/, "填完要说清还得点保存");
  const notices = JSON.parse(await page.getByTestId("notices").textContent());
  assert.equal(notices.filter((line) => line.includes("脚本已填入")).length, 1, "同一个作业只提示一次");
  // 用户在填完之后手工改的内容，不该被下一拍轮询又盖回去。
  await script.fill("我自己改的");
  await page.waitForTimeout(1500);
  assert.equal(await editorText(script), "我自己改的", "轮询不能反复把脚本盖回去");

  assert.deepEqual(errors, [], "AI 协助面板不应产生运行时异常");
  console.log("preview ai assist: ok (running rounds, cancel, restart interruption survives refresh, dismiss, fill once)");
} finally {
  await browser?.close();
  await server.close();
}
