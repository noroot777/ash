import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentExecutorProfile, AgentType, LlmProvider } from "@harness/shared";
import { ArrowLeft, CaretRight, Robot, SpinnerGap, Warning } from "@phosphor-icons/react";
import { useAgentModelCatalog } from "../lib/modelCatalog.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import {
  agentRows,
  clampIndex,
  flattenModelRows,
  modelSections,
  stepIndex,
  type MentionTarget,
} from "./mentionPicker.ts";

/**
 * 「派谁 + 跑哪个模型」两步选择器。自带筛选框与键盘导航，用在两个入口：
 * ① 对话框里 @ 选中智能体之后，直接以第二步（选模型）打开；
 * ② 点对话框底部那颗「智能体 · 模型」胶囊，从第一步（选智能体）打开。
 *
 * 第二步按**供应商**分块：块标题是供应商名，块内是它的模型；候选从哪来由供应商
 * 设置里的「每次调用 API / 固定模型」决定（见 lib/modelCatalog.ts）。
 */
export function AgentModelPicker({
  types,
  profiles,
  providers,
  initialStage,
  initialAgent,
  triggerRef,
  onCommit,
  onCancel,
}: {
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  initialStage: "agent" | "model";
  initialAgent: AgentType;
  triggerRef?: RefObject<HTMLElement | null>;
  onCommit: (target: MentionTarget) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState(initialStage);
  const [agent, setAgent] = useState<AgentType>(initialAgent);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useDismissable({ enabled: true, containerRef, onClose: onCancel, restoreFocusRef: triggerRef });

  // 打开就把焦点接过来，用户不用再点一下输入框才能筛选。
  useEffect(() => { inputRef.current?.focus(); }, [stage]);

  const groups = useAgentModelCatalog(stage === "model" ? agent : null, profiles, providers);
  const agents = useMemo(() => agentRows(types, profiles, query), [profiles, query, types]);
  const sections = useMemo(() => modelSections(groups, query), [groups, query]);
  const modelRows = useMemo(() => flattenModelRows(sections), [sections]);

  const rowCount = stage === "agent" ? agents.length : modelRows.length;
  const active = clampIndex(rowCount, index);

  const openModels = (next: AgentType) => {
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
    const row = modelRows[active];
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
    // 第二步里筛选词已经空了还按退格 = 「我选错智能体了」，退回第一步而不是关掉。
    if (event.key === "Backspace" && stage === "model" && initialStage === "agent" && !query) {
      event.preventDefault();
      back();
    }
  };

  return (
    <div className="agent-model-picker" ref={containerRef} onKeyDown={onKeyDown}>
      <div className="agent-model-picker-head">
        {stage === "model" && initialStage === "agent" && (
          <button type="button" className="agent-model-picker-back" onClick={back} aria-label="返回选择智能体">
            <ArrowLeft size={12} weight="bold" />
          </button>
        )}
        <span className="agent-model-picker-crumb">
          <Robot size={12} aria-hidden="true" />
          {stage === "agent" ? "选择智能体" : <>@{agent} <CaretRight size={9} weight="bold" aria-hidden="true" /> 选择模型</>}
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
            const offset = modelRows.indexOf(section.rows[0]!);
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
                      className={row.model === null ? "is-follow" : ""}
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

      <footer>↑↓ 选择 · 回车确认 · Esc 取消{stage === "model" && initialStage === "agent" ? " · 退格返回" : ""}</footer>
    </div>
  );
}
