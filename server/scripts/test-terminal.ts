import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTerminalDirectory, TerminalSessionManager } from "../src/terminal.js";

const cwd = mkdtempSync(join(tmpdir(), "harness-terminal-"));
const manager = new TerminalSessionManager();

try {
  assert.equal(resolveTerminalDirectory("~"), homedir());
  const session = manager.create("project-test", cwd, {
    shell: "/bin/sh",
    shellArgs: [],
    cols: 80,
    rows: 20,
  });
  let output = "";
  let unsubscribe: (() => void) | null = null;
  const received = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`terminal output timed out: ${JSON.stringify(output)}`));
    }, 5000);
    unsubscribe = manager.subscribe(session.id, "project-test", (event) => {
      if (event.type !== "data") return;
      output += event.data;
      if (output.includes("__HARNESS_TERMINAL_OK__") && output.includes(cwd)) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  assert.ok(unsubscribe);
  assert.equal(manager.get(session.id, "wrong-project"), null);
  assert.equal(manager.resize(session.id, "project-test", 110, 32), true);
  assert.equal(manager.write(session.id, "project-test", "printf '__HARNESS_TERMINAL_OK__\\n'; pwd\n"), true);
  await received;
  assert.ok(manager.eventsAfter(session.id, "project-test", 0)?.length);
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 0);
  assert.ok(manager.get(session.id, "project-test"));
  unsubscribe();
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 1);
  assert.equal(manager.get(session.id), null);
  console.log("terminal session test passed");
} finally {
  manager.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
