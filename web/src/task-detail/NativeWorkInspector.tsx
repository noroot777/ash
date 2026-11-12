// 「子智能体」格：一行一个，右边是用时。在跑的那几个排在最前，用时是主色，底下多一行它此刻
// 在做什么；别的状态只换右边那几个字。点开先是它带回来的话，再是一行出处（类型 · 模型 ·
// 几点派的），「收到的输入」折着，「执行过程」打开盖住会话的那只抽屉。不同轮次派出去的之间
// 多留一点空。智能体自己记的待办收成最底下一行——它在会话的执行过程里也有一份。
import { useState, type ReactNode } from "react";
import { ArrowUpRight, CaretRight, Check, Circle, CircleNotch, X } from "@phosphor-icons/react";
import { InspButton, InspNone, InspNote } from "../inspector/parts.tsx";
import { agentDoing, agentListRows, agentProvenance, agentSideText, todoCount } from "./nativeWorkList.ts";
import { NATIVE_WORK_NO_ASSIGNMENT, NATIVE_WORK_STATUS_LABELS, type NativeWorkItem } from "./nativeWorkModel.ts";
import { useNativeWorkTiming } from "./nativeWorkTiming.ts";
import "../styles/native-work.css";
// 抽屉（NativeAgentConversation）的样式也从这里带上：它不在 tsx 单测能加载 CSS 的那条链上。
import "../styles/native-agent.css";

