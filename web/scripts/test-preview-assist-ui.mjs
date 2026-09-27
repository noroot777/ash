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
//      **不许再动一次输入框**（否则用户刚手写并保存的脚本被旧结果盖回去）；
//   ⑨ 别处点的那份**正在跑**的时候才打开页面 → 同样一路只读，不许在它成功时冒充「我点的」；
//   ⑩ 别处那份正在跑的时候**点了按钮** → 服务端复用了它、这一次并没有新开，界面要说实话，
//      而且它的结果照样不许动输入框（认领只认这次点击自报的 claim）；
//   ⑪ 同一个浏览器的**另一个标签页**（同源、共享 localStorage、从没点过按钮）→ 照实显示这个
//      项目上有一份在跑，但说清「是别的页面点的」，成功时一个字都不动它自己的输入框；
//   ⑫ 从点过按钮的那一页**打开/复制出来的标签**（sessionStorage 带着来源页的初始副本，手里那份
//      claim 跟服务端作业对得上）→ 同样只读：所有权得靠一次「谁还拿着这个 claim」的裁决分出来；
//   ⑬ 那次裁决**不能靠正主答话**：正主主线程卡住、标签被冻结时它一声不出，静默不许被读成
//      「没有正主」（主路交给浏览器记账的页面租约，JS 停摆不影响锁的账）；
//   ⑭ 没有 Web Locks 的环境（裸 http 的局域网地址不是安全上下文）只能点名，那就必须**可撤回**：
//      正主的应答迟到 800ms，副本先认了领，迟到那句话一到就得当场交出去；
//   ⑮ 同一档里顺序反过来（作业先成功、确认后到）→ 「暂且算我的」撑不起不可逆的动作：成功时只许
//      把脚本摆出来让用户拍板，不许自己填（填进去和那句「已填入」都收不回来）。正主那一路照旧自动填。
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
  // 一个 context 里开页面（不是 browser.newPage()，那样每页一份独立存储）：⑪ 要的正是
  // **同源、共享 localStorage 的两个标签页**，作业所有权不能在它们之间串。
  const context = await browser.newContext({ viewport: { width: 1000, height: 1200 } });
  const page = await context.newPage();
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

  // ⑨ 别处点的那一份**正在跑**的时候才打开页面：从头到尾只读，连它成功之后也不许动输入框
  //    （第 4 轮审查复现：本地没有任何追踪，判成「不是我的」之后却照样把它记进追踪，
  //    下一拍就凭「jobId 对上了」翻成「我点的」，成功时把用户已保存的脚本换掉）
  await page.getByTestId("assist-foreign-running").click();
  await page.reload();
  await script.waitFor();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  assert.equal(await editorText(script), handwritten, "别处在跑，输入框不该动");
  await page.waitForTimeout(2000); // 至少跨一拍轮询：修好之前正是这一拍把它认成「我点的」
  await page.getByTestId("assist-succeed").click();
  await progress.getByText("没有动上面输入框里的内容", { exact: false }).waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await editorText(script), handwritten, "别处跑出来的结果不许覆盖我已保存的脚本");
  assert.deepEqual((await notices()).filter((line) => line.includes("脚本已填入")), [], "没填就不该提示填入");

  // ⑩ 别处那份还在跑的时候点按钮：服务端直接把那一份交回来（不新开）。界面必须说清「这次没有
  //    新开」，而且它成功时也不许当成自己的结果填进输入框（第 5 轮审查复现：空 jobId 的 pending
  //    记录会认领任意作业，同事跑出来的脚本覆盖了用户已保存的那条）
  await page.getByTestId("assist-foreign-running").click();
  await startAssist.click();
  await page.locator(".preview-assist-error").getByText("没有新开", { exact: false }).waitFor();
  assert.equal(await editorText(script), handwritten, "这一次没开起来，输入框不该动");
  await page.getByTestId("assist-succeed").click();
  await progress.getByText("没有动上面输入框里的内容", { exact: false }).waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await editorText(script), handwritten, "服务端复用的那份别人的作业，成功了也不许覆盖");
  assert.deepEqual((await notices()).filter((line) => line.includes("脚本已填入")), [], "没填就不该提示填入");

  // ⑪ 同一浏览器的另一个标签页：所有权凭据不能摊给同源的每一个标签（第 6 轮审查双标签复现：
  //    B 从没点过按钮，却显示「AI 正在判断…」，并在成功时把自己输入框里的内容改掉）
  const own = "# 等这一页自己的 AI 结果";
  await script.fill(own);
  await startAssist.click();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  const other = await context.newPage();
  const otherErrors = [];
  other.on("pageerror", (failure) => otherErrors.push(failure.message));
  await other.goto(url);
  const otherScript = other.getByRole("textbox", { name: "启动脚本", exact: true });
  const otherProgress = other.locator(".preview-assist-progress");
  const otherNotices = async () => JSON.parse(await other.getByTestId("notices").textContent());
  await otherScript.waitFor();
  // 照实说这个项目上有一份在跑，同时说清它不是这一页点的
  await otherProgress.getByText("别的页面点的", { exact: false }).waitFor();
  assert.equal(await editorText(otherScript), handwritten, "另一个标签页读的是已保存那条，不该被动");
  await page.getByTestId("assist-succeed").click();
  // 点了按钮的那一页照旧拿到结果（隔离所有权不能把正常那条路一起隔掉）
  await page.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n") === expected, "npm run dev -- --port $PORT");
  await otherProgress.getByText("没有动上面输入框里的内容", { exact: false }).waitFor();
  await other.waitForTimeout(1500);
  assert.equal(await editorText(otherScript), handwritten, "别的页面点出来的结果不许改这个标签页的脚本");
  assert.deepEqual((await otherNotices()).filter((line) => line.includes("脚本已填入")), [], "它没填就不该提示填入");
  assert.deepEqual(otherErrors, [], "另一个标签页也不应产生运行时异常");
  await other.close();

  // ⑫ 由点过按钮的这一页 `window.open` 出来的新标签（「复制标签页」是同一种入口）：浏览器会把
  //    **来源页面 sessionStorage 的初始副本**交给它，于是它手里也有一份对得上的 claim
  //    （第 7 轮审查复现：副本页从没点过按钮，成功时却自动改掉自己的启动脚本并说「脚本已填入」）。
  //    ⑪ 用的 context.newPage() 没有 opener，正好绕过了这种复制语义，所以得单开一条。
  await script.fill("# 等这一页自己的 AI 结果（第二发）");
  await startAssist.click();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  const [copy] = await Promise.all([
    context.waitForEvent("page"),
    page.evaluate(() => { window.open(location.href, "_blank"); }),
  ]);
  const copyErrors = [];
  copy.on("pageerror", (failure) => copyErrors.push(failure.message));
  await copy.waitForLoadState();
  const copyScript = copy.getByRole("textbox", { name: "启动脚本", exact: true });
  const copyProgress = copy.locator(".preview-assist-progress");
  const copyNotices = async () => JSON.parse(await copy.getByTestId("notices").textContent());
  await copyScript.waitFor();
  // 它也该照实显示这个项目上有一份在跑 —— 但必须说清不是这一页点的
  await copyProgress.getByText("别的页面点的", { exact: false }).waitFor();
  assert.equal(await editorText(copyScript), handwritten, "复制出来的标签读的是已保存那条，不该被动");
  await page.getByTestId("assist-succeed").click();
  // 点了按钮的那一页照旧拿到结果
  await page.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n") === expected, "npm run dev -- --port $PORT");
  await copyProgress.getByText("没有动上面输入框里的内容", { exact: false }).waitFor();
  await copy.waitForTimeout(1500);
  assert.equal(await editorText(copyScript), handwritten, "继承来的会话副本不许把结果填进自己的输入框");
  assert.deepEqual((await copyNotices()).filter((line) => line.includes("脚本已填入")), [], "它没填就不该提示填入");
  assert.deepEqual(copyErrors, [], "复制出来的标签也不应产生运行时异常");
  await copy.close();

  // ⑬ 正主**答不上话**的时候（主线程卡住几百毫秒、标签被冻结、调度延迟）：所有权裁决不许把
  //    静默读成「没有正主」（第 8 轮审查复现：正主回包迟到 800ms，副本在 300ms 静默超时上
  //    就认了领，作业成功后把自己的输入框改了）。主路的账记在浏览器那边 —— 锁还在正主手里，
  //    它一个字不答也照样是正主。
  await script.fill("# 正主正在忙，但它还活着");
  await startAssist.click();
  await progress.getByText("正在读这个项目", { exact: false }).waitFor();
  // 让这一页从此不再应答任何点名（等价于它的 JS 停摆）。产品代码一行没动，patch 只在测试里。
  const muteHeld = () => {
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (note) {
      if (note && typeof note === "object" && note.kind === "held") return undefined;
      return post.call(this, note);
    };
  };
  await page.evaluate(muteHeld);
  const [mute] = await Promise.all([
    context.waitForEvent("page"),
    page.evaluate(() => { window.open(location.href, "_blank"); }),
  ]);
  const muteErrors = [];
  mute.on("pageerror", (failure) => muteErrors.push(failure.message));
  await mute.waitForLoadState();
  const muteScript = mute.getByRole("textbox", { name: "启动脚本", exact: true });
  const muteProgress = mute.locator(".preview-assist-progress");
  const muteNotices = async () => JSON.parse(await mute.getByTestId("notices").textContent());
  await muteScript.waitFor();
  await muteProgress.getByText("别的页面点的", { exact: false }).waitFor();
  await page.getByTestId("assist-succeed").click();
  // 正主自己那一路不能被这套裁决挡掉
  await page.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n") === expected, "npm run dev -- --port $PORT");
  await muteProgress.getByText("没有动上面输入框里的内容", { exact: false }).waitFor();
  await mute.waitForTimeout(1500);
  assert.equal(await editorText(muteScript), handwritten, "正主答不上话，也不等于副本可以认领它的作业");
  assert.deepEqual((await muteNotices()).filter((line) => line.includes("脚本已填入")), [], "它没填就不该提示填入");
  assert.deepEqual(muteErrors, [], "这一页也不应产生运行时异常");
  await mute.close();

  assert.deepEqual(errors, [], "AI 协助面板不应产生运行时异常");

  // ⑭ 没有 Web Locks 的那一档（裸 http 的局域网地址不是安全上下文，ash 常这么开）：只能点名，
  //    于是「暂且算我的」必须可撤回 —— 正主的应答迟到 800ms，远超 300ms 静默超时。
  const lanContext = await browser.newContext({ viewport: { width: 1000, height: 1200 } });
  await lanContext.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "locks", { configurable: true, get: () => undefined });
  });
  const lan = await lanContext.newPage();
  const lanErrors = [];
  lan.on("pageerror", (failure) => lanErrors.push(failure.message));
  await lan.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/project-settings-draft.html?case=${caseId}-lan`);
  const lanScript = lan.getByRole("textbox", { name: "启动脚本", exact: true });
  const lanProgress = lan.locator(".preview-assist-progress");
  await lanScript.waitFor();
  assert.equal(await lan.evaluate(() => navigator.locks === undefined), true, "这一档要测的就是没有 Web Locks");
  await lanScript.fill("# 局域网那一档：正主在等 AI");
  await lan.getByRole("button", { name: "AI 协助填写" }).click();
  await lanProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  await lan.evaluate(() => {
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (note) {
      if (note && typeof note === "object" && note.kind === "held") {
        setTimeout(() => post.call(this, note), 800);
        return undefined;
      }
      return post.call(this, note);
    };
  });
  const [slow] = await Promise.all([
    lanContext.waitForEvent("page"),
    lan.evaluate(() => { window.open(location.href, "_blank"); }),
  ]);
  const slowErrors = [];
  slow.on("pageerror", (failure) => slowErrors.push(failure.message));
  await slow.waitForLoadState();
  const slowScript = slow.getByRole("textbox", { name: "启动脚本", exact: true });
  const slowProgress = slow.locator(".preview-assist-progress");
  const slowNotices = async () => JSON.parse(await slow.getByTestId("notices").textContent());
  await slowScript.waitFor();
  const slowBefore = await editorText(slowScript);
  // 迟到的那句应答一到，先前那次认领就得当场翻过来
  await slowProgress.getByText("别的页面点的", { exact: false }).waitFor();
  await lan.getByTestId("assist-succeed").click();
  await lan.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n") === expected, "npm run dev -- --port $PORT");
  await slowProgress.getByText("没有动上面输入框里的内容", { exact: false }).waitFor();
  await slow.waitForTimeout(1500);
  assert.equal(await editorText(slowScript), slowBefore, "撤回之后，副本不许再把结果填进自己的输入框");
  assert.deepEqual((await slowNotices()).filter((line) => line.includes("脚本已填入")), [], "它没填就不该提示填入");
  assert.deepEqual(slowErrors, [], "副本页不应产生运行时异常");
  assert.deepEqual(lanErrors, [], "正主页不应产生运行时异常");
  await slow.close();

  // ⑮ 同一档里**顺序反过来**：作业先成功，正主的确认后到（第 9 轮审查把应答延到 30 秒复现）。
  //    「暂且算我的」撑不起不可逆的动作 —— 填进输入框和那句「脚本已填入」都收不回来，所以这一档
  //    成功时只许把脚本摆出来让用户拍板。顺带钉住：**正主自己那一路没被降级**（裸 http 上点一下、
  //    等它跑完、自动填上，一点没变）。
  const owner = await lanContext.newPage();
  const ownerErrors = [];
  owner.on("pageerror", (failure) => ownerErrors.push(failure.message));
  await owner.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/project-settings-draft.html?case=${caseId}-lan`);
  const ownerScript = owner.getByRole("textbox", { name: "启动脚本", exact: true });
  const ownerProgress = owner.locator(".preview-assist-progress");
  await ownerScript.waitFor();
  await ownerScript.fill("# 局域网正主：等 AI 自己填上来");
  await owner.getByRole("button", { name: "AI 协助填写" }).click();
  await ownerProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  // 这一次把确认压到 5 秒之后 —— 足够让作业先成功
  await owner.evaluate(() => {
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (note) {
      if (note && typeof note === "object" && note.kind === "held") {
        setTimeout(() => post.call(this, note), 5000);
        return undefined;
      }
      return post.call(this, note);
    };
  });
  const [early] = await Promise.all([
    lanContext.waitForEvent("page"),
    owner.evaluate(() => { window.open(location.href, "_blank"); }),
  ]);
  const earlyErrors = [];
  early.on("pageerror", (failure) => earlyErrors.push(failure.message));
  await early.waitForLoadState();
  const earlyScript = early.getByRole("textbox", { name: "启动脚本", exact: true });
  const earlyProgress = early.locator(".preview-assist-progress");
  const earlyNotices = async () => JSON.parse(await early.getByTestId("notices").textContent());
  await earlyScript.waitFor();
  // 它已经暂且认了领：这时还没有「别的页面点的」那句（确认要 5 秒后才到）
  await earlyProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  assert.equal(await earlyProgress.getByText("别的页面点的", { exact: false }).count(), 0,
    "这一步要测的正是「确认还没到、它已经暂且认了领」");
  const earlyBefore = await editorText(earlyScript);
  await owner.getByTestId("assist-succeed").click();
  // 正主照旧自动填上（点过按钮这件事是副本复制不走的证据）
  await owner.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n") === expected, "npm run dev -- --port $PORT");
  // 副本这边：脚本摆出来等拍板，一个字都不许自己填
  await earlyProgress.getByText("归属没能确认", { exact: false }).waitFor();
  await early.waitForTimeout(1500);
  assert.equal(await editorText(earlyScript), earlyBefore, "归属没定下来就不许改用户的输入框");
  assert.match(await earlyProgress.innerText(), /npm run dev -- --port \$PORT/, "摆出来的那条脚本还是要看得见");
  assert.deepEqual((await earlyNotices()).filter((line) => line.includes("脚本已填入")), [], "没填就不该提示填入");
  assert.deepEqual(earlyErrors, [], "副本页不应产生运行时异常");
  assert.deepEqual(ownerErrors, [], "正主页不应产生运行时异常");
  await lanContext.close();

  console.log("preview ai assist: ok (rounds, cancel, restart vs expiry, dropped start recovered, dropped-but-succeeded kept, manual edit protected, keep-mine wording, fill once, stale success not reapplied, foreign job stays read-only, reused job never claimed, second tab never claims, copied session never claims, silent owner still owns, late answer revokes, provisional claim never fills)");
} finally {
  await browser?.close();
  await server.close();
}
