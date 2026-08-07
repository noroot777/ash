// 工作流定义层 —— 一条线由若干「站」组成，任务按站往下走。
//
// 这一层只管**定义和校验**，不碰执行：server 的执行链读它，web 的编排器改它，
// 两边共用同一份闸（checkWorkflow）。运行时值住在这里，所以走子路径导出
// `@harness/shared/workflow`——index.ts 只再导出类型，转发运行时值会让服务端起不来。
//
// 术语对齐产品口径：用户看到的是「起手式」（一条线的模板），代码里叫 workflow。
import type { TaskStage, TaskStatus } from "./index.ts";

export const STEP_KINDS = ["run", "verify", "preview", "human", "command", "accept"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_LABELS: Record<StepKind, string> = {
  run: "让 AI 干活", verify: "自动验证", preview: "打开预览",
  human: "等我点头", command: "跑一条命令", accept: "合并并清理",
};

// 「合并并清理」和「让 AI 干活」在一条线上至多一次。
//   accept —— 不可逆，而且合完之后这条线上再没有第二次可合的东西。
//   run    —— 执行链是**被这一轮结算唤醒**的，唤醒时只知道「有一轮干完了」，说不清
//              是第几个 run 站；两个 run 站的第二个没有任何东西能把它区分出来。
// 「自动验证」和「等我点头」不在此列：它们各自的唤醒事件（某一轮审查有了结论、用户
// 在某个关口点了头）都能落到**具体那一站**上——执行链按 `tasks.workflow_at` 这个游标
// 推进（见 workflow-policy.ts 的段落切分），所以一条线上写两轮验证、两道关口是真的
// 跑得出来的。编排器据此只把已经有了的 run/accept 从「加一站」菜单里去掉。
export const SINGLETON_KINDS = ["run", "accept"] as const;
export type SingletonKind = (typeof SINGLETON_KINDS)[number];
export function isSingletonKind(kind: StepKind): kind is SingletonKind {
  return (SINGLETON_KINDS as readonly string[]).includes(kind);
}

// 这一站跑起来时，任务在列表里长什么样。**刻意只存 (status, stage) 而不存文案**：
// 线路图上每站底下那行「任务显示：待验收」必须跟任务列表里那一格**一个字都不差**，
// 否则用户照着线路图预期的状态在列表里根本找不到。存文案就等于开了第二份真相，迟早
// 漂移；存状态则由 taskDisplayStatus() 统一派生，结构上不可能对不上。
// note 是附加说明（「预览已起」），它不是状态、不进那一格，只在线路图上作小字。
export const STEP_RUNTIME: Record<
  StepKind,
  { status: TaskStatus; stage: TaskStage | null; note: string | null }
> = {
  run: { status: "running", stage: null, note: null },
  verify: { status: "running", stage: "verifying", note: null },
  preview: { status: "running", stage: null, note: "预览已起" },
  human: { status: "awaiting_review", stage: "awaiting_acceptance", note: null },
  command: { status: "running", stage: null, note: "跑命令" },
  accept: { status: "done", stage: "accepted", note: null },
};

// ── 失败策略 ───────────────────────────────────────────────────────────────
// 三档，每一档都对应一件执行链真的会做的事：
//   stop —— 什么都不做，任务停在那儿等人（最不吵人的一档）
//   ask  —— 把「这一站没过，你想怎么办」作为提问挂到任务上，答复照常送进它的会话
//   back —— 不问，直接把报错交回给干活的 agent 让它修，最多 max 轮
// 只有 preview 和 human 没有失败分支：预览起不来就是这一站失败，没有「起不来但继续」
// 的语义；人工关口的「没过」是**人当场按的**（界面上就摆着「打回重做」和「验收通过」
// 两个按钮），预先编排「人不点头怎么办」只会在线路图上多一份不生效的承诺。
export const FAIL_MODES = ["stop", "ask", "back"] as const;
export type FailMode = (typeof FAIL_MODES)[number];
export const FAIL_MODE_LABELS: Record<FailMode, string> = {
  stop: "停下等人", ask: "问我一句", back: "打回给 AI 重做",
};
// 刻意**没有** backTo：「回到第几站」这个旋钮曾经存在，但执行链里所有的 back 最终都
// 只能做同一件事 —— 把报错交回给干活的 agent。夹在中间的 command/preview 是成段跑的，
// 单独回到其中一站既没有触发它的事件，也没有「从这儿接着往下」的入口。留着一个只能
// 摆着看的下拉，比少一个概念更糟。
export interface FailPolicy {
  mode: FailMode;
  max: number; // 最多打回几轮，1..5
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
export const PREVIEW_MODE = ["command", "frontend", "full", "test"] as const;
export type PreviewMode = (typeof PREVIEW_MODE)[number];
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

// 枚举值的中文说法跟枚举本身放一起：编排界面上的选项、线路图上的小字、以后的通知
// 文案都从这儿取，谁也别再自己写一份。
export const PREVIEW_READY_LABELS: Record<PreviewReady, string> = {
  port: "端口可连就算起来了", "port+log": "端口可连 + 日志 ready", http200: "HTTP 返回 200",
};
export const PREVIEW_MODE_LABELS: Record<PreviewMode, string> = {
  command: "按项目启动命令",
  frontend: "只启动前端",
  full: "前后端全启动（独立新库）",
  test: "前后端 + 测试库快照",
};
export const PREVIEW_LIFE_LABELS: Record<PreviewLife, string> = {
  gate: "下一个人工关口结束时回收", task: "任务结束时回收",
  // 口径按实现写：我们没法知道「有没有人在看」（预览进程的请求不经过 harness），
  // 所以这一档是**起来满 30 分钟就回收**，不是「闲置 30 分钟」。宁可标签朴素，
  // 也不能让线上写着一件我们做不到的事。
  idle30: "起来满 30 分钟就回收",
};
export const HUMAN_SHOW_LABELS: Record<HumanShow, string> = {
  diff: "diff", report: "验证报告", shots: "截图",
};
export const HUMAN_NOTIFY_LABELS: Record<HumanNotify, string> = {
  inbox: "落「需处理」", push: "推送通知", mail: "邮件",
};
export const COMMAND_WHERE_LABELS: Record<CommandWhere, string> = {
  workspace: "任务工作区", repo: "项目根目录",
};
export const ACCEPT_STRATEGY_LABELS: Record<AcceptStrategy, string> = {
  safe: "安全合并（仓库锁内）", squash: "squash 合并", tag: "只打标签不合并",
};
export const ACCEPT_CLEAN_LABELS: Record<AcceptClean, string> = {
  all: "删 worktree 和任务分支", worktree: "只删 worktree", none: "都留着",
};
export const WORKSPACE_LABELS: Record<Workspace, string> = {
  isolated: "单独开一份工作区", shared: "直接在项目目录里干活",
};

export interface StepParams {
  run: { instruction: string | null; executorId: string | null; model: string | null; reasoningEffort: string | null };
  verify: { executorId: string | null; model: string | null; reasoningEffort: string | null; checks: VerifyCheck[] };
  preview: { cmd: string; mode: PreviewMode; ready: PreviewReady; life: PreviewLife };
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
  verify: () => ({ executorId: null, model: null, reasoningEffort: null, checks: ["build"] }),
  preview: () => ({ cmd: "npm run dev", mode: "test", ready: "port+log", life: "gate" }),
  human: () => ({ show: ["diff", "report"], notify: ["inbox", "push"] }),
  command: () => ({ cmd: "npm run lint", where: "workspace" }),
  accept: () => ({ strategy: "safe", clean: "all" }),
};

export function hasFailBranch(kind: StepKind): boolean {
  return kind !== "preview" && kind !== "human";
}

export function makeStep(kind: StepKind, id: string): WorkflowStep {
  const step = { id, kind, p: DEFAULT_PARAMS[kind](), fail: null } as WorkflowStep;
  if (hasFailBranch(kind)) step.fail = { mode: "stop", max: 2 };
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
  // 「让 AI 干活」「合并并清理」至多一次；理由和取舍见 SINGLETON_KINDS 那儿的注释。
  // 宁可在这儿拒绝，也不能让线路图上画着一站永远不会跑。
  for (const kind of SINGLETON_KINDS) {
    const hit = steps.filter((s) => s.kind === kind);
    if (hit.length > 1) {
      issues.push({ level: "deny", text: `「${STEP_LABELS[kind]}」只能有一站`, stepId: hit[1]!.id });
    }
  }
  const accepts = steps.filter((s) => s.kind === "accept");
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
    if (f && (!Number.isInteger(f.max) || f.max < 1 || f.max > MAX_FAIL_ROUNDS)) {
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
  // 两站「会停下来等的站」贴在一起，中间什么都没有：跑得出来，但第一站刚放行就立刻
  // 又停一次，多半是编排时插错了位置。只提醒不拦——真想要「验两轮」也说得通。
  for (const [i, s] of steps.entries()) {
    const next = steps[i + 1];
    if (!next || s.kind !== next.kind) continue;
    if (s.kind === "human" || s.kind === "verify") {
      issues.push({
        level: "warn",
        text: `两站「${STEP_LABELS[s.kind]}」挨在一起，中间没有别的站`,
        stepId: next.id,
      });
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
    return {
      executorId: pickNullableText(r.executorId, 80),
      model: pickNullableText(r.model, 80),
      reasoningEffort: pickNullableText(r.reasoningEffort, 40),
      checks: pickEnums(r.checks, VERIFY_CHECKS),
    };
  }
  if (kind === "preview") {
    return {
      cmd: pickText(r.cmd, d.preview().cmd),
      // 新建站由 DEFAULT_PARAMS 明确写 test；老数据没有 mode 时必须保持原来的
      // 「照启动命令跑」语义，不能在一次 normalize 后静默变成 Harness 的测试库快照。
      mode: pickEnum(r.mode, PREVIEW_MODE, "command"),
      ready: pickEnum(r.ready, PREVIEW_READY, "port+log"),
      life: pickEnum(r.life, PREVIEW_LIFE, "gate"),
    };
  }
  if (kind === "human") {
    return {
      // 「字段缺了」和「显式给了空数组」必须分开看：缺了照旧补默认（老数据、手写 JSON
      // 的行为一点不变），而空数组**当真** —— 用户把三项都取消掉是一种真实用法（什么都
      // 不给，我自己打开前一站的预览去点）。原来一律回落默认，表现出来就是界面上「这
      // 个勾去不掉」：取消完最后一项、存完再回来，它又原样长回去了。
      show: Array.isArray(r.show) ? pickEnums(r.show, HUMAN_SHOW) : d.human().show,
      notify: pickEnums(r.notify, HUMAN_NOTIFY),
    };
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
  return { mode, max }; // 老数据里的 backTo 到这儿被丢掉，行为不变（它本来也没生效过）
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

// 三级作用域的挑选规矩：任务显式选的 → 项目默认 → 全局默认 → 出厂推荐。
// 这一份是**唯一一份**：服务端建任务时用它，前端在新建面板上预览「这次会走哪条线」
// 也用它。分两处写迟早会漂移成「面板上显示 A、建出来是 B」。
//
// 每一级都可能指向一条被删掉或停用的条目，那就往下落一级而不是报错；唯独**显式选的
// 那条即使停用了也照用** —— 用户此刻就是要它。
export function resolveWorkflowFromList(
  items: WorkflowItem[],
  chain: (string | null | undefined)[],
  explicitId?: string | null,
): WorkflowItem | null {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  for (const candidate of chain) {
    if (!candidate) continue;
    const item = byId.get(candidate);
    if (item && (!item.disabled || candidate === explicitId)) return item;
  }
  return null;
}
