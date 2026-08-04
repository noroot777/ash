// 工作流定义层的闸（shared/src/workflow.ts）。
//
// 这条线是用户自己编排的，所以「什么线不许存」必须只有一处口径：前端编排器和
// 服务端 API 读同一个 checkWorkflow，界面上放行、存进去被拒这种事不该发生。
// 这份测试钉住的就是那份口径本身 —— 尤其是**合并之前必须有人点过头**：
// 合并不可逆，一旦这条闸松了，用户编排出一条「AI 干完直接合进主干」的线，
// 出事时没有任何一刻可以叫停。
//
// 跑法：npm -w server run test:workflow
import {
  MAX_WORKFLOW_STEPS, checkWorkflow, isWorkflowUsable, makeStep, normalizeWorkflowDef,
} from "@harness/shared/workflow";
import type { StepKind, WorkflowDef, WorkflowStep } from "@harness/shared/workflow";
import { BUILTIN_WORKFLOWS, builtinWorkflowDef } from "@harness/shared/workflow-presets";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

function line(kinds: StepKind[], workspace: WorkflowDef["workspace"] = "isolated"): WorkflowDef {
  return { workspace, steps: kinds.map((k, i) => makeStep(k, `s${i + 1}`)) };
}
const denials = (def: WorkflowDef) => checkWorkflow(def).filter((i) => i.level === "deny").map((i) => i.text);
const warnings = (def: WorkflowDef) => checkWorkflow(def).filter((i) => i.level === "warn").map((i) => i.text);

// ── 内置起手式必须全部合法 ────────────────────────────────────────────────
// 装在产品里的东西自己过不了自己的闸，是最尴尬的一种 bug。
for (const b of BUILTIN_WORKFLOWS) {
  const def = builtinWorkflowDef(b.key);
  check(`内置「${b.name}」存在`, !!def, true);
  check(`内置「${b.name}」通过闸`, def ? denials(def) : ["缺失"], []);
}
check("内置 key 认得出来", builtinWorkflowDef("nope"), null);
// 每次现造一份：改了返回值不该污染下一个调用方
const a = builtinWorkflowDef("standard")!;
a.steps[0]!.p = { ...a.steps[0]!.p, instruction: "被改过" } as WorkflowStep["p"];
check("内置定义每次现造", (builtinWorkflowDef("standard")!.steps[0]!.p as { instruction: string | null }).instruction, null);

// ── deny：结构性的错 ──────────────────────────────────────────────────────
check("没有 run 站", denials(line(["verify"])), ["没有「让 AI 干活」这一站，任务不会开工"]);
check("空线", denials({ workspace: "isolated", steps: [] }), ["一条线至少要有一站"]);
check("合并前没人点头", denials(line(["run", "accept"])), ["合并之前必须有一站「等我点头」"]);
check("点头在合并之后不算数", denials(line(["run", "accept", "human"])), ["合并之前必须有一站「等我点头」"]);
check("点头在前就放行", denials(line(["run", "human", "accept"])), []);
check("两站合并", denials(line(["run", "human", "accept", "accept"])), ["「合并并清理」只能有一站"]);
check("预览之后没人看", denials(line(["run", "preview"])), ["预览起来之后没有人工关口，没人会去看它"]);
check("预览之后有人看", denials(line(["run", "preview", "human"])), []);

// 回拐：只能往前，且必须指到真实存在的站
const back = line(["run", "verify"]);
back.steps[1]!.fail = { mode: "back", backTo: "s1", max: 2 };
check("回拐到前面", denials(back), []);
back.steps[1]!.fail = { mode: "back", backTo: "s9", max: 2 };
check("回拐指向不存在的站", denials(back), ["「回到某一步重做」没指到有效的站"]);
back.steps[1]!.fail = { mode: "back", backTo: "s2", max: 2 };
check("回拐指向自己", denials(back), ["只能回到前面的站，不能往后跳"]);
back.steps[1]!.fail = { mode: "back", backTo: "s1", max: 9 };
check("重做轮数越界", denials(back), ["重做轮数只能是 1..5"]);

