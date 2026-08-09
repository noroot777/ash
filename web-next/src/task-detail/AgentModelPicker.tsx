import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { AgentExecutorProfile, AgentType, LlmProvider } from "@harness/shared";
import { ArrowLeft, CaretRight, Robot, SpinnerGap, Warning } from "@phosphor-icons/react";
import { useAgentModelCatalog } from "../lib/modelCatalog.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";
import {
  agentRows,
  clampIndex,
  flattenModelRows,
  modelSections,
  stepIndex,
  type AgentModelSelection,
} from "./mentionPicker.ts";

/**
 * 「派谁 + 跑哪个模型」选择器。自带筛选框与键盘导航，用在三个入口：
 * ① 对话框里 @ 选中智能体之后，直接以第二步（选模型）打开；
 * ② 点三段胶囊的**智能体**那一段（`agentOnly`）：只列智能体，选完由外层向右打开模型段；
 * ③ 点三段胶囊的**模型**那一段：直接以第二步打开当前智能体的模型列表。
 *
 * 第二步按**供应商分块**：块标题是供应商名，块内是它的模型——供应商和模型是同一
 * 步里的两件事，看着「哪家的」直接点「哪一个」。候选从哪来由供应商设置里的「每次
 * 调用 API / 固定模型」决定（见 lib/modelCatalog.ts）。当前执行器所在的那一块排在
 * 最前面：多数时候要换的就是它旗下的另一个模型。
 *
 * **智能水平不在这里**：它是同一颗胶囊的第三段（components/EffortPicker.tsx）。混进
 * 来会让「只想换个模型」的人多走一步，也让「只想调档位」的人得重选一遍模型。
 *
 * 两种落点：默认贴着调用方自己的定位上下文（对话框在页面底部，朝上弹）；传 `anchorRef`
 * 就改成挂到 body 的 fixed 浮层并贴着那颗触发器算位置——新建任务面板的卡片是
 * `overflow: hidden` 的，不这么做浮层会被卡片边界裁掉半截。
 */

type Stage = "agent" | "model";

