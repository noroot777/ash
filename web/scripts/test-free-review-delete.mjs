import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 派审对话框里删审查者。每一段一张干净页面：
//
// ① 基本面：每一行都有自己的删除入口（按钮不能套按钮，所以行是 div + 两颗按钮），点它只
//    开确认框，不会顺手把这一行选中，也不会把外面那层派审对话框一起关掉；取消不发请求；
//    删掉的是**全局配置**，确认框要说清它会从所有任务的列表里消失；删到本任务已经预约的
//    那位时点名「本任务」；删掉选中项下一位顶上；删光了摊开新建表单。
// ② 草稿面：删掉被预约引用的审查者会让服务端撤掉预约、任务状态跟着变。那不等于「用户重新
//    打开了对话框」—— 正在写的审查者 / 检查类型 / 轮数 / 附言一个都不许被远端刷新打回。
// ③ 失败面：DELETE 报错后确认框留着，再点一次要真的重试；两个框都不许因此消失。
// ④ 就绪面：任务状态还没到就**不开放编辑**（摆加载态、没有可填的表单、提交按钮灰着）。
//    否则在空表单上写的东西，等状态到了会被那一次初始化整套盖掉。
// ⑤ 同步面：别的页面删掉了本页选中的那位 —— 任务状态一变，本页要重读权威清单、让失效的
//    选中项回退并说一声，而不是继续摆着一个点下去才报「审查者不存在」的配置；与此同时
//    用户正在填的附言一个字都不能动。
// ⑥ 乱序面：同步那次读取被按在半空，期间本页删掉一位；放行后旧清单不许把它贴回来。
// ⑦ 换任务面：对话框开着的时候任务被换掉（后退 / 切任务，容器不重建组件），草稿必须整套
//    重来，提交发出去的必须是**新任务**自己的内容，不能把写给 A 的附言保存到 B 身上。
// ⑧ 焦点面：删掉选中项之后，焦点要留在对话框里，不能掉到 body 上。

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const AGENTS = [{
  id: "codex-local",
  name: "codex@local",
  type: "codex",
  target: { kind: "local" },
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  isDefault: true,
}];

