import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { ClaudeExecutor } from "../src/executors/claude.js";
import type { RunHandle } from "../src/executors/types.js";
import { IS_WINDOWS } from "../src/platform.js";

process.env.ASH_ALLOW_REAL_AGENT = "1";
const root = mkdtempSync(join(tmpdir(), "ash-claude-steer-ack-"));
const requestPath = join(root, "request-id");
const gatePath = join(root, "ack-gate");
const newInputPath = join(root, "new-input");
const script = join(root, "fake-claude.mjs");
const bin = IS_WINDOWS ? join(root, "claude.cmd") : script;
let handle: RunHandle | null = null;

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

try {
  writeFileSync(script, `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let users = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    writeFileSync(${JSON.stringify(requestPath)}, message.request_id);
    const timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(gatePath)})) return;
      clearInterval(timer);
      emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
      emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "interrupted", session_id: "ack-session" });
    }, 10);
    return;
  }
  if (message.type !== "user") return;
  users += 1;
  if (users === 1) return emit({ type: "system", session_id: "ack-session" });
  writeFileSync(${JSON.stringify(newInputPath)}, message.message.content[0].text);
  emit({ type: "result", subtype: "success", session_id: "ack-session" });
});
`);
  if (IS_WINDOWS) writeFileSync(bin, `@node "%~dp0fake-claude.mjs" %*\r\n`);
  else chmodSync(bin, 0o755);

  handle = new ClaudeExecutor({ bin }).runSteerable({ cwd: root, prompt: "OLD" });
  const events: AgentEvent[] = [];
  const consuming = (async () => { for await (const event of handle!.events) events.push(event); })();
  let resolved = false;
  const steering = handle.steer!("NEW").then(() => { resolved = true; });
  await waitFor(() => existsSync(requestPath), "fixture 收到 interrupt");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resolved, false, "只写入 stdin 不能算 interrupt 已确认");
  assert.equal(existsSync(newInputPath), false, "control_response 前不得把新方向送进 CLI");

  writeFileSync(gatePath, "ack");
  await steering;
  await waitFor(() => existsSync(newInputPath), "ACK 后收到新方向");
  assert.equal(readFileSync(newInputPath, "utf8"), "NEW");
  await Promise.race([
    consuming,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Claude steer 流未收尾")), 5_000)),
  ]);
  assert.ok(events.some((event) => event.kind === "done" && event.exitStatus === 0));
  console.log("✓ Claude 原生引导等待真实 control_response 后才发送新方向");
} finally {
  handle?.kill();
  await handle?.cleanup?.().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
