// 任务级 model / reasoningEffort 覆盖的继承规则（shared/src/executor-overrides.ts）。
//
// 起因（2026-07-28 事故）：团队默认 workerModel 是给 codex 配的 "gpt-5.6-sol"，
// dispatch 一个只改了 agentType:"claude" 的执行者时被无条件继承，claude CLI 拿到
// GPT 模型名启动即 exit 1。执行器解析早就有「换类型不硬套默认 profile」的逻辑，
// 只有 model/effort 没跟着走同一条 —— 这份测试就是钉住那条口径。
//
// 跑法：npm -w server run test:executor-overrides
import { inheritExecutorOverrides, pickExecutor, sameExecutor } from "@ash/shared/executors";
import type { AgentType } from "@ash/shared";

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

// profile 表：codex@team 是团队默认执行者，claude@relay 是另一个 claude profile。
const TYPES: Record<string, AgentType> = {
  "codex-team": "codex",
  "codex-other": "codex",
  "claude-relay": "claude",
};
const typeOf = (id: string) => TYPES[id];

// ── sameExecutor：粒度是「解析后的 executorId」，都为空才退回比 agentType ──────
check("同一个 profile 算同一个执行器", sameExecutor({ executorId: "codex-team", agentType: "codex" }, { executorId: "codex-team", agentType: "codex" }), true);
check("同类型不同 profile 不算同一个", sameExecutor({ executorId: "codex-team", agentType: "codex" }, { executorId: "codex-other", agentType: "codex" }), false);
check("都没 profile 且同类型算同一个", sameExecutor({ executorId: null, agentType: "claude" }, { executorId: null, agentType: "claude" }), true);
check("都没 profile 但类型不同不算", sameExecutor({ executorId: null, agentType: "claude" }, { executorId: null, agentType: "codex" }), false);
check("一边有 profile 一边没有不算", sameExecutor({ executorId: "codex-team", agentType: "codex" }, { executorId: null, agentType: "codex" }), false);

// ── 继承规则 ────────────────────────────────────────────────────────────────
const teamWorker = { executorId: "codex-team", agentType: "codex" as AgentType };
const teamDefaults = { defaultModel: "gpt-5.6-sol", defaultReasoningEffort: "xhigh" };

check(
  "同执行器 → 继承团队默认 model/effort",
  inheritExecutorOverrides({ from: teamWorker, to: { executorId: "codex-team", agentType: "codex" }, ...teamDefaults }),
  { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
);
check(
  "换 agentType → 不继承（正是事故本身）",
  inheritExecutorOverrides({ from: teamWorker, to: { executorId: null, agentType: "claude" }, ...teamDefaults }),
  { model: null, reasoningEffort: null },
);
check(
  "换 executorId（同类型不同 profile）→ 不继承",
  inheritExecutorOverrides({ from: teamWorker, to: { executorId: "codex-other", agentType: "codex" }, ...teamDefaults }),
  { model: null, reasoningEffort: null },
);
check(
  "显式传 model → 换了执行器也永远生效",
  inheritExecutorOverrides({ from: teamWorker, to: { executorId: null, agentType: "claude" }, model: "opus", reasoningEffort: "high", ...teamDefaults }),
  { model: "opus", reasoningEffort: "high" },
);
check(
  "显式传 null → 明确清空，不被默认值补回",
  inheritExecutorOverrides({ from: teamWorker, to: { executorId: "codex-team", agentType: "codex" }, model: null, reasoningEffort: null, ...teamDefaults }),
  { model: null, reasoningEffort: null },
);
check(
  "空串归一成 null",
  inheritExecutorOverrides({ from: teamWorker, to: { executorId: "codex-team", agentType: "codex" }, model: "", reasoningEffort: "" }),
  { model: null, reasoningEffort: null },
);
check(
  "model 与 effort 各算各的：只显式给 model 时 effort 仍按执行器是否变化处理",
  inheritExecutorOverrides({ from: teamWorker, to: { executorId: null, agentType: "claude" }, model: "opus", ...teamDefaults }),
  { model: "opus", reasoningEffort: null },
);

// ── PATCH 场景：from = 编辑前的任务，默认值 = 任务上残留的旧覆盖 ─────────────
const patched = (
  before: { executorId: string | null; agentType: AgentType | null },
  after: { executorId: string | null; agentType: AgentType | null },
  explicit: { model?: string | null; reasoningEffort?: string | null } = {},
) =>
  inheritExecutorOverrides({
    from: before,
    to: after,
    ...explicit,
    defaultModel: "gpt-5.6-sol",
    defaultReasoningEffort: "xhigh",
  });

check(
  "PATCH 换 agentType 且没给 model → 旧覆盖被清空",
  patched({ executorId: "codex-team", agentType: "codex" }, { executorId: null, agentType: "claude" }),
  { model: null, reasoningEffort: null },
);
check(
  "PATCH 只改标题（执行器没动）→ 旧覆盖原样保留",
  patched({ executorId: "codex-team", agentType: "codex" }, { executorId: "codex-team", agentType: "codex" }),
  { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
);
check(
  "PATCH 换执行器同时显式给新 model → 用新值",
  patched({ executorId: "codex-team", agentType: "codex" }, { executorId: "claude-relay", agentType: "claude" }, { model: "opus" }),
  { model: "opus", reasoningEffort: null },
);

// ── pickExecutor：换类型时不硬套默认 profile ────────────────────────────────
check(
  "什么都没给 → 整份继承默认执行器",
  pickExecutor({ fallback: teamWorker, typeOf }),
  { executorId: "codex-team", agentType: "codex" },
);
check(
  "只给 agentType 且类型对不上 → 丢掉继承的 profile",
  pickExecutor({ agentType: "claude", fallback: teamWorker, typeOf }),
  { executorId: null, agentType: "claude" },
);
check(
  "只给 agentType 且类型对得上 → 保留继承的 profile",
  pickExecutor({ agentType: "codex", fallback: teamWorker, typeOf }),
  { executorId: "codex-team", agentType: "codex" },
);
check(
  "显式给 executorId → 类型由它决定",
  pickExecutor({ executorId: "claude-relay", fallback: teamWorker, typeOf }),
  { executorId: "claude-relay", agentType: "claude" },
);
check(
  "显式给 executorId:null → 不继承 profile，类型退回默认执行器的类型",
  pickExecutor({ executorId: null, fallback: teamWorker, typeOf }),
  { executorId: null, agentType: "codex" },
);
check(
  "悬空的默认 profile → 保留 id（解析期再降级），类型用默认类型",
  pickExecutor({ fallback: { executorId: "deleted-profile", agentType: "codex" }, typeOf }),
  { executorId: "deleted-profile", agentType: "codex" },
);

// ── 两者串起来：dispatch 的真实事故复现 ─────────────────────────────────────
const pick = pickExecutor({ agentType: "claude", fallback: teamWorker, typeOf });
check(
  "事故复现：dispatch 只改 agentType → 执行器落 claude 默认、model 不再继承 gpt-5.6-sol",
  { ...pick, ...inheritExecutorOverrides({ from: teamWorker, to: pick, ...teamDefaults }) },
  { executorId: null, agentType: "claude", model: null, reasoningEffort: null },
);

if (failures) {
  console.error(`\n${failures} executor-override test(s) failed`);
  process.exit(1);
}
console.log("\nexecutor override tests passed");
