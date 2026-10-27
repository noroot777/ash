import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (/^ASH_(?:DB|RUNS_DIR)$/i.test(key)) delete environment[key];
}

// 验收前置命令跑哪几条。加一条的判据：它拦的是**无声退化**——不跑就没有任何人会发现的
// 那一类。提示词体积属于这一类：注入给模型的字数涨上去不会报任何错，只会在几个月后变成
// 一张「每回合读 39.7M token」的账单；它现在由后端那一步带进来（test:accept → test:review
// → test-prompt-budget），所以这里**不要**再单列一条，单列就是同一条跑两遍。
const STEPS = [
  { label: "后端核心回归", args: ["-w", "server", "run", "test:accept"] },
  { label: "前端全量回归", args: ["run", "test:web"] },
];

for (const { label, args } of STEPS) {
  console.log(`[accept-test] 运行${label}…`);
  const result = spawnSync(NPM, args, { ...NPM_SPAWN_OPTS, cwd: repo, stdio: "inherit", env: environment });
  if (result.error) console.error(`[accept-test] 无法启动${label}：${result.error.message}`);
  if (result.signal) console.error(`[accept-test] ${label}被信号 ${result.signal} 终止。`);
  const status = result.status ?? 1;
  if (status !== 0) {
    console.log(`[accept-test] ${label}未通过，阻止验收。`);
    process.exit(status);
  }
  console.log(`[accept-test] ${label}通过。`);
}

console.log("[accept-test] 验收前置检查全部通过。");
process.exit(0);
