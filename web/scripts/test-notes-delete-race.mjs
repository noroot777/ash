import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { fetchLog, fetchesSettled, outlastPageTimers, settlePage, trackFetches, waitUntil } from "./wait-until.mjs";

// 删除不再先落盘（「存不下去就不许删」是删除按钮点不动的来由），代价是点确认的那一刻
// 草稿可能还脏着：确认框一关，800ms 自动保存就重新计时，于是一次 PATCH 和 DELETE 并排
// 跑。迟到的 PATCH 回包会把刚删掉的那条又塞回 rows —— 用户先看到「随手记已删除」，接着
// 它自己冒回列表，而服务端其实已经没有它了（审查第 1 轮发现 2）。
//
// 这条钉住：删除期间一条保存都不许发（判据在落盘函数自己身上，覆盖自动保存 / ⌘+回车 /
// 保存按钮 / 各出口 / 卸载清理这五条来路），而且删掉的那条不许复活、也不许顺手把刚切
// 过去的那条白存一遍。
//
// 还钉住另一半：**那道闸关上之后得有人把它重新打开**。删除确认框开着的时候自动保存被挡
// 掉，用户若取消确认（或删除失败），草稿还脏着却再没人排下一次定时器 —— 它就一直停在
// 「等待自动保存」，不手动点一下永远不落盘（第 2 轮审查的非阻塞项）。
// DELETE 比 PATCH 先发、后回：正是「保存回包迟到」那个顺序。这个顺序靠扣住造，不靠延时
// 赌：DELETE 扣在路上，直到测试确认 800ms 自动保存那一档已经过去（并排的 PATCH 要发就已经
// 发了）才放行；PATCH（如果有）扣到 DELETE 回完之后才回。
const AUTOSAVE_MS = 800;

const web = await startWebServer();

