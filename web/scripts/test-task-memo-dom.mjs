// 任务备忘 DOM 回归：真 Vite + 真 Chromium（headless）+ 真组件，API 用 `page.route` 拦下来
// 按一份内存里的清单答（见 `memosOf`）。钉住的是四件靠静态渲染摸不到的事：
//  ① 面板里的增 / 改 / 删各自真的发了什么请求，列表跟着变没变；
//  ② 几百字一条时折到几行、溢出才给「展开全文」（要量 scrollHeight，静态渲染量不到）；
//  ③ 会话里选中一段 →「添加到备忘」→ 面板**切过去**并指出刚进来的是哪条（切面板的是
//     InspectorHost，写入的是模块级 store，两边不在同一棵子树里）；
//  ④ 侧边栏铺开那一格「追问和备忘哪个新显示哪个」，以及悬浮卡里备忘排在追问正文下面；
//  ⑤ 保存失败时草稿**留在框里**（几百字一条，把失败当成功退出去等于直接删掉它们）；
//  ⑥ 写入成功之后一发更早的 GET 到达，不许把那条抹掉、也不许让它出现两次；
//  ⑦ 第 201 个任务（首批之外）也拿得到备忘摘要 —— 真 hook 自己去取，批次是它内部的事。
//  ⑧ 保存还没结束时切走再回来：框子仍然禁用（在途状态活得过面板卸载）。
//  ⑨ 旧保存回来只许清自己提交的那一版草稿，不许清掉这期间新写的。
//  ⑩ 铺开那一列：迟到的旧批量摘要不许把已经显示的新摘要顶回去。
//  ⑪ 同一条备忘的两发写逆序返回时，晚到的旧回执不许盖掉后发那一版。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const LONG = "几百字一条的备忘：".repeat(40);

let server;
let browser;

