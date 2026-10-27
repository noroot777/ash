import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (/^ASH_(?:DB|RUNS_DIR)$/i.test(key)) delete environment[key];
}

const phases = [
  ["后端核心回归", ["-w", "server", "run", "test:accept"]],
  ["前端全量回归", ["run", "test:web"]],
];

for (const [label, args] of phases) {
  console.log(`[accept-test] 运行${label}…`);
  const result = spawnSync(NPM, args, {
    ...NPM_SPAWN_OPTS,
    cwd: repo,
    stdio: "inherit",
    env: environment,
  });
  if (result.error) console.error(`[accept-test] 无法启动${label}：${result.error.message}`);
  if (result.signal) console.error(`[accept-test] ${label}被信号 ${result.signal} 终止。`);
  const status = result.status ?? 1;
  if (status !== 0) {
    console.log(`[accept-test] ${label}未通过，阻止验收。`);
    process.exit(status);
  }
  console.log(`[accept-test] ${label}通过。`);
}
process.exit(0);
