// 每一站有哪些可改的参数 —— **一份规格，两处用**：站台底下那排 chip 的字从这儿
// 派生，点开 chip 的弹层也照着这儿渲染。分成两份的话，迟早出现「chip 上写着 A、
// 点开却没有 A 这个选项」。
//
// executor / model / effort 三种类型交给组件用现成控件渲染（复用 composer 那套
// 执行器选择），其余都是纯枚举/文本，规格表自己就描述完了。
import type { StepKind, WorkflowStep } from "@ash/shared/workflow";
import {
  ACCEPT_CLEAN, ACCEPT_CLEAN_LABELS, ACCEPT_STRATEGY, ACCEPT_STRATEGY_LABELS,
  COMMAND_WHERE, COMMAND_WHERE_LABELS, HUMAN_NOTIFY, HUMAN_NOTIFY_LABELS,
  HUMAN_SHOW, HUMAN_SHOW_LABELS, PREVIEW_LIFE, PREVIEW_LIFE_LABELS,
  PREVIEW_MODE, PREVIEW_MODE_LABELS, PREVIEW_READY, PREVIEW_READY_LABELS,
  VERIFY_CHECKS, VERIFY_CHECK_LABELS,
} from "@ash/shared/workflow";

export interface FieldOption { value: string; label: string }

export type FieldSpec =
  | { key: string; label: string; type: "select"; options: FieldOption[] }
  // emptyOk：一个都不选是**正经选项**而不是没填完（典型：人工关口「什么都不给，我自己
  // 去看」）。它决定 chip 要不要标黄，也决定弹层里给不给那颗「都不给」的按钮 —— 少了
  // 后者，用户只能靠「把最后一个也点掉」来表达，界面上根本看不出这是允许的。
  | { key: string; label: string; type: "multi"; options: FieldOption[]; emptyText: string; emptyOk?: boolean }
  | { key: string; label: string; type: "text"; placeholder: string; emptyText: string; hint?: string }
  | { key: string; label: string; type: "executor"; emptyText: string }
  | { key: string; label: string; type: "model" }
  | { key: string; label: string; type: "effort" };

const opts = <T extends string>(values: readonly T[], labels: Record<T, string>): FieldOption[] =>
  values.map((value) => ({ value, label: labels[value] }));

// 命令这一栏交给谁跑,是**跨平台会变的契约**,所以写在提示里而不是只写进文档:
// macOS/Linux 是 `sh -lc`(登录 shell,吃得到用户的 nvm/rbenv 那套 PATH),Windows 是
// `cmd /d /s /c`。写成这两句是因为一条工作流会被两边的人共用 —— 只说当前这台机器
// 的规矩,等于让另一边的人自己去撞。
const SHELL_HINT = "\n命令交给系统 shell 跑：macOS/Linux 是 `sh -lc`，Windows 是 `cmd /d /s /c`。"
  + "POSIX 专有写法（`FOO=1 cmd` 前缀、`$(…)`、`2>/dev/null`）在 Windows 上不成立，"
  + "要跨平台就写成 npm scripts 再调。";