const note = (id, body, updatedAt) => ({
  id,
  projectId: "p1",
  body,
  attachments: [],
  taskLinks: [],
  createdAt: 1756000000000,
  updatedAt,
});

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
  const rows = new Map([
    ["note-a", note("note-a", "第一条随手记", 1756000002000)],
    ["note-b", note("note-b", "第二条随手记", 1756000001000)],
  ]);
  const requests = [];
  const started = Date.now();
  const at = () => Date.now() - started;
  const deleteArrived = Promise.withResolvers();
  const releaseDelete = Promise.withResolvers();
  const deleteReplied = Promise.withResolvers();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (body, status = 200) => route
      .fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
      .catch(() => {});
    const single = /^\/api\/notes\/([^/]+)$/.exec(path);
    if (single && request.method() === "PATCH") {
      const body = JSON.parse(request.postData() ?? "{}");
      requests.push({ method: "PATCH", id: single[1], body, sentAt: at() });
      // 请求进来就按下处理、把回包内容定下来，之后才慢慢回 —— 模拟「服务端已经处理完，
      // 只是回包在路上」。这是迟到回包能复活记录的前提。
      const snapshot = { ...rows.get(single[1]), ...body, updatedAt: 1756000009000 };
      if (rows.has(single[1])) rows.set(single[1], snapshot);
      await deleteReplied.promise;
      await reply(snapshot);
      return;
    }
    if (single && request.method() === "DELETE") {
      requests.push({ method: "DELETE", id: single[1], sentAt: at() });
      deleteArrived.resolve();
      await releaseDelete.promise;
      rows.delete(single[1]);
      await reply({ deleted: true });
      deleteReplied.resolve();
      return;
    }
    if (path === "/api/notes" && request.method() === "GET") {
      await reply([...rows.values()]);
      return;
    }
    await reply([]);
  });
  // 页面这一侧记下每一发单条读写：「一条都没发」以页面调没调 fetch 为准，「迟到回包有没有
  // 复活」以回包被页面消费完为准。
  await trackFetches(page, "/api/notes/");
  await page.goto(`${web.origin}/scripts/fixtures/notes-panel.html`);
  const pageWrites = async () => (await fetchLog(page)).map((entry) => `${entry.method} ${new URL(entry.url, web.origin).pathname}`);

  const row = (title) => page.getByRole("button", { name: new RegExp(title) });
  const editor = page.locator(".note-editor textarea");

  // 改一条、**不等自动保存**就立刻删掉它：确认的那一刻草稿是脏的。
  await row("第一条随手记").waitFor();
  await page.locator(".note-editor-preview").click();
  await editor.waitFor();
  await editor.fill("准备删除的改动内容");
  await page.locator(".notes-footer-actions button", { hasText: "删除" }).click();
  const dialog = page.locator(".task-confirm-dialog");
  await dialog.waitFor();
  await dialog.locator("footer button.is-danger").click();

  // DELETE 在路上的时候，确认框关掉后重新计时的那一档自动保存必须已经走完：页面里排一个
  // 比它晚到期的定时器等它触发，并排的 PATCH 要发就已经调过 fetch 了。然后才放 DELETE 回去。
  await waitUntil(() => requests.some((entry) => entry.method === "DELETE"), "DELETE 到达路由桩");
  await deleteArrived.promise;
  await outlastPageTimers(page, AUTOSAVE_MS + 200);
  releaseDelete.resolve();
  await page.getByText("提示：随手记已删除").waitFor();
  // 复活要发生就发生在「删除落地之后又排的自动保存」或「并排 PATCH 的迟到回包」里：再等过
  // 一档自动保存，然后等页面上每一发读写都被消费完（迟到的 PATCH 回包被读完），冲刷后再看。
  await outlastPageTimers(page, AUTOSAVE_MS + 200);
  await fetchesSettled(page, 1, "删除那一发（以及并排的保存，如果发了）都被页面消费完");
  await settlePage(page);
  assert.deepEqual(await pageWrites(), ["DELETE /api/notes/note-a"], "页面上只该发过这一次删除，一条保存都不该有");

  const deletes = requests.filter((entry) => entry.method === "DELETE");
  assert.deepEqual(deletes.map((entry) => entry.id), ["note-a"], "删除必须真的发出去，且只发一次");
  assert.deepEqual(
    requests.filter((entry) => entry.method === "PATCH"),
    [],
    `删除期间一条保存都不该发：${JSON.stringify(requests)}`,
  );

  const titles = await page.locator(".note-row").allInnerTexts();
  assert.equal(
    titles.filter((text) => text.includes("准备删除的改动内容")).length,
    0,
    `提示过「已删除」之后那条不许再冒回列表：${JSON.stringify(titles)}`,
  );
  assert.equal(titles.length, 1, `服务端只剩一条，界面也该只有一条：${JSON.stringify(titles)}`);
  assert.deepEqual([...rows.keys()], ["note-b"], "服务端样例里只该剩第二条");

  // 迟到回包也不许把「已存内容」的基准写成别人的，否则刚切过去的这条会被凭空判成有改动、
  // 白存一遍。界面上的说法同样得是「已保存」而不是「等待自动保存」。
  await page.locator(".note-row.is-selected", { hasText: "第二条随手记" }).waitFor();
  assert.match(await page.locator(".notes-panel footer span").first().innerText(), /已自动保存/, "切过去的那条不该被判成有改动");

  // 取消删除之后，脏草稿得自己接着存上 —— 准入（落盘函数那道闸）和调度（自动保存定时器）
  // 必须成对恢复。
  await page.locator(".note-editor-preview").click();
  await editor.waitFor();
  const RESUMED = "取消删除之后应当继续自动保存";
  await editor.fill(RESUMED);
  await page.locator(".notes-footer-actions button", { hasText: "删除" }).click();
  await dialog.waitFor();
  const beforeCancel = requests.length;
  const pageBeforeCancel = (await pageWrites()).length;
  // 确认框开着就是不许存（这一条两种实现下都该成立；万一这里红了，说明下面那条断言的
  // 时序前提没站住，而不是悄悄放过）。fill 时排上的那一档自动保存比这个页面定时器先到期，
  // 它要发 PATCH 就已经发了。
  await outlastPageTimers(page, AUTOSAVE_MS + 200);
  assert.deepEqual((await pageWrites()).slice(pageBeforeCancel), [], "确认框开着的时候页面不许发请求");
  assert.equal(requests.length, beforeCancel, `确认框开着的时候不许发请求：${JSON.stringify(requests.slice(beforeCancel))}`);
  await dialog.locator("footer button:not(.is-danger)").first().click();
  await dialog.waitFor({ state: "detached" });

  await waitUntil(() => requests.length > beforeCancel, "取消删除之后那次自动保存到达路由桩");
  assert.deepEqual(
    requests.slice(beforeCancel).map((entry) => ({ method: entry.method, id: entry.id, body: entry.body?.body })),
    [{ method: "PATCH", id: "note-b", body: RESUMED }],
    `取消删除之后那次自动保存必须补上：${JSON.stringify(requests.slice(beforeCancel))}`,
  );
  assert.equal(rows.get("note-b").body, RESUMED, "服务端那份要真的存上");

  console.log("notes panel delete-race test passed");
} finally {
  await browser?.close();
  await web.close();
}
