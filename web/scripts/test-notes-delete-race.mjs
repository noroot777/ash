import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

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
const root = fileURLToPath(new URL("..", import.meta.url));

// DELETE 比 PATCH 先发、后回：正是「保存回包迟到」那个顺序。
const DELETE_DELAY_MS = 1400;
const PATCH_DELAY_MS = 1600;

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

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
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
  const rows = new Map([
    ["note-a", note("note-a", "第一条随手记", 1756000002000)],
    ["note-b", note("note-b", "第二条随手记", 1756000001000)],
  ]);
  const requests = [];
  const started = Date.now();
  const at = () => Date.now() - started;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
      await sleep(PATCH_DELAY_MS);
      await reply(snapshot);
      return;
    }
    if (single && request.method() === "DELETE") {
      requests.push({ method: "DELETE", id: single[1], sentAt: at() });
      await sleep(DELETE_DELAY_MS);
      rows.delete(single[1]);
      await reply({ deleted: true });
      return;
    }
    if (path === "/api/notes" && request.method() === "GET") {
      await reply([...rows.values()]);
      return;
    }
    await reply([]);
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/notes-panel.html`);

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

  await page.getByText("提示：随手记已删除").waitFor({ timeout: 8000 });
  // 等过「自动保存重新计时 + PATCH 迟到回包」那整段窗口，复活要发生就在这里面发生。
  await page.waitForTimeout(PATCH_DELAY_MS + 1200);

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
  // 确认框开着就是不许存（这一条两种实现下都该成立；万一这里红了，说明下面那条断言的
  // 时序前提没站住，而不是悄悄放过）。
  await page.waitForTimeout(1200);
  assert.equal(requests.length, beforeCancel, `确认框开着的时候不许发请求：${JSON.stringify(requests.slice(beforeCancel))}`);
  await dialog.locator("footer button:not(.is-danger)").first().click();
  await dialog.waitFor({ state: "detached" });

  for (let i = 0; i < 60 && requests.length === beforeCancel; i++) await page.waitForTimeout(100);
  assert.deepEqual(
    requests.slice(beforeCancel).map((entry) => ({ method: entry.method, id: entry.id, body: entry.body?.body })),
    [{ method: "PATCH", id: "note-b", body: RESUMED }],
    `取消删除之后那次自动保存必须补上：${JSON.stringify(requests.slice(beforeCancel))}`,
  );
  assert.equal(rows.get("note-b").body, RESUMED, "服务端那份要真的存上");

  console.log("notes panel delete-race test passed");
} finally {
  await browser?.close();
  await server.close();
}
