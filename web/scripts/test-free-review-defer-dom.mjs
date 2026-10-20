// 驳回卡上第三个出口（转为独立任务）的 DOM 回归。
//
// 盯的是**出口的存在条件和它与另外两个的差别**，不是措辞细节：
// ① 只有执行者逐条写明了越界依据（deferReason 非空）时这颗按钮才出现——凭空给它，
//    它就成了谁都能按的免修开关；
// ② 只提转出时标题不能还写「驳回了意见」：执行者说的恰恰是「报告是对的，只是不该
//    在这儿修」；
// ③ 两段理由同时给时，两块都得摆出来，四个出口并存（不逼执行者三选一）；
// ④ 按下去发的是 resolution=deferred，回报里带着建出来的那个任务；
// ⑤ 每个裁定确认框里都有**裁定要点**那一栏，措辞按档位换，写下的话真的随裁定发出去。
//    三档枚举表达不了「这条我认，但按辩论里达成的方案做」，它是那部分结论唯一的出口；
// ⑥ 辩完之后每段发言上的「用这段作要点」：灌整段原文、追加不覆盖、落到「让它接着改」。
// ⑦ 同一个卡片位置换一轮内容时，折叠档位跟着**新内容**走，不沿用上一轮的手动展开；
// ⑧ 那一句人话真的被渲染成大字正文色——它是整屏唯一的主角，被通用段落样式压成灰小字
//    就等于白写（这两条都是第 1 轮审查记下的 N1/N2）。
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
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/free-review-defer.html`);

  const deferOnly = page.locator(".defer-only-fixture");
  const reasonOnly = page.locator(".reason-only-fixture");
  const mixed = page.locator(".mixed-fixture");
  await deferOnly.locator(".free-review-dispute-card").waitFor();

  // ② 只提转出：标题换说法，「驳回理由」那块整块不出现。
  assert.match(
    await deferOnly.locator("header b").innerText(),
    /认可第 1 轮意见，但说该另开一个任务去改/,
    "只提转出时标题不能写成「驳回了意见」——执行者说的是报告对、只是不该在这儿修",
  );
  assert.equal(
    await deferOnly.locator(".folded-prose:not(.is-defer)").count(),
    0,
    "只提转出时不该摆出空的「驳回依据」块",
  );
  // 执行者那一句人话是这一屏的主角：先读它再决定要不要展开几千字依据（用户 2026-10-20
  // 「一大篇文字都看不懂」）。所以它摆在首屏、且不折叠。
  assert.match(
    await deferOnly.locator(".free-review-dispute-card__gist").innerText(),
    /这两条我认，但它们是上一轮照意见改出来的新问题/,
    "那一句人话必须摆在卡上，不能只有折叠着的技术依据",
  );
  const deferProse = deferOnly.locator(".folded-prose.is-defer");
  assert.equal(await deferProse.locator(".task-markdown").count(), 0,
    "有摘要时技术依据默认折着：一墙字拍上来，用户连「有几个选项」都看不见");
  assert.match(await deferProse.locator("button em").innerText(), /\d+ 字/,
    "折叠标题要报字数，用户才知道展开要读多少");
  await deferProse.locator("button").click();
  assert.match(
    await deferProse.locator(".task-markdown").innerText(),
    /超出原任务边界/,
    "展开之后技术依据原样可读",
  );

  // ① 出口的存在条件：没写越界依据就没有这颗按钮。
  assert.equal(
    await reasonOnly.getByRole("button", { name: "转为独立任务" }).count(),
    0,
    "执行者没提越界依据时不给「转为独立任务」出口（后端同样拒绝，这里不是唯一防线）",
  );
  assert.equal(
    await reasonOnly.getByRole("button", { name: "这一轮不用改了" }).count(),
    1,
    "现有两个出口一个都不许少",
  );
  assert.equal(await reasonOnly.getByRole("button", { name: "让它接着改" }).count(), 1);
  assert.match(await reasonOnly.locator("header b").innerText(), /不认第 1 轮审查意见/);
  // 这一张是**老数据**（没有那一句人话）：此时正文必须默认摊开，折起来就成了「什么都没有」。
  assert.equal(await reasonOnly.locator(".free-review-dispute-card__gist").count(), 0,
    "没有摘要就不编一句糊上去");
  assert.equal(await reasonOnly.locator(".folded-prose .task-markdown").count(), 1,
    "老驳回没有摘要，技术依据要默认摊开——否则这张卡上一个字都读不到");
  // 出口竖排成一列，每行都带一句「我什么时候该点它」：横排时四颗按钮各只有五个字，
  // 彼此的差别写在确认框里，用户只能挨个点开看。
  const exits = reasonOnly.locator(".free-review-dispute-card__exits > li");
  assert.ok(await exits.count() >= 3, "出口要摆成一列");
  for (const [index, blurb] of [[0, /审查说得对/], [1, /它说得对/]]) {
    assert.match(await exits.nth(index).locator("small").innerText(), blurb,
      "每个出口都要有一行「我什么时候该点它」");
  }

  // ③ 混合形态：两块理由 + 四个出口并存。
  assert.equal(
    await mixed.locator(".folded-prose").count(),
    2,
    "两段理由同时给时两块都要摆出来（一次交接里表达「不成立」和「成立但越界」共存）",
  );
  assert.match(
    await mixed.locator("header b").innerText(),
    /不认第 1 轮的部分意见，另几条说该另开任务去改/,
    "混合形态的标题要把两件事都说出来",
  );
  for (const name of ["让双方辩论", "转为独立任务", "这一轮不用改了", "让它接着改"]) {
    assert.equal(await mixed.getByRole("button", { name }).count(), 1, `混合形态下「${name}」出口要在`);
  }

  // ④ 按下去：确认框讲清「没有作废、只是换个地方修」，确认后发 deferred 并回报那个任务。
  await deferOnly.getByRole("button", { name: "转为独立任务" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const message = await dialog.innerText();
  assert.match(message, /待办，不会自动开跑/, "确认框必须说清建出来的是待办任务，不会自己起跑");
  assert.match(message, /没有作废/, "确认框必须把它和「这一轮不用改了」的差别说死");
  // 转出之后这条链就停住了，可执行者在提驳回之前已经把在边界内的那几条改掉了——那部分
  // 代码一轮都没审过。不说一句，用户按完只会以为「处理完了」，改动就这么没人看地留着。
  assert.match(
    message,
    /还没审过.*再派一轮审查/,
    "确认框要说清：执行者已经改掉的那部分还没审过，要继续推进得再派一轮",
  );
  // ⑤ 裁定要点：这一档写给的是新任务，措辞得说清它落到哪儿去。
  const note = dialog.locator(".free-review-dispute-note");
  await note.waitFor();
  assert.match(await note.locator("span").innerText(), /交代给新任务/,
    "转出这一档的要点是写给派生任务的，不是写给本任务执行者的");
  assert.match(await note.locator("small").innerText(), /待办任务的描述/,
    "要说清这段话落到哪儿，否则用户不知道有没有人会看");
  await note.locator("textarea").fill("这几条连同上一轮那个 helper 一起重写。");

  await dialog.getByRole("button", { name: "建任务并转走这几条" }).click();

  await page.waitForFunction(() => (window.__resolutions ?? []).length === 1);
  assert.deepEqual(
    await page.evaluate(() => window.__resolutions),
    ["deferred"],
    "点下去发的裁定必须是 deferred",
  );
  assert.deepEqual(
    await page.evaluate(() => window.__notes),
    ["这几条连同上一轮那个 helper 一起重写。"],
    "裁定要点必须跟着裁定一起发出去：漏传的话界面看着一切正常，那段话却谁都收不到",
  );
  await page.waitForFunction(() => (window.__notices ?? []).length === 1);
  assert.match(
    (await page.evaluate(() => window.__notices))[0],
    /已转为独立任务：原任务 · 承接第 1 轮审查的越界意见/,
    "提示里要带上建出来的那个任务，否则用户不知道东西落到哪儿去了",
  );

  // ⑤（续）另外两档各有各的去处，措辞不能共用一份：「让它接着改」那段会随修复指令
  // 发给执行者并压过报告，「这一轮不用改了」那档压根不发消息。说反了用户就会把话写错地方。
  await reasonOnly.getByRole("button", { name: "让它接着改" }).click();
  const upheldDialog = page.getByRole("dialog");
  await upheldDialog.locator(".free-review-dispute-note").waitFor();
  assert.match(await upheldDialog.locator(".free-review-dispute-note span").innerText(), /交代给执行者/);
  assert.match(
    await upheldDialog.locator(".free-review-dispute-note small").innerText(),
    /一起发给它.*以你这段为准/,
    "维持这一档要说清：这段话会发给执行者，并且压过报告",
  );
  // 按钮上只写动作，但留档用的那套说法仍要露一次：用户回头会在时间线上读到「维持审查
  // 意见」，界面上一次都不提，那就成了他没按过的词。
  assert.match(
    await upheldDialog.locator(".free-review-dispute-recorded").innerText(),
    /维持审查意见/,
    "确认框要把留档用的那个名字对上",
  );
  await upheldDialog.getByRole("button", { name: "取消" }).click();

  await reasonOnly.getByRole("button", { name: "这一轮不用改了" }).click();
  const withdrawnDialog = page.getByRole("dialog");
  await withdrawnDialog.locator(".free-review-dispute-note").waitFor();
  assert.match(
    await withdrawnDialog.locator(".free-review-dispute-note small").innerText(),
    /不会给执行者发任何消息/,
    "采纳这一档不发消息，要说清这段话只是备查，别让用户以为执行者会读到",
  );
  await withdrawnDialog.getByRole("button", { name: "取消" }).click();
  assert.equal(
    (await page.evaluate(() => window.__resolutions)).length,
    1,
    "取消掉的两个确认框一个裁定都不许发出去",
  );

  // ⑥ 辩完之后：每段发言上的「用这段作要点」把整段灌进要点栏并直接落到「让它接着改」。
  // 辩论最有用的产物常常就是收尾那段里的具体方案，没有这颗按钮它是一次跨面板的手抄。
  const debated = page.locator(".debated-fixture");
  // 辩论回放逐段摆的是那一句人话，完整发言折在下面：七段发言合起来上万字（真实样本），
  // 而用户开辩论就是为了裁定，不是为了读完。
  const turns = debated.locator(".free-review-debate li");
  assert.match(
    await turns.nth(0).locator(".free-review-debate__gist").innerText(),
    /我坚持这一条/,
    "每段先摆那一句人话",
  );
  assert.equal(await turns.nth(0).locator(".folded-prose .task-markdown").count(), 0,
    "有摘要的那段，完整发言默认折着");
  assert.equal(await turns.nth(1).locator(".free-review-debate__gist").count(), 0,
    "老发言没有摘要就不编一句");
  assert.equal(await turns.nth(1).locator(".folded-prose .task-markdown").count(), 1,
    "没有摘要的那段要把发言摊开兜住");
  const quotes = debated.getByRole("button", { name: "用这段作要点" });
  assert.equal(await quotes.count(), 3, "三段发言各挂一颗：只许引用一方等于替用户挑了立场");
  await quotes.nth(2).click();
  const quoted = page.getByRole("dialog");
  await quoted.locator(".free-review-dispute-note").waitFor();
  assert.match(
    await quoted.locator("h2").first().innerText(),
    /接着改/,
    "引用一段发言的意思就是「照这个改」，该落在让它接着改那一档上",
  );
  const box = quoted.locator(".free-review-dispute-note textarea");
  assert.match(
    await box.inputValue(),
    /〔审查者第 3 段〕[\s\S]*我建议你让它按新方案改/,
    "灌进去的必须是那一段的原文并标明出处，不是摘要",
  );
  assert.match(
    await quoted.innerText(),
    /审查者最后那段会一并发给它/,
    "辩完这一档要说清收尾那段执行者自己没见过，否则用户会以为它听见了",
  );
  // 追加而不是覆盖：用户可能先自己写了半句再想起来引用，覆盖掉等于吃掉他刚打的字。
  await quoted.getByRole("button", { name: "取消" }).click();
  await quotes.nth(1).click();
  const twice = page.getByRole("dialog");
  await twice.locator(".free-review-dispute-note").waitFor();
  const merged = await twice.locator(".free-review-dispute-note textarea").inputValue();
  assert.match(merged, /〔审查者第 3 段〕/, "第一次引用的那段不能被第二次覆盖掉");
  assert.match(merged, /〔执行者第 2 段〕/);
  await twice.getByRole("button", { name: "发起修复" }).click();
  await page.waitForFunction(() => (window.__resolutions ?? []).length === 2);
  assert.deepEqual(
    await page.evaluate(() => window.__resolutions),
    ["deferred", "upheld"],
    "引用之后确认发出的是 upheld",
  );
  assert.match(
    (await page.evaluate(() => window.__notes))[1],
    /我建议你让它按新方案改/,
    "引用来的原文必须真的跟着裁定发出去",
  );

  // ⑧ 那一句人话的字号与颜色得是真的生效值，不是写在 CSS 里就算。`.free-review-dispute-card
  // > p` 是「类+元素」，比裸一个类更具体，所以摘要那条规则光写在它后面压不住——主角会被
  // 渲染成和状态行一样的灰小字（第 1 轮审查 N2 实测 9.5px/--muted）。
  const gistStyle = await mixed.locator(".free-review-dispute-card__gist").evaluate((node) => {
    const style = getComputedStyle(node);
    // 同一张卡里的状态行（那个没有 class 的 <p>）是「灰小字」的基准值：摘要跟它同款就
    // 说明通用段落规则又把它压了回去。
    const plain = node.parentElement.querySelector("p:not([class])");
    return { fontSize: style.fontSize, color: style.color, plainColor: getComputedStyle(plain).color };
  });
  assert.equal(gistStyle.fontSize, "11px", "摘要必须比周围的字大，否则读者第一眼落不到它身上");
  assert.notEqual(
    gistStyle.color,
    gistStyle.plainColor,
    "摘要要用正文色：跟状态行一样的灰字 = 主角被渲染成了配角",
  );

  // ⑦ 同一个位置换一轮：历史报告抽屉切换轮次时复用的就是这一个卡片位置。展开档位必须按
  // **内容**认——否则甲轮手动展开会跟着切到乙轮，而乙轮那条该默认摊开的老记录反倒是收起
  // 的，用户以为「这条没写理由」（第 1 轮审查 N1）。钉在组件这一层而不是抽屉里：这一屏有
  // 5 个 FoldedProse 调用点，靠每处记得传 key 就是在等下一处漏传。
  const switcher = page.locator(".switch-fixture");
  const switchProse = switcher.locator(".folded-prose");
  await switchProse.waitFor();
  assert.equal(await switchProse.locator(".task-markdown").count(), 0,
    "有摘要的那一轮，依据默认折着");
  await switcher.getByRole("button", { name: "换一轮" }).click();
  assert.equal(await switchProse.locator(".task-markdown").count(), 1,
    "换到没有摘要的那一轮，依据要按它自己的默认摊开——不能沿用上一轮的收起状态");
  await switchProse.locator("button").click();
  assert.equal(await switchProse.locator(".task-markdown").count(), 0, "手动收起照旧生效");
  await switcher.getByRole("button", { name: "换一轮" }).click();
  assert.equal(await switchProse.locator(".task-markdown").count(), 0,
    "切回有摘要那一轮，回到它自己的默认档（折着）");
  await switcher.getByRole("button", { name: "换一轮" }).click();
  assert.equal(await switchProse.locator(".task-markdown").count(), 0,
    "再切回去，用户刚才在这份内容上的手动收起要留着（状态按内容认，不是每次切换粗暴重置）");

  console.log("free review defer dom tests passed");} finally {
  await browser?.close();
  await server.close();
}
