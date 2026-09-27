// 「AI 协助」所有权裁决的**降级路**回归：没有 Web Locks 的环境（ash 常开在裸 http 的局域网
// 地址上，那不是安全上下文）只能靠跨页点名，于是这一整档都得另开 context 才测得着。
//
// 这里装 ⑭–⑰ 四组（⑬ 及之前那些共用主 context 的用例在 test-preview-assist-ui.mjs 里）：
//   ⑭ 「暂且算我的」必须可撤回：正主的应答迟到 800ms，远超 300ms 静默超时；
//   ⑮ 顺序反过来（作业先成功、确认后到）→ 暂且认下的那一份撑不起不可逆的动作；
//   ⑯ 同一个标签自己刷新是顺序交接、不是分身，照旧自动填；刷新后又动过手的只许摆出来让他挑
//      （⑯b 改成新内容、⑯e 首次读取被压住时改、⑯f 重新敲一遍旧草稿、⑯g 再清空一次、
//      ⑯d 刷新那一瞬跑成的也照样填、⑯c 正主刷新回来压得过暂且认领的副本）；
//   ⑰ 接力凭据不是只有刷新会写：带着它的标签再开两页，两页都不许把自己洗成正主。
//
// 由 test-preview-assist-ui.mjs 起的 vite + 浏览器喂进来，本文件只管用例本身。
import assert from "node:assert/strict";
import { editorText } from "./preview-assist-shared.mjs";

