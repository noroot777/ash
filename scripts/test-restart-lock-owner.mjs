// 回归 restart.mjs 认「锁里那个号码还是旧实例吗」的判据(platform.mjs 的 lockHolderPid)。
//
// 事故形状:ash 没正常退出,锁留在原地,号码被别的进程复用 —— Windows 上重启过机器几乎
// 必然撞上。旧判据只看「号码还活着」,于是把陌生进程当旧实例去杀:Windows 上报「无法安全
// 终止 Windows 旧实例」拒绝重启(--force 则整树强杀它),POSIX 上直接 SIGTERM 它。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPid, isAshServerCommand, lockHolderPid, sleep } from "./platform.mjs";
import { withTestResources } from "./test-process-resources.mjs";
import { spawnTestFixture } from "./test-process-scope.mjs";

const PORT = 4317;
const ASH = "/opt/homebrew/bin/node /Users/me/ash/server/dist/index.js";
const T0 = 1_794_749_046_785;
const fixed = (info) => () => info;
const lock = (extra = {}) => ({ pid: 4242, port: PORT, processStartedAtMs: T0, ...extra });

assert.equal(lockHolderPid(lock(), PORT, fixed({ command: ASH, startedAtMs: T0 + 600 })), 4242, "同一个实例要认");
assert.equal(lockHolderPid(lock(), PORT, fixed({ command: ASH, startedAtMs: T0 + 3_600_000 })), null, "号码复用:启动时刻对不上不认");
assert.equal(lockHolderPid(lock(), PORT, fixed({ command: "C:\\Windows\\System32\\svchost.exe -k netsvcs", startedAtMs: T0 })), null, "号码上不是 ash server 不认");
assert.equal(lockHolderPid(lock(), PORT, fixed({ command: "", startedAtMs: T0 + 200 })), 4242, "命令行读不到但代次对得上:还是它");
assert.equal(lockHolderPid(lock({ processStartedAtMs: undefined }), PORT, fixed({ command: "", startedAtMs: T0 })), null, "比不了代次又读不到命令行:不认");
assert.equal(lockHolderPid(lock({ processStartedAtMs: undefined }), PORT, fixed({ command: ASH, startedAtMs: null })), 4242, "旧版本的锁:命令行是唯一证据");
assert.equal(lockHolderPid(lock(), PORT, fixed(null)), null, "号码上没进程");
assert.equal(lockHolderPid(lock({ port: 14317 }), PORT, fixed({ command: ASH, startedAtMs: T0 })), null, "别的端口的锁不认");
assert.ok(isAshServerCommand('"C:\\Program Files\\nodejs\\node.exe" D:\\ai_workspace\\ash\\server\\dist\\index.js'));
console.log("✓ 锁里的号码:代次对不上 / 不是 ash server / 无从证明,一律不当旧实例");

// 真进程:inspectPid 读出来的启动时刻要和进程自报的对得上(server 写锁用的就是自报值),
// 否则上面的判据在真机上会把活着的旧实例认丢。
const stage = mkdtempSync(join(tmpdir(), "ash-lock-owner-"));
const entry = join(stage, "server", "dist", "index.js");
const bornFile = join(stage, "born");
mkdirSync(join(stage, "server", "dist"), { recursive: true });
writeFileSync(entry, `require("node:fs").writeFileSync(${JSON.stringify(bornFile)}, String(Date.now() - Math.round(process.uptime() * 1000)));
setInterval(() => {}, 1000);`);
const fake = spawnTestFixture(process.execPath, [entry], { stdio: "ignore" });
const bystander = spawnTestFixture(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
await withTestResources(async () => {
  let born = null;
  for (let i = 0; i < 100 && born === null; i++) {
    const text = (() => { try { return readFileSync(bornFile, "utf8"); } catch { return ""; } })();
    if (text) born = Number(text);
    else await sleep(50);
  }
  assert.ok(Number.isFinite(born), "假 server 没报出启动时刻");
  assert.equal(lockHolderPid({ pid: fake.pid, port: PORT, processStartedAtMs: born }, PORT), fake.pid, "真进程:同一实例要认");
  assert.equal(lockHolderPid({ pid: fake.pid, port: PORT, processStartedAtMs: born - 3_600_000 }, PORT), null, "真进程:代次对不上不认");
  const other = inspectPid(bystander.pid);
  assert.ok(other, "旁观进程查不到");
  assert.equal(lockHolderPid({ pid: bystander.pid, port: PORT, processStartedAtMs: other.startedAtMs }, PORT), null, "真进程:不是 ash server 不认");
  console.log("✓ 真进程:启动时刻与自报值对得上,复用号码和无关进程都认得出来");
}, [() => fake.dispose(), () => bystander.dispose(), () => rmSync(stage, { recursive: true, force: true })]);
