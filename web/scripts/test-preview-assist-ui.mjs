// 「AI 协助填写」这块面板的浏览器回归。
//
// 要钉的是**每一种结局在界面上都留得下痕迹、而且说的是实话**，因为这颗按钮要跑几分钟，
// 用户在这几分钟里会换页面、会刷新、会自己动手写脚本，还可能碰上 ash 重启或者网断一下：
//   ① 点下去 → 看得见第几轮、看得见「停止」；
//   ② 点停止 → 留下「已取消」（不是悄悄退回初始按钮）；
//   ③ ash 重启把内存态吞了 → 「已随 ash 重启中断」，而且**刷新之后还在**
//      （项目约定：停止/中断必须留下持久可见的状态，判据就是刷新后还看得见）；
//   ④ 作业正常跑完、终态过了 10 分钟被清掉 → 说的是「过期」，**不能说成重启**
//      （服务端回的都是 job: null，靠它自报的实例身份分辨）；
//   ⑤ 启动请求断在路上 → 服务端那边已经接单了，页面必须把它接管回来（否则停都停不了）；
//      连「响应丢掉之前作业已经跑成功」也算数：那一次验证是真的，不能变成一句 Failed to fetch；
//   ⑥ 用户在这期间自己写了脚本 → 成功结果**不许静默覆盖**，摆出来让他挑，挑完的话要说准
//      （「保留我写的」之后还说「已填入」＝骗人）；
//   ⑦ 输入框没动过 → 成功就直接填，且只填一次；
//   ⑧ 不是这个页面点出来的那份成功结果（服务端留 10 分钟，刷新就会再读到一遍）→ 只许展示，
//      **不许再动一次输入框**（否则用户刚手写并保存的脚本被旧结果盖回去）。
//
// 服务端那份是假的（fixture 里几个模块级变量），这里测的是前端这一侧的判断：什么时候轮询、
// null 该读成哪一种、填还是不填。
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
  const dismiss = () => progress.getByRole("button", { name: "知道了" }).click();
  const notices = async () => JSON.parse(await page.getByTestId("notices").textContent());
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
  await dismiss();
  await progress.waitFor({ state: "detached" });
  await page.reload();
  await script.waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await progress.count(), 0, "收掉的提示不该在刷新后又冒出来");

  // ④ 同样是 job: null，但 ash 没重启过：那是作业跑完之后终态自己过期了
  await startAssist.click();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  await page.getByTestId("assist-expire").click();
  await progress.getByText("已经过期", { exact: false }).waitFor();
  const expired = await progress.innerText();
  assert.doesNotMatch(expired, /重启/, "ash 没重启过就不能说它重启了");
  assert.match(expired, /只保留 10 分钟/, "要说清结果为什么没了");
  await dismiss();
  await progress.waitFor({ state: "detached" });

  // ⑤ 启动请求断在路上：服务端已经接单，页面得把它接管回来
  await page.getByTestId("assist-drop-post").click();
  await startAssist.click();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  await stopAssist.waitFor();
  assert.equal(await page.locator(".preview-assist-error").count(), 0, "接管成功就不该再红一条启动失败");
  await stopAssist.click();
  await progress.locator(".preview-assist-step").getByText("已取消", { exact: false }).waitFor();
  await dismiss().catch(() => {});

  // ⑤b 响应丢在路上，但服务端那边作业已经跑完、还成功了：那次验证是真的
  await page.getByTestId("assist-drop-post-succeeded").click();
  await startAssist.click();
  await progress.getByText("真的起来过一次", { exact: false }).waitFor();
  assert.equal(await page.locator(".preview-assist-error").count(), 0, "作业其实成功了就不该只报一句启动失败");
  await page.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n") === expected, "npm run dev -- --port $PORT");
  assert.equal(await editorText(script), "npm run dev -- --port $PORT", "响应丢了也不能把已经起来过的脚本丢掉");

  // ⑥ 跑的这几分钟里用户自己写了东西：不许静默覆盖
  await startAssist.click();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  const mine = "npm run dev -- --port 7777 # 我正在手写";
  await script.fill(mine);
  await page.getByTestId("assist-succeed").click();
  await progress.getByText("没有直接覆盖", { exact: false }).waitFor();
  assert.equal(await editorText(script), mine, "运行期间手写的内容不能被成功结果顶掉");
  assert.equal((await notices()).filter((line) => line.includes("没有直接覆盖")).length, 1, "不覆盖这件事要说一声");
  await page.waitForTimeout(1500);
  assert.equal(await editorText(script), mine, "下一拍轮询也不能把它盖回去");
  // 摆出来的那条脚本要看得见，而且换不换由用户点
  assert.match(await progress.innerText(), /npm run dev -- --port \$PORT/, "AI 试出来的那条要摆出来给人看");
  // 点完「保留我写的」，卡片得说准：说成「已填进上面的输入框」，用户就会以为框里这条手写的
  // 是 ash 验证过的（第 3 轮审查）。
  await progress.getByRole("button", { name: "保留我写的" }).click();
  await progress.getByText("保留你自己写的那条", { exact: false }).waitFor();
  const kept = await progress.innerText();
  assert.doesNotMatch(kept, /脚本已填进上面的输入框/, "没填进去就不能说填了");
  assert.match(kept, /没有经过 ash 试跑/, "要说清框里这条没被验证过");
  assert.equal(await editorText(script), mine, "选了保留就还是手写那份");

  // ⑥b 同一张卡的另一个选择：点「用这条替换」才换
  await startAssist.click();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  await script.fill(`${mine} 再改一遍`);
  await page.getByTestId("assist-succeed").click();
  await progress.getByText("没有直接覆盖", { exact: false }).waitFor();
  await progress.getByRole("button", { name: "用这条替换" }).click();
  await page.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n") === expected, "npm run dev -- --port $PORT");
  assert.equal(await editorText(script), "npm run dev -- --port $PORT", "点了替换才换");
  assert.match(await progress.innerText(), /保存预览设置/, "替换之后才该说「已填进输入框、还得点保存」");

  // ⑦ 输入框没动过：成功就直接填，且只填一次
  const filledBefore = (await notices()).filter((line) => line.includes("脚本已填入")).length;
  await script.fill("# 等 AI 填");
  await startAssist.click();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  await page.getByTestId("assist-succeed").click();
  await progress.getByText("真的起来过一次", { exact: false }).waitFor();
  await page.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n") === expected, "npm run dev -- --port $PORT");
  assert.equal(await editorText(script), "npm run dev -- --port $PORT", "起来过的那条脚本要填进输入框");
  assert.match(await progress.innerText(), /保存预览设置/, "填完要说清还得点保存");
  assert.equal((await notices()).filter((line) => line.includes("脚本已填入")).length, filledBefore + 1, "同一个作业只提示一次");
  const handwritten = "npm run dev -- --port 8888 # 这条是我自己定的";
  await script.fill(handwritten);
  await page.waitForTimeout(1500);
  assert.equal(await editorText(script), handwritten, "轮询不能反复把脚本盖回去");
  assert.equal((await notices()).filter((line) => line.includes("脚本已填入")).length, filledBefore + 1, "下一拍轮询也不该再提示一次");

  // ⑧ 服务端把成功终态留 10 分钟：**不是这个页面点出来的**那一份只许展示，不许再动输入框
  //    （第 3 轮审查复现：手写并保存之后刷一下页面，旧结果又被填回去，再点保存就把刚存的改回去）
  await page.getByRole("button", { name: "保存预览设置" }).click();
  await page.waitForFunction((expected) =>
    (document.querySelector('[data-testid="stored-projects"]')?.textContent ?? "").includes(expected), handwritten);
  await page.reload();
  await script.waitFor();
  await progress.getByText("没有动上面输入框里的内容", { exact: false }).waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await editorText(script), handwritten, "刷新后旧的成功结果不许再覆盖一次");
  const shown = await progress.innerText();
  assert.doesNotMatch(shown, /脚本已填进上面的输入框/, "没动输入框就不能说填了");
  assert.match(shown, /npm run dev -- --port \$PORT/, "旧结果本身还是要看得见，能复制走");
  assert.deepEqual((await notices()).filter((line) => line.includes("脚本已填入")), [], "刷新之后不该再提示一次填入");

  assert.deepEqual(errors, [], "AI 协助面板不应产生运行时异常");
  console.log("preview ai assist: ok (rounds, cancel, restart vs expiry, dropped start recovered, dropped-but-succeeded kept, manual edit protected, keep-mine wording, fill once, stale success not reapplied)");
} finally {
  await browser?.close();
  await server.close();
}
