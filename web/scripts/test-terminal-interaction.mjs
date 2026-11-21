import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager } from "../../server/src/terminal.ts";
import { terminalInputChunks } from "../src/workspace/terminalInput.ts";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const unicode = "a".repeat(16_383) + "😀汉字".repeat(20_000);
const chunks = [...terminalInputChunks(unicode)];
assert.equal(chunks.join(""), unicode);
assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 64 * 1024 && chunk.isWellFormed()));

const scratch = mkdtempSync(join(tmpdir(), "navi-terminal-interaction-"));
const manager = new TerminalSessionManager();
const projectId = "terminal-interaction";
const inputs = [];
const streams = [];
const sizes = new Map();
const outputOf = (sessionId) => manager.eventsAfter(sessionId, projectId, 0)
  ?.filter((event) => event.type === "data").map((event) => event.data).join("") ?? "";
const backend = createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type,last-event-id,x-navi-human-action-token");
  response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  const json = (body, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname;
  const base = `/api/projects/${projectId}/terminal/sessions`;
  if (path === base && request.method === "GET") return json({ sessions: manager.listForProject(projectId) });
  if (path.startsWith(base)) {
    const [, sessionId, action] = path.slice(base.length).split("/");
    if (action === "events") {
      const after = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
      streams.push({ sessionId, after });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(": connected\n\n");
      const write = (event) => response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      for (const event of manager.eventsAfter(sessionId, projectId, after) ?? []) write(event);
      const stop = manager.subscribe(sessionId, projectId, write);
      response.on("close", () => stop?.());
      return;
    }
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const raw = Buffer.concat(parts).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    if (path === base && request.method === "POST") {
      const options = existsSync("/bin/zsh") ? { shell: "/bin/zsh", shellArgs: ["-f"] } : {};
      return json(await manager.createAsync(projectId, scratch, { ...body, ...options }));
    }
    if (action === "input") {
      inputs.push({ sessionId, data: body.data });
      if (Buffer.byteLength(body.data) > 64 * 1024) return json({ error: "data too large" }, 413);
      manager.write(sessionId, projectId, body.data);
      return json({});
    }
    if (action === "resize") {
      sizes.set(sessionId, body);
      manager.resize(sessionId, projectId, body.cols, body.rows);
      return json({});
    }
    if (request.method === "DELETE") { await manager.destroy(sessionId, projectId); return json({}); }
  }
  return json({ error: "not found" }, 404);
});
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${backend.address().port}`;
const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__terminalOpens = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        this.addEventListener("open", () => window.__terminalOpens.push(String(url)));
      }
    };
  });
  await page.route("**/api/**", (route) => route.fulfill({
    status: 307, headers: { location: origin + new URL(route.request().url()).pathname + new URL(route.request().url()).search },
  }));
  await page.goto(`${web.origin}/scripts/fixtures/terminal-interaction.html`);
  await page.getByRole("button", { name: "终端", exact: true }).click();
  const viewport = page.locator(".project-terminal__viewport:not([hidden])");
  const input = viewport.locator("textarea");
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    console.error("INPUT", JSON.stringify(inputs.slice(-20)));
    console.error("OUTPUT", JSON.stringify(manager.listForProject(projectId).map((session) => outputOf(session.id).slice(-2500))));
    console.error("SCREEN", await viewport.innerText());
    await page.screenshot({ path: "/tmp/navi-terminal-failure.png" });
    throw new Error(`Timed out: ${description}`);
  };
  await waitFor(() => manager.listForProject(projectId).length === 1, "shell created");
  const first = manager.listForProject(projectId)[0].id;
  await waitFor(() => outputOf(first).length > 0, "shell prompt");
  await input.focus();
  await page.keyboard.type("discard-me");
  await page.keyboard.press("Control+k");
  await waitFor(() => inputs.some((entry) => entry.data.includes("\x0b")), "Ctrl+K reaches PTY");
  assert.equal(await page.getByTestId("palette").textContent(), "false");
  await page.keyboard.press("Control+c");

  if (existsSync("/usr/bin/vi") && existsSync("/bin/zsh")) {
    await page.keyboard.type("bindkey -e; printf '__ZLE_READY__\\n'");
    await page.keyboard.press("Enter");
    await waitFor(() => outputOf(first).includes("\r\n__ZLE_READY__\r\n"), "emacs shell keymap ready");
    const file = join(scratch, "vi-edit.txt");
    await page.keyboard.type(`vi -u NONE -i NONE '${file}'`);
    await page.keyboard.press("Enter");
    await waitFor(() => viewport.innerText().then((text) => text.includes("New File")), "vi alternate screen");
    await page.keyboard.type("iheader");
    await page.keyboard.press("Enter");
    await page.keyboard.type("tail");
    await page.keyboard.press("Escape");
    await waitFor(() => viewport.innerText().then((text) => text.includes("tail")), "vi inserted text");
    await page.getByRole("button", { name: "收起终端（shell 与服务继续跑）" }).click();
    assert.equal(await page.locator(".project-terminal").isVisible(), false);
    await page.getByRole("button", { name: "终端", exact: true }).click();
    await waitFor(() => streams.some((entry) => entry.sessionId === first && entry.after > 0), "drawer preserves alternate screen");
    await page.getByRole("button", { name: "新建 CLI" }).click();
    await waitFor(() => manager.listForProject(projectId).length === 2, "second shell created");
    await page.getByRole("button", { name: /^交互验证（/ }).click();
    await waitFor(() => streams.some((entry) => entry.sessionId === first && entry.after > 0), "resume without replaying old screen");
    await input.focus();
    await page.keyboard.type("gg0iTOP-");
    await page.keyboard.press("Escape");
    await page.keyboard.type(":wq");
    await page.keyboard.press("Enter");
    await waitFor(() => existsSync(file), "vi wrote file");
    assert.equal(readFileSync(file, "utf8"), "TOP-header\ntail\n");
    await waitFor(() => outputOf(first).lastIndexOf("\x1b[?2004h") > outputOf(first).lastIndexOf("\x1b[?1049l"), "shell restored after vi");

    const paste = async (text) => input.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    }, text);
    await paste("print -r -- 'alpha\nbeta'");
    await waitFor(() => inputs.at(-1)?.data.includes("\x1b[201~"), "multiline bracketed paste delivered");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Control+a");
    for (let index = 0; index < 5; index += 1) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("t");
    await page.keyboard.press("Control+e");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("X");
    await page.keyboard.press("Enter");
    await waitFor(() => outputOf(first).includes("\r\nalphX\r\nbeta\r\n"), "first line of multiline paste edited");

    const start = inputs.length;
    await paste("#" + unicode);
    await waitFor(() => inputs.slice(start).map((entry) => entry.data).join("").endsWith("\x1b[201~"), "large Unicode paste delivered in order");
    const sent = inputs.slice(start).map((entry) => entry.data).join("");
    const expected = "\x1b[200~#" + unicode + "\x1b[201~";
    const mismatch = Array.from({ length: Math.max(sent.length, expected.length) }, (_, index) => index).find((index) => sent[index] !== expected[index]);
    assert.ok(sent === expected, JSON.stringify({ actualLength: sent.length, expectedLength: expected.length, mismatch,
      actual: sent.slice(mismatch, mismatch + 60), expected: expected.slice(mismatch, mismatch + 60) }));
    assert.ok(inputs.slice(start).every((entry) => Buffer.byteLength(entry.data) <= 64 * 1024));
    await page.keyboard.press("Control+c");
    console.log("PASS: vi editing, alternate-screen tab switch, multiline paste editing, large Unicode paste");
  }

  const connections = streams.length;
  const count = manager.listForProject(projectId).length;
  await page.getByRole("button", { name: "终端外观", exact: true }).click();
  await page.getByRole("button", { name: "纸白", exact: true }).click();
  await page.getByRole("button", { name: "16 像素", exact: true }).click();
  await waitFor(() => page.locator(".project-terminal").evaluate((element) => getComputedStyle(element).backgroundColor === "rgb(245, 242, 235)"), "paper theme applied");
  await page.keyboard.press("Escape");
  assert.equal(manager.get(first, projectId).exitCode, null);
  assert.equal(streams.length, connections);
  assert.equal(manager.listForProject(projectId).length, count);
  await page.screenshot({ path: "/tmp/navi-terminal-paper.png" });
  await page.getByRole("button", { name: "终端外观", exact: true }).click();
  await page.getByRole("button", { name: "午夜", exact: true }).click();
  await page.getByRole("button", { name: "14 像素", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "/tmp/navi-terminal-midnight.png" });
  if (count > 1) {
    await input.focus();
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await waitFor(() => manager.get(first, projectId)?.exitCode !== null, "shell exited");
    await page.getByRole("button", { name: /^交互验证（已退出）/ }).waitFor();
    const before = await page.evaluate((sessionId) => window.__terminalOpens.filter((url) => url.includes(sessionId)).length, first);
    await page.getByRole("button", { name: /^交互验证 2（/ }).click();
    await page.getByRole("button", { name: /^交互验证（已退出）/ }).click();
    await waitFor(() => page.evaluate(({ sessionId, before }) => window.__terminalOpens.filter((url) => url.includes(sessionId)).length > before, { sessionId: first, before }), "ended shell reattached");
    await page.getByRole("button", { name: /^交互验证（已退出）/ }).waitFor();
    console.log("PASS: exited shell stays exited after reconnecting");
  }
  await page.reload();
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await page.getByRole("button", { name: "终端外观", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "午夜", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("button", { name: "14 像素", exact: true }).getAttribute("aria-pressed"), "true");
  await page.setViewportSize({ width: 375, height: 700 });
  assert.ok(await page.locator(".terminal-appearance__panel").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth;
  }));
  assert.equal(await page.getByTestId("notices").textContent(), "");
  assert.deepEqual(errors, []);
  console.log("PASS: terminal key ownership, themes, font sizes, persistence, narrow layout, no session recreation");
} finally {
  await browser?.close();
  manager.shutdown();
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
  await web.close();
  rmSync(scratch, { recursive: true, force: true });
}
