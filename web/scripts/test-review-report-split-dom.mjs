// 审查报告摘要/明细折叠的 DOM 回归。
//
// 盯的是**用户打开报告第一眼看到什么**，不是措辞：
// ① 合规证明（基线 hash、命令输出、清场记录）默认一个字都不在屏幕上——这正是用户
//    「看不懂审查出的到底是什么问题」的直接来源；
// ② 结论和问题默认就在屏幕上，不需要先点一下；
// ③ 明细只是折叠**不是丢弃**：展开后原样都在（盘上的 report.md 更是一个字没动，
//    修复 agent 读的就是它）；
// ④ 对不上契约的存量报告必须整篇铺开、不画展开按钮——误拆会把内容藏起来，
//    那比啰嗦严重得多。
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

  // ④ 存量报告：整篇铺开，不给展开按钮。样本的首节标题含「结论」但意思相反
  //    （「先说结论之外的」），正是按标题判契约那一版会误拆的形态——两条【高】
  //    会被折叠进写着「验证过程、证据、清场记录」的按钮里。
  const legacyText = await legacy.locator(".task-markdown").first().innerText();
  assert.match(legacyText, /verify_failed/, "存量报告的结论要照常可见");
  assert.match(
    legacyText,
    /【高】身份页高内容屏/,
    "高优先级发现必须留在首屏——认不出契约就整篇铺开，宁可啰嗦也不能把发现藏掉",
  );
  assert.match(legacyText, /【高】设置页/, "第二条【高】同样不能被折叠吃掉");
  assert.equal(
    await legacy.getByRole("button", { name: /技术明细/ }).count(),
    0,
    "拆不动的报告不该画出一个什么都不装的展开按钮",
  );

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

  console.log("review report split dom ok");
} finally {
  await browser?.close();
  await server.close();
}
