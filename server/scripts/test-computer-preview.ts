import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@navi/shared";

const root = mkdtempSync(join(tmpdir(), "navi-computer-preview-"));
process.env.NAVI_DB = join(root, "ash.db");
process.env.NAVI_DATA_DIR = root;
process.env.NAVI_RUNS_DIR = join(root, "runs");
process.env.NAVI_UPLOADS_DIR = join(root, "uploads");
const { imageStore } = await import("../src/agent-attachments.js");
const { ComputerToolImages, isComputerTool, toolImageEvents } = await import("../src/executors/computer-images.js");
const { computerUseFrame, activeComputerUseFrame, clearComputerFrame } = await import("../src/computer-preview.js");
const { computerApplicationCommand } = await import("../src/computer-application.js");
const { validComputerTarget } = await import("../src/executors/computer-targets.js");
const { markTurnActive, clearTurnActive } = await import("../src/session-turn-registry.js");
const { appendSessionTrace, sessionTracePath } = await import("../src/transcript.js");
const { parseBrowserAction } = await import("@navi/shared/task-runtime");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const content = [{ type: "image", data: png, mimeType: "image/png" }];
const turn = "2026-11-21T01:00:00.000Z";

try {
  for (const name of ["computer", "computer.screenshot", "computer_use.screenshot", "cua_repl.js", "mcp__cua_repl__js", "mcp__unified_computer_use__screenshot"]) {
    assert.equal(isComputerTool(name), true, name);
  }
  const browserTools = ["playwright.browser_take_screenshot", "mcp__playwright__browser_take_screenshot", "mcp__claude_in_chrome__computer", "claude_in_chrome.computer", "mcp__navi__browser_action"];
  for (const name of ["Read", "image_gen", "mcp__grok_it__grok_image_generate", "mcp__node_repl__js", "not_computer.screenshot", ...browserTools]) {
    assert.equal(isComputerTool(name), false, name);
  }
  const seen = imageStore();
  const first = toolImageEvents({ content }, seen, "cua_repl.js")[0]!;
  assert.equal(first.computer, "cua_repl.js");
  assert.ok(first.path && existsSync(first.path));
  assert.deepEqual(toolImageEvents({ content }, seen, "cua_repl.js"), [first]);
  assert.deepEqual(toolImageEvents({ content }, seen, "Read"), []);
  const plain = toolImageEvents({ content }, imageStore(), "Read")[0]!;
  assert.equal(plain.computer, undefined);
  for (const name of browserTools) {
    const image = toolImageEvents({ content }, imageStore(), name)[0]!;
    assert.ok(image.path);
    assert.equal(image.computer, undefined, name);
  }

  const tracker = new ComputerToolImages();
  tracker.call({ id: "computer", name: "screenshot", toolset_name: "computer" });
  tracker.call({ id: "file", name: "Read" });
  assert.equal(tracker.result({ tool_use_id: "file", content }, imageStore())[0]?.computer, undefined);
  const claude = tracker.result({ tool_use_id: "computer", content }, imageStore())[0]!;
  assert.equal(claude.computer, "computer.screenshot");
  assert.equal(tracker.result({ tool_use_id: "unknown", content }, imageStore())[0]?.computer, undefined);
  const dynamic = toolImageEvents([{ type: "image", imageUrl: `data:image/png;base64,${png}` }], imageStore(), "cua_repl.js")[0]!;
  assert.ok(dynamic.computer);
  const native = imageStore();
  const messageTarget = { application: "/System/Applications/Messages.app", name: "信息", windowTitle: "未命名" };
  const selected = toolImageEvents({ content: [{ type: "text", text: 'Window: "未命名", App: 信息.' }, ...content] }, native, "cua_repl.js", false,
    { code: 'let messagesDemo = await cua.getApp("/System/Applications/Messages.app");' })[0]!;
  assert.deepEqual(selected.computerTarget, messageTarget);
  const screenshot = (code: string, store = native) => toolImageEvents({ content }, store, "cua_repl.js", false, { code })[0]!;
  assert.deepEqual(screenshot("await nodeRepl.emitImage(await messagesDemo.getScreenshot())").computerTarget, messageTarget);
  const notesTarget = { application: "com.apple.Notes", name: "备忘录", windowTitle: "备忘录" };
  toolImageEvents({ content: [{ type: "text", text: 'Window: "备忘录", App: 备忘录.' }] }, native, "cua_repl.js", false,
    JSON.stringify({ code: "const notes = await cua.getApp('com.apple.Notes')" }));
  assert.deepEqual(screenshot("await notes.getAXStateAndScreenshot()").computerTarget, notesTarget);
  assert.deepEqual(screenshot("await messagesDemo.getScreenshot()").computerTarget, messageTarget);
  assert.equal(screenshot("await unknown.getScreenshot()").computerTarget, undefined);
  assert.equal(screenshot("await messagesDemo.getScreenshot()", imageStore()).computerTarget, undefined);
  assert.equal(screenshot("await notes.getScreenshot(); await messagesDemo.getScreenshot()").computerTarget, undefined);
  assert.equal(screenshot("await tab.screenshot()").computerTarget, undefined);
  assert.equal(screenshot("await cua.getState()").computerTarget, undefined);
  const browserImages = imageStore();
  assert.equal(toolImageEvents({ content }, browserImages, "cua_repl.js", false, { code: 'let tab = await cua.getTab("tab-1", {browser:"chrome"})' })[0]!.computer, undefined);
  assert.deepEqual(toolImageEvents({ content }, browserImages, "cua_repl.js", false, { code: "await nodeRepl.emitImage(await tab.screenshot())" }), []);
  const browserFrame = toolImageEvents({ content }, imageStore(), "cua_repl.js", false,
    { code: 'await cua.createBrowserTab("iab", "about:blank")' })[0]!;
  assert.equal(browserFrame.computer, undefined);
  assert.deepEqual(screenshot("await messagesDemo.getScreenshot()").computerTarget, messageTarget);
  toolImageEvents({ isError: true, content: [{ type: "text", text: "not allowed to use the app for safety reasons" }] }, native, "cua_repl.js", false,
    { code: 'notes = await cua.getApp("com.openai.codex")' });
  assert.equal(screenshot("await notes.getScreenshot()").computerTarget, undefined);
  toolImageEvents({}, native, "cua_repl.js", false, { code: "notes = await cua.getApp(appId)" });
  assert.equal(screenshot("await notes.getScreenshot()").computerTarget, undefined);
  assert.equal(toolImageEvents({ content }, native, "cua_repl.js", false, { code: 'await cua.getApp("Unknown")' })[0]!.computerTarget, undefined);
  const changedWindow = toolImageEvents({ content: [{ type: "text", text: 'Window: "新的对话", App: 信息.' }, ...content] }, native, "cua_repl.js", false,
    { code: "await messagesDemo.getAXStateAndScreenshot()" })[0]!;
  assert.deepEqual(changedWindow.computerTarget, { ...messageTarget, windowTitle: "新的对话" });
  toolImageEvents({}, native, "cua_repl.js_reset");
  assert.equal(screenshot("await messagesDemo.getScreenshot()").computerTarget, undefined);
  const claudeNative = new ComputerToolImages();
  claudeNative.call({ id: "select", name: "js", toolset_name: "cua_repl", input: { code: 'let app = await cua.getApp("信息")' } });
  assert.deepEqual(claudeNative.result({ tool_use_id: "select", content: [{ type: "text", text: 'Window: "未命名", App: 信息.' }, ...content] }, native)[0]!.computerTarget,
    { application: "信息", name: "信息", windowTitle: "未命名" });
  for (const application of ["com.apple.Notes", "Google Chrome", "/Applications/My Editor.app"]) {
    assert.deepEqual(computerApplicationCommand({ application, name: "目标应用" }),
      { file: "/usr/bin/open", args: [application === "com.apple.Notes" ? "-b" : "-a", application] });
  }
  for (const application of ["", " ", "-a", "--args", " Notes", "Notes ", "Notes\n", "Notes\u007f", "https://example.com/", "file:///Applications/Notes.app", "relative/Notes.app", "/bin/sh", "mailto:user@example.com"]) {
    assert.throws(() => computerApplicationCommand({ application, name: "目标应用" }), /无效/);
  }
  for (const invalid of [null, [], messageTarget.application, JSON.stringify(messageTarget), { application: messageTarget.application }, { ...messageTarget, name: " " }, { ...messageTarget, windowTitle: 42 }]) {
    assert.equal(validComputerTarget(invalid), false);
  }

  appendSessionTrace("task", "codex-session", turn, first, turn);
  assert.equal(computerUseFrame("task")?.path, first.path);
  assert.equal(computerUseFrame("other"), null);
  appendSessionTrace("task", "claude-session", turn, plain, turn);
  assert.equal(computerUseFrame("task")?.sessionId, "codex-session");
  for (const name of browserTools) {
    appendSessionTrace("task", "browser-session", turn, { ...first, computer: name }, turn);
    assert.equal(computerUseFrame("task")?.sessionId, "codex-session", name);
  }
  const later = "2026-11-21T01:00:01.000Z";
  const child: AgentEvent = { kind: "tool", name: "child", nativeWork: { type: "activity", id: "child", event: claude } };
  appendSessionTrace("task", "claude-session", turn, child, later);
  assert.deepEqual(computerUseFrame("task"), { path: claude.path, tool: "computer.screenshot", at: later, sessionId: "claude-session", turnStartedAt: turn });
  appendSessionTrace("task", "codex-session", turn, first, "2026-11-21T01:00:02.000Z");
  assert.equal(computerUseFrame("task")?.path, first.path);
  assert.equal(JSON.parse(readFileSync(sessionTracePath("task", "codex-session"), "utf8").trim().split("\n")[0]!).event.computer, "cua_repl.js");
  clearComputerFrame("task", "unrelated-session");
  assert.ok(computerUseFrame("task"));
  clearComputerFrame("task", "codex-session");
  assert.equal(computerUseFrame("task"), null);
  const persistedFrame = { path: first.path, tool: "cua_repl.js", at: turn, sessionId: "codex-session", turnStartedAt: turn };
  const persistedPath = join(root, "runs", "task", "computer-preview.json");
  writeFileSync(persistedPath, JSON.stringify(persistedFrame));
  assert.deepEqual(computerUseFrame("task"), persistedFrame);
  assert.equal(activeComputerUseFrame("task"), null);
  assert.equal(markTurnActive({ sessionId: "codex-session", taskId: "task", startedAt: turn }), true);
  assert.deepEqual(activeComputerUseFrame("task"), persistedFrame);
  clearTurnActive("codex-session", turn);
  assert.equal(activeComputerUseFrame("task"), null);
  assert.equal(markTurnActive({ sessionId: "codex-session", taskId: "task", startedAt: later }), true);
  assert.equal(activeComputerUseFrame("task"), null);
  appendSessionTrace("task", "codex-session", later, selected, later);
  assert.deepEqual(activeComputerUseFrame("task")?.target, messageTarget);
  clearTurnActive("codex-session", later);
  assert.equal(activeComputerUseFrame("task"), null);
  assert.ok(computerUseFrame("task"));
  for (const target of [null, {}, JSON.stringify(messageTarget), { ...messageTarget, application: "--args" }]) {
    writeFileSync(persistedPath, JSON.stringify({ ...persistedFrame, target }));
    assert.deepEqual(computerUseFrame("task"), persistedFrame);
  }
  for (const name of browserTools) {
    writeFileSync(persistedPath, JSON.stringify({ ...persistedFrame, tool: name }));
    assert.equal(computerUseFrame("task"), null, name);
  }
  for (const field of ["path", "tool", "at", "sessionId", "turnStartedAt"] as const) {
    for (const invalid of ["", "   ", null, 123, true, {}, []]) {
      writeFileSync(persistedPath, JSON.stringify({ ...persistedFrame, [field]: invalid }));
      assert.equal(computerUseFrame("task"), null, `${field}: ${JSON.stringify(invalid)}`);
    }
  }
  assert.deepEqual(parseBrowserAction({ action: "viewport", mode: "responsive", width: 640, height: 800 }), { action: "viewport", mode: "responsive", width: 640, height: 800 });
  assert.throws(() => parseBrowserAction({ action: "viewport", mode: "invalid", width: 640, height: 800 }), /显示模式/);
  console.log("PASS computer preview: native target correlation, safe application commands, active-turn lifecycle, computer-only classification, Codex/Claude correlation, persisted frames and task isolation");
} finally {
  rmSync(root, { recursive: true, force: true });
}
