// 审查报告摘要/明细折叠的 DOM 回归。
//
// 盯的是**用户打开报告第一眼看到什么**，不是措辞：
// ① 合规证明（基线 hash、命令输出、清场记录）默认一个字都不在屏幕上——这正是用户
//    「看不懂审查出的到底是什么问题」的直接来源；
// ② 结论和问题默认就在屏幕上，不需要先点一下；
// ③ 明细只是折叠**不是丢弃**：展开后原样都在（盘上的 report.md 更是一个字没动，
//    修复 agent 读的就是它）；
// ④ 对不上契约的存量报告走降级那一档：引子留在首屏，第一个 `##` 起收进一个**什么都不
//    宣称**的「展开完整报告」。按钮文案是这一档的全部安全边际——「展开技术明细（验证
//    过程、证据、清场记录）」只有在报告证明得了自己按契约写时才准出现；
// ⑤ 连引子都没有的报告整篇铺开，一个按钮都不画。
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
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/review-report-split.html`);

  const conforming = page.locator(".conforming-fixture");
  const legacy = page.locator(".legacy-fixture");
  await conforming.locator(".task-markdown").first().waitFor();

  // 断言一律读 markdown 正文，不读整块 fixture：展开按钮的文案里就带着「清场记录」
  // 几个字，拿整块做否定断言会把按钮自己的标签当成泄漏的明细。
  const summaryBody = conforming.locator(".task-markdown").first();

  // ② 默认就该看见结论和问题。
  const summary = await summaryBody.innerText();
  assert.match(summary, /不能 —— 有 1 条必须先修/, "结论必须默认可见");
  assert.match(summary, /烧录出来的成片用的是你改之前的字幕/, "问题标题必须默认可见");
  assert.match(summary, /删除项目后整个网格会闪一下/, "「不拦验收但你该知道的」也属于摘要");

  // ① 合规证明默认不该占屏幕。
  for (const noise of ["被审范围与基线", "d7ee0b07", "npm run build", "清场", "lsof"]) {
    assert.doesNotMatch(summary, new RegExp(noise), `「${noise}」属于技术明细，默认不该出现在屏幕上`);
  }
  assert.equal(
    await conforming.locator(".review-report-detail").count(),
    0,
    "折叠着的时候明细整块不该挂在 DOM 上",
  );

  const toggle = conforming.getByRole("button", { name: /展开技术明细/ });
  assert.equal(await toggle.count(), 1, "合契约的报告必须给一个展开明细的出口");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");

  // ③ 折叠不是丢弃：展开后明细原样都在。
  await toggle.click();
  const detail = await conforming.locator(".review-report-detail .task-markdown").innerText();
  for (const line of ["被审范围与基线", "d7ee0b07", "npm run build", "清场", "lsof"]) {
    assert.match(detail, new RegExp(line), `展开后「${line}」必须原样还在，折叠不等于丢弃`);
  }
  assert.match(
    await summaryBody.innerText(),
    /不能 —— 有 1 条必须先修/,
    "展开明细不该把摘要顶掉",
  );
  assert.equal(
    await conforming.getByRole("button", { name: /收起技术明细/ }).getAttribute("aria-expanded"),
    "true",
  );

  // 能收回去。
  await conforming.getByRole("button", { name: /收起技术明细/ }).click();
  assert.equal(
    await conforming.locator(".review-report-detail").count(),
    0,
    "收起后明细应重新从 DOM 上摘掉",
  );

  // ④ 存量报告走第二档。样本的首节标题含「结论」但意思相反（「先说结论之外的」），
  //    正是按标题判契约那一版会误拆的形态——那一版把两条【高】折进写着「验证过程、
  //    证据、清场记录」的按钮里，首屏只剩「做对的部分」。
  //
  //    现在拆点在**第一个** `##` 之前：报告自己写的 `verify_failed` 留在首屏，「做对的
  //    部分」跟两条【高】一起收进「展开完整报告」。按钮一个字都不宣称里面装了什么，
  //    这是这一档跟误拆的分界线。
  const legacyText = await legacy.locator(".task-markdown").first().innerText();
  assert.match(legacyText, /verify_failed/, "报告自己的判定必须留在首屏");
  assert.match(legacyText, /2 个可复现的高优先级问题/, "「有几个问题」也留在首屏");
  assert.doesNotMatch(legacyText, /做对的部分/, "「做对的部分」不许冒充摘要占着首屏");
  assert.equal(
    await legacy.getByRole("button", { name: /技术明细/ }).count(),
    0,
    "认不出契约的报告，按钮不准替折叠里的东西背书",
  );
  const legacyToggle = legacy.getByRole("button", { name: /^展开完整报告$/ });
  assert.equal(await legacyToggle.count(), 1, "存量报告要给一个不作承诺的展开入口");
  await legacyToggle.click();
  const legacyDetail = await legacy.locator(".review-report-detail .task-markdown").innerText();
  assert.match(legacyDetail, /【高】身份页高内容屏/, "展开后第一条【高】原样都在");
  assert.match(legacyDetail, /【高】设置页/, "第二条【高】同样在");
  assert.match(legacyDetail, /做对的部分/, "折叠不是丢弃");
  await legacy.getByRole("button", { name: /^收起完整报告$/ }).click();
  assert.equal(await legacy.locator(".review-report-detail").count(), 0, "能收回去");

  // ⑤ 换一轮报告必须回到默认折叠。侧栏抽屉在同一个位置换正文、组件不重新挂载，
  //    展开状态一旦是独立 state 就会串过去——下一份报告一打开就是满屏命令输出。
  const switchable = page.locator(".switch-fixture");
  await switchable.getByRole("button", { name: /展开技术明细/ }).click();
  assert.equal(
    await switchable.locator(".review-report-detail").count(),
    1,
    "第一轮应当能正常展开",
  );

  await switchable.getByRole("button", { name: "切换轮次" }).click();
  const switched = await switchable.locator(".task-markdown").first().innerText();
  assert.match(switched, /第 5 轮自动验证报告/, "正文应当换成了下一轮");
  assert.equal(
    await switchable.locator(".review-report-detail").count(),
    0,
    "换一轮报告必须回到默认折叠，上一轮的展开状态不许串过来",
  );
  assert.equal(
    await switchable.getByRole("button", { name: /展开技术明细/ }).count(),
    1,
    "换轮后按钮应回到「展开」态",
  );
  assert.doesNotMatch(
    await switchable.innerText(),
    /ROUND2_ONLY_MARKER/,
    "下一轮的命令输出不该在用户没点之前就摆出来",
  );

  // 切回去同样是折叠的（不是只在「换到新的」那一个方向上归位）。
  await switchable.getByRole("button", { name: "切换轮次" }).click();
  assert.equal(
    await switchable.locator(".review-report-detail").count(),
    0,
    "切回上一轮也该是折叠的",
  );

  // ⑥ 两轮报告**一字不差**时同样要复位。同一处没修好、原样重报一遍就会撞上：正文判不出
  //    「换过轮」，于是上一轮展开的明细直接留在新轮次的标题底下。复位判据必须是报告身份。
  const identical = page.locator(".identical-fixture");
  await identical.getByRole("button", { name: /展开技术明细/ }).click();
  assert.equal(
    await identical.locator(".review-report-detail").count(),
    1,
    "第一轮应当能正常展开",
  );
  await identical.getByRole("button", { name: "切换轮次" }).click();
  assert.equal(
    await identical.locator(".review-report-detail").count(),
    0,
    "正文一字不差也算换了一轮，展开状态不许串过去",
  );
  assert.equal(
    await identical.getByRole("button", { name: /展开技术明细/ }).count(),
    1,
    "换轮后按钮应回到「展开」态",
  );

  // ⑦ Windows 报告（CRLF）在屏幕上必须跟 LF 那份长得一样：默认只有结论和问题，技术
  //    记录收在按钮后面。认不出 CRLF 时这份会整篇铺开、连按钮都没有——内容没丢，但这个
  //    改动的全部收益在 Windows 常见文本格式上归零。
  const crlf = page.locator(".crlf-fixture");
  const crlfSummary = await crlf.locator(".task-markdown").first().innerText();
  assert.match(crlfSummary, /不能 —— 有 1 条必须先修/, "CRLF 报告的结论同样默认可见");
  assert.match(crlfSummary, /烧录出来的成片/, "CRLF 报告的问题同样默认可见");
  for (const noise of ["被审范围与基线", "d7ee0b07", "npm run build", "清场", "lsof"]) {
    assert.doesNotMatch(crlfSummary, new RegExp(noise), `CRLF 报告里「${noise}」同样该收进明细`);
  }
  assert.equal(
    await crlf.getByRole("button", { name: /展开技术明细/ }).count(),
    1,
    "CRLF 报告同样要给出展开明细的出口",
  );
  await crlf.getByRole("button", { name: /展开技术明细/ }).click();
  assert.match(
    await crlf.locator(".review-report-detail .task-markdown").innerText(),
    /d7ee0b07/,
    "展开后 CRLF 报告的明细同样原样都在",
  );

  // ⑧ 结论里带代码示例的报告：代码内容里那行 ```… 不是闭合围栏，后面的 `##` 也不是小节
  //    标题。认错时用户打开报告只看到半截代码加一个按钮，真正的问题折在里面还被当成代码。
  const fence = page.locator(".fence-fixture");
  const fenceSummary = await fence.locator(".task-markdown").first().innerText();
  assert.match(fenceSummary, /保存后你刚改的内容会全部消失/, "真正的问题必须默认可见");
  assert.match(fenceSummary, /这一行仍是代码内容/, "代码示例本身也留在摘要里");
  assert.match(fenceSummary, /命令输出里的井号/, "代码里的 `##` 不是分界，不该被拆走");
  assert.doesNotMatch(fenceSummary, /被审范围与基线|d7ee0b07/, "技术记录该收进明细");
  await fence.getByRole("button", { name: /展开技术明细/ }).click();
  assert.match(
    await fence.locator(".review-report-detail .task-markdown").innerText(),
    /d7ee0b07/,
    "拆点应当落在那个真的二级标题上",
  );

  // ⑨ 结论里夹了一段 HTML 注释：里面的 `##` 不是分界，后面那条问题必须默认可见。
  //    （这份渲染器不解析裸 HTML，注释会以纯文本显示——那不影响这里要保证的事：
  //    它在 Markdown 里不是标题，不能拿它当拆点。）
  const comment = page.locator(".comment-fixture");
  const commentSummary = await comment.locator(".task-markdown").first().innerText();
  assert.match(commentSummary, /烧录出来的成片/, "第一条问题默认可见");
  assert.match(commentSummary, /保存后你刚改的内容会全部消失/, "第二条问题同样默认可见");
  assert.match(commentSummary, /这一段不会当成标题/, "注释整段留在摘要里，没被当成分界");
  assert.doesNotMatch(commentSummary, /被审范围与基线|d7ee0b07/, "技术记录该收进明细");
  assert.equal(
    await comment.locator(".task-markdown").first().getByRole("heading", { name: /这一段不会当成标题/ }).count(),
    0,
    "注释里的 `##` 不是标题",
  );
  await comment.getByRole("button", { name: /展开技术明细/ }).click();
  assert.match(
    await comment.locator(".review-report-detail .task-markdown").innerText(),
    /d7ee0b07/,
    "拆点应当落在那个真的顶层标题上",
  );

  // ⑩ 先引用上一轮栏目格式、后面才写真实问题的报告：引用里的四行不能充当本轮签名。
  //    认错时首屏只剩引用里的「可以 / 没有问题」，真正的问题要点开按钮才看得到。
  //    这份开头除了一级标题什么都没有，连降级的引子都凑不出来——整篇铺开，一个按钮都没有。
  const quoted = page.locator(".quoted-fixture");
  const quotedText = await quoted.locator(".task-markdown").first().innerText();
  assert.match(quotedText, /保存后你刚改的内容会全部消失/, "真正的问题必须默认可见");
  assert.match(quotedText, /下面引用上一轮的结论格式/, "引用段落照常铺开");
  assert.equal(
    await quoted.locator(".review-report-more").count(),
    0,
    "没有引子就整篇铺开，不该画出任何展开按钮",
  );

  // ⑪ 两份「像契约、其实是抄件」的报告：说明段里抄的四行、四栏整个倒着写。两份都不该
  //    拆——首屏写着「可以 / 没有」、真正的问题折在按钮里，正是这个改动要消灭的样子。
  for (const [kind, selector, finding] of [
    ["说明段里的抄件", ".prose-copy-fixture", /保存后你刚改的内容会全部消失/],
    ["四栏倒序", ".reordered-fixture", /导出的视频仍然使用旧字幕/],
  ]) {
    const fake = page.locator(selector);
    assert.match(
      await fake.locator(".task-markdown").first().innerText(),
      finding,
      `${kind}：真正的问题必须默认可见`,
    );
    assert.equal(
      await fake.locator(".review-report-more").count(),
      0,
      `${kind}：没有引子就整篇铺开，不该画出任何展开按钮`,
    );
  }

  // ⑫ 四栏写对了、但结构没证明问题在摘要里：首节写成「前言」（里面是上一轮抄件）、
  //    问题误用 `##`（首屏只剩「见下方」）。两份开头都只有一级标题，整篇铺开。
  for (const [kind, selector] of [
    ["首节写成「前言」", ".wrong-heading-fixture"],
    ["问题误用二级标题", ".problem-heading-fixture"],
  ]) {
    const fake = page.locator(selector);
    assert.match(
      await fake.locator(".task-markdown").first().innerText(),
      /保存后你刚改的内容会全部消失/,
      `${kind}：真正的问题必须默认可见`,
    );
    assert.equal(
      await fake.locator(".review-report-more").count(),
      0,
      `${kind}：没有引子就整篇铺开，不该画出任何展开按钮`,
    );
  }

  // ⑬ 旧格式的另一种主力形态：判定写在 `## 结论` 那一节里。折在第一个 `##` 之前时，
  //    首屏只剩「任务/时间/审查者」三行，「到底过没过」要点一下才知道——全库 21 份是
  //    这个形状。这一档从第二个 `##` 起折：结论整节留在首屏，技术记录照折。
  const legacyConclusion = page.locator(".legacy-conclusion-fixture");
  const lcSummary = await legacyConclusion.locator(".task-markdown").first().innerText();
  assert.match(lcSummary, /verified/, "判定必须默认可见");
  assert.match(lcSummary, /结论/, "结论那一节整个留在首屏");
  assert.doesNotMatch(lcSummary, /被审范围|45b8a02|清场/, "技术记录照折");
  assert.equal(
    await legacyConclusion.getByRole("button", { name: /技术明细/ }).count(),
    0,
    "旧格式不是契约，按钮不准替折叠里的东西背书",
  );
  const lcToggle = legacyConclusion.getByRole("button", { name: /^展开完整报告$/ });
  assert.equal(await lcToggle.count(), 1);
  await lcToggle.click();
  const lcDetail = await legacyConclusion.locator(".review-report-detail .task-markdown").innerText();
  assert.match(lcDetail, /45b8a02/, "展开后技术记录原样都在");
  assert.match(lcDetail, /清场/);

  // ⑭ 四栏写成 `###` 小标题、问题写成 `####` 的真实形态（`MiBg8G40scWo` 四轮 + 本任务
  //    上一轮报告）。只认加粗标签那一版时，这份会整篇铺开——首屏紧跟着结论就是仓库状态、
  //    命令和清场记录，连按钮都没有，正是这个改动要消灭的样子。
  const headingColumns = page.locator(".heading-columns-fixture");
  const hcSummary = await headingColumns.locator(".task-markdown").first().innerText();
  assert.match(hcSummary, /不能 —— 有 1 条必须先修/, "结论默认可见");
  assert.match(hcSummary, /四个栏目写成小标题时，整份报告又全部展开/, "问题本身默认可见");
  for (const noise of ["被审范围与仓库状态", "abc1234", "npm test", "临时服务已停止"]) {
    assert.doesNotMatch(hcSummary, new RegExp(noise), `「${noise}」属于技术明细，默认不该在屏幕上`);
  }
  const hcToggle = headingColumns.getByRole("button", { name: /展开技术明细/ });
  assert.equal(await hcToggle.count(), 1, "小标题写法跟加粗写法一样是契约，按钮也该这么写");
  await hcToggle.click();
  const hcDetail = await headingColumns.locator(".review-report-detail .task-markdown").innerText();
  for (const line of ["abc1234", "npm test", "临时服务已停止"]) {
    assert.match(hcDetail, new RegExp(line), `展开后「${line}」原样还在`);
  }

  console.log("review report split dom ok");
} finally {
  await browser?.close();
  await server.close();
}
