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
import { checkFloatingPreview, previewClearRatio } from "./preview-floating-checks.mjs";
import { checkExpandedPreviewShortcuts, checkPreviewControlShortcuts, checkPreviewPalette } from "./preview-shortcut-checks.mjs";
import { checkPreviewPanelOverlap } from "./preview-panel-overlap-checks.mjs";

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
    const savedRecords = new Map();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const launches = [];
    const config = { services: [{ id: "web", name: "Project web", command: "npm run project", port: 4321, kind: "web", enabled: true }] };
    const launchInfo = { kind: "workflow", reason: "", directory: "/task/worktree", steps: [{ id: "step", command: "npm run workflow" }],
      configured: { command: "npm run project", config }, candidates: [{ id: "static", name: "静态页面", command: "serve dist" }], truncated: false };
    const preview = () => ({ running, starting: false, hasLog: false, proxied: true, gen: "generation", startedAt: "session",
      services: running ? [
        { id: "web", name: "Web", status: "ready", url: "http://example.test", command: "npm run project" },
        { id: "admin", name: "Admin", status: "ready", url: "http://admin.test", command: "npm run admin" },
      ] : [] });
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
        if (realRuntime) return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><meta charset="utf-8"><script>
          const capture = Element.prototype.setPointerCapture;
          Element.prototype.setPointerCapture = function(id) { window.capturedPointerId = id; return capture.call(this, id); };
          const attach = Element.prototype.attachShadow;
          Element.prototype.attachShadow = function(options) {
            const root = attach.call(this, options); window.annotationShadow = root; return root;
          };
          ${previewAnnotationRuntime()}
          </script></head><body><div id="drag-target" style="margin:20px;width:400px;height:280px;background:#eee">Rectangle target</div>
          <input id="page-input" aria-label="Page input">
          <button id="fixed-bottom" style="position:fixed;bottom:0;left:calc(50% - 90px);width:180px;height:48px">页面固定底栏</button>
          <button id="fixed-top" style="position:fixed;right:15px;top:20px;height:30px;width:120px">页面固定顶栏</button>
          <button id="bottom-edge" style="position:fixed;bottom:0;left:20px;height:18px">页面最底部</button><script>
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
      if (path.endsWith("/annotation-batches")) return reply([...savedRecords.values()]);
      if (path.includes("/annotation-batches/") && request.method() === "PUT") {
        const data = request.postDataJSON();
        record = { ...data, batch: parseAnnotationBatch(data.batch), state: "saved", messageId: null, error: null, savedAt: "2026-09-11" };
        savedRecords.set(record.batch.id, record);
        return reply(record);
      }
      if (path.endsWith("/reply")) {
        record = { ...record, messageId: "sent", state: "delivered" };
        savedRecords.set(record.batch.id, record);
        return reply({ annotationBatch: record });
      }
      return reply([]);
    });
    await page.route("**/__preview-test", async (route) => route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml("/__preview-test", `<!doctype html><html><head>
      <style>:root { --panel:#fff;--raised:#eee;--ink:#222;--muted:#555;--line:#ddd;--line2:#ccc;--accent:#5566bb;--red:#b22;--canvas:#fafafa;--font-sans:system-ui;--font-mono:monospace; }
        * {box-sizing:border-box} body {margin:0} .workspace-main {isolation:isolate} #sidebar {position:fixed;inset:0 auto 0 0;width:220px;z-index:5;background:#ddd}
        #root {display:flex;position:absolute;left:220px;top:80px;width:900px;height:760px}</style>
      </head><body><div class="workspace-shell"><div id="sidebar"></div><div class="workspace-main" id="root"></div></div><div id="toast-root"></div><script type="module">
        import React from 'react';
        import { createPortal } from 'react-dom';
        import { createRoot } from 'react-dom/client';
        import { PreviewWorkspace, PreviewWorkspaceEntry } from '/src/preview-workspace/PreviewWorkspace.tsx';
        import { DraftProvider } from '/src/lib/DraftStore.tsx';
        import { WorkspaceToast } from '/src/workspace/WorkspaceToast.tsx';
        import { useWorkspaceShortcuts } from '/src/workspace/useWorkspaceShortcuts.ts';
        import { CommandPalette } from '/src/overlays/CommandPalette.tsx';
        import '/src/styles/workspace.css';
        import '/src/styles/overlays.css';
        import '/src/styles/dialogs.css';
        window.closeRequests = 0;
        window.workspaceShortcutActions = [];
        const tasks = [{id:'previous'}, {id:'fixture'}, {id:'next'}];
        const logShortcut = action => window.workspaceShortcutActions.push(action);
        function Fixture() {
          const [toast, setToast] = React.useState(true);
          const [open, setOpen] = React.useState(sessionStorage.getItem('preview-open') === 'true');
          const [selectedTaskId, setSelectedTaskId] = React.useState('fixture');
          const [paletteOpen, setPaletteOpen] = React.useState(false);
          const openPreview = () => { sessionStorage.setItem('preview-open', 'true'); setOpen(true); };
          useWorkspaceShortcuts({
            enabled: true, paletteOpen, composerOpen: false, spreadOpen: false,
            orderedTasks: tasks, selectedTaskId,
            onTask: task => {
              logShortcut('task:' + task.id); setSelectedTaskId(task.id);
              sessionStorage.removeItem('preview-open'); setOpen(false);
            },
            onTogglePalette: () => { logShortcut('palette'); setPaletteOpen(value => !value); }, onCreate: () => logShortcut('create'),
            onToggleSpread: () => logShortcut('spread'), onCloseSpread: () => logShortcut('close-spread'),
            onToggleTaskMode: () => logShortcut('task-mode'),
          });
          const workspace = open ? React.createElement(PreviewWorkspace, {key:selectedTaskId,taskId:selectedTaskId,onClose:()=>{
            window.closeRequests++; sessionStorage.removeItem('preview-open'); setOpen(false);
          }}) : React.createElement(PreviewWorkspaceEntry, {onOpen:openPreview});
          const sidebar = createPortal(React.createElement(React.Fragment, {},
            React.createElement('button', {id:'preview-external-opener',onClick:openPreview}, '外部预览入口'),
            React.createElement('input', {id:'preview-external-input','aria-label':'预览外输入框'}),
            React.createElement('output', {id:'workspace-selected-task'}, selectedTaskId),
            React.createElement('button', {'data-workspace-run-action':true,onClick:()=>logShortcut('run')}, '运行任务'),
          ), document.getElementById('sidebar'));
          const palette = createPortal(React.createElement(CommandPalette, {
            open: paletteOpen, projects: [], currentProject: null, tasks: [], selectedTask: null, groups: [],
            onClose: () => setPaletteOpen(false), onComposer: () => logShortcut('create'),
            onProject: () => {}, onTaskMode: () => {}, onTask: () => {}, onTaskUpdated: () => {},
            onNote: () => {}, onNewGroup: () => {}, onNewProject: () => {}, onDeleteTask: () => {},
            onSettings: () => {}, notify: () => {},
          }), document.getElementById('toast-root'));
          return React.createElement(React.Fragment, {}, workspace, sidebar, palette, createPortal(React.createElement(WorkspaceToast, {
            toasts: { pinned: toast ? {message:'预览启动提示仍然可见'} : null, transient: null }, onDismiss:()=>setToast(false),
          }), document.getElementById('toast-root')));
        }
        createRoot(document.getElementById('root')).render(React.createElement(DraftProvider, {}, React.createElement(Fixture)));
      </script></body></html>`) }));
    await page.goto(`http://127.0.0.1:${address.port}/__preview-test`);
    const button = (name) => page.getByRole("button", { name, exact: true });
    await button("打开预览工作区").waitFor();
    await checkPreviewPalette(page);
    await button("打开预览工作区").click();
    assert.deepEqual(await page.locator(".preview-workspace").boundingBox(), { x: 0, y: 0, width: 1400, height: 900 }, "the entry opens the expanded workspace directly, before preview launch");
    await checkExpandedPreviewShortcuts(page);
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
    assert.deepEqual(await iframe.boundingBox(), { x: 0, y: 0, width: 1400, height: 900 }, "the preview fills the window with tools and notes open");
    const toast = page.getByTestId('workspace-toast-pinned');
    await toast.waitFor();
    assert(await toast.evaluate((element) => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), 'sticky notifications remain above the expanded preview');
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    if (process.env.PREVIEW_WORKSPACE_SCREENSHOTS) await page.screenshot({ path: join(process.env.PREVIEW_WORKSPACE_SCREENSHOTS, "expanded.png") });
    await button("还原预览").click();
    const compact = await iframe.boundingBox();
    assert.deepEqual(compact, await page.locator(".preview-workspace").boundingBox(), "floating controls preserve the entire compact preview area too");
    await button("放大预览").click();
    let box = await page.locator(".preview-workspace").boundingBox();
    assert.deepEqual(box, { x: 0, y: 0, width: 1400, height: 900 });
    assert(await page.evaluate(() => !!document.elementFromPoint(10, 10)?.closest(".preview-workspace")), "expanded workspace covers the app sidebar stacking context");
    assert((await iframe.boundingBox()).width > compact.width + 400);
    await button("收起意见栏").click();
    assert.deepEqual(await iframe.boundingBox(), box, "collapsing notes does not resize the embedded page");
    assert(await page.evaluate(() => document.elementFromPoint(700, 400)?.tagName === "IFRAME"), "empty space between floating controls remains interactive");
    await button("标注").click();
    const draft = () => page.evaluate(() => JSON.parse(localStorage.getItem("ash.annotation-batch.fixture")));
    const emit = async (number, tool = "element") => {
      await page.frames().find((frame) => frame.url().includes("/preview/open/")).evaluate(({ number, tool }) => window.emit({ type: "annotation", canSelectParent: false, annotation: {
        id: `item-${number}`, number, tool, points: [{x:100,y:100}], element: null,
        context: {route:"/",scroll:{x:0,y:0},viewport:{width:innerWidth,height:innerHeight,scale:1},capturedAt:number},
      } }), { number, tool });
      await page.waitForFunction((number) => document.querySelectorAll(".preview-workspace-list-row").length === number, number);
    };
    await emit(1);
    assert.equal(await page.getByRole("complementary", { name: "页面标注列表" }).isVisible(), true, "new annotation reveals comments while expanded");
    assert.deepEqual(await iframe.boundingBox(), box, "revealing annotation details does not move the page or its annotation coordinates");
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

    const sampleBatch = structuredClone(record.batch);
    const mismatchNotice = page.locator(".preview-workspace-toolbar .annotation-batch-mismatch");
    const panelNotice = page.locator(".annotation-batch-panel .annotation-batch-mismatch");
    const waitForTools = () => page.waitForFunction(() => [...document.querySelectorAll('.preview-workspace-tools button')]
      .every((button) => !button.disabled));
    for (const scenario of ["restart", "service"]) {
      const oldBatch = { ...structuredClone(sampleBatch), id: `old-${scenario}`, createdAt: 1,
        gen: scenario === "restart" ? "previous-generation" : "generation" };
      oldBatch.items = oldBatch.items.map((item) => ({ ...item, gen: oldBatch.gen }));
      record = { batch: oldBatch, revision: 1, state: "saved", messageId: null, error: null, savedAt: "2026-09-11" };
      savedRecords.clear(); savedRecords.set(oldBatch.id, record);
      await page.evaluate((batch) => localStorage.setItem("ash.annotation-batch.fixture", JSON.stringify(batch)), oldBatch);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('.preview-workspace-modes button')?.disabled === false);
      if (scenario === "service") {
        await waitForTools();
        assert.equal(await page.locator(".annotation-batch-mismatch").count(), 0, "matching drafts have no mismatch notice");
        await page.getByRole("combobox", { name: "预览服务" }).selectOption("admin");
      }
      const reason = scenario === "restart" ? /服务「Web」已重启或更新页面.*之前的预览/ : /属于服务「Web」.*切换到服务「Admin」/;
      await mismatchNotice.waitFor();
      assert.match(await mismatchNotice.textContent(), reason);
      assert.equal(await panelNotice.isVisible(), true, "the send entry has the same local explanation and recovery action");
      assert.match(await panelNotice.textContent(), reason);
      assert.equal(await panelNotice.getByRole("button", { name: "新建批次继续标注" }).isEnabled(), true);
      assert.equal(await button("预览批次并发送").isEnabled(), true, "existing comments remain sendable across previews");
      for (const name of ["标注", "点选", "矩形", "画笔", "Pin", "父容器"]) {
        assert.equal(await button(name).isDisabled(), true, `${scenario}: ${name} stays locked until a fresh batch`);
        assert.match(await button(name).getAttribute("aria-describedby"), /.+/, "locked tools refer to the visible reason");
      }
      if (scenario === "restart") {
        await page.reload();
        await mismatchNotice.waitFor();
        assert.match(await mismatchNotice.textContent(), reason, "restored mismatched drafts keep a persistent explanation");
      } else {
        await page.getByRole("combobox", { name: "预览服务" }).selectOption("web");
        await waitForTools();
        assert.equal(await mismatchNotice.count(), 0, "returning to the original service removes the mismatch");
        await page.getByRole("combobox", { name: "预览服务" }).selectOption("admin");
        await mismatchNotice.waitFor();
      }
      const recovery = scenario === "restart" ? mismatchNotice : panelNotice;
      if (scenario === "restart") {
        await button("收起意见栏").click();
        assert.equal(await mismatchNotice.isVisible(), true, "toolbar recovery remains visible with the sidebar closed");
      }
      await recovery.getByRole("button", { name: "新建批次继续标注" }).click();
      await waitForTools();
      assert.equal(await mismatchNotice.count(), 0, "one recovery click removes the mismatch and unlocks tools");
      assert.equal(await draft(), null, "the fresh batch starts with no old annotations");
      assert.deepEqual(savedRecords.get(oldBatch.id).batch, oldBatch, "fresh saves and preserves the old batch");
      await button("点选").click();
      await emit(1);
      await page.locator(".preview-workspace-detail textarea").fill("当前页面的新意见");
      await page.getByRole("status").filter({ hasText: "已保存 · 草稿" }).waitFor();
      const freshBatch = await draft();
      assert.notEqual(freshBatch.id, oldBatch.id);
      assert.equal(freshBatch.gen, "generation");
      assert.equal(freshBatch.serviceId, scenario === "restart" ? "web" : "admin");
      assert.equal(freshBatch.items[0].comment, "当前页面的新意见");
      assert.equal(savedRecords.size, 2, "old and new batches are persisted separately");
      await page.getByText("已保存批次（2）", { exact: true }).click();
      const oldTimestamp = await page.evaluate(() => new Date(1).toLocaleString());
      await page.locator(".annotation-batch-history").filter({ hasText: oldTimestamp }).click();
      await mismatchNotice.waitFor();
      assert.equal((await draft()).id, oldBatch.id, "the saved old batch can still be reopened");
      await page.locator(".preview-workspace-item").click();
      assert.equal(await page.locator(".preview-workspace-detail textarea").inputValue(), "最终意见");
    }

    await page.evaluate(() => localStorage.removeItem("ash.annotation-batch.fixture"));
    record = null; savedRecords.clear(); realRuntime = true;
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
    await button('还原预览').click();
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
    await checkFloatingPreview(page, runtimeFrame, draft);
    await checkPreviewPanelOverlap(page, draft);
    for (const viewport of [{ width: 900, height: 600 }, { width: 760, height: 500 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      assert.deepEqual(await iframe.boundingBox(), { x: 0, y: 0, ...viewport });
      await button('展开标注工具').waitFor();
      assert.equal(await page.locator('.preview-workspace-notes').isVisible(), false);
      assert(await previewClearRatio(page) > .7, 'compact view keeps at least 70% of the page unobstructed by default');
      const controls = await page.locator('.preview-workspace-controls').boundingBox();
      await button('展开意见栏').click();
      const notes = await page.locator('.preview-workspace-notes').boundingBox();
      assert(controls.x >= 0 && controls.x + controls.width <= viewport.width);
      assert(notes.height > 100 && notes.height <= viewport.height * .45 + 1, 'notes remain scrollable without covering the whole small preview');
      if (process.env.PREVIEW_WORKSPACE_SCREENSHOTS) await page.screenshot({ path: join(process.env.PREVIEW_WORKSPACE_SCREENSHOTS, `narrow-${viewport.width}.png`) });
      await button('收起意见栏').click();
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    await checkPreviewControlShortcuts(page, draft);
    await button('还原预览').click();
    await button('关闭预览工作区').click();
    await button('打开预览工作区').click();
    assert.equal(await button('还原预览').isVisible(), true, 'reopening starts expanded even after the previous workspace was restored');
    assert.equal(await page.getByText("未能连接页面标注", { exact: false }).count(), 0);
    assert.deepEqual(errors, []);
    console.log("preview workspace DOM: launch/layout, undo/delete/locks, evidence, restart/service mismatch recovery and saved history, real runtime drawing, focused iframe Escape/defaultPrevented in browse and annotate modes passed");
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}
