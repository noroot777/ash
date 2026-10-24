import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

console.log("[accept-test] 运行前端全量回归…");
const result = spawnSync(NPM, ["run", "test:web"], {
  ...NPM_SPAWN_OPTS,
  cwd: repo,
  stdio: "inherit",
});

if (result.error) console.error(`[accept-test] 无法启动回归：${result.error.message}`);
if (result.signal) console.error(`[accept-test] 回归被信号 ${result.signal} 终止。`);
const status = result.status ?? 1;
console.log(status === 0 ? "[accept-test] 前端回归通过。" : "[accept-test] 前端回归未通过，阻止验收。");
process.exit(status);
