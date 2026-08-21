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
  MAX_WORKFLOW_STEPS, SINGLETON_KINDS, STEP_LABELS,
  checkWorkflow, isWorkflowUsable, makeStep, normalizeWorkflowDef,
} from "@ash/shared/workflow";
import type { StepKind, WorkflowDef, WorkflowStep } from "@ash/shared/workflow";
import { BUILTIN_WORKFLOWS, builtinWorkflowDef } from "@ash/shared/workflow-presets";

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
check("预览之后没人看", denials(line(["run", "preview"])), ["预览起来之后没有人工关口，没人会去看它"]);
check("预览之后有人看", denials(line(["run", "preview", "human"])), []);

// 只剩两种站每条线至多一个:「让 AI 干活」是这条线的起点(两个起点说不清从哪儿开工),
// 「合并并清理」是终局的不可逆动作(合两遍没有意义)。
//
// 「自动验证」「等我点头」曾经也在这张名单上,理由是执行链被唤醒时只说得清「哪一类
// 锚点过去了」、说不清是第几个。那个理由已经不成立:任务身上记着游标 `workflow_at`,
// 段落按**站的 id** 切,所以想画几站验证、几道关口都行(见 test-workflow-run.ts)。
for (const kind of SINGLETON_KINDS) {
  const dup = line(["run", "human", kind, kind]);
  check(`两站「${STEP_LABELS[kind]}」`, denials(dup).includes(`「${STEP_LABELS[kind]}」只能有一站`), true);
}
check("干活站在名单上", SINGLETON_KINDS.includes("run" as never), true);
check("合并站在名单上", SINGLETON_KINDS.includes("accept" as never), true);
check("验证站不在名单上了", SINGLETON_KINDS.includes("verify" as never), false);
check("人工关口不在名单上了", SINGLETON_KINDS.includes("human" as never), false);
// 反过来:除那两站之外都可以重复,自由编排靠的就是它们
check("命令站可以来好几遍", denials(line(["run", "command", "verify", "command", "human", "command"])), []);
check("预览起两次也行", denials(line(["run", "preview", "preview", "human"])), []);
check("验两遍:先粗验再细验", denials(line(["run", "verify", "command", "verify", "human"])), []);
check("两道关口:中途放行一次,最后再点一次头", denials(line(["run", "human", "command", "human", "accept"])), []);
check(
  "验一次点一次头再验一次点一次头",
  denials(line(["run", "verify", "human", "command", "verify", "human", "accept"])),
  [],
);

// 失败策略只剩「怎么办 + 几轮」两个旋钮,轮数有边界
const back = line(["run", "verify"]);
back.steps[1]!.fail = { mode: "back", max: 2 };
check("打回重做", denials(back), []);
back.steps[1]!.fail = { mode: "ask", max: 1 };
check("问我一句", denials(back), []);
back.steps[1]!.fail = { mode: "back", max: 9 };
check("重做轮数越界", denials(back), ["重做轮数只能是 1..5"]);
back.steps[1]!.fail = { mode: "back", max: 0 };
check("重做轮数不能是 0", denials(back), ["重做轮数只能是 1..5"]);
// 停不下来的站没有失败分支可谈:makeStep 就不给它挂
check("人工关口没有失败分支", makeStep("human", "h").fail, null);
check("预览站没有失败分支", makeStep("preview", "p").fail, null);
check("干活站默认停下等人", makeStep("run", "r").fail, { mode: "stop", max: 2 });

// ── 自由编排:不是模板里那几条也照样能跑 ─────────────────────────────────────
// 起手式只是起手式,用户自己搭的线才是常态,所以这几条得明确放行。
check("只有一站干活", denials(line(["run"])), []);
check("干完先跑命令再验", denials(line(["run", "command", "verify"])), []);
check("验完起预览让人看,看完不合并", denials(line(["run", "verify", "preview", "human"])), []);
check("在项目目录里干、不合并", denials(line(["run", "command", "human"], "shared")), []);
check("命令站在最后收尾", denials(line(["run", "human", "accept", "command"])), []);

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
check("老预览站没有 mode 时保持按启动命令跑", normalizeWorkflowDef({
  steps: [{ kind: "run" }, { kind: "preview", p: { cmd: "make preview" } }, { kind: "human" }],
}).def?.steps[1]!.p, { cmd: "make preview", mode: "command", ready: "port+log", life: "gate" });
check("预览启动方式越界回落", normalizeWorkflowDef({
  steps: [{ kind: "run" }, { kind: "preview", p: { mode: "magic" } }, { kind: "human" }],
}).def?.steps[1]!.p, { cmd: "npm run dev", mode: "command", ready: "port+log", life: "gate" });

// 老数据里的 backTo 到这儿被丢掉:那个旋钮从来没接通过执行链,留着就是骗人。丢掉之后
// 「怎么办」和「几轮」原样保留,老任务的行为跟它实际发生过的行为一致(= 打回重做)。
const legacy = normalizeWorkflowDef({
  steps: [{ id: "a", kind: "run" }, { id: "b", kind: "verify", fail: { mode: "back", backTo: "ghost", max: 3 } }],
});
check("老数据的 backTo 被丢掉", legacy.def?.steps[1]!.fail, { mode: "back", max: 3 });
check("人工关口的失败分支一并丢掉", normalizeWorkflowDef({
  steps: [{ kind: "run" }, { kind: "human", fail: { mode: "back", max: 2 } }],
}).def?.steps[1]!.fail, null);
check("轮数超上限就夹到上限", normalizeWorkflowDef({
  steps: [{ kind: "run", fail: { mode: "back", max: 99 } }],
}).def?.steps[0]!.fail, { mode: "back", max: 5 });
check("不认识的失败档回落成停下等人", normalizeWorkflowDef({
  steps: [{ kind: "run", fail: { mode: "teleport", max: 2 } }],
}).def?.steps[0]!.fail, { mode: "stop", max: 2 });

// 人工关口「什么都不给看」：前一站起了预览，人自己去点，不需要 diff/报告/截图。
// 「字段缺了」和「显式给了空数组」是两件事，混在一起就等于「这个勾去不掉」——
// 用户取消完最后一项、存完再读回来，它又长回 diff+report。
check("人工关口显式给空数组就当真", normalizeWorkflowDef({
  steps: [{ kind: "run" }, { kind: "human", p: { show: [], notify: [] } }],
}).def?.steps[1]!.p, { show: [], notify: [] });
check("人工关口缺字段仍补默认", normalizeWorkflowDef({
  steps: [{ kind: "run" }, { kind: "human" }],
}).def?.steps[1]!.p, { show: ["diff", "report"], notify: [] });

// 幂等：内置 → JSON → normalize 应当原样回来，否则存一次盘就漂一次
for (const b of BUILTIN_WORKFLOWS) {
  const def = builtinWorkflowDef(b.key)!;
  const round = normalizeWorkflowDef(JSON.parse(JSON.stringify(def)));
  check(`「${b.name}」存盘再读回不漂`, round.def, def);
}

console.log(failures ? `\n${failures} 处不符` : "\n工作流定义层的闸全部符合预期");
process.exit(failures ? 1 : 0);
