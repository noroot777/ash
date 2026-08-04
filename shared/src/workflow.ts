// 工作流定义层 —— 一条线由若干「站」组成，任务按站往下走。
//
// 这一层只管**定义和校验**，不碰执行：server 的执行链读它，web 的编排器改它，
// 两边共用同一份闸（checkWorkflow）。运行时值住在这里，所以走子路径导出
// `@harness/shared/workflow`——index.ts 只再导出类型，转发运行时值会让服务端起不来。
//
// 术语对齐产品口径：用户看到的是「起手式」（一条线的模板），代码里叫 workflow。
import type { TaskStage } from "./index.js";

export const STEP_KINDS = ["run", "verify", "preview", "human", "command", "accept"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_LABELS: Record<StepKind, string> = {
  run: "让 AI 干活", verify: "自动验证", preview: "打开预览",
  human: "等我点头", command: "跑一条命令", accept: "合并并清理",
};

// 这一站跑起来时，任务在列表里显示什么。stage 非空的站会真的写 tasks.stage，
// 为空的站只影响展示文案（执行期的落库在第二期接进来）。
export const STEP_STAGE: Record<StepKind, { stage: TaskStage | null; text: string }> = {
  run: { stage: null, text: "运行中" },
  verify: { stage: "verifying", text: "审查中" },
  preview: { stage: null, text: "运行中 · 预览已起" },
  human: { stage: "awaiting_acceptance", text: "需你处理" },
  command: { stage: null, text: "运行中 · 跑命令" },
  accept: { stage: "accepted", text: "已验收" },
};

// ── 失败策略 ───────────────────────────────────────────────────────────────
// 只有 preview 没有失败分支（起不来就是这一站失败，没有「起不来但继续」的语义）。
export const FAIL_MODES = ["stop", "ask", "back"] as const;
export type FailMode = (typeof FAIL_MODES)[number];
export const FAIL_MODE_LABELS: Record<FailMode, string> = {
  stop: "停下等人", ask: "问我一句", back: "回到某一步重做",
};
export interface FailPolicy {
  mode: FailMode;
  backTo: string | null; // 只在 mode === "back" 时有意义，指向前面某一站的 id
  max: number; // 最多重做几轮，1..5
}
export const MAX_FAIL_ROUNDS = 5;

// ── 各站的参数 ─────────────────────────────────────────────────────────────
// 执行器一律用 executorId（agents.id），null = 跟随任务自己的执行器；
// 展示用的名字由服务端读表时解析，绝不存进定义里（存了就会随改名腐烂）。
export const VERIFY_CHECKS = ["build", "tests", "browser", "smoke", "lint"] as const;
export type VerifyCheck = (typeof VERIFY_CHECKS)[number];
export const VERIFY_CHECK_LABELS: Record<VerifyCheck, string> = {
  build: "构建 + 类型检查", tests: "回归测试", browser: "浏览器真实点检",
  smoke: "接口冒烟", lint: "跑一遍 lint",
};

export const PREVIEW_READY = ["port", "port+log", "http200"] as const;
export type PreviewReady = (typeof PREVIEW_READY)[number];
export const PREVIEW_LIFE = ["gate", "task", "idle30"] as const;
export type PreviewLife = (typeof PREVIEW_LIFE)[number];

export const HUMAN_SHOW = ["diff", "report", "shots"] as const;
export type HumanShow = (typeof HUMAN_SHOW)[number];
export const HUMAN_NOTIFY = ["inbox", "push", "mail"] as const;
export type HumanNotify = (typeof HUMAN_NOTIFY)[number];

export const COMMAND_WHERE = ["workspace", "repo"] as const;
export type CommandWhere = (typeof COMMAND_WHERE)[number];

export const ACCEPT_STRATEGY = ["safe", "squash", "tag"] as const;
export type AcceptStrategy = (typeof ACCEPT_STRATEGY)[number];
export const ACCEPT_CLEAN = ["all", "worktree", "none"] as const;
export type AcceptClean = (typeof ACCEPT_CLEAN)[number];

export interface StepParams {
  run: { instruction: string | null; executorId: string | null; model: string | null; reasoningEffort: string | null };
  verify: { executorId: string | null; checks: VerifyCheck[] };
  preview: { cmd: string; ready: PreviewReady; life: PreviewLife };
  human: { show: HumanShow[]; notify: HumanNotify[] };
  command: { cmd: string; where: CommandWhere };
  accept: { strategy: AcceptStrategy; clean: AcceptClean };
}

export type WorkflowStep = {
  [K in StepKind]: { id: string; kind: K; p: StepParams[K]; fail: FailPolicy | null };
}[StepKind];

export type Workspace = "isolated" | "shared";

export interface WorkflowDef {
  workspace: Workspace;
  steps: WorkflowStep[];
}

export const DEFAULT_PARAMS: { [K in StepKind]: () => StepParams[K] } = {
  run: () => ({ instruction: null, executorId: null, model: null, reasoningEffort: null }),
  verify: () => ({ executorId: null, checks: ["build"] }),
  preview: () => ({ cmd: "npm run dev", ready: "port+log", life: "gate" }),
  human: () => ({ show: ["diff", "report"], notify: ["inbox", "push"] }),
  command: () => ({ cmd: "npm run lint", where: "workspace" }),
  accept: () => ({ strategy: "safe", clean: "all" }),
};

export function hasFailBranch(kind: StepKind): boolean {
  return kind !== "preview";
}

export function makeStep(kind: StepKind, id: string): WorkflowStep {
  const step = { id, kind, p: DEFAULT_PARAMS[kind](), fail: null } as WorkflowStep;
  if (hasFailBranch(kind)) step.fail = { mode: "stop", backTo: null, max: 2 };
  return step;
}

// ── 闸 ─────────────────────────────────────────────────────────────────────
// deny = 这条线不能存也不能跑；warn = 能跑但多半不是你想要的。
// 前端编排器和服务端 API 读同一份，所以「界面上放行、存进去被拒」不可能发生。
export type IssueLevel = "deny" | "warn";
export interface WorkflowIssue {
  level: IssueLevel;
  text: string;
  stepId?: string;
}

export function checkWorkflow(def: WorkflowDef): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const steps = def.steps;
  if (!steps.length) {
    issues.push({ level: "deny", text: "一条线至少要有一站" });
    return issues;
  }
  if (!steps.some((s) => s.kind === "run")) {
    issues.push({ level: "deny", text: "没有「让 AI 干活」这一站，任务不会开工" });
  }
  const accepts = steps.filter((s) => s.kind === "accept");
  if (accepts.length > 1) {
    issues.push({ level: "deny", text: "「合并并清理」只能有一站", stepId: accepts[1]!.id });
  }
  const index = new Map(steps.map((s, i) => [s.id, i]));
  for (const [i, s] of steps.entries()) {
    // 合并是不可逆的，前面必须有人点过头 —— 这条闸是整套设计的底线
    if (s.kind === "accept" && !steps.slice(0, i).some((p) => p.kind === "human")) {
      issues.push({ level: "deny", text: "合并之前必须有一站「等我点头」", stepId: s.id });
    }
    // 预览起来了却没人看，等于白起一个进程
    if (s.kind === "preview" && !steps.slice(i + 1).some((n) => n.kind === "human")) {
      issues.push({ level: "deny", text: "预览起来之后没有人工关口，没人会去看它", stepId: s.id });
    }
    const f = s.fail;
    if (!f || f.mode !== "back") continue;
    const target = f.backTo ? index.get(f.backTo) : undefined;
    if (target === undefined) {
      issues.push({ level: "deny", text: "「回到某一步重做」没指到有效的站", stepId: s.id });
    } else if (target >= i) {
      issues.push({ level: "deny", text: "只能回到前面的站，不能往后跳", stepId: s.id });
    }
    if (!Number.isInteger(f.max) || f.max < 1 || f.max > MAX_FAIL_ROUNDS) {
      issues.push({ level: "deny", text: `重做轮数只能是 1..${MAX_FAIL_ROUNDS}`, stepId: s.id });
    }
  }
  for (const s of steps) {
    if (s.kind === "verify" && !s.p.checks.length) {
      issues.push({ level: "warn", text: "这一站没选验什么，会直接通过", stepId: s.id });
    }
    if (s.kind === "command" && !s.p.cmd.trim()) {
      issues.push({ level: "deny", text: "命令是空的", stepId: s.id });
    }
    if (s.kind === "preview" && !s.p.cmd.trim()) {
      issues.push({ level: "deny", text: "预览的启动命令是空的", stepId: s.id });
    }
  }
  if (def.workspace === "shared" && accepts.length) {
    issues.push({ level: "warn", text: "直接在项目目录里干活，「合并」这一站没什么可合的" });
  }
  return issues;
}

