import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { previewAnnotationRuntime } from "../../server/src/preview-annotation-runtime.ts";
import { parseAnnotationBatch } from "../../shared/src/page-annotation-batch.ts";

export async function testPreviewWorkspaceDom() {
  const cacheDir = await mkdtemp(join(tmpdir(), "ash-preview-workspace-test-"));
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "error", cacheDir,
    server: { host: "127.0.0.1", port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    browser = await chromium.launch(await chromeLaunchOptions());
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let record = null, iframeLoads = 0, running = false, realRuntime = false;
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const launches = [];
    const config = { services: [{ id: "web", name: "Project web", command: "npm run project", port: 4321, kind: "web", enabled: true }] };
    const launchInfo = { kind: "workflow", reason: "", directory: "/task/worktree", steps: [{ id: "step", command: "npm run workflow" }],
      configured: { command: "npm run project", config }, candidates: [{ id: "static", name: "静态页面", command: "serve dist" }], truncated: false };
    const preview = () => ({ running, starting: false, hasLog: false, proxied: true, gen: "generation", startedAt: "session",
      services: running ? [{ id: "web", name: "Web", status: "ready", url: "http://example.test", command: "npm run project" }] : [] });
    await page.route("**/api/**", async (route) => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const reply = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      if (path === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": connected\n\n" });
      if (path.endsWith("/preview") && new URL(request.url()).searchParams.has("launch")) return reply(launchInfo);
      if (path.endsWith("/preview/restart")) { launches.push(request.postDataJSON()); running = true; return reply(preview()); }
      if (path.endsWith("/preview")) return reply(preview());
      if (path.endsWith("/annotation-review-status")) return reply({ canReopen: true, reason: "", previewKind: "workflow" });
      if (path.includes("/preview/open/")) {
        iframeLoads++;
        if (realRuntime) return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><script>
          const attach = Element.prototype.attachShadow;
          Element.prototype.attachShadow = function(options) {
            const root = attach.call(this, options); window.annotationShadow = root; return root;
          };
          ${previewAnnotationRuntime()}
          </script></head><body><div id="drag-target" style="margin:20px;width:400px;height:280px;background:#eee">Rectangle target</div>
          <input id="page-input" aria-label="Page input"><script>
            window.escapeCount = 0;
            for (const [phase, target, capture] of [['target', document.getElementById('page-input'), false],
              ['document', document, false], ['window-capture', window, true], ['window', window, false]]) {
              target.addEventListener('keydown', event => {
                if (event.key === 'Escape' && window.consumeEscape === phase) event.preventDefault();
              }, capture);
            }
            window.addEventListener('keydown', event => {
              if (event.key === 'Escape') { window.escapeCount++; window.escapePrevented = event.defaultPrevented; }
            });
          </script></body></html>` });
        return route.fulfill({ contentType: "text/html", body: `<html><body><h1>Fixture preview</h1><script>
          window.commands = [];
          window.addEventListener('message', event => {
            if (event.source !== parent || !event.ports[0]) return;
            const port = event.ports[0];
            window.emit = data => port.postMessage(data);
            port.onmessage = message => {
              window.commands.push(message.data);
              if (message.data.type === 'configure' && !window.holdConfiguration) port.postMessage({ type: 'configured', mode: message.data.mode, tool: message.data.tool });
            };
            port.postMessage({ type: 'ready', context: { route: '/', scroll: {x:0,y:0}, viewport: {width:innerWidth,height:innerHeight,scale:1},capturedAt:1 } });
          });
        </script></body></html>` });
      }
      if (path.endsWith("/annotation-reference")) return reply({ capturedAt: 1, missing: ["fixture image unavailable"] });
      if (path === "/api/uploads") return reply({ id: "image", path: "/uploads/fixture.png", url: "/api/uploads/fixture.png", name: "fixture.png", kind: "image" });
      if (path === "/api/uploads/fixture.png") return route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") });
      if (path.endsWith("/annotation-batches")) return reply(record ? [record] : []);
      if (path.includes("/annotation-batches/") && request.method() === "PUT") {
        const data = request.postDataJSON();
        record = { ...data, batch: parseAnnotationBatch(data.batch), state: "saved", messageId: null, error: null, savedAt: "2026-09-11" };
        return reply(record);
      }
      if (path.endsWith("/reply")) {
        record = { ...record, messageId: "sent", state: "delivered" };
        return reply({ annotationBatch: record });
      }
      return reply([]);
    });
    await page.route("**/__preview-test", async (route) => route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml("/__preview-test", `<!doctype html><html><head>
      <style>:root { --panel:#fff;--raised:#eee;--ink:#222;--muted:#555;--line:#ddd;--line2:#ccc;--accent:#5566bb;--red:#b22;--canvas:#fafafa;--font-sans:system-ui;--font-mono:monospace; }
        * {box-sizing:border-box} body {margin:0} .workspace-main {isolation:isolate} #sidebar {position:fixed;inset:0 auto 0 0;width:220px;z-index:5;background:#ddd}
        #root {display:flex;position:absolute;left:220px;top:80px;width:900px;height:760px}</style>
      </head><body class="workspace-shell"><div id="sidebar"></div><div class="workspace-main" id="root"></div><script type="module">
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { PreviewWorkspace } from '/src/preview-workspace/PreviewWorkspace.tsx';
        import { DraftProvider } from '/src/lib/DraftStore.tsx';
        window.closeRequests = 0;
        createRoot(document.getElementById('root')).render(React.createElement(DraftProvider, {}, React.createElement(PreviewWorkspace, {taskId:'fixture',onClose:()=>{window.closeRequests++;}})));
      </script></body></html>`) }));
    await page.goto(`http://127.0.0.1:${address.port}/__preview-test`);
    const button = (name) => page.getByRole("button", { name, exact: true });
    await button("按已保存配置启动").waitFor({ timeout: 10000 }).catch((error) => { throw new Error(`${error.message}\n${errors.join("\n")}`); });
    assert.equal(await button("启动 静态页面").isVisible(), false, "project configuration hides alternatives by default");
    assert.equal(await button("启动工作流预览").isVisible(), false);
    await page.getByText("换其它候选 / 自填命令", { exact: true }).click();
    assert.equal(await button("启动 静态页面").isVisible(), true);
    await page.getByText("自填启动命令", { exact: true }).click();
    await page.getByRole("textbox", { name: "本次预览命令" }).fill("npm run custom");
    assert.equal(await button("启动自填命令").isEnabled(), true);
    await button("按已保存配置启动").click();
    await page.waitForFunction(() => document.querySelector('.preview-workspace-modes button')?.disabled === false);
    assert.deepEqual(launches, [{ command: "npm run project", config, stepId: "step", workspace: true }]);
    const iframe = page.locator('iframe[title="任务页面预览"]');
    const frame = page.frames().find((frame) => frame.url().includes("/preview/open/"));
    const compact = await iframe.boundingBox();
    await button("放大预览").click();
    let box = await page.locator(".preview-workspace").boundingBox();
    assert.deepEqual(box, { x: 0, y: 0, width: 1400, height: 900 });
    assert(await page.evaluate(() => !!document.elementFromPoint(10, 10)?.closest(".preview-workspace")), "expanded workspace covers the app sidebar stacking context");
    assert((await iframe.boundingBox()).width > compact.width + 400);
    await button("收起意见栏").click();
    assert.equal((await iframe.boundingBox()).width, 1400);
    await button("标注").click();
    const draft = () => page.evaluate(() => JSON.parse(localStorage.getItem("ash.annotation-batch.fixture")));
    const emit = async (number, tool = "element") => {
      await frame.evaluate(({ number, tool }) => window.emit({ type: "annotation", canSelectParent: false, annotation: {
        id: `item-${number}`, number, tool, points: [{x:100,y:100}], element: null,
        context: {route:"/",scroll:{x:0,y:0},viewport:{width:innerWidth,height:innerHeight,scale:1},capturedAt:number},
      } }), { number, tool });
      await page.waitForFunction((number) => document.querySelectorAll(".preview-workspace-list-row").length === number, number);
    };
    await emit(1);
    assert.equal(await page.getByRole("complementary", { name: "页面标注列表" }).isVisible(), true, "new annotation reveals comments while expanded");
    await page.locator(".preview-workspace-detail textarea").fill("保留这条意见");
    await emit(2, "rectangle"); await emit(3, "pen"); await emit(4, "pin");
    await button("还原预览").click();
    assert.deepEqual(await iframe.boundingBox(), compact);
    assert.equal(iframeLoads, 1, "enlarge, collapse and restore preserve the iframe document and port");
    await button("放大预览").click();
    await button("还原预览").press("Escape");
    assert.equal(await button("放大预览").isVisible(), true, "Escape restores the expanded layout");
    await button("撤销").click();
    await page.waitForFunction(() => document.querySelectorAll(".preview-workspace-list-row").length === 3);
    const undoCommands = async () => frame.evaluate(() => window.commands.filter((c) => c.type === "remove").map((c) => c.id));
    await frame.evaluate(() => window.emit({ type: "undo" }));
    await page.waitForFunction(() => document.querySelectorAll(".preview-workspace-list-row").length === 2);
    await button("撤销").press("Control+z");
    await page.waitForFunction(() => document.querySelectorAll(".preview-workspace-list-row").length === 1);
    assert.deepEqual(await undoCommands(), ["item-4", "item-3", "item-2"]);
    assert.equal((await draft()).evidence.length, 2, "undo removes evidence for deleted annotations");
    assert.equal((await draft()).items[0].comment, "保留这条意见", "undo preserves earlier comments");
    await page.locator(".preview-workspace-item").click();
    await page.locator(".preview-workspace-detail textarea").press("Control+z");
    assert.equal((await draft()).items.length, 1, "text editing keeps its own undo");
    await button("撤销").press("Meta+z");
    await page.waitForFunction(() => document.querySelectorAll(".preview-workspace-list-row").length === 0);
    assert.equal(await button("撤销").isDisabled(), true);
    assert.deepEqual((await draft()).evidence, []);

    await emit(1); await emit(2, "pin");
    await frame.evaluate(() => { window.holdConfiguration = true; });
    await button("矩形").click();
    await button("删除标注 #1").click();
    await page.waitForFunction(() => document.querySelectorAll(".preview-workspace-list-row").length === 1);
    assert.equal((await draft()).items[0].id, "item-2", "list delete removes an unselected item directly");
    assert.equal((await undoCommands()).at(-1), "item-1", "removal reaches the iframe even while mode configuration awaits acknowledgement");
    await frame.evaluate(() => { window.holdConfiguration = false; window.emit({ type: "configured", mode: "annotate", tool: "rectangle" }); });
    await frame.evaluate(() => window.emit({ type: "selection", id: "item-2", canSelectParent: false }));
    await button("删除 #2").click();
    await page.waitForFunction(() => document.querySelectorAll(".preview-workspace-list-row").length === 0);
    assert.deepEqual((await undoCommands()).slice(-2), ["item-1", "item-2"]);
    await emit(1);
    await page.locator(".preview-workspace-detail textarea").fill("最终意见");
    await frame.evaluate((png) => window.emit({ type: "image", id: "item-1", image: {
      capturedAt: 1, dataUrl: `data:image/png;base64,${png}`, missing: ["Canvas", "fonts"],
    } }), png);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("ash.annotation-batch.fixture"))?.evidence.some((item) => item.path));
    await page.getByRole("status").filter({ hasText: "已保存 · 草稿" }).waitFor();
    assert.deepEqual((await draft()).evidence, record.batch.evidence, "uploaded evidence and server record have the same content");
    assert.notEqual(JSON.stringify((await draft()).evidence), JSON.stringify(record.batch.evidence), "server normalization reorders path/missing");
    const savedRevision = record.revision;
    await button("预览批次并发送").click();
    assert.equal(await button("撤销").isDisabled(), true);
    assert.equal(await button("删除标注 #1").isDisabled(), true);
    const beforeLocked = await undoCommands();
    await frame.evaluate(() => window.emit({ type: "undo" }));
    assert.equal((await draft()).items.length, 1);
    assert.deepEqual(await undoCommands(), beforeLocked, "locked batch cannot remove iframe marks");
    await button("确认发送此批次").click();
    await page.waitForFunction(() => !document.querySelector('iframe[title="任务页面预览"]'));
    assert.equal(record.messageId, "sent");
    assert.equal(record.revision, savedRevision, "sending an equivalent draft does not save a redundant revision");
    assert.equal(await button("删除标注 #1").isDisabled(), true);
    await page.reload();
    await button("删除标注 #1").waitFor();
    assert.equal(await button("删除标注 #1").isDisabled(), true, "restored sent batches remain immutable");
    assert.equal(record.batch.items.length, 1);

    await page.evaluate(() => localStorage.removeItem("ash.annotation-batch.fixture"));
    record = null; realRuntime = true;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.preview-workspace-modes button')?.disabled === false);
    await button("矩形").click();
    await page.waitForFunction(() => [...document.querySelectorAll('.preview-workspace-tools button')]
      .some((button) => button.textContent.includes('矩形') && button.getAttribute('aria-pressed') === 'true' && !button.disabled));
    const runtimeFrame = page.frames().find((frame) => frame.url().includes("/preview/open/"));
    const target = await runtimeFrame.locator("#drag-target").boundingBox();
    assert(target, "real runtime fixture has a drawable target");
    const paint = () => runtimeFrame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const drawn = () => runtimeFrame.evaluate(() => [...window.annotationShadow.querySelectorAll('rect')].map((rect) =>
      Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number(rect.getAttribute(key))]))));
    for (const [index, start, end] of [[0, { x: 180, y: 150 }, { x: 60, y: 70 }], [1, { x: 220, y: 180 }, { x: 320, y: 250 }]]) {
      const before = (await draft())?.items.length ?? 0;
      await page.mouse.move(target.x + start.x, target.y + start.y);
      await page.mouse.down(); await paint();
      assert.equal((await drawn()).at(-1).width, 0, "mousedown paints the draft rectangle");
      await page.mouse.move(target.x + end.x, target.y + end.y, { steps: 5 }); await paint();
      const expected = { width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
      const moving = (await drawn()).at(-1);
      assert.equal(moving.width, expected.width); assert.equal(moving.height, expected.height);
      assert.equal((await draft())?.items.length ?? 0, before, "mousemove has not committed the rectangle");
      await page.mouse.up(); await paint();
      await page.waitForFunction((count) => document.querySelectorAll('.preview-workspace-list-row').length === count, index + 1);
      assert.deepEqual((await drawn()).at(-1), moving, "mouseup commits the visible rectangle");
      assert.equal((await draft()).items.at(-1).tool, "rectangle");
    }
    for (const name of ["画笔", "Pin", "点选"]) {
      assert.equal(await button(name).isEnabled(), true);
      await button(name).click();
      await page.waitForFunction((name) => [...document.querySelectorAll('.preview-workspace-tools button')]
        .some((button) => button.textContent.includes(name) && button.getAttribute('aria-pressed') === 'true' && !button.disabled), name);
    }
    const preservedDraft = await draft();
    const loadsBeforeEscape = iframeLoads;
    for (const mode of ['浏览', '标注']) {
      await button(mode).click();
      await page.waitForFunction((mode) => [...document.querySelectorAll('.preview-workspace-modes button')]
        .some((button) => button.textContent === mode && button.getAttribute('aria-pressed') === 'true' && !button.disabled), mode);
      await button('放大预览').click();
      await runtimeFrame.evaluate(() => parent.postMessage({ type: 'escape' }, '*'));
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
      assert.equal(await button('还原预览').isVisible(), true, 'ordinary window messages cannot dismiss the workspace');
      const input = runtimeFrame.locator('#page-input');
      for (const phase of ['target', 'document', 'window-capture', 'window']) {
        await runtimeFrame.evaluate((phase) => { window.consumeEscape = phase; }, phase);
        await input.focus();
        assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'IFRAME');
        const before = await runtimeFrame.evaluate(() => window.escapeCount);
        await input.press('Escape');
        await runtimeFrame.waitForFunction((before) => window.escapeCount === before + 1, before);
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
        assert.equal(await runtimeFrame.evaluate(() => window.escapePrevented), true, `${mode}: page can consume Escape at ${phase}`);
        assert.equal(await button('还原预览').isVisible(), true, `${mode}: defaultPrevented keeps the workspace expanded`);
      }
      await runtimeFrame.evaluate(() => { window.consumeEscape = null; });
      await input.press('Escape');
      await button('放大预览').waitFor();
      assert.equal(await runtimeFrame.evaluate(() => window.escapePrevented), false, `${mode}: runtime leaves Escape's default action alone`);
      await input.press('Escape');
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
      assert.equal(await button('放大预览').isVisible(), true, 'Escape in compact view is idempotent');
      assert.equal(await page.evaluate(() => window.closeRequests), 0, 'frame Escape cannot close the workspace');
      assert.deepEqual(await draft(), preservedDraft, 'frame Escape cannot change annotation data');
    }
    assert.equal(iframeLoads, loadsBeforeEscape, 'frame Escape preserves the iframe document and channel');
    assert.equal(await page.getByText("未能连接页面标注", { exact: false }).count(), 0);
    assert.deepEqual(errors, []);
    console.log("preview workspace DOM: launch/layout, undo/delete/locks, evidence, real runtime drawing, focused iframe Escape/defaultPrevented in browse and annotate modes passed");
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}