const reviewer = (id, name) => ({
  id,
  name,
  agentType: "codex",
  executorId: "codex-local",
  executorLabel: "codex@local",
  model: null,
  reasoningEffort: "high",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const initialReviewers = () => [reviewer("reviewer-1", "顶级审查"), reviewer("reviewer-2", "opus5"), reviewer("reviewer-3", "grok4.6")];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  const base = `http://127.0.0.1:${address.port}/scripts/fixtures/free-review-delete.html`;

  browser = await chromium.launch(await chromeLaunchOptions());

  // 一个独立页面 + 一份独立的「服务端」内存清单。onList / onDelete 返回 true 表示它已经
  // 自己 fulfill 了这一次请求（用来演慢响应和 503）。
  const open = async ({ query = "", onList, onDelete } = {}) => {
    const page = await browser.newPage({ viewport: { width: 1080, height: 820 } });
    const store = { reviewers: initialReviewers(), deleted: [], dispatched: [], listCalls: 0, deleteCalls: 0 };
    await page.route("**/api/llm-providers", (route) => json(route, []));
    await page.route("**/api/agents", (route) => json(route, AGENTS));
    await page.route("**/api/reviewer-profiles*", async (route) => {
      store.listCalls += 1;
      if (await onList?.(store, route)) return;
      return json(route, store.reviewers);
    });
    await page.route("**/free-workflow/review", async (route) => {
      store.dispatched.push({
        taskId: new URL(route.request().url()).pathname.split("/").at(-3),
        body: JSON.parse(route.request().postData() ?? "{}"),
      });
      return json(route, { ok: true }, 200);
    });
    await page.route("**/api/reviewer-profiles/*", async (route) => {
      if (route.request().method() !== "DELETE") return json(route, { error: "unhandled" }, 404);
      store.deleteCalls += 1;
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      if (await onDelete?.(store, route, id)) return;
      store.deleted.push(id);
      store.reviewers = store.reviewers.filter((item) => item.id !== id);
      return json(route, { deleted: true });
    });
    await page.goto(`${base}${query}`);
    const dialog = page.locator(".free-review-dialog");
    const confirm = page.locator(".task-confirm-dialog");
    await dialog.waitFor();
    if (!query) await page.locator(".free-review-reviewer-row").first().waitFor();
    return {
      page,
      store,
      dialog,
      confirm,
      row: (name) => page.locator(".free-review-reviewer-row").filter({ hasText: name }),
      trash: (name) => page.getByRole("button", { name: `删除审查者「${name}」` }),
      confirmDelete: () => confirm.getByRole("button", { name: "删除", exact: true }),
      selectedName: () => dialog.locator(".free-review-reviewer-pick[aria-selected='true'] b").innerText(),
      submit: () => dialog.locator("footer button[type='submit']"),
      note: () => dialog.locator(".free-review-note textarea"),
    };
  };

  // ── ① 基本面 ──────────────────────────────────────────────────────────
  {
    const ui = await open();
    const { page, store, dialog, confirm } = ui;
    assert.equal(await page.locator(".free-review-reviewer-row").count(), 3);
    assert.equal(await ui.selectedName(), "opus5", "进来时应当选中状态里记着的那位");

    // 行尾那颗按钮平时收着，扫到这一行才露出；它不占选中那一下。
    assert.equal(
      await ui.trash("顶级审查").evaluate((element) => getComputedStyle(element).opacity),
      "0",
      "不悬停时删除按钮应当是收着的",
    );
    await ui.row("顶级审查").hover();
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector("[aria-label='删除审查者「顶级审查」']")).opacity === "1",
      null,
      { timeout: 2000 },
    );
    await page.screenshot({ path: "/tmp/ash-free-review-rows.png", fullPage: true });

    // 取消不删；文案说清这是全局配置。
    await ui.trash("顶级审查").click();
    await confirm.waitFor();
    await page.waitForTimeout(320);
    await page.screenshot({ path: "/tmp/ash-free-review-delete-confirm.png", fullPage: true });
    const otherText = await confirm.innerText();
    assert.match(otherText, /确定删除“顶级审查”/);
    assert.match(otherText, /会从所有任务的审查者列表里消失/);
    assert.match(otherText, /历史审查记录仍保留当时的配置快照/);
    assert.match(otherText, /「完成后自动审查」预约会被取消/, "删一份全局配置，别的任务挂着的预约也会断，得说");
    assert.doesNotMatch(otherText, /本任务/, "删的不是本任务预约的那位，别冤枉本任务");
    assert.equal(await ui.selectedName(), "opus5", "点删除不该顺手改选中项");
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    assert.deepEqual(store.deleted, [], "取消不该发出删除请求");
    assert.equal(await dialog.count(), 1, "关掉确认框不该把派审对话框一起带走");

    // 删本任务已经预约的那位：多说一句预约会断。
    await ui.row("opus5").hover();
    await ui.trash("opus5").click();
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /本任务已排上的审查预约会一并取消/);
    await ui.confirmDelete().click();
    await confirm.waitFor({ state: "detached" });
    assert.deepEqual(store.deleted, ["reviewer-2"]);
    await ui.row("opus5").waitFor({ state: "detached" });
    assert.match(await page.getByTestId("notices").innerText(), /已删除审查者「opus5」/);

    // 删掉的是选中那位：下一位顶上，提交按钮不许因此灰掉。
    const submit = dialog.locator("footer button[type='submit']");
    assert.equal(await ui.selectedName(), "顶级审查", "删掉选中项后应当自动选上剩下的第一位");
    assert.equal(await submit.isDisabled(), false);
    assert.match(await dialog.locator(".free-review-run-override").innerText(), /顶级审查|codex@local/);

    // 删到一个不剩：新建表单摊开，别留空列表 + 灰按钮的死角。
    for (const name of ["顶级审查", "grok4.6"]) {
      await ui.row(name).hover();
      await ui.trash(name).click();
      await confirm.waitFor();
      await ui.confirmDelete().click();
      await confirm.waitFor({ state: "detached" });
    }
    assert.deepEqual(store.deleted, ["reviewer-2", "reviewer-1", "reviewer-3"]);
    assert.equal(await page.locator(".free-review-reviewer-row").count(), 0);
    await dialog.locator(".free-review-create").waitFor();
    assert.equal(await submit.isDisabled(), true, "一个审查者都没有时不该还能点开始审查");
    assert.equal(await page.getByTestId("closed").count(), 0, "整个过程里派审对话框都不该被关掉");
    await page.screenshot({ path: "/tmp/ash-free-review-delete.png", fullPage: true });
    await page.close();
  }

  // ── ② 草稿面：删掉被预约引用的那位 → 服务端撤预约 → 正在填的东西一个都不许丢 ────
  {
    const ui = await open();
    const { page, dialog, confirm } = ui;
    const note = "删掉别的审查者不该清掉我刚写的附言";
    await dialog.locator(".free-review-options select").selectOption("syntax");
    await dialog.locator(".free-review-retry-field input").fill("7");
    await dialog.locator(".free-review-note textarea").fill(note);
    await ui.row("grok4.6").locator(".free-review-reviewer-pick").click();
    assert.equal(await ui.selectedName(), "grok4.6");

    await ui.row("opus5").hover();
    await ui.trash("opus5").click();
    await confirm.waitFor();
    await ui.confirmDelete().click();
    await confirm.waitFor({ state: "detached" });
    await ui.row("opus5").waitFor({ state: "detached" });
    // 生产里这一步由 task.review 事件 → 重读状态完成：预约被撤、选中项被清空。
    await page.evaluate(() => window.freeReviewFixture.cancelReservation());
    await page.waitForTimeout(150);

    assert.equal(await ui.selectedName(), "grok4.6", "远端撤预约不该把我刚选的审查者换掉");
    assert.equal(await dialog.locator(".free-review-options select").inputValue(), "syntax");
    assert.equal(await dialog.locator(".free-review-retry-field input").inputValue(), "7");
    assert.equal(await dialog.locator(".free-review-note textarea").inputValue(), note);
    await page.close();
  }

  // ── ③ 失败面：DELETE 报错后确认框留着，再点一次要真的重试 ─────────────────────
  {
    const ui = await open({
      onDelete: async (store, route) => {
        if (store.deleteCalls > 1) return false;
        await json(route, { error: "模拟删除失败：请重试" }, 503);
        return true;
      },
    });
    const { page, store, dialog, confirm } = ui;
    await ui.row("顶级审查").hover();
    await ui.trash("顶级审查").click();
    await confirm.waitFor();
    await ui.confirmDelete().click();
    await page.getByText("模拟删除失败：请重试").waitFor();
    assert.equal(await confirm.count(), 1, "删除失败后确认框应当留着让人重试");
    assert.equal(await dialog.count(), 1, "删除失败不该把派审对话框关掉");
    assert.equal(store.deleteCalls, 1);

    await ui.confirmDelete().click();
    await confirm.waitFor({ state: "detached" });
    assert.equal(store.deleteCalls, 2, "第二次点「删除」必须真的再发一次请求");
    assert.deepEqual(store.deleted, ["reviewer-1"]);
    assert.equal(await dialog.count(), 1, "重试成功后派审对话框仍要开着");
    assert.equal(await page.getByTestId("closed").count(), 0);
    await ui.row("顶级审查").waitFor({ state: "detached" });
    await page.close();
  }

  // ── ④ 就绪面：任务状态还没到就不开放编辑 ─────────────────────────────────
  {
    const ui = await open({ query: "?state=late" });
    const { page, dialog } = ui;
    await dialog.locator(".free-review-loading").waitFor();
    assert.match(await dialog.locator(".free-review-loading").innerText(), /正在读取任务状态/);
    assert.equal(await page.locator(".free-review-reviewer-row").count(), 0);
    assert.equal(await ui.note().count(), 0, "状态没到就不该给出可填的表单");
    assert.equal(await ui.submit().isDisabled(), true);

    await page.evaluate(() => window.freeReviewFixture.arrive());
    await page.locator(".free-review-reviewer-row").first().waitFor();
    assert.equal(await ui.selectedName(), "opus5", "状态到了之后要按这项任务的预约初始化");
    assert.equal(await ui.submit().isDisabled(), false);
    await page.close();
  }

  // ── ⑤ 同步面：别处删掉了本页选中的那位 ───────────────────────────────────
  {
    const ui = await open();
    const { page, store, dialog } = ui;
    const note = "清单同步不该把我正在写的附言碰掉";
    await ui.note().fill(note);
    // 另一个页面在设置页里把 opus5 删了；服务端随后清引用、撤预约并发 task.review。
    store.reviewers = store.reviewers.filter((item) => item.id !== "reviewer-2");
    await page.evaluate(() => window.freeReviewFixture.cancelReservation());

    await ui.row("opus5").waitFor({ state: "detached" });
    assert.equal(await ui.selectedName(), "顶级审查", "选中的那位没了，要替用户回退到还在的那位");
    assert.match(await page.getByTestId("notices").innerText(), /原先选中的审查者已被删除，已替你改选「顶级审查」/);
    assert.equal(await ui.note().inputValue(), note, "清单同步不许动用户正在填的东西");
    assert.equal(await ui.submit().isDisabled(), false);
    await page.close();
  }

  // ── ⑥ 乱序面：删除之前发出的那份清单回来了，不能把删掉的那位贴回去 ──────────────
  {
    let release;
    // 下一次读清单按在半空等这里放行，而且回的是**此刻**（删除之前）的那份清单。
    const gate = { hold: false, held: new Promise((resolve) => { release = resolve; }) };
    const ui = await open({
      onList: async (store, route) => {
        if (!gate.hold) return false;
        gate.hold = false;
        const stale = store.reviewers.map((item) => ({ ...item }));
        await gate.held;
        await json(route, stale);
        return true;
      },
    });
    const { page, store, confirm } = ui;
    assert.equal(await page.locator(".free-review-reviewer-row").count(), 3);

    gate.hold = true;
    await page.evaluate(() => window.freeReviewFixture.bumpState());
    await ui.row("顶级审查").hover();
    await ui.trash("顶级审查").click();
    await confirm.waitFor();
    await ui.confirmDelete().click();
    await confirm.waitFor({ state: "detached" });
    await ui.row("顶级审查").waitFor({ state: "detached" });

    release();
    await page.waitForTimeout(500);
    assert.equal(await ui.row("顶级审查").count(), 0, "删除之前发出的清单回来了，不能把删掉的那位贴回去");
    assert.deepEqual(store.reviewers.map((item) => item.name), ["opus5", "grok4.6"]);
    assert.equal(await page.locator(".free-review-reviewer-row").count(), 2);
    await page.close();
  }

  // ── ⑦ 换任务面：草稿属于「这个任务的这一次打开」 ────────────────────────────
  {
    const gate = { slow: false };
    const ui = await open({
      onList: async (store, route) => {
        if (!gate.slow) return false;
        await sleep(400);
        await json(route, store.reviewers);
        return true;
      },
    });
    const { page, store, dialog } = ui;
    await ui.note().fill("只给任务 A 的附言，不能发给任务 B");

    gate.slow = true;
    await page.evaluate(() => window.freeReviewFixture.switchTask());
    await page.getByTestId("current-task").getByText("task-b").waitFor();
    // 换任务那一瞬：旧草稿已经不属于当前任务，表单先收起来，提交按钮灰着。
    assert.equal(await ui.note().count(), 0, "任务换了，不能继续摆着上一个任务的草稿");
    assert.equal(await ui.submit().isDisabled(), true);

    await page.locator(".free-review-reviewer-row").first().waitFor();
    assert.equal(await ui.note().inputValue(), "任务 B 自己的附言", "要按新任务自己的预约重新初始化");
    assert.equal(await ui.selectedName(), "grok4.6");
    assert.equal(await dialog.locator(".free-review-options select").inputValue(), "syntax");
    assert.equal(await dialog.locator(".free-review-retry-field input").inputValue(), "3");

    await ui.submit().click();
    await page.waitForFunction(() => true);
    await page.waitForTimeout(200);
    assert.deepEqual(store.dispatched.map((item) => [item.taskId, item.body.note]), [["task-b", "任务 B 自己的附言"]]);
    await page.close();
  }

  // ── ⑧ 焦点面：删掉选中项之后焦点要留在对话框里 ────────────────────────────────
  {
    const ui = await open();
    const { page, confirm } = ui;
    await ui.row("opus5").hover();
    await ui.trash("opus5").click();
    await confirm.waitFor();
    await ui.confirmDelete().click();
    await confirm.waitFor({ state: "detached" });
    await ui.row("opus5").waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(() => !!document.querySelector(".free-review-dialog")?.contains(document.activeElement)),
      true,
      "删掉选中项后焦点不能掉到 body 上，键盘得还能接着用",
    );
    await page.close();
  }

  console.log("test-free-review-delete: OK");
} finally {
  await browser?.close();
  await server.close();
}