function AgentRow({ row, batchStart, parent, showSession, viewing, onOpen }: {
  row: NativeWorkItem;
  batchStart: boolean;
  parent?: NativeWorkItem;
  showSession: boolean;
  viewing: boolean;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  // 在跑的那一行用时每秒往前走（只有它起定时器）。
  useNativeWorkTiming(row);
  const now = Date.now();
  const side = agentSideText(row, now);
  const doing = agentDoing(row);
  const facts = agentProvenance(row, { now, parentTitle: parent?.title, showSession });
  // 还在跑的那种，result 里装的是派活调用当场的回执（codex 回的是一个 agent_id），不是它带回来的话。
  const live = row.status === "running" || row.status === "pending";
  const returned = live ? null : row.result;
  return (
    <div
      className={`native-work__agent${open ? " is-open" : ""}${batchStart ? " is-batch-start" : ""}${viewing ? " is-viewing" : ""}`}
      data-status={row.status}
    >
      <button
        type="button"
        className="insp-go native-work__row"
        aria-expanded={open}
        aria-label={`${row.title}，${NATIVE_WORK_STATUS_LABELS[row.status]}${side.text !== NATIVE_WORK_STATUS_LABELS[row.status] ? `，${side.text}` : ""}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="insp-cut native-work__title">{row.title}</span>
        <span className={`insp-meta native-work__side${side.tone === "live" ? " insp-live" : side.tone === "bad" ? " insp-bad" : ""}`}>
          {side.text}
        </span>
        <CaretRight size={12} aria-hidden="true" className="insp-go__chev" />
      </button>
      {doing && <p className="insp-cut native-work__doing">{doing}</p>}
      {open && (
        <div className="native-work__more">
          {returned
            ? <p className="native-work__result">{returned}</p>
            : (
              <p className="native-work__result is-empty">
                {live ? "还没带回来话，跑完会出现在这里。" : "没有带回来的话。"}
              </p>
            )}
          {facts.length > 0 && <p className="native-work__facts">{facts.join(" · ")}</p>}
          {row.legacy && <p className="insp-hint">历史记录仅保留派活调用，未记录最终状态。</p>}
          <div className="native-work__folds">
            <button
              type="button"
              className="native-work__fold"
              aria-expanded={inputOpen}
              onClick={() => setInputOpen((current) => !current)}
            >
              <CaretRight size={12} aria-hidden="true" />
              收到的输入
            </button>
            <button
              type="button"
              className="native-work__fold native-work__open"
              aria-pressed={viewing}
              aria-label={`查看执行：${row.title}`}
              onClick={onOpen}
            >
              执行过程
              <ArrowUpRight size={12} aria-hidden="true" />
            </button>
          </div>
          {inputOpen && (
            <p className={`native-work__input${row.description ? "" : " is-empty"}`}>
              {row.description || NATIVE_WORK_NO_ASSIGNMENT}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const TODO_ICON: Record<NativeWorkItem["status"], ReactNode> = {
  completed: <Check size={12} aria-hidden="true" />,
  running: <CircleNotch size={12} aria-hidden="true" />,
  failed: <X size={12} aria-hidden="true" />,
  stopped: <X size={12} aria-hidden="true" />,
  pending: <Circle size={12} aria-hidden="true" />,
  unknown: <Circle size={12} aria-hidden="true" />,
};

/** 最底下那一行「待办 做完几项 / 一共几项」，点开是一项一行。没有子智能体时默认铺开。 */
function TodoRow({ rows, byId, defaultOpen }: { rows: NativeWorkItem[]; byId: Map<string, NativeWorkItem>; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { done, total } = todoCount(rows);
  return (
    <section className="native-work__todos" aria-label="待办">
      <button type="button" className="insp-go native-work__todo-row" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span>待办</span>
        <span className="insp-meta insp-num">{done} / {total}</span>
        <CaretRight size={12} aria-hidden="true" className="insp-go__chev" />
      </button>
      {open && (
        <ol className="native-work__todo-list">
          {rows.map((row) => {
            const parent = row.parentId ? byId.get(row.parentId) : undefined;
            const odd = row.status === "running" || row.status === "failed" || row.status === "stopped" || row.status === "unknown";
            return (
              <li key={row.id} data-status={row.status}>
                <span className="native-work__todo-icon">{TODO_ICON[row.status]}</span>
                <span className="native-work__todo-title">
                  {row.title}
                  {parent && <span className="insp-faint"> · {parent.title}</span>}
                </span>
                {odd && (
                  <span className={`insp-meta${row.status === "running" ? " insp-live" : row.status === "failed" ? " insp-bad" : ""}`}>
                    {NATIVE_WORK_STATUS_LABELS[row.status]}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export interface NativeWorkInspectorProps {
  /** 由宿主（useSubagents）算好传进来：抽屉和列表必须认同一份行。 */
  rows: NativeWorkItem[];
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  /** 正从左侧抽屉里看着的那个子智能体，用来在列表上回显。 */
  openAgentId: string | null;
  onOpenAgent: (id: string) => void;
}

export function NativeWorkInspector({ rows, loading, error, onRetry, openAgentId, onOpenAgent }: NativeWorkInspectorProps) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const agents = agentListRows(rows);
  const todos = rows.filter((row) => row.kind === "task");
  // 团队里一格装着好几路会话的子智能体：那时出处里带上是哪一路派的。
  const showSession = new Set(agents.map(({ row }) => row.sessionId)).size > 1;
  return (
    <div className="insp-pane native-work">
      {error && (
        <div role="alert" className="native-work__error">
          <InspNote tone="bad" action={onRetry && <InspButton size="sm" onClick={onRetry}>重试</InspButton>}>{error.message}</InspNote>
        </div>
      )}
      {loading && rows.length === 0 && <InspNone>正在读取会话记录…</InspNone>}
      {agents.length > 0 && (
        <div className="native-work__agents" aria-label="子智能体列表">
          {agents.map(({ row, batchStart }) => (
            <AgentRow
              key={row.id}
              row={row}
              batchStart={batchStart}
              parent={byId.get(row.parentId ?? "")}
              showSession={showSession}
              viewing={row.id === openAgentId}
              onOpen={() => onOpenAgent(row.id)}
            />
          ))}
        </div>
      )}
      {!loading && !error && agents.length === 0 && todos.length === 0 && <InspNone>这个任务没有派过子智能体。</InspNone>}
      {todos.length > 0 && <TodoRow rows={todos} byId={byId} defaultOpen={agents.length === 0} />}
    </div>
  );
}