export async function fallbackArbitrationCases({ browser, address, caseId }) {
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
  const ownerNotices = async () => JSON.parse(await owner.getByTestId("notices").textContent());
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
  await early.close();

  // ⑯ 还是这一档（没有 Web Locks），但这次是**同一个标签自己刷新**：刷新是顺序交接（旧文档先死
  //    才有新文档），不是复制出来的分身，所以它照旧是正主 —— 成功就直接填，不该退化成「再点一次
  //    用这条替换」（第 10 轮审查：我上一轮把刷新和复制归成了一档，裸 http 上刷新之后就不自动填了）。
  await ownerScript.fill("# 刷新之前：等 AI");
  await owner.getByRole("button", { name: "AI 协助填写" }).click();
  await ownerProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  await owner.reload();
  await ownerScript.waitFor();
  await ownerProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  assert.equal(await owner.evaluate(() => navigator.locks === undefined), true, "这一条测的还是没有 Web Locks 那一档");
  const filledBeforeReload = (await ownerNotices()).filter((line) => line.includes("脚本已填入")).length;
  await owner.getByTestId("assist-succeed").click();
  await owner.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n") === expected, "npm run dev -- --port $PORT");
  assert.equal(await editorText(ownerScript), "npm run dev -- --port $PORT", "同一个标签刷新过，成功了照旧直接填");
  assert.match(await ownerProgress.innerText(), /保存预览设置/, "填完要说清还得点保存");
  assert.doesNotMatch(await ownerProgress.innerText(), /归属没能确认/, "自己刷新的标签不是会话副本，别把它当副本");
  assert.equal((await ownerNotices()).filter((line) => line.includes("脚本已填入")).length, filledBeforeReload + 1,
    "填了就该提示一次");

  // ⑯b 刷新之后**又自己动过**输入框：那就仍旧不许静默覆盖（第 2 轮定下的），但话要说准 ——
  //     是「你改过」，不是「归属没能确认」。
  await ownerScript.fill("# 刷新之前：等 AI（第二发）");
  await owner.getByRole("button", { name: "AI 协助填写" }).click();
  await ownerProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  await owner.reload();
  await ownerScript.waitFor();
  await ownerProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  const afterReload = "# 刷新后继续等待";
  await ownerScript.fill(afterReload);
  await owner.getByTestId("assist-succeed").click();
  await ownerProgress.getByText("你在这期间改过", { exact: false }).waitFor();
  assert.equal(await editorText(ownerScript), afterReload, "刷新后手写的内容照样不许被顶掉");
  assert.doesNotMatch(await ownerProgress.innerText(), /归属没能确认/, "这一档的原因是「你改过」，不是归属没定");
  assert.deepEqual(ownerErrors, [], "正主页不应产生运行时异常");

  // ⑯d 作业**恰好在刷新那一瞬跑完**：新文档第一次问服务端就直接读到终态，压根没见过 running，
  //     于是「点下去那一刻框里是什么」没人记过。接班的是同一个标签、凭据也验过，它就该继续
  //     「跑成了就直接填」，而不是反过来要用户再点一次「用这条替换」（第 12 轮审查复现）。
  await ownerScript.fill("# 刷新那一瞬它就跑成了");
  await owner.getByRole("button", { name: "AI 协助填写" }).click();
  await ownerProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  await owner.getByTestId("assist-succeed-on-boot").click();
  const filledBeforeBoot = (await ownerNotices()).filter((line) => line.includes("脚本已填入")).length;
  await owner.reload();
  await ownerScript.waitFor();
  await owner.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n") === expected, "npm run dev -- --port $PORT");
  const booted = await ownerProgress.innerText();
  assert.match(booted, /保存预览设置/, "填完要说清还得点保存");
  assert.doesNotMatch(booted, /没有直接覆盖/, "可信的刷新接力不该反过来要用户再挑一次");
  assert.doesNotMatch(booted, /归属没能确认/, "凭据验过了就不是「归属没定」");
  assert.equal((await ownerNotices()).filter((line) => line.includes("脚本已填入")).length, filledBeforeBoot + 1,
    "填了就该提示一次");
  assert.deepEqual(ownerErrors, [], "正主页不应产生运行时异常");

  // ⑯e 同一段可信接力，只是**首次读取压在路上**：页面已经能用了，用户先往框里敲了几行，之后
  //     那一次读取才带回终态。判「他动过手没有」不能等终态到了再拿框里那份当基准 —— 那一份已经
  //     是他刷新后新写的东西，比较必然「相等」，刚写的几行会被静默顶掉（第 13 轮审查复现）。
  const beforeSlow = "# 慢读取之前：等 AI";
  await ownerScript.fill(beforeSlow);
  await owner.getByRole("button", { name: "AI 协助填写" }).click();
  await ownerProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  await owner.getByTestId("assist-succeed-on-boot").click();
  await owner.getByTestId("assist-hold-next-get").click();
  await owner.reload();
  await ownerScript.waitFor();
  // 首次读取还没回来（卡片还没出现），这时候动输入框
  assert.equal(await ownerProgress.count(), 0, "这一条要的就是「首次读取还没回来」那一段");
  const duringSlow = "# 我在刷新后刚写的新内容";
  await ownerScript.fill(duringSlow);
  await ownerProgress.getByText("你在这期间改过", { exact: false }).waitFor();
  assert.equal(await editorText(ownerScript), duringSlow, "首次读取还在路上时写的内容照样不许被顶掉");
  assert.match(await ownerProgress.innerText(), /npm run dev -- --port \$PORT/, "AI 那条要摆出来让他自己挑");
  // 刷新把提示清了，所以这一页从头到尾都不该出现「已填入」
  assert.deepEqual((await ownerNotices()).filter((line) => line.includes("脚本已填入")), [],
    "没填就不该提示填入");
  assert.deepEqual(ownerErrors, [], "正主页不应产生运行时异常");
  // 挑了「用这条替换」才该换 —— 这条路还得是通的
  await ownerProgress.getByRole("button", { name: "用这条替换" }).click();
  assert.equal(await editorText(ownerScript), "npm run dev -- --port $PORT", "他自己点了替换就该换上去");

  // ⑯f 同一段时序，但用户刷新后**重新敲了一遍刷新前那份草稿**：内容恰好等于点下去那一刻那一份，
  //     可按内容比对就会把这次明明白白的编辑读成「没动过」，照样覆盖（第 14 轮审查复现）。
  const retyped = "# 刷新后我会重新敲一遍这一份";
  await ownerScript.fill(retyped);
  await owner.getByRole("button", { name: "AI 协助填写" }).click();
  await ownerProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  await owner.getByTestId("assist-succeed-on-boot").click();
  await owner.getByTestId("assist-hold-next-get").click();
  await owner.reload();
  await ownerScript.waitFor();
  assert.equal(await ownerProgress.count(), 0, "这一条要的还是「首次读取还没回来」那一段");
  assert.notEqual(await editorText(ownerScript), retyped, "刷新把未保存的草稿丢了，这一条才测得着「重新敲一遍」");
  await ownerScript.fill(retyped);
  await ownerProgress.getByText("你在这期间改过", { exact: false }).waitFor();
  assert.equal(await editorText(ownerScript), retyped, "重新敲一遍旧草稿也是编辑，不许被顶掉");
  assert.deepEqual((await ownerNotices()).filter((line) => line.includes("脚本已填入")), [],
    "没填就不该提示填入");

  // ⑯g 同一条的另一面：**清空**也是编辑。已保存一份非空脚本 → 清空后点 AI → 刷新（框里恢复成
  //     已保存那份）→ 再清空一次。按内容比对时「空」恰好等于点下去那一刻那份，于是被当成没动过。
  const saved = "# 已保存的启动脚本";
  await ownerScript.fill(saved);
  await owner.getByRole("button", { name: "保存预览设置" }).click();
  await owner.waitForFunction((expected) =>
    (document.querySelector('[data-testid="stored-projects"]')?.textContent ?? "").includes(expected), saved);
  await ownerScript.fill("");
  await owner.getByRole("button", { name: "AI 协助填写" }).click();
  await ownerProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  await owner.getByTestId("assist-succeed-on-boot").click();
  await owner.getByTestId("assist-hold-next-get").click();
  await owner.reload();
  await ownerScript.waitFor();
  assert.equal(await editorText(ownerScript), saved, "刷新后框里是已保存那一份");
  await ownerScript.fill("");
  await ownerProgress.getByText("你在这期间改过", { exact: false }).waitFor();
  assert.equal(await editorText(ownerScript), "", "他刷新后自己清空的，就别替他填回去");
  assert.deepEqual((await ownerNotices()).filter((line) => line.includes("脚本已填入")), [],
    "没填就不该提示填入");
  assert.deepEqual(ownerErrors, [], "正主页不应产生运行时异常");

  // ⑯c 两套机制碰头：副本已经「暂且认领」了，正主才刷新回来。站得住的那一份必须压得过暂且认下的
  //     —— 按「谁先拿住」比就会判错，因为刷新后的新文档 since 反而更晚。
  await ownerScript.fill("# 刷新前：等 AI（第三发）");
  await owner.getByRole("button", { name: "AI 协助填写" }).click();
  await ownerProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  await owner.evaluate(() => {
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (note) {
      if (note && typeof note === "object" && note.kind === "held") return undefined;
      return post.call(this, note);
    };
  });
  const [rival] = await Promise.all([
    lanContext.waitForEvent("page"),
    owner.evaluate(() => { window.open(location.href, "_blank"); }),
  ]);
  const rivalErrors = [];
  rival.on("pageerror", (failure) => rivalErrors.push(failure.message));
  await rival.waitForLoadState();
  const rivalScript = rival.getByRole("textbox", { name: "启动脚本", exact: true });
  const rivalProgress = rival.locator(".preview-assist-progress");
  const rivalNotices = async () => JSON.parse(await rival.getByTestId("notices").textContent());
  await rivalScript.waitFor();
  await rivalProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  assert.equal(await rivalProgress.getByText("别的页面点的", { exact: false }).count(), 0, "它这时确实暂且认了领");
  const rivalBefore = await editorText(rivalScript);
  // 正主刷新回来（patch 随文档一起没了）：凭据在它手里，所有权该回到它身上
  await owner.reload();
  await ownerScript.waitFor();
  await ownerProgress.getByText("正在读这个项目", { exact: false }).waitFor();
  await rivalProgress.getByText("别的页面点的", { exact: false }).waitFor();
  await owner.getByTestId("assist-succeed").click();
  await owner.waitForFunction((expected) =>
    [...document.querySelectorAll('.cm-content[aria-label="启动脚本"] .cm-line')]
      .map((line) => line.textContent).join("\n") === expected, "npm run dev -- --port $PORT");
  await rivalProgress.getByText("没有动上面输入框里的内容", { exact: false }).waitFor();
  await rival.waitForTimeout(1500);
  assert.equal(await editorText(rivalScript), rivalBefore, "被顶回去的那一页不许改自己的输入框");
  assert.deepEqual((await rivalNotices()).filter((line) => line.includes("脚本已填入")), [], "它没填就不该提示填入");
  assert.deepEqual(rivalErrors, [], "副本页不应产生运行时异常");
  assert.deepEqual(ownerErrors, [], "正主页不应产生运行时异常");
  await lanContext.close();

  // ⑰ 接力凭据**不是只有刷新会写**（pagehide 在跳走、关掉时同样触发）：那个带着未消费凭据的标签
  //    再开出两个设置页，两页各克隆一份、各自消费掉，于是两页都算站得住、都往自己的输入框里填
  //    （第 11 轮审查复现）。这一档里把跨页仲裁整个掐掉（held 一律不发），所以剩下的唯一防线就是
  //    凭据自己：只有「刷新出来的那一份文档」认得它，而且读到就删、认不认都删。
  const cloneContext = await browser.newContext({ viewport: { width: 1000, height: 1200 } });
  await cloneContext.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "locks", { configurable: true, get: () => undefined });
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (note) {
      if (note && typeof note === "object" && note.kind === "held") return undefined;
      return post.call(this, note);
    };
  });
  const settingsUrl = `http://127.0.0.1:${address.port}/scripts/fixtures/project-settings-draft.html?case=${caseId}-clone`;
  const carrier = await cloneContext.newPage();
  const carrierErrors = [];
  carrier.on("pageerror", (failure) => carrierErrors.push(failure.message));
  await carrier.goto(settingsUrl);
  const carrierScript = carrier.getByRole("textbox", { name: "启动脚本", exact: true });
  await carrierScript.waitFor();
  await carrierScript.fill("# 这一页点完就跳走");
  await carrier.getByRole("button", { name: "AI 协助填写" }).click();
  await carrier.locator(".preview-assist-progress").getByText("正在读这个项目", { exact: false }).waitFor();
  // 跳到同源的空白中间页：这一跳会触发 pagehide，把接力凭据留在这个标签的 sessionStorage 里
  await carrier.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/blank.html`);
  const clones = [];
  for (let i = 0; i < 2; i += 1) {
    const [opened] = await Promise.all([
      cloneContext.waitForEvent("page"),
      carrier.evaluate((target) => { window.open(target, "_blank"); }, settingsUrl),
    ]);
    await opened.waitForLoadState();
    clones.push(opened);
  }
  const cloneErrors = [];
  for (const clone of clones) clone.on("pageerror", (failure) => cloneErrors.push(failure.message));
  const cloneScripts = clones.map((clone) => clone.getByRole("textbox", { name: "启动脚本", exact: true }));
  const cloneProgress = clones.map((clone) => clone.locator(".preview-assist-progress"));
  for (let i = 0; i < clones.length; i += 1) {
    await cloneScripts[i].waitFor();
    await cloneProgress[i].getByText("正在读这个项目", { exact: false }).waitFor();
  }
  const cloneBefore = await Promise.all(cloneScripts.map((editor) => editorText(editor)));
  await clones[0].getByTestId("assist-succeed").click();
  for (let i = 0; i < clones.length; i += 1) {
    await cloneProgress[i].getByText("归属没能确认", { exact: false }).waitFor();
  }
  await clones[0].waitForTimeout(1500);
  for (let i = 0; i < clones.length; i += 1) {
    assert.equal(await editorText(cloneScripts[i]), cloneBefore[i], `克隆出来的第 ${i + 1} 页不许自己填脚本`);
    const lines = JSON.parse(await clones[i].getByTestId("notices").textContent());
    assert.deepEqual(lines.filter((line) => line.includes("脚本已填入")), [], `第 ${i + 1} 页没填就不该提示填入`);
  }
  assert.deepEqual(cloneErrors, [], "克隆页不应产生运行时异常");
  assert.deepEqual(carrierErrors, [], "中间页不应产生运行时异常");
  await cloneContext.close();
}
