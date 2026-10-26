import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = process.platform !== "win32";
const testHook = fileURLToPath(new URL("./accept-gate-test-confinement.mjs", import.meta.url));
const env = fixture ? { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(testHook)}` } : process.env;
if (fixture) console.log("[gate-tests] 编排回归使用进程组夹具，不代表生产平台支持可靠围栏；生产进程/恢复测试独立运行且不加载夹具。");
const commandOnly = process.argv.includes("--command-only");
const orchestrated = commandOnly ? ["test-accept-gate-command.ts"]
  : ["test-accept-gate.ts", "test-accept-gate-readonly.ts", "test-accept-gate-identity.ts", "test-accept-gate-pending.ts", "test-accept-gate-command.ts"];
for (const script of orchestrated) {
  const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL(script, import.meta.url))], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const script of commandOnly ? [] : ["test-accept-gate-source.ts", "test-accept-gate-links.ts", "test-accept-gate-borrow.ts",
  "test-accept-gate-relocate.ts", "test-accept-gate-runs-inside.ts", "test-accept-gate-process.ts"]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL(script, import.meta.url))], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
