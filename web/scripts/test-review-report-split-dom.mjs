// 审查报告摘要/明细折叠的 DOM 回归。
//
// 盯的是**用户打开报告第一眼看到什么**，不是措辞：
// ① 合规证明（基线 hash、命令输出、清场记录）默认一个字都不在屏幕上——这正是用户
//    「看不懂审查出的到底是什么问题」的直接来源；
// ② 结论和问题默认就在屏幕上，不需要先点一下；
// ③ 折叠**不是丢弃**：展开后原样都在（盘上的 report.md 更是一个字没动，修复 agent 读的
//    就是它）；
// ④ **按钮能说什么，只由这一轮的权威结论 `conclusion` 决定**。「展开技术明细（验证过程、
//    证据、清场记录）」这句承诺只在「这一轮通过了 + 报告照格式写了」时才准出现；其余一律
//    是什么都不宣称的「展开完整报告」。同一份正文配不同结论并排挂着，就是为了让这条一眼
//    看得出来——正文骗得过判据，骗不过那个字段；
// ⑤ 连引子都凑不出来、切不动的报告不猜切点——按渲染高度夹住，底下同样给一个什么都不宣称
//    的「展开完整报告」；装得下（或只超出一点点）的就一个按钮都不画。
//
// 「哪一档」的判据由纯函数测试穷举（`test-review-report-format/boundary/fallback/claim`）。
// 这一份只验**屏幕上真的是那样**。
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
  assert.equal(await toggle.count(), 1, "通过了、又照格式写的报告才给这个出口");
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

  // ④ 这次改动的全部要害，两份并排：**同一份正文**，只是这一轮的权威结论不同。
  //
  //    十轮复审攻的都是同一个形状——从报告正文里猜「作者到底有没有说可以验收」，判据每次
  //    都比它要证明的事松一档（`~~可以验收~~`、`可以验收？`、`❌ 可以验收`、三行写成
  //    图片……）。反例空间无限，词表可枚举，收敛不了。现在不猜了：这一轮通没通过，
  //    `free_review_rounds.conclusion` 里存着，界面上那个红绿标签渲染的就是它。
  //
  //    没通过 / 还没判，折叠里就可能装着拦验收的问题，按钮一个字都不许替它宣称。
  for (const [what, selector] of [
    ["这一轮没通过", ".failed-fixture"],
    ["拿不到权威结论", ".unknown-fixture"],
  ]) {
    const box = page.locator(selector);
    assert.equal(
      await box.getByRole("button", { name: /技术明细/ }).count(),
      0,
      `${what}：按钮不准替折叠里的东西背书`,
    );
    const plain = box.getByRole("button", { name: /^展开完整报告$/ });
    assert.equal(await plain.count(), 1, `${what}：仍要给一个不作承诺的展开入口`);
    // 切点不跟着结论走：铺开的那一半跟上面那份通过了的一字不差。
    assert.equal(
      await box.locator(".task-markdown").first().innerText(),
      summary,
      `${what}：换个结论只换按钮文案，切点必须原地不动`,
    );
    await plain.click();
    assert.match(
      await box.locator(".review-report-detail .task-markdown").innerText(),
      /d7ee0b07/,
      `${what}：折的仍是那半截技术记录，一个字没少`,
    );
  }

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

  // 两轮报告**一字不差**时同样要复位。同一处没修好、原样重报一遍就会撞上：正文判不出
  // 「换过轮」，于是上一轮展开的明细直接留在新轮次的标题底下。复位判据必须是报告身份。
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

  // ⑥ Windows 报告（CRLF）在屏幕上必须跟 LF 那份长得一样：默认只有结论和问题，技术
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

  // ⑦ 结论里带代码示例的报告：代码内容里那行 ```… 不是闭合围栏，后面的 `##` 也不是小节
  //    标题。认错时用户打开报告只看到半截代码加一个按钮，真正的问题折在里面还被当成代码。
  const fence = page.locator(".fence-fixture");
  const fenceSummary = await fence.locator(".task-markdown").first().innerText();
  assert.match(fenceSummary, /保存后你刚改的内容会全部消失/, "真正的问题必须默认可见");
  assert.match(fenceSummary, /这一行仍是代码内容/, "代码示例本身也留在摘要里");
  assert.match(fenceSummary, /命令输出里的井号/, "代码里的 `##` 不是分界，不该被切走");
  assert.doesNotMatch(fenceSummary, /被审范围与基线|d7ee0b07/, "技术记录该收进明细");
  await fence.getByRole("button", { name: /展开技术明细/ }).click();
  assert.match(
    await fence.locator(".review-report-detail .task-markdown").innerText(),
    /d7ee0b07/,
    "切点应当落在那个真的二级标题上",
  );

  // ⑧ 结论里夹了一段 HTML 注释：里面的 `##` 不是分界，后面那条问题必须默认可见。
  //    （这份渲染器不解析裸 HTML，注释会以纯文本显示——那不影响这里要保证的事：
  //    它在 Markdown 里不是标题，不能拿它当切点。）
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
    "切点应当落在那个真的顶层标题上",
  );

  // ⑨ 四栏写成 `###` 小标题、问题写成 `####` 的真实形态（`MiBg8G40scWo` 四轮 + 本任务
  //    某一轮的报告）。只认加粗标签那一版时，这份会整篇铺开——首屏紧跟着结论就是仓库状态、
  //    命令和清场记录，连按钮都没有，正是这个改动要消灭的样子。
  const headingColumns = page.locator(".heading-columns-fixture");
  const hcSummary = await headingColumns.locator(".task-markdown").first().innerText();
  assert.match(hcSummary, /不能 —— 有 1 条必须先修/, "结论默认可见");
  assert.match(hcSummary, /四个栏目写成小标题时，整份报告又全部展开/, "问题本身默认可见");
  for (const noise of ["被审范围与仓库状态", "abc1234", "npm test", "临时服务已停止"]) {
    assert.doesNotMatch(hcSummary, new RegExp(noise), `「${noise}」属于技术明细，默认不该在屏幕上`);
  }
  const hcToggle = headingColumns.getByRole("button", { name: /展开技术明细/ });
  assert.equal(await hcToggle.count(), 1, "小标题写法跟加粗写法一样是这套格式，按钮也该这么写");
  await hcToggle.click();
  const hcDetail = await headingColumns.locator(".review-report-detail .task-markdown").innerText();
  for (const line of ["abc1234", "npm test", "临时服务已停止"]) {
    assert.match(hcDetail, new RegExp(line), `展开后「${line}」原样还在`);
  }

  // ⑩ 第二档的两种来由，屏幕上长得一样：切得动、但按钮什么都不宣称。
  //
  //    `legacy` 是这一轮没通过；`legacyConclusion` 是通过了、却没照这套格式写（判定写在
  //    `## 结论` 那一节里的旧形态，全库 146 份）。后者尤其要钉住：**通过了不等于敢宣称**,
  //    还得报告自己的结构证明得了切点落在结论之后。
  const legacy = page.locator(".legacy-fixture");
  const legacyText = await legacy.locator(".task-markdown").first().innerText();
  assert.match(legacyText, /verify_failed/, "报告自己的判定必须留在首屏");
  assert.match(legacyText, /2 个可复现的高优先级问题/, "「有几个问题」也留在首屏");
  assert.doesNotMatch(legacyText, /做对的部分/, "「做对的部分」不许冒充摘要占着首屏");
  assert.equal(
    await legacy.getByRole("button", { name: /技术明细/ }).count(),
    0,
    "没通过的报告，按钮不准替折叠里的东西背书",
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

  const legacyConclusion = page.locator(".legacy-conclusion-fixture");
  const lcSummary = await legacyConclusion.locator(".task-markdown").first().innerText();
  assert.match(lcSummary, /verified/, "判定必须默认可见");
  assert.match(lcSummary, /结论/, "结论那一节整个留在首屏");
  assert.doesNotMatch(lcSummary, /被审范围|45b8a02|清场/, "技术记录照切");
  assert.equal(
    await legacyConclusion.getByRole("button", { name: /技术明细/ }).count(),
    0,
    "通过了但没照格式写，按钮同样不准替折叠里的东西背书",
  );
  const lcToggle = legacyConclusion.getByRole("button", { name: /^展开完整报告$/ });
  assert.equal(await lcToggle.count(), 1);
  await lcToggle.click();
  const lcDetail = await legacyConclusion.locator(".review-report-detail .task-markdown").innerText();
  assert.match(lcDetail, /45b8a02/, "展开后技术记录原样都在");
  assert.match(lcDetail, /清场/);

  // ⑪ 正文自相矛盾的那一类（首屏写着「没有发现问题」、条数却写着 2，真问题在下一个
  //    `##` 里）。这种报告现在不靠渲染侧救——救不住，十轮试下来每一版判据都被绕开。
  //    渲染侧只保证一件事：这一轮既然没通过，按钮就一个字都不宣称。
  const contradictory = page.locator(".contradictory-fixture");
  assert.equal(
    await contradictory.getByRole("button", { name: /技术明细/ }).count(),
    0,
    "没通过的报告，正文再像「都过了」也不许替折叠背书",
  );
  assert.equal(
    await contradictory.getByRole("button", { name: /^展开完整报告$/ }).count(),
    1,
    "仍要给一个不作承诺的展开入口",
  );

  // ⑫ 第三档（切不动）的两种：说明段里抄了四行栏目名却凑不齐签名——那是新格式写坏了，
  //    问题本来就该在结论节里，从第二个 `##` 起切会把问题一起切走，所以整篇铺开。
  const proseCopy = page.locator(".prose-copy-fixture");
  assert.match(
    await proseCopy.locator(".task-markdown").first().innerText(),
    /保存后你刚改的内容会全部消失/,
    "格式写坏了的报告，问题必须默认可见",
  );
  assert.equal(
    await proseCopy.locator(".review-report-more").count(),
    0,
    "整篇铺开，不该画出任何展开按钮",
  );

  // 另一半：元数据开场，连引子都凑不出来（真实形态是一份 111 行报告）。不猜切点——按首节
  // 切会把 P1～P3 折掉——改成按渲染高度夹住：首屏不许糊人一脸，按钮照旧什么都不宣称，
  // 整篇仍在 DOM 里一个字没少。
  const metadata = page.locator(".metadata-first-fixture");
  const clamp = metadata.locator(".review-report-whole");
  assert.equal(await clamp.count(), 1, "认不出摘要的报告走夹住那一档");
  assert.ok(await clamp.evaluate((node) => node.classList.contains("is-clamped")), "长报告默认夹住");
  const clampedHeight = (await clamp.boundingBox())?.height ?? 0;
  assert.ok(clampedHeight > 0 && clampedHeight <= 641, `夹住后高度应止于上限，实为 ${clampedHeight}`);
  assert.equal(
    await metadata.getByRole("button", { name: /技术明细/ }).count(),
    0,
    "按钮不准替看不见的那半截背书",
  );
  // 夹住的是视觉，不是内容：整篇都还在 DOM 里，修复 agent 读的盘上那份更是一个字没动。
  assert.match(await clamp.innerText(), /建议先修 P1/, "夹住不是丢弃");

  const wholeToggle = metadata.getByRole("button", { name: /^展开完整报告$/ });
  assert.equal(await wholeToggle.count(), 1, "夹住了就得给一个展开的出口");
  await wholeToggle.click();
  assert.ok(
    !(await clamp.evaluate((node) => node.classList.contains("is-clamped"))),
    "点开之后不再夹",
  );
  assert.ok(((await clamp.boundingBox())?.height ?? 0) > clampedHeight, "展开后铺满全文");
  assert.equal(await metadata.getByRole("button", { name: /^收起完整报告$/ }).count(), 1);

  // ⑬ 装得下的报告一个按钮都不画；**刚过上限也不画**——夹住得真省下东西，不然那个按钮
  //    只是碍事。真实形态 `YsEYKwIz-EaC`（34 行、844px）就卡在这一档。判据是渲染高度，
  //    所以这份 fixture 的宽度写死，先断言它确实落在「过了上限、没过余量」那一段。
  const justOver = page.locator(".just-over-fixture");
  const justOverBody = justOver.locator(".review-report-whole > div");
  const natural = await justOverBody.evaluate((node) => node.scrollHeight);
  assert.ok(natural > 640, `这份 fixture 得真的超过上限，否则下面的断言是空的（实为 ${natural}px）`);
  assert.equal(
    await justOver.locator(".review-report-more").count(),
    0,
    `只超出上限两百来 px 时不该画按钮（实为 ${natural}px）`,
  );
  assert.equal(await justOver.locator(".review-report-whole.is-clamped").count(), 0, "没过余量就别夹");

  console.log("review report split dom ok");
} finally {
  await browser?.close();
  await server.close();
}
