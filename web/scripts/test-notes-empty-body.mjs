import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 「写几个字 → 全删掉 → 点下面的删除」曾经把整个面板焊死：删除按钮点不动、Esc 也关不掉、
// 换不到别的随手记。根因是落盘函数把「正文空，服务端不收」和「保存真失败」压成同一个
// false，而面板里每个「要离开这条草稿」的动作都拿它当放行条件。这条钉住：
// ① 清空正文不会往服务端发空正文的 PATCH（服务端 400，发了也白发）；
// ② 清空之后换一条 / 关面板都走得通，服务端那份原文一个字不动；
// ③ 清空之后删除按钮照旧开确认框，确认后真的发 DELETE；
// ④ 非空的改动仍然挡在「离开」前面先落盘 —— 这一条别连坐修掉；
// ⑤ 「正文空」不等于「草稿里没有要紧东西」：清空正文之后传的附件必须单独落盘，
//    否则离开一次就只剩 uploads 里一个没人认领的文件（审查第 1 轮发现 1）。
const root = fileURLToPath(new URL("..", import.meta.url));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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
  const patched = [];
  const deleted = [];
  const uploaded = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (body, status = 200) => route
      .fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
      .catch(() => {});
    const single = /^\/api\/notes\/([^/]+)$/.exec(path);
    if (single && request.method() === "PATCH") {
      const body = JSON.parse(request.postData() ?? "{}");
      patched.push({ id: single[1], ...body });
      // 跟 server/src/notes.ts 一个口径：空正文一律 400，别让夹具比真服务端宽松。
      if (typeof body.body === "string" && !body.body.trim()) {
        await reply({ error: "body required" }, 400);
        return;
      }
      const saved = { ...rows.get(single[1]), ...body, updatedAt: 1756000009000 };
      rows.set(single[1], saved);
      await reply(saved);
      return;
    }
    if (single && request.method() === "DELETE") {
      deleted.push(single[1]);
      rows.delete(single[1]);
      await reply({ deleted: true });
      return;
    }
    if (path === "/api/notes" && request.method() === "GET") {
      await reply([...rows.values()]);
      return;
    }
    if (path === "/api/uploads" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      const name = typeof body.name === "string" ? body.name : "pasted.png";
      uploaded.push(name);
      await reply({ id: `up-${name}`, path: `/tmp/uploads/${name}`, url: `data:image/png;base64,${PNG}`, name, kind: "image" });
      return;
    }
    await reply([]);
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/notes-panel.html`);

  const selectedRow = page.locator(".note-row.is-selected");
  const status = page.locator(".notes-panel footer span").first();
  const log = page.locator("[data-testid='log']");
  const editor = page.locator(".note-editor textarea");
  const row = (title) => page.getByRole("button", { name: new RegExp(title) });
  const typeBody = async (text) => {
    await page.locator(".note-editor-preview").click();
    await editor.waitFor();
    await editor.fill(text);
  };
  // 自动保存的防抖是 800ms，等过那一档才能断言「它没发请求」而不是「它还没发」。
  const pastAutosave = () => page.waitForTimeout(1100);
  const pastePng = async (name) => {
    await page.locator(".note-editor-preview, .note-editor textarea").first().click();
    await editor.waitFor();
    await editor.evaluate((textarea, { name, png }) => {
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: "image/png" }));
      textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, { name, png: PNG });
    for (let i = 0; i < 100 && !uploaded.includes(name); i++) await page.waitForTimeout(50);
  };

  // ① 清空一条已存在的随手记：不往服务端发空正文，状态栏说清为什么没存。
  await row("第一条随手记").waitFor();
  await typeBody("");
  await pastAutosave();
  assert.equal(patched.length, 0, "空正文不该发 PATCH，服务端只会回 400");
  assert.match(await status.innerText(), /不能为空/, "状态栏要说清这条为什么没存上");

  // ② 清空之后还换得走，而且换走之后原文还在（清空没落盘，服务端那份没动）。
  await row("第二条随手记").click();
  await page.locator(".note-row.is-selected", { hasText: "第二条随手记" }).waitFor();
  assert.match(await log.innerText(), /不能为空/, "得告诉用户这次清空没保存");
  assert.equal(await row("第一条随手记").count(), 1, "原内容必须保留");

  // ③ 非空改动照旧先落盘再离开 —— 别为了治「空正文卡死」把这道保护一起拆了。
  await row("第一条随手记").click();
  await typeBody("第一条随手记（改过）");
  await row("第二条随手记").click();
  for (let i = 0; i < 60 && !patched.length; i++) await page.waitForTimeout(50);
  assert.deepEqual(
    patched.at(-1),
    { id: "note-a", body: "第一条随手记（改过）", attachments: [] },
    "非空改动必须在切走之前存下来",
  );

  // ④ 清空正文之后点删除：确认框照旧开得出来，标题读的是服务端那份原文。
  await row("第一条随手记（改过）").click();
  await typeBody("");
  await pastAutosave();
  await page.locator(".notes-footer-actions button", { hasText: "删除" }).click();
  const dialog = page.locator(".task-confirm-dialog");
  await dialog.waitFor({ timeout: 4000 });
  assert.match(await dialog.innerText(), /第一条随手记（改过）/, "确认框该认服务端那份标题");

  // ⑤ 确认之后真的删掉，用户看得到结果。
  await dialog.locator("footer button.is-danger").click();
  await page.getByText("提示：随手记已删除").waitFor({ timeout: 4000 });
  assert.deepEqual(deleted, ["note-a"], "确认之后必须真的发 DELETE");
  assert.equal(await row("第一条随手记（改过）").count(), 0, "删掉的那条要从列表里走掉");

  // ⑥ 清空正文之后传的附件：正文存不下去，不代表附件关联也该跟着丢。服务端的 PATCH
  //    不带 body 时跳过空正文校验，所以附件那半边必须单独存上去。
  await page.locator(".note-row.is-selected", { hasText: "第二条随手记" }).waitFor();
  await typeBody("");
  await pastePng("note-b-shot.png");
  for (let i = 0; i < 120 && !patched.some((entry) => entry.id === "note-b"); i++) await page.waitForTimeout(50);
  assert.deepEqual(
    patched.filter((entry) => entry.id === "note-b").at(-1),
    { id: "note-b", attachments: ["/tmp/uploads/note-b-shot.png"] },
    "空正文时只存附件、不带 body（带了会被服务端 400 挡掉）",
  );
  assert.deepEqual(rows.get("note-b").attachments, ["/tmp/uploads/note-b-shot.png"], "服务端那份要真的挂上这个附件");

  // 离开再回来：附件还在，正文回到服务端那份原文。
  await page.locator(".notes-list-tools button[aria-label='新建随手记']").click();
  await row("第二条随手记").click();
  await page.locator(".note-attachments").getByText("note-b-shot.png", { exact: true }).waitFor({ timeout: 4000 });

  // ⑦ 清空正文之后 Esc 也关得掉 —— 面板不是一按清空就焊死的笼子。
  await typeBody("");
  await pastAutosave();
  await page.keyboard.press("Escape");
  await page.getByText("面板已关闭").waitFor({ timeout: 4000 });
  assert.equal(await page.locator(".notes-panel").count(), 0, "清空正文之后必须关得掉面板");

  assert.ok(
    patched.every((entry) => typeof entry.body !== "string" || entry.body.trim()),
    `整轮下来一条空正文的 PATCH 都不该有：${JSON.stringify(patched)}`,
  );

  console.log("notes panel empty-body test passed");
} finally {
  await browser?.close();
  await server.close();
}