// ── warn：能跑，但多半不是你要的 ──────────────────────────────────────────
const noChecks = line(["run", "verify"]);
(noChecks.steps[1]!.p as { checks: string[] }).checks = [];
check("验证站没选验什么只是提醒", denials(noChecks), []);
check("——并且真的提醒了", warnings(noChecks), ["这一站没选验什么，会直接通过"]);
check("共享工作区里谈合并", warnings(line(["run", "human", "accept"], "shared")), [
  "直接在项目目录里干活，「合并」这一站没什么可合的",
]);
check("isWorkflowUsable 只看 deny", isWorkflowUsable(noChecks), true);

// ── normalize：任意 JSON 进来 ────────────────────────────────────────────
check("非对象", normalizeWorkflowDef(null).error, "工作流定义必须是对象");
check("空 steps", normalizeWorkflowDef({ steps: [] }).error, "steps 至少要有一站");
check("不认识的 kind", normalizeWorkflowDef({ steps: [{ kind: "deploy" }] }).error, "第 1 站的 kind 不认识：deploy");
check("id 重复", normalizeWorkflowDef({ steps: [{ id: "x", kind: "run" }, { id: "x", kind: "run" }] }).error, "站的 id 重复：x");
check("超上限", normalizeWorkflowDef({ steps: Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, () => ({ kind: "run" })) }).error,
  `一条线最多 ${MAX_WORKFLOW_STEPS} 站`);
check("闸也拦 normalize", normalizeWorkflowDef({ steps: [{ kind: "run" }, { kind: "accept" }] }).error,
  "合并之前必须有一站「等我点头」");

// 枚举越界回落到默认值，而不是整条作废 —— 手写 JSON / 老数据都得能进来
const loose = normalizeWorkflowDef({
  workspace: "nonsense",
  steps: [
    { kind: "run", p: { instruction: "  只改这个模块  ", executorId: 42 } },
    { kind: "verify", p: { checks: ["build", "build", "nope", "lint"] } },
    { kind: "command", p: { cmd: "npm test", where: "moon" } },
    { kind: "human" },
  ],
});
check("越界的 workspace 回落", loose.def?.workspace, "isolated");
check("字符串两头空白被吃掉", (loose.def?.steps[0]!.p as { instruction: string }).instruction, "只改这个模块");
check("类型不对的字段回落成 null", (loose.def?.steps[0]!.p as { executorId: string | null }).executorId, null);
check("checks 去重去非法", (loose.def?.steps[1]!.p as { checks: string[] }).checks, ["build", "lint"]);
check("越界的枚举回落", (loose.def?.steps[2]!.p as { where: string }).where, "workspace");
check("没给 id 就按位置补", loose.def?.steps.map((s) => s.id), ["s1", "s2", "s3", "s4"]);
check("preview 没有失败分支", normalizeWorkflowDef({
  steps: [{ kind: "run" }, { kind: "preview", fail: { mode: "stop", max: 2 } }, { kind: "human" }],
}).def?.steps[1]!.fail, null);

// 悬空的 backTo 就地降级成「停下等人」，而不是让整条线作废
const dangling = normalizeWorkflowDef({
  steps: [{ id: "a", kind: "run" }, { id: "b", kind: "verify", fail: { mode: "back", backTo: "ghost", max: 3 } }],
});
check("悬空回拐降级", dangling.def?.steps[1]!.fail, { mode: "stop", backTo: null, max: 3 });

// 幂等：内置 → JSON → normalize 应当原样回来，否则存一次盘就漂一次
for (const b of BUILTIN_WORKFLOWS) {
  const def = builtinWorkflowDef(b.key)!;
  const round = normalizeWorkflowDef(JSON.parse(JSON.stringify(def)));
  check(`「${b.name}」存盘再读回不漂`, round.def, def);
}

console.log(failures ? `\n${failures} 处不符` : "\n工作流定义层的闸全部符合预期");
process.exit(failures ? 1 : 0);
