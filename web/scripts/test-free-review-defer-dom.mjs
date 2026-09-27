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
    /超出本任务边界/,
    "只提转出时标题不能写成「驳回了意见」——执行者说的是报告对、只是不该在这儿修",
  );
  assert.equal(
    await deferOnly.locator(".free-review-dispute-card__reason:not(.is-defer)").count(),
    0,
    "只提转出时不该摆出空的「驳回理由」块",
  );
  assert.match(
    await deferOnly.locator(".free-review-dispute-card__reason.is-defer").innerText(),
    /超出原任务边界/,
    "转出理由要原样摆出来给用户看",
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
  assert.match(await reasonOnly.locator("header b").innerText(), /驳回了第 1 轮意见/);

  // ③ 混合形态：两块理由 + 四个出口并存。
  assert.equal(
    await mixed.locator(".free-review-dispute-card__reason").count(),
    2,
    "两段理由同时给时两块都要摆出来（一次交接里表达「不成立」和「成立但越界」共存）",
  );
  for (const name of ["让双方辩论", "转为独立任务", "这一轮不用改了", "让它接着改"]) {
    assert.equal(await mixed.getByRole("button", { name }).count(), 1, `混合形态下「${name}」出口要在`);
  }

  // ④ 按下去：确认框讲清「没有作废、只是换个地方修」，确认后发 deferred 并回报那个任务。
  await deferOnly.getByRole("button", { name: "转为独立任务" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const message = await dialog.innerText();
  assert.match(message, /待办、不起跑/, "确认框必须说清建出来的是待办任务，不会自己起跑");
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
  assert.match(await note.locator("span").innerText(), /写给新任务的要点/,
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
    /已转为独立任务：承接第 1 轮审查的越界意见/,
    "提示里要带上建出来的那个任务，否则用户不知道东西落到哪儿去了",
  );

  // ⑤（续）另外两档各有各的去处，措辞不能共用一份：「让它接着改」那段会随修复指令
  // 发给执行者并压过报告，「这一轮不用改了」那档压根不发消息。说反了用户就会把话写错地方。
  await reasonOnly.getByRole("button", { name: "让它接着改" }).click();
  const upheldDialog = page.getByRole("dialog");
  await upheldDialog.locator(".free-review-dispute-note").waitFor();
  assert.match(await upheldDialog.locator(".free-review-dispute-note span").innerText(), /写给执行者的要点/);
  assert.match(
    await upheldDialog.locator(".free-review-dispute-note small").innerText(),
    /随修复指令一起发过去.*以你这段为准/,
    "维持这一档要说清：这段话会发给执行者，并且压过报告",
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
    /收尾发言会一并发给它/,
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

  console.log("free review defer dom tests passed");} finally {
  await browser?.close();
  await server.close();
}