export function workflowDenied(def: WorkflowDef): WorkflowIssue[] {
  return checkWorkflow(def).filter((i) => i.level === "deny");
}
export function isWorkflowUsable(def: WorkflowDef): boolean {
  return workflowDenied(def).length === 0;
}

// ── 收敛：任意 JSON → 合法定义 ─────────────────────────────────────────────
// DB 里存的是 json 文本、API 收的是用户传的对象，两条路都走这里。原则是**能修就修、
// 修不了才拒**：多余字段丢掉、缺的补默认、枚举越界回落到默认值，唯独结构性的东西
// （不认识的 kind、重复的 id、空数组）直接拒 —— 那种情况继续猜只会猜出个假定义。
function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
function pickEnums<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !(allowed as readonly string[]).includes(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item as T);
  }
  return out;
}
function pickText(value: unknown, fallback: string, max = 400): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return text && text.length <= max ? text : fallback;
}
function pickNullableText(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function normalizeParams(kind: StepKind, raw: unknown): StepParams[StepKind] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PARAMS;
  if (kind === "run") {
    return {
      instruction: pickNullableText(r.instruction),
      executorId: pickNullableText(r.executorId, 80),
      model: pickNullableText(r.model, 80),
      reasoningEffort: pickNullableText(r.reasoningEffort, 40),
    };
  }
  if (kind === "verify") {
    return { executorId: pickNullableText(r.executorId, 80), checks: pickEnums(r.checks, VERIFY_CHECKS) };
  }
  if (kind === "preview") {
    return {
      cmd: pickText(r.cmd, d.preview().cmd),
      ready: pickEnum(r.ready, PREVIEW_READY, "port+log"),
      life: pickEnum(r.life, PREVIEW_LIFE, "gate"),
    };
  }
  if (kind === "human") {
    const show = pickEnums(r.show, HUMAN_SHOW);
    return { show: show.length ? show : d.human().show, notify: pickEnums(r.notify, HUMAN_NOTIFY) };
  }
  if (kind === "command") {
    return { cmd: pickText(r.cmd, d.command().cmd), where: pickEnum(r.where, COMMAND_WHERE, "workspace") };
  }
  return { strategy: pickEnum(r.strategy, ACCEPT_STRATEGY, "safe"), clean: pickEnum(r.clean, ACCEPT_CLEAN, "all") };
}

