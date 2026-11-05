import { fileURLToPath } from "node:url";
import { runSteps } from "./test-runner.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (/^ASH_(?:DB|RUNS_DIR)$/i.test(key)) delete environment[key];
}

// 验收前置命令跑哪几条。加一条的判据：它拦的是**无声退化**——不跑就没有任何人会发现的
// 那一类。提示词体积属于这一类：注入给模型的字数涨上去不会报任何错，只会在几个月后变成
// 一张「每回合读 39.7M token」的账单；它现在由后端那一步带进来（test:accept → test:review
// → test-prompt-budget），所以这里**不要**再单列一条，单列就是同一条跑两遍。
//
// 两步的叶子进同一个并行池子（scripts/test-runner.mjs），任何一条红就收掉在跑的、拒绝验收。
const STEPS = [
  { label: "后端核心回归", workspace: "server", script: "test:accept" },
  { label: "前端全量回归", workspace: "web", script: "test" },
];

console.log(`[accept-test] 运行${STEPS.map((step) => step.label).join("、")}…`);
let outcome;
try {
  outcome = await runSteps(repo, STEPS.map((step) => ({
    ...step,
    onPass: () => console.log(`[accept-test] ${step.label}通过。`),
  })), { env: environment });
} catch (error) {
  console.log(`[accept-test] 无法展开测试清单：${error.message}，阻止验收。`);
  process.exit(1);
}
const { leaf, code } = outcome;

if (code !== 0) {
  const step = STEPS[leaf?.step];
  console.log(`[accept-test] ${step ? `${step.label}未通过` : outcome.reason ?? "回归被中断"}${leaf?.command ? `（${leaf.label}）` : ""}，阻止验收。`);
  process.exit(code);
}

console.log("[accept-test] 验收前置检查全部通过。");
process.exit(0);
