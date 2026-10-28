// 任务备忘 DOM 回归：真 Vite + 真 Chromium（headless）+ 真组件，API 用 `page.route` 拦下来
// 按一份内存里的清单答（见 `memosOf`）。钉住的是四件靠静态渲染摸不到的事：
//  ① 面板里的增 / 改 / 删各自真的发了什么请求，列表跟着变没变；
//  ② 几百字一条时折到几行、溢出才给「展开全文」（要量 scrollHeight，静态渲染量不到）；
//  ③ 会话里选中一段 →「添加到备忘」→ 面板**切过去**并指出刚进来的是哪条（切面板的是
//     InspectorHost，写入的是模块级 store，两边不在同一棵子树里）；
//  ④ 侧边栏铺开那一格「追问和备忘哪个新显示哪个」，以及悬浮卡里备忘排在追问正文下面。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const LONG = "几百字一条的备忘：".repeat(40);

let server;
let browser;

/** 这一页的后端：一份内存清单 + 四条端点。返回的对象能让用例直接读/改它。 */
function backend() {
  const rows = [];
  let seq = 0;
  return {
    rows,
    requests: [],
    async route(route) {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      this.requests.push(`${method} ${url.pathname}`);
      const list = /^\/api\/tasks\/([^/]+)\/memos$/.exec(url.pathname);
      const one = /^\/api\/tasks\/([^/]+)\/memos\/([^/]+)$/.exec(url.pathname);
      if (list && method === "GET") return route.fulfill({ json: rows });
      if (list && method === "POST") {
        const body = JSON.parse(request.postData() ?? "{}").body;
        const at = new Date(Date.now() + ++seq * 1000).toISOString();
        const memo = { id: `m${seq}`, taskId: list[1], body, createdAt: at, updatedAt: at };
        rows.unshift(memo);
        return route.fulfill({ status: 201, json: memo });
      }
      if (one && method === "PATCH") {
        const memo = rows.find((row) => row.id === one[2]);
        memo.body = JSON.parse(request.postData() ?? "{}").body;
        memo.updatedAt = new Date(Date.now() + ++seq * 1000).toISOString();
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
    await panel.getByText("验收时记得查严格增长门").waitFor();
    assert.equal(api.rows.length, 1, "保存要真的落到后端，不是只画在界面上");
    // 有几条要写进图标条的标题：扫一眼就知道这个任务记过东西。
    await page.getByRole("tab", { name: /^备忘（1）/ }).waitFor();

    await panel.getByRole("button", { name: "编辑这条备忘" }).click();
    await panel.locator("textarea").fill("改过的备忘");
    await panel.getByRole("button", { name: "保存" }).click();
    await panel.getByText("改过的备忘").waitFor();
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
    await panel.getByText("一句话").waitFor();
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
    await panel.getByText(/严格增长门/).waitFor();
    assert.equal(api.rows.length, 1, "选文那条要真的存下来");
    await panel.locator(".task-memo-card.is-new").waitFor();
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

  console.log("task-memo DOM regression passed");
} finally {
  await browser?.close();
  await server?.close();
}
