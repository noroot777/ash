import { useRef, useState } from "react";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { CaretDown, Robot } from "@phosphor-icons/react";
import { AgentModelPicker } from "../task-detail/AgentModelPicker.tsx";
import { useProviders } from "../lib/modelCatalog.ts";
import type { AgentModelSelection } from "../task-detail/mentionPicker.ts";

/**
 * 「执行器 · 模型」这一颗胶囊：**派给谁**和**跑哪个模型**是同一个决定的两半——
 * 换了执行器就得重新看有哪些模型，选中某个模型也就同时定了走哪家供应商的哪个
 * Profile。所以它们合成一颗，点开是同一个两步浮层（AgentModelPicker）。
 *
 * 思考强度**不在这颗里**：它跟模型是两件独立的事，是并排的另一颗胶囊
 * （components/EffortPicker.tsx）。所有选模型的表面都按这个形状摆：
 * 新建/派生面板（composer/ExecutorPickerField.tsx）、存量任务信息面板
 * （task-detail/TaskInspector.tsx）、对话框底部（task-detail/ReplyBox.tsx）。
 */
export function ExecutorModelPicker({
  label,
  types,
  profiles,
  knownProfiles,
  selection,
  fallbackType,
  model,
  disabled = false,
  emptyText = "暂无可用执行器",
  unsetText = "还没指定",
  onCommit,
}: {
  /** 无可见标题时的可访问名称。 */
  label: string;
  /** 可派的 CLI 类型。 */
  types: AgentType[];
  /** 可选的执行器 Profile。 */
  profiles: AgentExecutorProfile[];
  /** 用于显示当前执行器名字：包含已不可用的那些，否则胶囊会显示成空。 */
  knownProfiles?: AgentExecutorProfile[];
  /** null = 还没指定（工作流的站点可以「跟随任务的执行器」），胶囊上写 unsetText。 */
  selection: { agentType: AgentType; executorId: string | null } | null;
  /** 没指定时浮层从哪个 CLI 起步；不传就取第一个可派类型。 */
  fallbackType?: AgentType;
  /** 当前模型覆盖（空 = 跟随执行器）。 */
  model: string | null;
  disabled?: boolean;
  emptyText?: string;
  unsetText?: string;
  onCommit: (next: AgentModelSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const providers = useProviders();

  const pool = knownProfiles ?? profiles;
  const profile = selection?.executorId
    ? pool.find((candidate) => candidate.id === selection.executorId)
    : undefined;
  const empty = types.length + profiles.length === 0;
  const modelText = model?.trim() || "跟随执行器";
  const openAt = selection?.agentType ?? fallbackType ?? types[0] ?? profiles[0]?.type ?? "claude";

  return (
    <div className="executor-model-picker">
      <button
        ref={triggerRef}
        type="button"
        className="ui-select-trigger composer-executor-trigger"
        disabled={disabled || empty}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={selection
          ? `${label}：${selection.agentType}${profile ? ` · ${profile.name}` : ""}，模型 ${modelText}；点击更改`
          : `${label}：${unsetText}；点击更改`}
        onClick={() => setOpen((current) => !current)}
      >
        {empty ? (
          <span className="is-placeholder">{emptyText}</span>
        ) : !selection ? (
          <>
            <Robot size={12} aria-hidden="true" />
            <span className="is-placeholder">{unsetText}</span>
          </>
        ) : (
          <>
            <Robot size={12} aria-hidden="true" />
            <b>{selection.agentType}</b>
            <span>{profile ? profile.name : "类型默认"}</span>
            <code>{modelText}</code>
          </>
        )}
        <CaretDown size={11} weight="bold" className="ui-select-caret" aria-hidden="true" />
      </button>
      {open && (
        <AgentModelPicker
          types={types}
          profiles={profiles}
          providers={providers}
          initialStage="agent"
          initialAgent={openAt}
          currentExecutorId={selection?.executorId ?? null}
          triggerRef={triggerRef}
          anchorRef={triggerRef}
          onCommit={(next) => {
            setOpen(false);
            onCommit(next);
            triggerRef.current?.focus();
          }}
          onCancel={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
