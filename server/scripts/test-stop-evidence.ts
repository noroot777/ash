import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { IS_WINDOWS } from "../src/platform.js";
import { processAlive } from "../src/terminal-process-tree.js";
import { inspectPid } from "../src/service-ports-probe.js";
import { mergeStop } from "../src/terminal-stop-facts.js";
import type { StopFact } from "../src/terminal-session-facts.js";

let incomplete: StopFact = mergeStop({ kind: "none" }, {
  kind: "unresolved", pids: [], complete: false, why: "enumeration incomplete",
});
assert.deepEqual(mergeStop(incomplete, { kind: "verified" }), incomplete);
assert.deepEqual(mergeStop({ kind: "unresolved", pids: [], complete: true, why: "all known members exited" }, {
  kind: "verified",
}), { kind: "verified" });

if (!IS_WINDOWS) {
  const originalKill = process.kill;
  try {
    process.kill = (() => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); }) as typeof process.kill;
    assert.equal(processAlive(process.pid), true);
    process.kill = (() => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); }) as typeof process.kill;
    assert.equal(processAlive(process.pid), false);
  } finally { process.kill = originalKill; }
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = once(child, "exit");
  const childPid = child.pid!;
  try {
    incomplete = mergeStop(incomplete, {
      kind: "unresolved", pids: [childPid], complete: true, why: "known member remains",
    });
    assert.equal(incomplete.kind, "unresolved");
    assert.ok(incomplete.kind === "unresolved" && !incomplete.complete);
    assert.ok(incomplete.kind === "unresolved" && incomplete.pids.includes(childPid));
    assert.equal(mergeStop(incomplete, { kind: "verified" }).kind, "unresolved");
    const complete = mergeStop({ kind: "none" }, {
      kind: "unresolved", pids: [childPid], complete: true, why: "known member remains",
    });
    const unknownWithPid = mergeStop(complete, {
      kind: "unresolved", pids: [], complete: false, why: "another enumeration failed",
    });
    assert.ok(unknownWithPid.kind === "unresolved" && !unknownWithPid.complete);
    type InspectionExec = NonNullable<Parameters<typeof inspectPid>[2]>;
    const failures = [{ killed: true }, { code: "ENOENT" }, { code: "EACCES" }];
    for (const failure of failures) {
      const exec = (async () => { throw failure; }) as InspectionExec;
      assert.equal((await inspectPid(childPid, 100, exec)).state, "unknown");
    }
    const malformed = (async () => ({ stdout: "unparseable", stderr: "" })) as InspectionExec;
    assert.equal((await inspectPid(childPid, 100, malformed)).state, "unknown");
    assert.equal((await inspectPid(childPid)).state, "found");
    child.kill("SIGKILL");
    await exited;
    const afterExit = mergeStop(incomplete, { kind: "verified" });
    assert.ok(afterExit.kind === "unresolved" && !afterExit.complete);
    assert.deepEqual(afterExit.pids, []);
    assert.equal(afterExit.why, "enumeration incomplete");
    assert.deepEqual(mergeStop(complete, { kind: "verified" }), { kind: "verified" });
    assert.equal(mergeStop(unknownWithPid, { kind: "verified" }).kind, "unresolved");
    assert.equal((await inspectPid(childPid, 100, malformed)).state, "gone");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}

console.log("stop evidence passed: completeness survives PID merges and inspection failures stay unknown");