/** 这一页的后端：一份内存清单 + 几条端点。返回的对象能让用例直接读/改它。 */
function backend() {
  const rows = [];
  let seq = 0;
  return {
    rows,
    requests: [],
    /** 批量摘要每一发问了哪些 taskId（钉「第 201 个也问到了」用）。 */
    digestBatches: [],
    /** 这个任务有备忘（批量摘要据此作答）。 */
    digestOf: new Map(),
    /** 真 = 把 GET 的应答按住不发（手里那份快照就此变旧）。 */
    holdReads: false,
    held: [],
    /**
     * 放行被按住的那几发（它们带的是按住当时的快照），并**等到真的发出去**。
     * 不等的话，紧跟其后的断言会在旧应答还没被页面收下时就跑完（第 2 轮审查 N5）。
     */
    release() { return Promise.all(this.held.splice(0).map((send) => send())); },
    /** 真 = PATCH 一律 503（注入保存失败）。 */
    failPatch: false,
    /**
     * 真 = 把写（PATCH）的回执按住不发：库里已经改好了，只是回执还在路上 —— 真服务上
     * 「保存还没结束」就是这个样子。
     */
    holdWrites: false,
    heldWrites: [],
    releaseWrites() { return Promise.all(this.heldWrites.splice(0).map((send) => send())); },
    /** 只放行第 index 发（从 0 数）。「应答逆序返回」就靠它：先放后发的那一发。 */
    releaseWrite(index) {
      const [send] = this.heldWrites.splice(index, 1);
      return send ? send() : Promise.resolve();
    },
    /**
     * 真 = 把**批量**摘要（问多于一个任务的那种）的应答按住不发。只按住批量那种，是为了
     * 跟「写入之后只问一个任务的补发」分得开 —— 后者必须照常回，才复现得出「新的先到、
     * 旧的后到」。
     */
    holdBulkDigests: false,
    heldDigests: [],
    releaseDigests() { return Promise.all(this.heldDigests.splice(0).map((send) => send())); },
    async route(route) {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      this.requests.push(`${method} ${url.pathname}`);
      const list = /^\/api\/tasks\/([^/]+)\/memos$/.exec(url.pathname);
      const one = /^\/api\/tasks\/([^/]+)\/memos\/([^/]+)$/.exec(url.pathname);
      if (url.pathname === "/api/tasks/memos" && method === "POST") {
        const ids = JSON.parse(request.postData() ?? "{}").taskIds ?? [];
        this.digestBatches.push(ids);
        // 跟真后端同一条规矩：没有备忘的任务**不在返回里**。快照在这一刻定下来。
        const digests = ids.flatMap((taskId) => {
          const digest = this.digestOf.get(taskId);
          return digest ? [{ taskId, count: 1, truncated: false, ...digest }] : [];
        });
        if (this.holdBulkDigests && ids.length > 1) {
          return new Promise((resolve) => {
            this.heldDigests.push(async () => {
              await route.fulfill({ json: digests });
              resolve();
            });
          });
        }
        return route.fulfill({ json: digests });
      }
      // 铺开那一下另外两列也会发请求，给它们空清单，别让 route 落到 500 兜底上。
      if (url.pathname === "/api/tasks/follow-ups" || url.pathname === "/api/tasks/bodies") {
        return route.fulfill({ json: [] });
      }
      if (list && method === "GET") {
        // 快照在**这一刻**定下来：按住期间写进去的东西不在里面，这正是要复现的那种旧应答。
        const snapshot = [...rows];
        if (this.holdReads) {
          return new Promise((resolve) => {
            this.held.push(async () => {
              await route.fulfill({ json: snapshot });
              resolve();
            });
          });
        }
        return route.fulfill({ json: snapshot });
      }
      if (list && method === "POST") {
        const body = JSON.parse(request.postData() ?? "{}").body;
        const at = new Date(Date.now() + ++seq * 1000).toISOString();
        const memo = { id: `m${seq}`, taskId: list[1], body, createdAt: at, updatedAt: at };
        rows.unshift(memo);
        // 摘要跟着写入走（真后端是从同一张表算的），否则「写完那一列该显示新的」测不出来。
        this.digestOf.set(list[1], { text: body, at });
        return route.fulfill({ status: 201, json: memo });
      }
      if (one && method === "PATCH") {
        if (this.failPatch) return route.fulfill({ status: 503, json: { error: "保存失败（503）" } });
        const memo = rows.find((row) => row.id === one[2]);
        memo.body = JSON.parse(request.postData() ?? "{}").body;
        memo.updatedAt = new Date(Date.now() + ++seq * 1000).toISOString();
        this.digestOf.set(one[1], { text: memo.body, at: memo.updatedAt });
        if (this.holdWrites) {
          const sent = { ...memo };
          return new Promise((resolve) => {
            this.heldWrites.push(async () => {
              await route.fulfill({ json: sent });
              resolve();
            });
          });
        }
        return route.fulfill({ json: memo });
      }
      if (one && method === "DELETE") {
        rows.splice(rows.findIndex((row) => row.id === one[2]), 1);
        return route.fulfill({ json: { deleted: true } });
      }
      return route.fulfill({ status: 500, json: { error: `unexpected ${method} ${url.pathname}` } });
    },
  };
}

async function openPage(origin, api, query = "") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => window.localStorage.clear());
  if (api) await page.route("**/api/**", (route) => api.route(route));
  await page.goto(`${origin}/scripts/fixtures/task-memo.html${query}`);
  return { page, errors };
}

/**
 * 等某条备忘的**读态正文**出现。
 *
 * 不要图省事写 `panel.getByText(...)`：Playwright 的文字匹配把 textarea 的 value 也算
 * 进去，于是「刚打进编辑框里的字」会被当成「已经存好了」，断言在请求还在飞的时候就
 * 提前通过 —— 这正是本轮调试掉进去的那个坑。
 */
const bodyShowing = (panel, text) =>
  panel.locator(".task-memo-card__body").filter({ hasText: text }).first().waitFor();

/**
 * 等一个 **Node 侧**的条件成真 —— 用来等后端桩收到某一发请求，页面侧的 waitFor 看不到它。
 * `check` 可以是 async（比如还要顺带问一眼 DOM）。
 */
