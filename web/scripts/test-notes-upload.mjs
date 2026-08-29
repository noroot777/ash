import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

// 随手记里粘的图是「传完之后由 effect 折进当前草稿」的，所以上传没落地就切走/关掉，
// 结果要么没人接住（附件白传），要么落到刚切过去的那条头上。这条钉住：这些动作一律
// 排在上传落地之后，而且落地后接着跑，用户不用自己再点一次。
const root = fileURLToPath(new URL("..", import.meta.url));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const note = (id, body) => ({
  id,
  projectId: "p1",
  body,
  attachments: [],
  taskLinks: [],
  createdAt: 1756000000000,
  updatedAt: id === "note-a" ? 1756000002000 : 1756000001000,
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const rows = new Map([["note-a", note("note-a", "第一条随手记")], ["note-b", note("note-b", "第二条随手记")]]);
  const patched = [];
  const held = new Map();
  const release = async (name) => {
    for (let i = 0; i < 100 && !held.has(name); i++) await page.waitForTimeout(50);
    held.get(name)?.();
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
    if (path === "/api/uploads" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      const name = typeof body.name === "string" ? body.name : "pasted.png";
      await new Promise((resolve) => held.set(name, resolve));
      await reply({ id: `up-${name}`, path: `/tmp/uploads/${name}`, url: `data:image/png;base64,${PNG}`, name, kind: "image" });
      return;
    }
    const patch = /^\/api\/notes\/([^/]+)$/.exec(path);
    if (patch && request.method() === "PATCH") {
      const body = JSON.parse(request.postData() ?? "{}");
      patched.push({ id: patch[1], ...body });
      const saved = { ...rows.get(patch[1]), ...body, updatedAt: 1756000009000 };
      rows.set(patch[1], saved);
      await reply(saved);
      return;
    }
    if (path === "/api/notes" && request.method() === "GET") {
      await reply([...rows.values()]);
      return;
    }
    await reply([]);
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/notes-upload.html`);

  const pasteInto = async (name) => {
    await page.locator(".note-editor-preview").click();
    const editor = page.locator(".note-editor textarea");
    await editor.waitFor();
    await editor.evaluate((textarea, { name, png }) => {
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: "image/png" }));
      textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, { name, png: PNG });
    await page.getByText(name, { exact: true }).waitFor();
  };

  // ① 在第一条里粘图，没传完就去点第二条：不许切走，否则这张图会落到第二条头上。
  const selectedRow = page.locator(".note-row.is-selected");
  await page.getByRole("button", { name: /第一条随手记/ }).waitFor();
  await pasteInto("note-a-shot.png");
  await page.getByRole("button", { name: /第二条随手记/ }).click();
  await page.waitForTimeout(300);
  assert.match(await selectedRow.innerText(), /第一条随手记/, "上传没落地不能切到别的随手记");
  assert.match(await page.locator(".notes-panel footer span").first().innerText(), /传完就保存并继续/, "得说清楚在等什么");

  // ② 传完之后：附件存进**粘它的那条**，然后刚才那次切换自动接着跑。
  await release("note-a-shot.png");
  for (let i = 0; i < 100 && !patched.length; i++) await page.waitForTimeout(50);
  assert.equal(patched.at(0)?.id, "note-a", "附件必须存回粘它的那条随手记");
  assert.deepEqual(patched.at(0)?.attachments, ["/tmp/uploads/note-a-shot.png"], "存回去的就是刚传好的那张");
  await page.locator(".note-row.is-selected", { hasText: "第二条随手记" }).waitFor();

  // ③ 在第二条里粘图，没传完就按 Esc：面板不许关（关了就没人接住上传结果）。
  await pasteInto("note-b-shot.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".notes-panel").count(), 1, "上传没落地不能关掉面板");
  assert.equal(await page.getByText("面板已关闭").count(), 0, "面板不该在这时候关");

  // ④ 传完之后自动保存并关闭，用户不用再按一次 Esc。
  await release("note-b-shot.png");
  await page.getByText("面板已关闭").waitFor();
  assert.deepEqual(
    patched.at(-1),
    { id: "note-b", body: "第二条随手记", attachments: ["/tmp/uploads/note-b-shot.png"] },
    "关掉之前必须把第二条连附件一起存下来",
  );

  console.log("notes panel upload test passed");
} finally {
  await browser?.close();
  await server.close();
}