function normalizeFail(kind: StepKind, raw: unknown): FailPolicy | null {
  if (!hasFailBranch(kind)) return null;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode = pickEnum(r.mode, FAIL_MODES, "stop");
  const max = typeof r.max === "number" && Number.isInteger(r.max)
    ? Math.min(Math.max(r.max, 1), MAX_FAIL_ROUNDS)
    : 2;
  return { mode, backTo: mode === "back" ? pickNullableText(r.backTo, 80) : null, max };
}

export const MAX_WORKFLOW_STEPS = 24;

export function normalizeWorkflowDef(value: unknown): { def?: WorkflowDef; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "工作流定义必须是对象" };
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.steps) || !raw.steps.length) return { error: "steps 至少要有一站" };
  if (raw.steps.length > MAX_WORKFLOW_STEPS) return { error: `一条线最多 ${MAX_WORKFLOW_STEPS} 站` };
  const ids = new Set<string>();
  const steps: WorkflowStep[] = [];
  for (const [i, item] of raw.steps.entries()) {
    if (!item || typeof item !== "object") return { error: `第 ${i + 1} 站不是对象` };
    const s = item as Record<string, unknown>;
    if (typeof s.kind !== "string" || !(STEP_KINDS as readonly string[]).includes(s.kind)) {
      return { error: `第 ${i + 1} 站的 kind 不认识：${String(s.kind)}` };
    }
    const kind = s.kind as StepKind;
    const id = pickNullableText(s.id, 80) ?? `s${i + 1}`;
    if (ids.has(id)) return { error: `站的 id 重复：${id}` };
    ids.add(id);
    steps.push({ id, kind, p: normalizeParams(kind, s.p), fail: normalizeFail(kind, s.fail) } as WorkflowStep);
  }
  // backTo 指向不存在的站就地清成「停下等人」，让老数据/手写 JSON 不至于整条作废
  for (const s of steps) {
    if (s.fail?.mode === "back" && (!s.fail.backTo || !ids.has(s.fail.backTo))) {
      s.fail = { mode: "stop", backTo: null, max: s.fail.max };
    }
  }
  const def: WorkflowDef = { workspace: pickEnum(raw.workspace, ["isolated", "shared"] as const, "isolated"), steps };
  const denied = workflowDenied(def);
  if (denied.length) return { error: denied[0]!.text };
  return { def };
}

// ── 起手式库的对外形状 ────────────────────────────────────────────────────
// 前端拿到的每一条都长这样，**分不出「系统自带」和「用户自建」的差别**除了这三个
// 标记位：自带的删不掉（只能 disabled）、改过的能 restore 回出厂定义。
export interface WorkflowItem {
  // 自带条目恒等于内置 key（"standard"），有没有被覆写过都不变 —— 项目/任务引用它
  // 才不会因为一次「恢复系统默认」就悬空。用户自建的是行 id。
  id: string;
  name: string;
  description: string;
  def: WorkflowDef;
  builtin: boolean;
  modified: boolean; // 自带 + 用户改过（于是「恢复系统默认」有东西可恢复）
  disabled: boolean;
  updatedAt: string | null;
}
