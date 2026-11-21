import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { runTestProcess } from "./test-process.mjs";
import { withTestResources } from "./test-process-resources.mjs";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS native computer preview");
  process.exit(0);
}
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "navi-computer-live-"));
let active = true;
let authorized = 0;
const server = createServer((request, response) => {
  if (request.url === "/api/tasks/task/runtime") {
    if (request.headers.cookie !== "preview_probe=known-instance") { response.writeHead(403).end(); return; }
    authorized += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ computer: active ? { sessionId: "session", turnStartedAt: "turn",
      target: { application: "com.apple.Notes", name: "备忘录", windowTitle: "Probe" } } : null }));
  } else if (request.url === "/end") { active = false; response.end("ended"); }
  else if (request.url === "/resume") { active = true; response.end("active"); }
  else if (request.url === "/iframe") { response.setHeader("content-type", "text/html"); response.end("<script>window.webkit.messageHandlers.naviComputerPreview.postMessage({id:'iframe',taskId:'task',sessionId:'session',turnStartedAt:'turn',action:'start'})</script>"); }
  else { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Computer Preview Probe</title>"); }
});
await withTestResources(async () => {
  const executable = join(temporary, "computer-preview-probe");
  await runTestProcess("swiftc", ["-swift-version", "5", "-target", "arm64-apple-macos14.0",
    ...["Sources/ComputerPreviewStream.swift", "Sources/ComputerPreviewBridge.swift", "Tests/ComputerPreview/main.swift"]
      .map((path) => join(root, "desktop/macos", path)), "-o", executable], { cwd: root });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const result = await runTestProcess(executable, [`http://127.0.0.1:${server.address().port}/`], { cwd: root, timeout: 60000 });
  process.stdout.write(result.stdout);
  assert.ok(authorized >= 3, "native layer keeps validating its own active-turn authorization");
}, [async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve())); },
  () => rmSync(temporary, { recursive: true, force: true })]);
