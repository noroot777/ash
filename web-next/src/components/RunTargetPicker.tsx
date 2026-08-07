import { useRef, useState } from "react";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { CaretDown, Robot } from "@phosphor-icons/react";
import { AgentModelPicker } from "../task-detail/AgentModelPicker.tsx";
import { EffortPicker } from "./EffortPicker.tsx";
import { useProviders } from "../lib/modelCatalog.ts";
import type { AgentModelSelection } from "../task-detail/mentionPicker.ts";

/**
 * 「这活儿谁来跑」的**唯一形状**：一颗胶囊、三段——**智能体 · 模型 · 智能水平**。
 *
 * 三段各管一件事，点哪段只改哪段：
 * ① 智能体：列已注册的 CLI，选完就落，不再顺手把你拖进选模型；
 * ② 模型：直接开当前智能体的模型列表（按供应商分块），不必先重选一遍智能体；
 * ③ 智能水平：档位候选跟着模型的能力收窄（EffortPicker）。
 *
 * 以前是两颗：「执行器 · 模型」合成一颗、思考强度另起一颗。合着的那颗有两个毛病——
 * 想换个智能体得连着把模型也选一遍，想换个模型又得先从智能体那一步走过去；而且
 * 「三件事、两颗胶囊」本身就读不出来谁管谁。现在一段一件事，三段并排即是全部答案。
 *
 * **换智能体会把模型和智能水平打回「跟随执行器」**（旧模型名/档位在新 CLI 上多半
 * 根本不存在），这一步由调用方在 onCommit 里落实；重复点中同一个智能体视作没改，
 * 本组件直接吞掉，免得白清一次用户刚选好的模型。
 *
 * 所有选模型的表面都用它：新建/派生面板与工作流站点（composer/ExecutorPickerField.tsx）、
 * 存量任务的对话框底部（task-detail/ReplyBox.tsx）、验证配置（task-detail/TaskReviewInspector.tsx）。
 */
export function RunTargetPicker({
  label,
  types,
  profiles,
  knownProfiles,
  selection,
  fallbackType,
  model,
  effort,
  disabled = false,
  variant = "field",
  highlight = false,
  emptyText = "暂无可用执行器",
  unsetText = "还没指定",
  effortFollowLabel,
  onCommit,
  onEffortChange,
}: {
  /** 无可见标题时的可访问名称。 */
  label: string;
  /** 可派的 CLI 类型。 */
  types: AgentType[];
  /** 可选的执行器 Profile。 */
  profiles: AgentExecutorProfile[];
  /** 用于显示当前执行器名字：包含已不可用的那些，否则胶囊会显示成空。 */
  knownProfiles?: AgentExecutorProfile[];
  /** null = 还没指定（工作流的站点可以「跟随任务的执行器」），第一段写 unsetText。 */
  selection: { agentType: AgentType; executorId: string | null } | null;
  /** 没指定时浮层从哪个 CLI 起步；不传就取第一个可派类型。 */
  fallbackType?: AgentType;
  /** 当前模型覆盖（空 = 跟随执行器）。 */
  model: string | null;
  /** 当前智能水平覆盖（空 = 跟随执行器）。 */
  effort: string;
  disabled?: boolean;
  /** chip = 对话框底部那排小胶囊；field = 表单里跟输入框同高的控件。 */
  variant?: "chip" | "field";
  /** 高亮态：对话框里「本回合另派了人」时点亮，跟任务常设配置区分开。 */
  highlight?: boolean;
  emptyText?: string;
  unsetText?: string;
  /** 「不覆盖」那一行的措辞（默认「跟随执行器」）。 */
  effortFollowLabel?: string;
  onCommit: (next: AgentModelSelection) => void;
  /** 不传就只画前两段——讨论者那种服务端根本不收智能水平的表面。 */
  onEffortChange?: (effort: string) => void;
}) {
  const [open, setOpen] = useState<"agent" | "model" | null>(null);
  const agentRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const providers = useProviders();

  const pool = knownProfiles ?? profiles;
  const profile = selection?.executorId
    ? pool.find((candidate) => candidate.id === selection.executorId)
    : undefined;
  const empty = types.length + profiles.length === 0;
  const modelText = model?.trim() || "跟随执行器";
  const openAt = selection?.agentType ?? fallbackType ?? types[0] ?? profiles[0]?.type ?? "claude";
  const shell = `run-target-picker is-${variant}${highlight ? " is-highlight" : ""}`;

  // 一个执行器都没有时三段全是空话：缩成一段把原因说清楚，别摆一排点不动的壳子。
  if (empty) {
    return (
      <div className={shell} role="group" aria-label={label}>
        <span className="run-target-seg is-placeholder">{emptyText}</span>
      </div>
    );
  }

  const close = (ref: React.RefObject<HTMLButtonElement | null>) => {
    setOpen(null);
    ref.current?.focus();
  };

  return (
    <div className={shell} role="group" aria-label={label}>
      <button
        ref={agentRef}
        type="button"
        className="run-target-seg run-target-seg--agent"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open === "agent"}
        aria-label={selection
          ? `智能体：${selection.agentType}${profile ? ` · ${profile.name}` : ""}；点击更改`
          : `智能体：${unsetText}；点击更改`}
        onClick={() => setOpen((current) => (current === "agent" ? null : "agent"))}
      >
        <Robot size={12} aria-hidden="true" />
        {selection ? <b>{selection.agentType}</b> : <span className="is-placeholder">{unsetText}</span>}
        {/* 执行器名是「选了哪个模型」的结果，挤在对话框底部那排时先让位给模型本身。 */}
        {selection && profile && variant === "field" && <span>{profile.name}</span>}
        <CaretDown size={9} weight="bold" className="run-target-caret" aria-hidden="true" />
      </button>

      <button
        ref={modelRef}
        type="button"
        className="run-target-seg run-target-seg--model"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open === "model"}
        aria-label={`模型：${modelText}；点击更改`}
        onClick={() => setOpen((current) => (current === "model" ? null : "model"))}
      >
        <code>{modelText}</code>
        <CaretDown size={9} weight="bold" className="run-target-caret" aria-hidden="true" />
      </button>

      {onEffortChange && (
        <EffortPicker
          type={selection?.agentType ?? null}
          model={model}
          value={effort}
          disabled={disabled}
          variant="segment"
          label="智能水平"
          followLabel={effortFollowLabel ?? "跟随执行器"}
          onChange={onEffortChange}
        />
      )}

      {open === "agent" && (
        <AgentModelPicker
          types={types}
          profiles={profiles}
          providers={providers}
          initialStage="agent"
          initialAgent={openAt}
          agentOnly
          currentExecutorId={selection?.executorId ?? null}
          triggerRef={agentRef}
          anchorRef={agentRef}
          onCommit={(next) => {
            close(agentRef);
            // 点回同一个智能体 = 什么都没改。照常提交会把模型/智能水平当成「换了人」
            // 一并清掉，等于惩罚了「点开看看又关上」。
            if (selection && next.agent === selection.agentType) return;
            onCommit(next);
          }}
          onCancel={() => close(agentRef)}
        />
      )}
      {open === "model" && (
        <AgentModelPicker
          types={types}
          profiles={profiles}
          providers={providers}
          initialStage="model"
          initialAgent={openAt}
          currentExecutorId={selection?.executorId ?? null}
          triggerRef={modelRef}
          anchorRef={modelRef}
          onCommit={(next) => {
            close(modelRef);
            onCommit(next);
          }}
          onCancel={() => close(modelRef)}
        />
      )}
    </div>
  );
}
