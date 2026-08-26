// 一次性 agent 正常退出后,它用 `&` / `start /b` 留下的后台后代也必须被收掉。
// Windows 是本测试的关键平台:父进程死后 ParentProcessId 仍保留旧 pid,只要 RunHandle
// 还没丢,cleanupAfterRun 就能从这个已死根继续遍历。POSIX 同一用例靠继承 fd 追踪。
import assert from "node:assert/strict";
import { once } from "node:events";
import { isPidAlive, killTree } from "../src/platform.js";
import { cleanupAfterRun, spawnAgent } from "../src/executors/spawn.js";

process.env.ASH_ALLOW_REAL_AGENT = "1";

const grandchildCode = "setInterval(() => {}, 1000)";
const rootCode = `
const { spawn } = require("node:child_process");
const stdio = process.platform === "win32"
  ? ["ignore", "ignore", "ignore"]
  : ["ignore", "ignore", "ignore", 3];
const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], {
  detached: true,
  windowsHide: true,
  stdio,
});
if (!child.pid) process.exit(2);
process.stdout.write(String(child.pid));
child.unref();
`;

const root = spawnAgent(process.cwd(), process.execPath, ["-e", rootCode], "");
let stdout = "";
root.stdout?.setEncoding("utf8");
root.stdout?.on("data", (chunk: string) => { stdout += chunk; });
await once(root, "close");

const grandchildPid = Number(stdout.trim());
assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1, `拿不到后台孙进程 pid: ${stdout}`);
try {
  assert.equal(isPidAlive(grandchildPid), true, "前置条件:agent 根退出后,后台孙进程确实仍活着");
  await cleanupAfterRun(root);
  assert.equal(isPidAlive(grandchildPid), false, "RunHandle 收尾必须回收已经逃逸的后台孙进程");
  console.log("agent descendant cleanup ok");
} finally {
  if (isPidAlive(grandchildPid)) killTree(grandchildPid, "SIGKILL");
}
