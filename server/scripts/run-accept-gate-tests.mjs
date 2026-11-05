import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 用法：node scripts/run-accept-gate-tests.mjs <test-accept-gate-*.ts>…
// 给编排类门禁回归套上进程组夹具再跑。生产进程/恢复那几条不经过这里，在 package.json 里直接
// tsx 跑，不加载夹具。每条在 test:accept-gate 里各占一个叶子：以前十九条串在一个进程里，并行
// 门禁的总墙钟就被这一条叶子定死了。
const scripts = process.argv.slice(2);
if (scripts.length === 0) {
  console.error("[gate-tests] 用法：node scripts/run-accept-gate-tests.mjs <test-accept-gate-*.ts>…");
  process.exit(2);
}
const fixture = process.platform !== "win32";
const testHook = fileURLToPath(new URL("./accept-gate-test-confinement.mjs", import.meta.url));
const env = fixture ? { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(testHook)}` } : process.env;
if (fixture) console.log("[gate-tests] 编排回归使用进程组夹具，不代表生产平台支持可靠围栏；生产进程/恢复测试独立运行且不加载夹具。");
for (const script of scripts) {
  const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL(script, import.meta.url))], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
