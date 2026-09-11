import { ArrowUpRight, CaretDown, CheckCircle, Circle, Robot, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { NATIVE_WORK_STATUS_LABELS as labels, type NativeWorkItem } from "./nativeWorkModel.ts";
import { NativeWorkMeta } from "./NativeWorkMeta.tsx";
import "../styles/native-work.css";

function WorkRow({ row, parent, open, onOpen }: { row: NativeWorkItem; parent?: NativeWorkItem; open: boolean; onOpen: () => void }) {
  const Icon = row.status === "completed" ? CheckCircle : row.status === "running" ? SpinnerGap
    : row.status === "failed" ? WarningCircle : row.kind === "agent" ? Robot : Circle;
  return (
    <article className={`native-work__entry${open ? " is-open" : ""}`} data-status={row.status}>
      <details className="native-work__row" data-status={row.status}>
        <summary>
          <span className="native-work__avatar"><Icon size={17} aria-hidden="true" /></span>
          <span className="native-work__identity"><span className="native-work__title">{row.title}</span>
            <span className="native-work__status" data-status={row.status}>{labels[row.status]}</span>
          </span>
          <CaretDown className="native-work__chevron" size={13} aria-hidden="true" />
        </summary>
        <div className="native-work__detail">
          <dl>
            <dt>来源会话</dt><dd>{row.sessionLabel}</dd>
            {parent && <><dt>所属子智能体</dt><dd>{parent.title}</dd></>}
            {row.nativeId && <><dt>编号</dt><dd>{row.nativeId}</dd></>}
            {row.agentType && <><dt>类型</dt><dd>{row.agentType}</dd></>}
            {row.owner && <><dt>负责人</dt><dd>{row.owner}</dd></>}
          </dl>
          {row.description && <section><h4>任务说明</h4><p>{row.description}</p></section>}
          {row.message && <section><h4>最近动态</h4><p>{row.message}</p></section>}
          {row.result && <section><h4>返回结果</h4><p>{row.result}</p></section>}
          {row.legacy && <p className="native-work__hint">{row.kind === "task"
            ? "历史任务编号按创建顺序还原，状态来自智能体的任务更新记录。"
            : "历史记录仅保留派活调用，未记录最终状态。"}</p>}
        </div>
      </details>
      <NativeWorkMeta row={row} />
      <footer className="native-work__footer"><span>{row.sessionLabel}</span>
        {row.kind === "agent" && <button className="native-work__open" type="button" onClick={onOpen} aria-pressed={open} aria-label={`查看执行：${row.title}`}>查看执行<ArrowUpRight size={13} aria-hidden="true" /></button>}
      </footer>
    </article>
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
  const running = rows.filter((row) => row.status === "running").length;
  const complete = rows.filter((row) => row.status === "completed").length;
  return (
    <div className="native-work">
      {error && <div role="alert" className="native-work__error">{error.message} {onRetry && <button type="button" onClick={onRetry}>重试</button>}</div>}
      {loading && <p role="status" className="native-work__hint">正在读取会话记录…</p>}
      {rows.length > 0 ? <>
        <div className="native-work__counts" aria-live="polite"><span><strong>{rows.length}</strong> 项工作</span><span data-status="running"><strong>{running}</strong> 进行中</span><span data-status="completed"><strong>{complete}</strong> 已完成</span></div>
        <p className="native-work__intro">派出的工作与进展，集中在这里。点「查看执行」从左侧展开它的执行详情。</p>
        {(["agent", "task"] as const).map((kind) => {
          const group = rows.filter((row) => row.kind === kind);
          return group.length > 0 && <section className="native-work__group" key={kind} aria-label={kind === "agent" ? "子智能体列表" : "内部任务列表"}>
            <h3>{kind === "agent" ? "子智能体" : "内部任务"}<span>{group.length}</span></h3>
            {group.map((row) => <WorkRow key={row.id} row={row} parent={byId.get(row.parentId ?? "")} open={row.id === openAgentId} onOpen={() => onOpenAgent(row.id)} />)}
          </section>;
        })}
      </> : !loading && !error && <div className="native-work__empty"><Robot size={28} aria-hidden="true" /><strong>暂无子智能体或内部任务</strong><p>智能体派出子任务或创建待办后，会自动显示在这里。</p></div>}
    </div>
  );
}
