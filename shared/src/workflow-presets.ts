// 系统自带的起手式 —— 「自带」只意味着**开箱就有**，不意味着不能动：
// 用户可以就地改（覆写行存在 workflows 表里，key 相同），改坏了按「恢复系统默认」
// 就是删掉那行、回落到这里的定义；删不掉但可以停用。所以这份常量是**兜底**，
// 不是运行时唯一的真相 —— 真相由 server 的 workflows.ts 合并覆写后给出。
import type { StepKind, WorkflowDef, WorkflowStep } from "./workflow.ts";
import { makeStep } from "./workflow.ts";

export interface BuiltinWorkflow {
  key: string;
  name: string;
  desc: string;
}

// 「回到某一步重做」一律指向第一站（那是唯一一定存在的 run 站）
type Row = [StepKind, Partial<Record<string, unknown>>?];

function build(rows: Row[], workspace: WorkflowDef["workspace"], backRounds?: Partial<Record<StepKind, number>>): WorkflowDef {
  const steps: WorkflowStep[] = rows.map(([kind, params], i) => {
    const step = makeStep(kind, `s${i + 1}`);
    if (params) Object.assign(step.p as Record<string, unknown>, params);
    return step;
  });
  const first = steps[0]!.id;
  for (const step of steps) {
    const rounds = backRounds?.[step.kind];
    if (!rounds || !step.fail || step.id === first) continue;
    step.fail = { mode: "back", backTo: first, max: rounds };
  }
  return { workspace, steps };
}

const BUILDERS: Record<string, () => WorkflowDef> = {
  blank: () => build([["run"]], "isolated"),
  fast: () => build([["run"]], "shared"),
  standard: () => build(
    [["run"], ["verify", { checks: ["build", "tests"] }], ["human"], ["accept"]],
    "isolated",
    { verify: 2, human: 2 },
  ),
  frontend: () => build(
    [
      ["run"],
      ["verify", { checks: ["build", "browser"] }],
      ["preview", { cmd: "npm run dev", life: "gate" }],
      ["human", { show: ["diff", "report", "shots"] }],
      ["accept"],
    ],
    "isolated",
    { verify: 2, human: 2 },
  ),
  release: () => build(
    [
      ["run"],
      ["verify", { checks: ["build", "tests", "lint"] }],
      ["human"],
      ["accept"],
      ["command", { cmd: "./scripts/release.sh", where: "repo" }],
    ],
    "isolated",
    { verify: 2, human: 2 },
  ),
};

export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflow[] = Object.freeze([
  { key: "blank", name: "空白", desc: "从一步开始，自己搭" },
  { key: "fast", name: "极速原型", desc: "干完就算完" },
  { key: "standard", name: "标准交付", desc: "验证 → 人工点头 → 合并" },
  { key: "frontend", name: "前端真实验收", desc: "验证 → 起预览 → 人工点头 → 合并" },
  { key: "release", name: "发布流水", desc: "验证 → 人工点头 → 合并 → 跑发布脚本" },
]);

export const DEFAULT_WORKFLOW_KEY = "standard";

export function isBuiltinKey(key: unknown): key is string {
  return typeof key === "string" && key in BUILDERS;
}

// 每次都现造一份，调用方随便改
export function builtinWorkflowDef(key: string): WorkflowDef | null {
  const make = BUILDERS[key];
  return make ? make() : null;
}
