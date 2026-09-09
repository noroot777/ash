import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// **git 操作跑到一半，浮层不许被误触抹掉。**
//
// 项目 Git 浮层是「点别处就收起」的下拉，而 fetch / pull / push / checkout 都是秒级往上的
// 活。老实现把操作状态放在浮层自己的 hook 里，这两件事一撞：手滑点到别处 → 浮层卸载 →
// busy、成功消息、错误全跟着组件没了。请求其实还在飞、服务端照旧在跑，用户看到的却是
// 「整个过程被打断」，重新点开浮层更是一点痕迹都没有。
//
// 判据七条：
//   ① 操作在途时，点浮层外面**不收起**（那几秒的点击九成是手滑）；
//   ② 用 Esc 主动收起来之后，胶囊接着转圈——「我停不下来的那件事还在跑」得留在界面上；
//   ③ 结果落定时，浮层开着就显示在浮层里、关着就补一句 toast，成功失败都不许无声无息；
//   ④ **切到别的项目也算「点了别处」**：胶囊跟着当前项目卸载，旧项目的操作照样得有人认领；
//   ⑤⑥ 写之前发出的那趟读，**成功也好失败也罢**，回来晚了都不许再改面板；
//   ⑦ 读取错误不许挂在那里，把后来做成的事说成失败。
//
// ④ 守的是**播报口挂在哪一层**：现在它在 WorkspaceShell（`useProjectGitAnnouncer`），
// 谁的操作落定都听得见。哪天有人图就近把它搬回分支胶囊里、写成「只管我这个项目」，这条
// 就会红——那正是搬回去之后会丢的东西。
//
// ⑤⑥ 守的是**跨浮层缓存的代价**：缓存让按钮在后台那趟 GET 落地之前就可点，于是「读发在
// 写之前、回来在写之后」成了日常时序。scm 面板栽过同一道题（`test-scm-race.mjs`）。
//
// ⑦ 守的是**读取错误跟操作结果必须住在一起**：分家成两套状态，合并出来的 error 就永远
// 非空，做成了的操作会一直显示成在报错。

const root = fileURLToPath(new URL("..", import.meta.url));

