import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentExecutorProfile, AgentType, LlmProvider } from "@harness/shared";
import { ArrowLeft, CaretRight, Robot, SpinnerGap, Warning } from "@phosphor-icons/react";
import { REASONING_EFFORT_VALUES } from "@harness/shared/cli-presets";
import { useAgentModelCatalog } from "../lib/modelCatalog.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import {
  agentRows,
  clampIndex,
  modelRows,
  providerRows,
  stepIndex,
  type MentionTarget,
} from "./mentionPicker.ts";

/**
 * 「派谁 + 用哪家供应商 + 跑哪个模型 + 想多久」四步选择器。自带筛选框与键盘导航，
 * 用在两个入口：
 * ① 对话框里 @ 选中智能体之后，直接以第二步（选供应商）打开；
 * ② 点对话框底部那颗「智能体 · 模型」胶囊，从第一步（选智能体）打开。
 *
 * 第二步先挑**供应商**：这一回合到底走哪套账号 / 目录，先在这里定下来。
 * 第三步才看**模型**：只列刚选那家供应商下面的模型，避免不同供应商的同名模型
 * 混在一起，让人先看到模型再倒回去猜它属于谁。
 *
 * 第四步是思考强度，**排在模型之后**：档位跟着模型走（gpt-5.5 顶到 xhigh、有的
 * 模型压根没有档位），模型还没定就先挑档位只会挑出一个该模型不支持的值，而非法
 * 组合要等 CLI 真跑起来才被上游拒绝。档位表来自 shared 的 REASONING_EFFORT_VALUES
 * （按 CLI 分档）——供应商的 /v1/models 只返回模型 id，接口里拿不到档位能力；
 * 该 CLI 没有档位时第四步自动跳过，选完模型直接落定。
 */

