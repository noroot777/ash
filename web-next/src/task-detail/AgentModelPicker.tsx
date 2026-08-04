import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
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
 *
 * 两种落点：默认贴着调用方自己的定位上下文（对话框在页面底部，朝上弹）；传 `anchorRef`
 * 就改成挂到 body 的 fixed 浮层并贴着那颗触发器算位置——新建任务面板的卡片是
 * `overflow: hidden` 的，不这么做浮层会被卡片边界裁掉半截。
 */

type Placement = { left: number; top: number; width: number };

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 320; // 够不够翻转到上方的判据，不是硬高度（内部列表自带 max-height）

type Stage = "agent" | "provider" | "model" | "effort";
export function AgentModelPicker({
  types,
  profiles,
  providers,
  initialStage,
  initialAgent,
  triggerRef,
  anchorRef,
  onCommit,
  onCancel,
}: {
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  initialStage: "agent" | "provider";
  initialAgent: AgentType;
  triggerRef?: RefObject<HTMLElement | null>;
  /** 传了就挂到 body 上、贴着这个元素定位（躲开祖先的 overflow 裁切）。 */
  anchorRef?: RefObject<HTMLElement | null>;
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
  const [place, setPlace] = useState<Placement | null>(null);

  useDismissable({ enabled: true, containerRef, onClose: onCancel, restoreFocusRef: triggerRef });

  // fixed 落点：贴着触发器算，下方装不下就翻到上方；页面滚动/改尺寸时跟着走。
  useLayoutEffect(() => {
    if (!anchorRef) return;
    const measure = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const flip = below < PANEL_HEIGHT && above > below;
      const width = Math.max(rect.width, PANEL_WIDTH);
      setPlace({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: flip ? Math.max(8, rect.top - 6 - PANEL_HEIGHT) : rect.bottom + 6,
        width,
      });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchorRef]);

  // 打开或切步骤就把焦点接回筛选框，避免上一行按钮被卸载后把焦点退回 body。
  // **每一步都必须有这个输入框**（强度那步也不例外）：workspace 的 j/k/↑↓ 快捷键
  // 挂在 window 的**捕获**阶段（useWorkspaceShortcuts.ts），浮层里怎么 stopPropagation
  // 都拦不住它，它唯一的让路条件是 `isTextEntry(event.target)`——焦点在 input/textarea 里。
  // 所以焦点一旦落到普通 div 上，↑↓ 就会被拿去切换任务列表。
  useLayoutEffect(() => {
    inputRef.current?.focus();
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
  const effortRows = useMemo(() => {
    const rows = [{ value: "", label: "跟随执行器" }, ...efforts.map((value) => ({ value, label: value }))];
    const keyword = query.trim().toLowerCase();
    return keyword ? rows.filter((row) => row.label.toLowerCase().includes(keyword)) : rows;
  }, [efforts, query]);

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
    if (event.key === "Backspace" && !query && (
      stage === "effort"
      || stage === "model"
      || (stage === "provider" && initialStage === "agent")
    )) {
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
      style={anchorRef && place ? { left: place.left, top: place.top, width: place.width } : undefined}
    >
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
        <input
          ref={inputRef}
          value={query}
          placeholder={
            stage === "agent"
              ? "筛选智能体…"
              : stage === "provider"
                ? `筛选 ${agent} 可用的供应商…`
                : stage === "model"
                  ? `筛选 ${selectedGroup?.providerName ?? agent} 的模型…`
                  : "筛选思考强度…"
          }
          aria-label={
            stage === "agent"
              ? "筛选智能体"
              : stage === "provider" ? "筛选供应商" : stage === "model" ? "筛选模型" : "筛选思考强度"
          }
          onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
        />
      </div>

      {stage === "effort" ? (
        <div className="agent-model-picker-rows" role="listbox" aria-label="思考强度">
          {!effortRows.length && <p>没有匹配的档位</p>}
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

  return anchorRef ? createPortal(panel, document.body) : panel;
}