const until = async (probe, hint) => {
  for (let i = 0; i < 100; i += 1) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等不到：${hint}`);
};

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
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/project-git-lifetime.html`;

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage();
  await page.goto(url);

  const pill = page.locator(".workspace-git-context");
  const panel = page.locator(".project-git-panel");
  const running = page.locator(".project-git-panel__running");
  const toast = page.getByTestId("toast");
  // 说了几句 / 刷了几次：只比对文本会被上一次的残留骗过去（同一个操作说的是同一句话）。
  const said = async () => Number(await page.getByTestId("said").innerText());
  const refreshed = async () => Number(await page.getByTestId("refreshed").innerText());

  // ── ① 在途时点外面不收浮层 ────────────────────────────────────────────
  await pill.click();
  await panel.waitFor();
  await page.getByRole("button", { name: "更新远端信息（fetch --prune）" }).click();
  await running.waitFor();
  assert.match(await running.innerText(), /正在更新远端信息/, "浮层里要说清此刻在跑什么");

  await page.getByTestId("outside").click();
  await page.waitForTimeout(200);
  assert.equal(await panel.count(), 1, "操作在途时点外面不许把浮层收走——那正是「过程被打断」的观感来源");

  // ── ② 主动收起来之后，胶囊接着转圈 ──────────────────────────────────
  await page.keyboard.press("Escape");
  await until(async () => (await panel.count()) === 0, "Esc 把浮层收起来");
  assert.equal(await pill.getAttribute("aria-busy"), "true", "浮层收起来了，胶囊得接着说「还在跑」");
  assert.equal(await pill.locator(".is-spinning").count(), 1, "胶囊上要有转圈");

  // ── ③ 浮层关着时落定 → 补一句 toast，且外面那份 ProjectHealth 要刷 ──
  await page.evaluate(() => window.__release());
  await until(async () => (await said()) === 1, "结果补一句 toast");
  assert.match(await toast.innerText(), /已更新 main 的远端信息/, "成功也要说一声，别无声无息");
  assert.equal(await refreshed(), 1, "操作成功要通知外面重拉 ProjectHealth");
  await until(async () => (await pill.getAttribute("aria-busy")) === null, "落定后胶囊停止转圈");

  // 重新点开：结果还在浮层里，而不是「什么都没发生过」。
  await pill.click();
  await panel.waitFor();
  assert.match(await panel.locator(".project-git-panel__ok").innerText(), /已更新 main 的远端信息/, "重开浮层要还看得到上一次的结果");

  // ── ④ 切到别的项目也不许把结果吞掉 ──────────────────────────────────
  await page.getByRole("button", { name: "更新远端信息（fetch --prune）" }).click();
  await running.waitFor();
  await page.getByTestId("switch-project").click();
  await until(async () => /release/.test(await pill.innerText()), "胶囊切到另一个项目");
  assert.equal(await panel.count(), 0, "换项目连浮层带胶囊一起换掉了");
  const saidBefore = await said();
  const refreshedBefore = await refreshed();
  await page.evaluate(() => window.__release());
  await until(async () => (await said()) === saidBefore + 1, "切走之后旧项目的结果照样有人认领");
  assert.match(await toast.innerText(), /已更新 main 的远端信息/, "说的得是切走前那个项目的结果");
  assert.equal(await refreshed(), refreshedBefore + 1, "切走之后照样要通知外面重拉 ProjectHealth");
  await page.getByTestId("switch-project").click();
  await until(async () => /main/.test(await pill.innerText()), "切回原项目");

  // ── ⑤ 缓存让按钮提前可点，那趟后台 GET 就不许再说了算 ────────────────
  // 重开浮层时先摆缓存、后台补一趟 GET。缓存已经让分支行可点，用户完全来得及在这几百
  // 毫秒里切一次分支——于是「读发在写之前、回来在写之后」。老实现只在写入那一刻看 busy，
  // 那时 busy 早清空了，这份写之前的快照就把 checkout 的结果盖了回去：面板从 feature 退
  // 回 main，连带按钮门禁和 upstream/ahead/behind 一起回到旧仓库状态。
  await page.keyboard.press("Escape");
  await until(async () => (await panel.count()) === 0, "先把浮层收起来");
  await page.evaluate(() => window.__holdNextGet());
  await pill.click();
  await panel.waitFor();
  await until(async () => page.evaluate(() => window.__heldGetArrived()), "被扣住的那趟 GET 到达");

  // 分支行的可及名字是「分支名 + 上游那一小段」（feature 没有 upstream），所以按前缀匹配。
  await page.getByRole("button", { name: /^feature/ }).click();
  await until(
    async () => /已切换到 feature/.test(await panel.locator(".project-git-panel__ok").innerText().catch(() => "")),
    "checkout 落定",
  );

  await page.evaluate(() => window.__releaseGet());
  // 响应到浏览器、fetch 落地、React 重渲染都在这之后，给它一点时间真的把状态写进去
  // ——测的是「盖回去了没有」，所以必须等它有机会盖。
  await page.waitForTimeout(400);
  const current = page.locator(".project-git-branch.is-current");
  assert.equal(await current.count(), 1, "当前分支只该有一行");
  assert.match(await current.innerText(), /feature/, "写之前发出的那趟 GET 不许把 checkout 结果盖回 main");
  assert.match(await panel.locator(".project-git-panel__branch b").innerText(), /feature/, "浮层顶上那行也得是切过去的分支");

  // ── ⑥ 过期的读**失败**了，同样不许改写刚做成的那件事 ─────────────────
  // 跟 ⑤ 是同一条竞态的另一半。只拦成功那一路的话，剩下的失败一路照样能把「已切换到
  // main」改写成一句读取错误——用户刚做成的事，转眼被一条过期的读说成出错了；而且面板
  // 里 error 一非空，成功消息就被顶掉不显示，看上去就是「切分支失败了」。
  await page.keyboard.press("Escape");
  await until(async () => (await panel.count()) === 0, "先把浮层收起来");
  await page.evaluate(() => window.__holdNextGet(true));
  await pill.click();
  await panel.waitFor();
  await until(async () => page.evaluate(() => window.__heldGetArrived()), "被扣住的那趟 GET 到达");

  await page.getByRole("button", { name: /^main/ }).click();
  await until(
    async () => /已切换到 main/.test(await panel.locator(".project-git-panel__ok").innerText().catch(() => "")),
    "checkout 落定",
  );

  await page.evaluate(() => window.__releaseGet());
  await page.waitForTimeout(400);
  assert.equal(await panel.locator(".project-git-panel__error").count(), 0, "写之前发出的那趟读失败了，不许在面板上说话");
  assert.match(await panel.locator(".project-git-panel__ok").innerText(), /已切换到 main/, "成功消息不许被过期读的失败顶掉");
  assert.match(await panel.locator(".project-git-branch.is-current").innerText(), /main/, "当前分支仍是刚切过去的那条");

  // ── ⑦ 读取错误不许挂在那里，把后来做成的事说成失败 ────────────────────
  // 这条不是竞态，是**状态归属**：读取错误一旦跟账本分家（留在 hook 本地 state 里），
  // 「账本记着 checkout 成功」和「组件里那条读取错误没人清」就成了两套说法，合并出来的
  // error 永远非空——面板照着「有错就不显示成功消息」的规矩，把一次做成了的操作一直显示
  // 成在报错。缓存分支清单还在，用户照样点得动，所以这条时序一点都不刁钻。
  await page.keyboard.press("Escape");
  await until(async () => (await panel.count()) === 0, "先把浮层收起来");
  await page.evaluate(() => window.__holdNextGet(true));
  await pill.click();
  await panel.waitFor();
  await until(async () => page.evaluate(() => window.__heldGetArrived()), "被扣住的那趟 GET 到达");
  await page.evaluate(() => window.__releaseGet());
  // 这一趟没人跟它抢，读取错误本来就该显示出来——先确认它真的挂上去了，后面那条断言才有
  // 意义（否则「没有错误」可能只是因为压根没出过错）。
  await until(async () => (await panel.locator(".project-git-panel__error").count()) === 1, "读失败要如实说");
  assert.match(await panel.locator(".project-git-panel__error").innerText(), /过期的那趟读失败了/, "报的得是这趟读的原因");

  await page.getByRole("button", { name: /^feature/ }).click();
  // 等的是**分支行**变过去，不是成功消息：成功消息正是这条判据要测的东西（残留的读取错误
  // 会把它整个压掉不渲染），拿它当等待条件的话，红的会是一句「等不到」而不是那条断言。
  await until(
    async () => /feature/.test(await panel.locator(".project-git-branch.is-current").innerText().catch(() => "")),
    "checkout 落定（当前分支变成 feature）",
  );
  await page.waitForTimeout(200);
  assert.equal(await panel.locator(".project-git-panel__error").count(), 0, "操作做成了，上一条读取错误就该作废，不能挂着继续报错");
  assert.match(await panel.locator(".project-git-panel__ok").innerText(), /已切换到 feature/, "成功消息不许被残留的读取错误压掉");

  // ── 失败一路：浮层关着时同样得说话，而且留住让人看 ──────────────────
  // ⑦ 结束时浮层还开着，直接接着点 fetch。
  await page.evaluate(() => window.__failNext());
  await page.getByRole("button", { name: "更新远端信息（fetch --prune）" }).click();
  await running.waitFor();
  const saidBeforeFail = await said();
  await page.keyboard.press("Escape");
  await until(async () => (await panel.count()) === 0, "Esc 把浮层收起来");
  await page.evaluate(() => window.__release());
  await until(async () => (await said()) === saidBeforeFail + 1, "失败也要补一句 toast");
  assert.match(await toast.innerText(), /更新远端信息失败/, "toast 要说清是哪一步失败了");

  const before = await page.evaluate(() => window.__calls.gets);
  await pill.click();
  await panel.waitFor();
  assert.match(await panel.locator(".project-git-panel__error").innerText(), /Connection timed out/, "重开浮层要还看得到失败原因");
  assert(await page.evaluate((n) => window.__calls.gets > n, before), "重开浮层照旧拉一趟最新状态");

  console.log("project git lifetime test passed");
} finally {
  await browser?.close();
  await server.close();
}