type Stage = "agent" | "provider" | "model" | "effort";
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
  initialStage: "agent" | "provider";
  initialAgent: AgentType;
  triggerRef?: RefObject<HTMLElement | null>;
  onCommit: (target: MentionTarget) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<Stage>(initialStage);
  const [agent, setAgent] = useState<AgentType>(initialAgent);
  const [providerKey, setProviderKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ executorId: string | null; model: string } | null>(null);
  const [index, setIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useDismissable({ enabled: true, containerRef, onClose: onCancel, restoreFocusRef: triggerRef });

  // 打开或切步骤就把焦点接过来，避免上一行按钮被卸载后把焦点退回 body。
  // 强度这步没有筛选框，所以焦点直接落容器，↑↓ / 回车才有人接。
  useLayoutEffect(() => {
    if (stage === "effort") containerRef.current?.focus();
    else inputRef.current?.focus();
  }, [stage]);

  const groups = useAgentModelCatalog(stage === "agent" ? null : agent, profiles, providers);
  const agents = useMemo(() => agentRows(types, profiles, query), [profiles, query, types]);
  const providerList = useMemo(() => providerRows(groups, query), [groups, query]);
  const selectedGroup = useMemo(
    () => groups.find((group) => group.key === providerKey) ?? null,
    [groups, providerKey],
  );
  const models = useMemo(() => modelRows(selectedGroup, query), [selectedGroup, query]);

  const efforts = REASONING_EFFORT_VALUES[agent] ?? [];
  const effortRows = useMemo(
    () => [{ value: "", label: "跟随执行器" }, ...efforts.map((value) => ({ value, label: value }))],
    [efforts],
  );

  const rowCount = stage === "agent"
    ? agents.length
    : stage === "provider"
      ? providerList.length
      : stage === "model" ? models.length : effortRows.length;
  const active = clampIndex(rowCount, index);

  const openProviders = (next: AgentType) => {
    setAgent(next);
    setStage("provider");
    setProviderKey(null);
    setQuery("");
    setIndex(0);
    setPicked(null); // 档位表按 CLI 走，换了智能体上一次挑的供应商/模型/强度都不成立了
  };

  const openModels = (nextProviderKey: string) => {
    setProviderKey(nextProviderKey);
    setStage("model");
    setQuery("");
    setIndex(0);
    setPicked(null);
  };

  /** 选完模型：有档位就进第四步，没有就直接落定。 */
  const openEffort = (executorId: string | null, model: string) => {
    if (!efforts.length) {
      onCommit({ agent, executorId, model, reasoningEffort: null });
      return;
    }
    setPicked({ executorId, model });
    setStage("effort");
    setQuery("");
    setIndex(0);
  };

  const commitEffort = (value: string) => {
    if (!picked) return;
    onCommit({ agent, executorId: picked.executorId, model: picked.model, reasoningEffort: value || null });
  };

  const back = () => {
    if (stage === "effort") {
      setStage("model");
      setPicked(null);
    } else if (stage === "model") {
      setStage("provider");
    } else if (stage === "provider" && initialStage === "agent") {
      setStage("agent");
      setProviderKey(null);
    }
    setQuery("");
    setIndex(0);
  };

  const pick = () => {
    if (stage === "agent") {
      const row = agents[active];
      if (row) openProviders(row.agent);
      return;
    }
    if (stage === "provider") {
      const row = providerList[active];
      if (row) openModels(row.groupKey);
      return;
    }
    if (stage === "effort") {
      const row = effortRows[active];
      if (row) commitEffort(row.value);
      return;
    }
    const row = models[active];
    if (row) openEffort(row.executorId, row.model);
  };

  const handleKey = (key: string): boolean => {
    if (key === "ArrowDown") {
      setIndex(stepIndex(rowCount, active, 1));
      return true;
    }
    if (key === "ArrowUp") {
      setIndex(stepIndex(rowCount, active, -1));
      return true;
    }
    if (key === "Enter") {
      pick();
      return true;
    }
    // 筛选词已经空了还按退格 = 「上一步我选错了」，退一步而不是关掉。
    if (key === "Backspace" && !query && (
      stage === "effort"
      || stage === "model"
      || (stage === "provider" && initialStage === "agent")
    )) {
      back();
      return true;
    }
    return false;
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (handleKey(event.key)) event.preventDefault();
  };

  // 强度这步没有筛选框，焦点只能落在容器上——而用户是**点**上一步某一行进来的，
  // 那颗按钮当场被卸载，浏览器把焦点退回 body，挂在容器上的 onKeyDown 从此收不到
  // 冒泡：↑↓ 失灵而 Esc 还好用（Esc 归 useDismissable 的 document 级监听）。
  // 所以这一步的键盘也挂到 document 上，不依赖焦点在哪。
  const keyRef = useRef(handleKey);
  keyRef.current = handleKey;
  useEffect(() => {
    if (stage !== "effort") return;
    const onKey = (event: KeyboardEvent) => {
      if (!keyRef.current(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [stage]);

  return (
    <div className="agent-model-picker" ref={containerRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="agent-model-picker-head">
        {(stage === "effort" || stage === "model" || (stage === "provider" && initialStage === "agent")) && (
          <button type="button" className="agent-model-picker-back" onClick={back} aria-label="返回上一步">
            <ArrowLeft size={12} weight="bold" />
          </button>
        )}
        <span className="agent-model-picker-crumb">
          <Robot size={12} aria-hidden="true" />
          {stage === "agent" && "选择智能体"}
          {stage === "provider" && <>@{agent} <CaretRight size={9} weight="bold" aria-hidden="true" /> 选择供应商</>}
          {stage === "model" && (
            <>@{agent} <CaretRight size={9} weight="bold" aria-hidden="true" /> {selectedGroup?.providerName ?? "供应商"} <CaretRight size={9} weight="bold" aria-hidden="true" /> 选择模型</>
          )}
          {stage === "effort" && (
            <><code>{picked?.model}</code> <CaretRight size={9} weight="bold" aria-hidden="true" /> 思考强度</>
          )}
        </span>
        {stage !== "effort" && (
          <input
            ref={inputRef}
            value={query}
            placeholder={
              stage === "agent"
                ? "筛选智能体…"
                : stage === "provider"
                  ? `筛选 ${agent} 可用的供应商…`
                  : `筛选 ${selectedGroup?.providerName ?? agent} 的模型…`
            }
            aria-label={stage === "agent" ? "筛选智能体" : stage === "provider" ? "筛选供应商" : "筛选模型"}
            onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
          />
        )}
      </div>

      {stage === "effort" ? (
        <div className="agent-model-picker-rows" role="listbox" aria-label="思考强度">
          {effortRows.map((row, rowIndex) => (
            <button
              type="button"
              role="option"
              aria-selected={rowIndex === active}
              key={row.value || "follow"}
              onMouseEnter={() => setIndex(rowIndex)}
              onClick={() => commitEffort(row.value)}
            >
              <b>{row.label}</b>
              {!row.value && <span>不指定，由执行器决定</span>}
            </button>
          ))}
        </div>
      ) : stage === "agent" ? (
        <div className="agent-model-picker-rows" role="listbox" aria-label="已注册的智能体">
          {!agents.length && <p>没有匹配的已注册智能体</p>}
          {agents.map((row, rowIndex) => (
            <button
              type="button"
              role="option"
              aria-selected={rowIndex === active}
              key={row.key}
              onMouseEnter={() => setIndex(rowIndex)}
              onClick={() => openProviders(row.agent)}
            >
              <b>@{row.agent}</b>
              <span>{row.detail}</span>
              <CaretRight size={11} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : stage === "provider" ? (
        <div className="agent-model-picker-rows" role="listbox" aria-label="可选供应商">
          {!providerList.length && <p>没有匹配的供应商</p>}
          {providerList.map((row, rowIndex) => (
            <button
              type="button"
              role="option"
              aria-selected={rowIndex === active}
              key={row.key}
              onMouseEnter={() => setIndex(rowIndex)}
              onClick={() => openModels(row.groupKey)}
            >
              <b>{row.label}</b>
              <span>{row.detail}</span>
              <CaretRight size={11} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <div className="agent-model-picker-rows" role="listbox" aria-label="可选模型">
          {selectedGroup && (
            <header>
              <b>{selectedGroup.providerName}</b>
              <small className={selectedGroup.status === "failed" ? "is-error" : ""}>
                {selectedGroup.status === "loading" && <SpinnerGap size={10} className="is-spinning" aria-hidden="true" />}
                {selectedGroup.status === "failed" && <Warning size={10} aria-hidden="true" />}
                {selectedGroup.note}
              </small>
            </header>
          )}
          {!models.length && <p>{selectedGroup ? "没有匹配的模型" : "先选供应商"}</p>}
          {models.map((row, rowIndex) => (
            <button
              type="button"
              role="option"
              aria-selected={rowIndex === active}
              key={row.key}
              onMouseEnter={() => setIndex(rowIndex)}
              onClick={() => openEffort(row.executorId, row.model)}
            >
              <b>{row.label}</b>
              {row.detail && <span>{row.detail}</span>}
              <CaretRight size={11} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}

      <footer>
        ↑↓ 选择 · 回车确认 · Esc 取消
        {stage !== "agent" ? " · 退格返回" : ""}
      </footer>
    </div>
  );
}
