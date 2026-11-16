// 回归 restart.mjs 认「锁里那个号码还是旧实例吗」的判据(platform.mjs 的 lockHolderPid)。
//
// 事故形状:ash 没正常退出,锁留在原地,号码被别的进程复用 —— Windows 上重启过机器几乎
// 必然撞上。旧判据只看「号码还活着」,于是把陌生进程当旧实例去杀:Windows 上报「无法安全
// 终止 Windows 旧实例」拒绝重启(--force 则整树强杀它),POSIX 上直接 SIGTERM 它。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAshServerCommand, lockHolderPid, sleep } from "./platform.mjs";
import { withTestResources } from "./test-process-resources.mjs";
import { spawnTestFixture } from "./test-process-scope.mjs";

const PORT = 4317;
const ENTRY = "/Users/me/ash/server/dist/index.js";
const ASH = `/opt/homebrew/bin/node ${ENTRY}`;
const T0 = 1_794_749_046_785;
const fixed = (info) => () => info;
const lock = (extra = {}) => ({ pid: 4242, port: PORT, processStartedAtMs: T0, argv: ["/opt/homebrew/bin/node", ENTRY], ...extra });
const seen = (command, startedAtMs = T0 - 300) => fixed({ command, startedAtMs });

assert.equal(lockHolderPid(lock(), PORT, seen(ASH)), 4242, "同一个实例要认");
assert.equal(lockHolderPid(lock(), PORT, seen(ASH, T0 + 800)), 4242, "POSIX etime 截断到秒:观察值略晚也要认");
assert.equal(lockHolderPid(lock(), PORT, seen(ASH, T0 + 3_600_000)), null, "号码复用:进程比锁晚一小时出生");
assert.equal(lockHolderPid(lock(), PORT, seen(ASH, T0 + 5_000)), null, "号码复用:进程比锁里那一刻晚 5s 出生");
assert.equal(lockHolderPid(lock(), PORT, seen("C:\\Windows\\System32\\svchost.exe -k netsvcs")), null, "号码上不是 ash server");
assert.equal(lockHolderPid(lock(), PORT, seen("/usr/local/bin/node /srv/other-app/dist/index.js")), null, "别的项目的同名入口");
assert.equal(lockHolderPid(lock(), PORT, seen("/usr/local/bin/node /Users/me/ash/mcp/dist/index.js")), null, "ash 自己的 MCP 入口也不是 server");
assert.equal(lockHolderPid(lock(), PORT, seen(`/usr/local/bin/node tool.js --entry ${ENTRY} --watch`)), null, "入口只出现在参数中间");
assert.equal(lockHolderPid(lock(), PORT, seen("")), null, "命令行读不到:证明不了");
assert.equal(lockHolderPid(lock(), PORT, fixed({ command: ASH, startedAtMs: null })), null, "启动时刻读不到:证明不了");
assert.equal(lockHolderPid(lock({ processStartedAtMs: undefined }), PORT, seen(ASH)), null, "旧版本的锁没记启动时刻:证明不了代次");
assert.equal(lockHolderPid(lock({ argv: undefined }), PORT, seen(ASH)), null, "锁里没记入口:证明不了是哪个服务");
assert.equal(lockHolderPid(lock(), PORT, fixed(null)), null, "号码上没进程");
assert.equal(lockHolderPid(lock({ port: 14317 }), PORT, seen(ASH)), null, "别的端口的锁不认");
assert.ok(isAshServerCommand('"C:\\Program Files\\nodejs\\node.exe" D:\\ai_workspace\\ash\\server\\dist\\index.js'));
console.log("✓ 锁里的号码:入口、代次任一证明不了就不当旧实例(别的项目的 dist/index.js、晚出生的进程、旧锁都不认)");

// 真进程:inspectPid 读出来的启动时刻要和进程自报的对得上(server 写锁用的就是自报值),
// 否则上面的判据在真机上会把活着的旧实例认丢。旁观者是另一个项目的 `dist/index.js` ——
// 它也命中「像 ash」的宽泛正则,能拦住它的只有入口比对。
const stage = mkdtempSync(join(tmpdir(), "ash-lock-owner-"));
const reporter = (bornFile) => `require("node:fs").writeFileSync(${JSON.stringify(bornFile)}, String(Date.now() - Math.round(process.uptime() * 1000)));
setInterval(() => {}, 1000);`;
const entry = join(stage, "ash", "server", "dist", "index.js");
const otherEntry = join(stage, "other-app", "dist", "index.js");
mkdirSync(join(stage, "ash", "server", "dist"), { recursive: true });
mkdirSync(join(stage, "other-app", "dist"), { recursive: true });
writeFileSync(entry, reporter(join(stage, "ash.born")));
writeFileSync(otherEntry, reporter(join(stage, "other.born")));
const fake = spawnTestFixture(process.execPath, [entry], { stdio: "ignore" });
const bystander = spawnTestFixture(process.execPath, [otherEntry], { stdio: "ignore" });
const bornOf = async (file) => {
  for (let i = 0; i < 100; i++) {
    const text = (() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })();
    if (text) return Number(text);
    await sleep(50);
  }
  return NaN;
};
await withTestResources(async () => {
  const born = await bornOf(join(stage, "ash.born"));
  const otherBorn = await bornOf(join(stage, "other.born"));
  assert.ok(Number.isFinite(born) && Number.isFinite(otherBorn), "fixture 没报出启动时刻");
  const ashLock = (pid, processStartedAtMs) => ({ pid, port: PORT, processStartedAtMs, argv: [process.execPath, entry] });
  assert.equal(lockHolderPid(ashLock(fake.pid, born), PORT), fake.pid, "真进程:同一实例要认");
  assert.equal(lockHolderPid(ashLock(fake.pid, born - 5_000), PORT), null, "真进程:锁里那一刻早于它出生 5s,是后来的进程");
  assert.equal(lockHolderPid(ashLock(bystander.pid, otherBorn), PORT), null, "真进程:号码上是别的项目的 dist/index.js");
  console.log("✓ 真进程:启动时刻与自报值对得上,复用号码和别的 Node 服务都认得出来");
}, [() => fake.dispose(), () => bystander.dispose(), () => rmSync(stage, { recursive: true, force: true })]);
