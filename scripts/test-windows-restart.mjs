import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { windowsRestartPlan, windowsRestartTargets, windowsTerminateScript } from "./windows-restart.mjs";
import { IS_WINDOWS, killServerProcess, listProcesses } from "./platform.mjs";

const row = (pid, ppid, created, command = "node fixture.mjs") => ({ pid, ppid, created: String(created), command });
const rows = [row(10, 1, 100), row(11, 10, 110), row(12, 10, 90), row(13, 12, 120), row(14, 11, 120)];
assert.deepEqual(windowsRestartTargets(rows, 10, []).map((entry) => entry.pid), [10, 11, 14]);
assert.deepEqual(windowsRestartTargets(rows, 10, [11]).map((entry) => entry.pid), [10]);
assert.throws(() => windowsRestartTargets([...rows, { ...row(15, 11, 120), created: "" }], 10, []));
const unreadable = [...rows, row(15, 11, 120, ""), row(16, 15, 130)];
assert.deepEqual(windowsRestartPlan(unreadable, 10, []), { targets: [rows[0], rows[1], rows[4]], preservedPids: [15] });
assert.deepEqual(windowsRestartTargets(unreadable, [10], [11]).map((entry) => entry.pid), [10]);
assert.throws(() => windowsRestartTargets(unreadable, [10, 16], []), /受保护子树/);
assert.throws(() => windowsRestartTargets([row(10, 1, 100, "")], 10, []), /身份不完整/);
assert.throws(() => windowsRestartTargets([{ ...row(10, 1, 100), ppid: null }], 10, []), /身份不完整/);
assert.ok(windowsTerminateScript([row(10, 1, 100)]).includes("GetProcessTimes"));
console.log("✓ 排除陈旧父号,未知代次/服务端身份拒杀,未知后代整棵保留");

if (IS_WINDOWS) {
  const fixture = childProcess.spawn(process.execPath, ["-e", "setInterval(()=>{},1000);\nvoid 'tab\t汉字';"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { fixture.once("spawn", resolve); fixture.once("error", reject); });
  const original = childProcess.execFileSync;
  try {
    for (const protect of [[], [fixture.pid]]) {
      let kills = 0;
      childProcess.execFileSync = (file, args, options) => {
        const index = args?.indexOf("-EncodedCommand") ?? -1;
        const script = index >= 0 ? Buffer.from(args[index + 1], "base64").toString("utf16le") : "";
        if (script.includes("Get-CimInstance Win32_Process")) throw new Error("test CIM unavailable");
        if (String(file).toLowerCase().includes("taskkill")) kills++;
        return original(file, args, options);
      };
      syncBuiltinESMExports();
      assert.throws(() => killServerProcess(fixture.pid, protect), /进程表/);
      assert.equal(kills, 0);
      assert.doesNotThrow(() => process.kill(fixture.pid, 0));
    }
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
    const actual = listProcesses().find((entry) => entry.pid === fixture.pid);
    assert.ok(actual?.created);
    assert.ok(actual.command.includes("\n") && actual.command.includes("汉字"));
    const changed = { ...actual, created: String(BigInt(actual.created) + 10_000_000n) };
    const script = windowsTerminateScript([actual, changed]);
    const result = childProcess.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8" });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotThrow(() => process.kill(fixture.pid, 0), "代次不符时不能下刀");
    assert.equal(killServerProcess(fixture.pid), "selective");
    console.log("✓ 原生 Windows:查询失败不下刀,代次变化拒杀,绑定句柄正常终止");
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
    try { fixture.kill(); } catch {}
  }
}

if (IS_WINDOWS) await import("./test-windows-restart-preservation.mjs");
