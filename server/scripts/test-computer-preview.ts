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
const { computerUseFrame, clearComputerFrame } = await import("../src/computer-preview.js");
const { appendSessionTrace, sessionTracePath } = await import("../src/transcript.js");
const { parseBrowserAction } = await import("@navi/shared/task-runtime");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const content = [{ type: "image", data: png, mimeType: "image/png" }];
const turn = "2026-11-21T01:00:00.000Z";

try {
  for (const name of ["computer", "computer.screenshot", "cua_repl.js", "mcp__cua_repl__js", "cua_repl.js", "mcp__claude_in_chrome__computer", "playwright.browser_take_screenshot"]) {
    assert.equal(isComputerTool(name), true, name);
  }
  for (const name of ["Read", "image_gen", "mcp__grok_it__grok_image_generate", "mcp__node_repl__js", "not_computer.screenshot"]) {
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

  const tracker = new ComputerToolImages();
  tracker.call({ id: "computer", name: "screenshot", toolset_name: "computer" });
  tracker.call({ id: "file", name: "Read" });
  assert.equal(tracker.result({ tool_use_id: "file", content }, imageStore())[0]?.computer, undefined);
  const claude = tracker.result({ tool_use_id: "computer", content }, imageStore())[0]!;
  assert.equal(claude.computer, "computer.screenshot");
  assert.equal(tracker.result({ tool_use_id: "unknown", content }, imageStore())[0]?.computer, undefined);
  const dynamic = toolImageEvents([{ type: "image", imageUrl: `data:image/png;base64,${png}` }], imageStore(), "cua_repl.js")[0]!;
  assert.ok(dynamic.computer);

  appendSessionTrace("task", "codex-session", turn, first, turn);
  assert.equal(computerUseFrame("task")?.path, first.path);
  assert.equal(computerUseFrame("other"), null);
  appendSessionTrace("task", "claude-session", turn, plain, turn);
  assert.equal(computerUseFrame("task")?.sessionId, "codex-session");
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
  for (const field of ["path", "tool", "at", "sessionId", "turnStartedAt"] as const) {
    for (const invalid of ["", "   ", null, 123, true, {}, []]) {
      writeFileSync(persistedPath, JSON.stringify({ ...persistedFrame, [field]: invalid }));
      assert.equal(computerUseFrame("task"), null, `${field}: ${JSON.stringify(invalid)}`);
    }
  }
  assert.deepEqual(parseBrowserAction({ action: "viewport", mode: "responsive", width: 640, height: 800 }), { action: "viewport", mode: "responsive", width: 640, height: 800 });
  assert.throws(() => parseBrowserAction({ action: "viewport", mode: "invalid", width: 640, height: 800 }), /显示模式/);
  console.log("PASS computer preview: Codex/Claude correlation, screenshot reuse, dynamic images, validated persisted frames, child activity, task isolation and deletion");
} finally {
  rmSync(root, { recursive: true, force: true });
}