export function AgentModelPicker({
  types,
  profiles,
  providers,
  initialStage,
  initialAgent,
  agentOnly = false,
  currentExecutorId = null,
  triggerRef,
  anchorRef,
  onCommit,
  onCancel,
}: {
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  initialStage: Stage;
  initialAgent: AgentType;
  /**
   * 只选智能体：选完直接 onCommit（executorId / model 都给 null = 跟随该类型的默认
   * 执行器），组件内不往「选模型」推；三段胶囊的外层会接着打开右边的模型段。
   */
  agentOnly?: boolean;
  /** 当前生效的执行器：它挂的供应商在第二步里排最前。 */
  currentExecutorId?: string | null;
  triggerRef?: RefObject<HTMLElement | null>;
  /** 传了就挂到 body 上、贴着这个元素定位（躲开祖先的 overflow 裁切）。 */
  anchorRef?: RefObject<HTMLElement | null>;
  onCommit: (selection: AgentModelSelection) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<Stage>(initialStage);
  const [agent, setAgent] = useState<AgentType>(initialAgent);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const place = usePanelPlacement(anchorRef, containerRef);

  useDismissable({ enabled: true, containerRef, onClose: onCancel, restoreFocusRef: triggerRef });

  // 打开或切步骤就把焦点接回筛选框，避免上一行按钮被卸载后把焦点退回 body。
  // **每一步都必须有这个输入框**：workspace 的 j/k/↑↓ 快捷键挂在 window 的**捕获**
  // 阶段（useWorkspaceShortcuts.ts），浮层里怎么 stopPropagation 都拦不住它，它唯一
  // 的让路条件是 `isTextEntry(event.target)`——焦点在 input/textarea 里。所以焦点一旦
  // 落到普通 div 上，↑↓ 就会被拿去切换任务列表。
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, [stage]);

  // 第一步时不去拉模型目录：那会为「只是想换个智能体」的人白发一轮 /v1/models。
  const groups = useAgentModelCatalog(
    stage === "model" ? agent : null,
    profiles,
    providers,
    stage === "model" && agent === initialAgent ? currentExecutorId : null,
  );
  const agents = useMemo(() => agentRows(types, profiles, query), [profiles, query, types]);
  const sections = useMemo(() => modelSections(groups, query), [groups, query]);
  const models = useMemo(() => flattenModelRows(sections), [sections]);

  const rowCount = stage === "agent" ? agents.length : models.length;
  const active = clampIndex(rowCount, index);
  const canGoBack = stage === "model" && initialStage === "agent";

  const openModels = (next: AgentType) => {
    // agentOnly：这一段只提交智能体，executorId 留空 = 跟随该类型的默认执行器；
    // 模型给 null，由调用方清旧覆盖并向右打开模型段。
    if (agentOnly) {
      onCommit({ agent: next, executorId: null, model: null });
      return;
    }
    setAgent(next);
    setStage("model");
    setQuery("");
    setIndex(0);
  };

  const back = () => {
    setStage("agent");
    setQuery("");
    setIndex(0);
  };

  const pick = () => {
    if (stage === "agent") {
      const row = agents[active];
      if (row) openModels(row.agent);
      return;
    }
    const row = models[active];
    if (row) onCommit({ agent, executorId: row.executorId, model: row.model });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex(stepIndex(rowCount, active, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex(stepIndex(rowCount, active, -1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pick();
      return;
    }
    // 筛选词已经空了还按退格 = 「上一步我选错了」，退一步而不是关掉。
    if (event.key === "Backspace" && !query && canGoBack) {
      event.preventDefault();
      back();
    }
  };

  const panel = (
    <div
      className={`agent-model-picker${anchorRef ? " is-floating" : ""}`}
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={anchorRef ? placementStyle(place) : undefined}
    >
      <div className="agent-model-picker-head">
        {canGoBack && (
          <button type="button" className="agent-model-picker-back" onClick={back} aria-label="返回上一步">
            <ArrowLeft size={12} weight="bold" />
          </button>
        )}
        <span className="agent-model-picker-crumb">
          <Robot size={12} aria-hidden="true" />
          {stage === "agent" && "选择智能体"}
          {stage === "model" && <>@{agent} <CaretRight size={9} weight="bold" aria-hidden="true" /> 选择模型</>}
        </span>
        <input
          ref={inputRef}
          value={query}
          placeholder={stage === "agent" ? "筛选智能体…" : `筛选 ${agent} 的模型…`}
          aria-label={stage === "agent" ? "筛选智能体" : "筛选模型"}
          onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
        />
      </div>

      {stage === "agent" ? (
        <div className="agent-model-picker-rows" role="listbox" aria-label="已注册的智能体">
          {!agents.length && <p>没有匹配的已注册智能体</p>}
          {agents.map((row, rowIndex) => (
            <button
              type="button"
              role="option"
              aria-selected={rowIndex === active}
              key={row.key}
              onMouseEnter={() => setIndex(rowIndex)}
              onClick={() => openModels(row.agent)}
            >
              <b>@{row.agent}</b>
              <span>{row.detail}</span>
              <CaretRight size={11} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <div className="agent-model-picker-rows" role="listbox" aria-label="可选模型">
          {!sections.length && <p>没有匹配的模型</p>}
          {sections.map((section) => {
            const offset = section.rows.length ? models.indexOf(section.rows[0]!) : -1;
            return (
              <section key={section.group.key}>
                <header>
                  <b>{section.group.providerName}</b>
                  <small className={section.group.status === "failed" ? "is-error" : ""}>
                    {section.group.status === "loading" && <SpinnerGap size={10} className="is-spinning" aria-hidden="true" />}
                    {section.group.status === "failed" && <Warning size={10} aria-hidden="true" />}
                    {section.group.note}
                  </small>
                </header>
                {section.rows.map((row, rowIndex) => {
                  const flatIndex = offset + rowIndex;
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={flatIndex === active}
                      key={row.key}
                      onMouseEnter={() => setIndex(flatIndex)}
                      onClick={() => onCommit({ agent, executorId: row.executorId, model: row.model })}
                    >
                      <b>{row.label}</b>
                      {row.detail && <span>{row.detail}</span>}
                    </button>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}

      <footer>
        ↑↓ 选择 · 回车确认 · Esc 取消{canGoBack ? " · 退格返回" : ""}
      </footer>
    </div>
  );

  return anchorRef ? createPortal(panel, document.body) : panel;
}