export const STEP_FIELDS: Record<StepKind, FieldSpec[]> = {
  run: [
    { key: "instruction", label: "额外交代", type: "text", placeholder: "留空就照任务描述做", emptyText: "照任务描述做" },
    { key: "executorId", label: "谁来干", type: "executor", emptyText: "跟随任务的执行器" },
    { key: "model", label: "模型", type: "model" },
    { key: "reasoningEffort", label: "智能水平", type: "effort" },
  ],
  verify: [
    { key: "executorId", label: "谁来验", type: "executor", emptyText: "跟随任务的执行器" },
    { key: "model", label: "用什么模型验", type: "model" },
    { key: "reasoningEffort", label: "智能水平", type: "effort" },
    { key: "checks", label: "验什么（全过才算过）", type: "multi", options: opts(VERIFY_CHECKS, VERIFY_CHECK_LABELS), emptyText: "还没选验什么" },
  ],
  preview: [
    {
      key: "mode", label: "启动方式", type: "select", options: opts(PREVIEW_MODE, PREVIEW_MODE_LABELS),
    },
    // 端口这句得写在这儿，不能只写进文档：预览起在自己的 worktree 里，而同一个项目
    // 此刻通常已经有一份在跑（用户自己那份、或别的任务的预览），写死端口必撞。ash
    // 每次都借一个空闲端口用 PORT 传进来，命令认它才错得开。
    {
      key: "cmd", label: "启动命令", type: "text", placeholder: "npm run dev", emptyText: "还没填命令",
      hint: "ash 会把上面的选择作为 $ASH_PREVIEW_MODE 传给命令；项目不识别它时，"
        + "就是普通自定义命令。同时每次借一个空闲端口，用 $PORT 传入。端口写死的话，"
        + "同一个项目已经有一份在跑时必然撞车 —— 写成认 $PORT 的形式（例如 npm run dev -- --port $PORT）才错得开。"
        + SHELL_HINT,
    },
    { key: "ready", label: "怎么算起来了", type: "select", options: opts(PREVIEW_READY, PREVIEW_READY_LABELS) },
    { key: "life", label: "什么时候关掉", type: "select", options: opts(PREVIEW_LIFE, PREVIEW_LIFE_LABELS) },
  ],
  human: [
    // 这两项都可以一个不选：不给看什么，是因为人自己会去点前一站起的预览；不通知，
    // 是因为人就守在跟前。所以它们 emptyOk，空了不标黄。
    {
      key: "show", label: "给我看什么", type: "multi", options: opts(HUMAN_SHOW, HUMAN_SHOW_LABELS),
      emptyText: "什么都不给，我自己去看", emptyOk: true,
    },
    {
      key: "notify", label: "怎么叫我", type: "multi", options: opts(HUMAN_NOTIFY, HUMAN_NOTIFY_LABELS),
      emptyText: "不通知", emptyOk: true,
    },
  ],
  command: [
    { key: "cmd", label: "命令", type: "text", placeholder: "npm run lint", emptyText: "还没填命令", hint: SHELL_HINT.trim() },
    { key: "where", label: "在哪跑", type: "select", options: opts(COMMAND_WHERE, COMMAND_WHERE_LABELS) },
  ],
  accept: [
    { key: "strategy", label: "怎么合", type: "select", options: opts(ACCEPT_STRATEGY, ACCEPT_STRATEGY_LABELS) },
    { key: "clean", label: "合完清理", type: "select", options: opts(ACCEPT_CLEAN, ACCEPT_CLEAN_LABELS) },
  ],
};

export interface FieldChip {
  key: string;
  text: string;
  /** 这一项没填/没选，线路图上标出来（checkWorkflow 那边多半也会有话说） */
  warn: boolean;
}

/** run/verify 站的 model 字段：没显式设就跟着执行器走，chip 上不占地方。 */
export function fieldChip(
  step: WorkflowStep,
  spec: FieldSpec,
  resolveExecutor: (id: string) => string | null,
): FieldChip | null {
  const value = (step.p as Record<string, unknown>)[spec.key];
  if (spec.type === "multi") {
    const list = Array.isArray(value) ? (value as string[]) : [];
    const labels = list.map((v) => spec.options.find((o) => o.value === v)?.label ?? v);
    return {
      key: spec.key,
      text: labels.length ? labels.join("、") : spec.emptyText,
      warn: !labels.length && !spec.emptyOk,
    };
  }
  if (spec.type === "select") {
    const found = spec.options.find((o) => o.value === value);
    return { key: spec.key, text: found?.label ?? String(value ?? ""), warn: !found };
  }
  if (spec.type === "text") {
    const text = typeof value === "string" ? value.trim() : "";
    return { key: spec.key, text: text || spec.emptyText, warn: !text };
  }
  if (spec.type === "executor") {
    const id = typeof value === "string" ? value : "";
    if (!id) return { key: spec.key, text: spec.emptyText, warn: false };
    const name = resolveExecutor(id);
    return { key: spec.key, text: name ?? "执行器已不在了", warn: !name };
  }
  // model / effort：只有显式指定了才值得占一颗 chip
  const text = typeof value === "string" ? value.trim() : "";
  return text ? { key: spec.key, text, warn: false } : null;
}

export function stepChips(
  step: WorkflowStep,
  resolveExecutor: (id: string) => string | null,
): FieldChip[] {
  return STEP_FIELDS[step.kind]
    .map((spec) => fieldChip(step, spec, resolveExecutor))
    .filter((chip): chip is FieldChip => chip !== null);
}