async function waitFor(check, what, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 会话里选中一段话，跟真人拖选一样把事件补齐（照 test-side-chat-selection-browser.mjs）。 */
async function selectContents(locator) {
  await locator.evaluate((element) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    const box = range.getBoundingClientRect();
    const init = { bubbles: true, clientX: box.right, clientY: box.bottom };
    element.dispatchEvent(new PointerEvent("pointerup", init));
    element.dispatchEvent(new MouseEvent("mouseup", init));
  });
}

try {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch(await chromeLaunchOptions());

  // ── ① 面板：空态 → 写一条 → 改 → 删 ─────────────────────────────────────
  {
    const api = backend();
    const { page, errors } = await openPage(origin, api);
    await page.getByRole("tab", { name: /^备忘/ }).click();
    const panel = page.getByLabel("任务备忘");
    await panel.waitFor();
    assert.match(await panel.textContent(), /这个任务还没有备忘/, "空态要说清这一格是干什么的");

    await page.getByRole("button", { name: "写一条备忘" }).click();
    await panel.locator("textarea").fill("验收时记得查严格增长门");
    await panel.getByRole("button", { name: "保存" }).click();
    await bodyShowing(panel, "验收时记得查严格增长门");
    assert.equal(api.rows.length, 1, "保存要真的落到后端，不是只画在界面上");
    // 有几条要写进图标条的标题：扫一眼就知道这个任务记过东西。
    await page.getByRole("tab", { name: /^备忘（1）/ }).waitFor();

    await panel.getByRole("button", { name: "编辑这条备忘" }).click();
    await panel.locator("textarea").fill("改过的备忘");
    await panel.getByRole("button", { name: "保存" }).click();
    await bodyShowing(panel, "改过的备忘");
    assert.equal(api.rows[0].body, "改过的备忘");
    assert.ok(api.requests.some((line) => line.startsWith("PATCH ")), "改一条走 PATCH");
    await panel.getByText("已编辑").waitFor();

    // 删之前必须过确认框（原生 confirm 是被约定禁掉的，见 scripts/check-conventions.mjs）。
    await panel.getByRole("button", { name: "删除这条备忘" }).click();
    const dialog = page.getByRole("dialog", { name: "删掉这条备忘" });
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /改过的备忘/, "确认框要把删的是哪条摆出来");
    await dialog.getByRole("button", { name: "删掉", exact: true }).click();
    await page.getByText("这个任务还没有备忘。").waitFor();
    assert.equal(api.rows.length, 0);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── ② 长正文：默认折起来，溢出才给「展开全文」 ──────────────────────────
  {
    const api = backend();
    const { page, errors } = await openPage(origin, api);
    await page.getByRole("tab", { name: /^备忘/ }).click();
    const panel = page.getByLabel("任务备忘");
    await page.getByRole("button", { name: "写一条备忘" }).click();
    await panel.locator("textarea").fill(LONG);
    await panel.getByRole("button", { name: "保存" }).click();
    const body = panel.locator(".task-memo-card__body");
    await body.waitFor();
    const folded = await body.evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight }));
    assert.ok(folded.scroll > folded.client, "几百字一条默认要折起来，不能把面板顶成长卷");
    await panel.getByRole("button", { name: "展开全文" }).click();
    const opened = await body.evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight }));
    assert.ok(opened.client >= opened.scroll - 1, `展开之后要真的全出来：${JSON.stringify(opened)}`);
    await panel.getByRole("button", { name: "收起" }).click();
    const refolded = await body.evaluate((node) => node.clientHeight);
    assert.ok(refolded < opened.client, "收起要回到折叠高度");

    // 短的那条不该有「展开全文」——点了什么都不会发生的按钮比没有更糟。
    await page.getByRole("button", { name: "写一条备忘" }).click();
    await panel.locator("textarea").fill("一句话");
    await panel.getByRole("button", { name: "保存" }).click();
    await bodyShowing(panel, "一句话");
    assert.equal(await panel.getByRole("button", { name: "展开全文" }).count(), 1, "只有长的那条带展开");
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── ③ 会话里选一段 →「添加到备忘」→ 切过去并指出是哪条 ────────────────────
  {
    const api = backend();
    const { page, errors } = await openPage(origin, api);
    // 默认停在「信息」那一格：这条用例要的就是「它自己切过去」。
    assert.equal(await page.getByLabel("任务备忘").count(), 0);
    await selectContents(page.getByTestId("said"));
    const action = page.getByRole("button", { name: "添加到备忘" });
    await action.waitFor();
    // 前两颗仍在，且备忘排在它们之后（用户指定的位置）。
    const labels = await page.locator(".conversation-selection-action button").allTextContents();
    assert.deepEqual(labels, ["添加到对话", "在侧聊中提问", "添加到备忘"]);
    await action.click();
    const panel = page.getByLabel("任务备忘");
    await panel.waitFor();
    await bodyShowing(panel, /严格增长门/);
    assert.equal(api.rows.length, 1, "选文那条要真的存下来");
    await panel.locator(".task-memo-card.is-new").waitFor();

    // 团队调度台那种形态（没有侧聊格，onAsk 不传）：浮条上只该剩「添加到备忘」。
    await selectContents(page.getByTestId("team-said"));
    await page.getByRole("button", { name: "添加到备忘" }).waitFor();
    assert.deepEqual(
      await page.locator(".conversation-selection-action button").allTextContents(),
      ["添加到备忘"],
      "没有侧聊的那一页不该出现点了没地方去的「在侧聊中提问」",
    );
    await page.getByRole("button", { name: "添加到备忘" }).click();
    await bodyShowing(panel, /拆成三份/);
    assert.equal(api.rows.length, 2);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── ⑤ 保存失败：留在编辑态，草稿一个字不动 ────────────────────────────────
  {
    const api = backend();
    const { page, errors } = await openPage(origin, api);
    await page.getByRole("tab", { name: /^备忘/ }).click();
    const panel = page.getByLabel("任务备忘");
    await page.getByRole("button", { name: "写一条备忘" }).click();
    await panel.locator("textarea").fill("先存下来的那一版");
    await panel.getByRole("button", { name: "保存" }).click();
    await bodyShowing(panel, "先存下来的那一版");

    const long = `改到一半的长正文：${"这段话很长，几百字一条是常态。".repeat(12)}`;
    api.failPatch = true;
    await panel.getByRole("button", { name: "编辑这条备忘" }).click();
    await panel.locator("textarea").fill(long);
    await panel.getByRole("button", { name: "保存" }).click();
    // 失败要说出来，但**不能把编辑框收掉** —— 收掉就等于把这几百字删了。
    await page.waitForFunction(() => window.__notices.some((line) => line.includes("503")));
    assert.equal(await panel.locator("textarea").count(), 1, "保存失败要留在编辑态");
    assert.equal(await panel.locator("textarea").inputValue(), long, "草稿一个字都不许动");
    assert.equal(api.rows[0].body, "先存下来的那一版", "后端那条当然还是旧的");

    // 恢复之后同一份草稿按一下就能存上（不必让用户重打一遍）。
    api.failPatch = false;
    await panel.getByRole("button", { name: "保存" }).click();
    // 成功才退出编辑态 —— 等编辑框自己消失，别等文字（它在编辑框里本来就在）。
    await panel.locator("textarea").waitFor({ state: "detached" });
    await bodyShowing(panel, /改到一半的长正文/);
    assert.equal(api.rows[0].body, long);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── ⑥ 旧读取不许撤回已确认的写入，也不许让它出现两次 ──────────────────────
  {
    const api = backend();
    api.holdReads = true;
    const { page, errors } = await openPage(origin, api);
    await page.getByRole("tab", { name: /^备忘/ }).click();
    const panel = page.getByLabel("任务备忘");
    await panel.getByText("正在读备忘…").waitFor();

    // 首发 GET 还按在手里（它的快照是空的），这期间写一条。
    await page.getByRole("button", { name: "写一条备忘" }).click();
    await panel.locator("textarea").fill("按住读取时写进来的那条");
    await panel.getByRole("button", { name: "保存" }).click();
    await bodyShowing(panel, "按住读取时写进来的那条");
    assert.equal(api.rows.length, 1);

    // 放行那发旧应答：它不含刚写的那条，但不许据此把界面抹回去。
    const reads = () => api.requests.filter((line) => line === "GET /api/tasks/task-a/memos").length;
    assert.equal(reads(), 1, "按住的就是首发那一发");
    api.holdReads = false;
    await api.release();
    // **等到补发那一发 GET 出现**才算旧应答真的被收下并判了废：补发只写在作废那条分支
    // 里，它出现就是证据。少了这道屏障，「卡片仍是 1 条」在放行之前就已经成立，这个
    // 用例等于什么都没验（第 2 轮审查 N5）。
    await waitFor(() => reads() >= 2, "旧快照作废后补发一发 GET");
    // 再等一会儿让补发的应答落地：它拉回的是含那条的最新快照，所以处理完**仍是** 1 条，
    // 而且不该再触发下一发（那会是重拉死循环）。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(reads(), 2, "补发那一发自己不该再引出一发");
    await bodyShowing(panel, "按住读取时写进来的那条");
    assert.equal(
      await panel.locator(".task-memo-card").count(),
      1,
      "既不能被旧快照抹掉，也不能因为两边都有而出现两条",
    );
    await page.getByRole("tab", { name: /^备忘（1）/ }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── ⑦ 首批之外的任务也拿得到备忘摘要（真 hook 自己去取） ──────────────────
  {
    const api = backend();
    api.digestOf.set("old-tail", { text: "旧任务上记的那条备忘", at: "2026-10-26T02:00:00.000Z" });
    const { page, errors } = await openPage(origin, api, "?fetch=1");
    const cell = page.getByTestId("row-old-tail").locator(".workspace-spread-cell--last");
    await cell.waitFor();
    // 201 个任务 → 两发（200 + 1）。只问头一批的那种写法下，第二发根本不存在，
    // 这一格就永远停在「—」上（旧任务记了备忘却看不到）。
    await cell.getByText("旧任务上记的那条备忘").waitFor();
    const asked = api.digestBatches.flat();
    assert.ok(api.digestBatches.length >= 2, `摘要要分批问完：${api.digestBatches.map((b) => b.length)}`);
    assert.ok(asked.includes("old-tail"), "排在首批之外的那个任务也必须被问到");
    assert.ok(
      api.digestBatches.every((batch) => batch.length <= 200),
      "每一批都不许超过 TASK_BATCH_LIMIT（后端对超限是 400，不是截断）",
    );
    assert.match(await cell.textContent(), /^备忘/);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── ④ 铺开那一格：哪个新显示哪个；悬浮卡里备忘在追问下面 ──────────────────
  {
    const { page, errors } = await openPage(origin, null, "?spread=1");
    const cellOf = (id) => page.getByTestId(`row-${id}`).locator(".workspace-spread-cell--last");
    await cellOf("memo-newer").waitFor();

    assert.match(await cellOf("memo-newer").textContent(), /^备忘/, "备忘更新就显示备忘");
    assert.match(await cellOf("memo-newer").textContent(), /验收时记得查严格增长门/);
    assert.match(await cellOf("memo-newer").textContent(), /3$/, "不止一条要标出共几条");
    assert.match(await cellOf("ask-newer").textContent(), /^你说/, "追问更新就还是显示追问");
    assert.match(await cellOf("ask-newer").textContent(), /这条命令要连后端一起测/);
    assert.match(await cellOf("memo-only").textContent(), /^备忘/, "没追问过、只有备忘时显示备忘");
    assert.match(await cellOf("neither").textContent(), /还没追问过/, "两样都没有时原样说「还没追问过」");

    const peek = page.getByRole("tooltip");
    await peek.waitFor();
    const order = await peek.evaluate((node) => {
      const text = node.textContent ?? "";
      return { ask: text.indexOf("这条命令要连后端一起测"), memo: text.indexOf("验收时记得查严格增长门") };
    });
    assert.ok(order.ask >= 0 && order.memo > order.ask, `悬浮卡里备忘要排在追问下面：${JSON.stringify(order)}`);
    assert.match(await peek.textContent(), /共 3 条/, "悬浮卡要说清一共几条");
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── ⑧ 保存还没结束时切走再回来：框子仍然禁用，不许让人写出白写的第二版 ──────
  {
    const api = backend();
    const { page, errors } = await openPage(origin, api);
    await page.getByRole("tab", { name: /^备忘/ }).click();
    const panel = page.getByLabel("任务备忘");
    await page.getByRole("button", { name: "写一条备忘" }).click();
    await panel.locator("textarea").fill("第一版：验收时先过严格增长门");
    await panel.getByRole("button", { name: "保存" }).click();
    await bodyShowing(panel, "第一版：验收时先过严格增长门");

    // 改成几百字，按住回执再点保存 —— 这发 PATCH 就停在「库里改好了、回执在路上」。
    await panel.getByRole("button", { name: "编辑这条备忘" }).click();
    const first = `第一版长正文：${LONG}`;
    await panel.locator("textarea").fill(first);
    api.holdWrites = true;
    await panel.getByRole("button", { name: "保存" }).click();

    // 切到「信息」再回来。面板真的卸载过（locator 等它 detach 才算），所以这一步测的是
    // 「在途状态活得过卸载」：草稿还在，而且**还是禁用的**。禁用随卸载归零的话，用户
    // 在这儿写下的几百字会在旧那一发回来时被清掉，而且没有恢复入口（第 3 轮审查 F1）。
    await page.getByRole("tab", { name: "信息" }).click();
    await panel.waitFor({ state: "detached" });
    await page.getByRole("tab", { name: /^备忘/ }).click();
    const editor = panel.locator("textarea");
    await editor.waitFor();
    assert.equal(await editor.inputValue(), first, "切走再回来，编辑草稿还在");
    assert.equal(await editor.isDisabled(), true, "那一发保存还在飞，这个框必须还是禁用的");

    api.holdWrites = false;
    await api.releaseWrites();
    // 存上了才退出编辑态。
    await editor.waitFor({ state: "detached" });
    await bodyShowing(panel, /第一版长正文/);
    assert.equal(api.rows[0].body, first);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── ⑨ 旧保存回来，不许清掉这期间新写的那一版草稿 ──────────────────────────
  {
    const api = backend();
    const { page, errors } = await openPage(origin, api);
    await page.getByRole("tab", { name: /^备忘/ }).click();
    const panel = page.getByLabel("任务备忘");
    await page.getByRole("button", { name: "写一条备忘" }).click();
    await panel.locator("textarea").fill("第一版：验收时先过严格增长门");
    await panel.getByRole("button", { name: "保存" }).click();
    await bodyShowing(panel, "第一版：验收时先过严格增长门");

    await panel.getByRole("button", { name: "编辑这条备忘" }).click();
    await panel.locator("textarea").fill("第一版改动：先过严格增长门再看回归");
    api.holdWrites = true;
    await panel.getByRole("button", { name: "保存" }).click();

    // 这会儿从**别的入口**把草稿改掉（界面上那个框是禁用的，但 store 的写入口不止面板
    // 一处）。旧那一发回来时只许清自己提交的那一版 —— 照抄 fixture 里的 POKED。
    const poked = "第二版：绕开界面写进来的那几个字";
    await page.getByTestId("poke-draft").click();
    assert.equal(await panel.locator("textarea").inputValue(), poked);

    api.holdWrites = false;
    await api.releaseWrites();
    // 那一发收尾跑完的证据有两种形态：占位交还（框子重新可用）= 对的那种；草稿被清掉
    // （编辑框整个消失）= 回归的那种。两种都等，才能把失败报在断言上而不是等待超时。
    await page.waitForFunction(() => {
      const node = document.querySelector(".task-memo-card__edit textarea");
      return !node || !node.disabled;
    });
    const editor = panel.locator(".task-memo-card__edit textarea");
    assert.equal(await editor.count(), 1, "旧保存清掉了这期间新写的那一版，编辑态跟着没了");
    assert.equal(await editor.inputValue(), poked, "旧保存不许清掉后写的那一版");
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── ⑩ 铺开那一列：迟到的旧批量摘要不许把已经显示的新摘要顶回去 ──────────────
  {
    const api = backend();
    api.digestOf.set("old-tail", { text: "第二版：列表先读到的那条", at: "2026-10-26T02:00:00.000Z" });
    // 两个任务 → 批量一发就问完，跟写入之后只问一个任务的补发分得开。
    api.holdBulkDigests = true;
    const { page, errors } = await openPage(origin, api, "?fetch=1&n=2");
    const cell = page.getByTestId("row-old-tail").locator(".workspace-spread-cell--last");
    await cell.waitFor();
    await waitFor(() => api.heldDigests.length >= 1, "批量摘要那一发已经按在手里");

    // 写一条：store 推一版写入版本，那一列据此补发只问这个任务的摘要（不按住，照常回）。
    await page.getByTestId("write-memo").click();
    await cell.getByText("第三版：刚刚存上的那条备忘").waitFor();

    // 放行按住的那一发批量摘要：它带的是写入之前的快照。
    api.holdBulkDigests = false;
    await api.releaseDigests();
    // 再等一会儿让它真的落到 setState 上 —— 没有版本边界的话这一格就在这里倒退回第二版
    // （第 3 轮审查 N1 实测：显示第三版、旧应答一到退回第二版，而库里仍是第三版）。
    await new Promise((resolve) => setTimeout(resolve, 300));
    const text = await cell.textContent();
    assert.match(text, /第三版：刚刚存上的那条备忘/, `迟到的旧批量摘要不许顶掉新的：${text}`);
    assert.doesNotMatch(text, /第二版/, `那一格不许倒退：${text}`);
    assert.equal(api.rows[0].body, "第三版：刚刚存上的那条备忘");
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── ⑪ 同一条备忘的两发写逆序返回：晚到的旧回执不许盖掉后发那一版 ────────────
  {
    const api = backend();
    const { page, errors } = await openPage(origin, api);
    await page.getByRole("tab", { name: /^备忘/ }).click();
    const panel = page.getByLabel("任务备忘");
    await page.getByRole("button", { name: "写一条备忘" }).click();
    await panel.locator("textarea").fill("原来那一版");
    await panel.getByRole("button", { name: "保存" }).click();
    await bodyShowing(panel, "原来那一版");

    // 照抄 fixture 里的 RACE_A / RACE_B。
    const a = "先发那一发：只过严格增长门";
    const b = "后发那一发：严格增长门和回归一起过";
    api.holdWrites = true;
    await page.getByTestId("race-edits").click();
    await waitFor(() => api.heldWrites.length >= 2, "两发 PATCH 都按在手里");

    // 先放后发的那一发（它是最新的），再放先发的 —— 后者带的是旧正文。
    api.holdWrites = false;
    await api.releaseWrite(1);
    await bodyShowing(panel, b);
    const reads = () => api.requests.filter((line) => line === "GET /api/tasks/task-a/memos").length;
    const before = reads();
    const showsOld = () => panel.locator(".task-memo-card__body").filter({ hasText: a }).count();
    await api.releaseWrite(0);
    // 晚到那份一律不拿来改本地状态，改为重拉一发让后端定胜负 —— 补发的那一发出现就是
    // 走了这条分支的证据（不然「正文还是 b」在放行之前就已经成立，这用例等于没验）。
    // 回归时的形态是另一种：它直接写进本地状态，正文当场变回 a。两种都等，失败才报在
    // 断言上而不是等待超时。
    await waitFor(
      async () => reads() > before || (await showsOld()) > 0,
      "旧回执要么作废重拉、要么（回归时）把正文盖回去",
    );
    assert.ok(reads() > before, "晚到的旧回执必须作废重拉，不能直接写进本地状态");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await bodyShowing(panel, b);
    assert.equal(await showsOld(), 0, "晚到的旧回执把正文盖回了先发那一版");
    assert.equal(api.rows[0].body, b, "后端那边本来就是后发那一版");
    assert.deepEqual(errors, []);
    await page.close();
  }

  console.log("task-memo DOM regression passed");
} finally {
  await browser?.close();
  await server?.close();
}
