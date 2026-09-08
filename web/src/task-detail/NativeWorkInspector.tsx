import { useMemo } from "react";
import { CheckCircle, Circle, Robot, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import type { NativeWorkStatus, TaskStatus } from "@ash/shared";
import type { ConversationItem } from "./conversationModel.ts";
import { buildNativeWork, type NativeWorkItem } from "./nativeWorkModel.ts";
import "../styles/native-work.css";

const labels: Record<NativeWorkStatus, string> = {
  pending: "待处理", running: "进行中", completed: "已完成", failed: "失败", stopped: "已停止", unknown: "状态未知",
};

function WorkRow({ row, parent }: { row: NativeWorkItem; parent?: NativeWorkItem }) {
  const Icon = row.status === "completed" ? CheckCircle : row.status === "running" ? SpinnerGap
    : row.status === "failed" ? WarningCircle : row.kind === "agent" ? Robot : Circle;
  return (
    <details className="native-work__row" data-status={row.status}>
      <summary>
        <Icon size={15} aria-hidden="true" />
        <span className="native-work__title">{row.title}</span>
        <span className="native-work__status">{labels[row.status]}</span>
      </summary>
      <div className="native-work__detail">
        <dl>
          <dt>来源会话</dt><dd>{row.sessionLabel}</dd>
          {parent && <><dt>所属子智能体</dt><dd>{parent.title}</dd></>}
          {row.nativeId && <><dt>编号</dt><dd>{row.nativeId}</dd></>}
          {row.agentType && <><dt>类型</dt><dd>{row.agentType}</dd></>}
          {row.model && <><dt>模型</dt><dd>{row.model}</dd></>}
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
  );
}

export interface NativeWorkInspectorProps {
  items: ConversationItem[];
  status: TaskStatus;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}

export function NativeWorkInspector({ items, status, loading, error, onRetry }: NativeWorkInspectorProps) {
  const rows = useMemo(() => buildNativeWork(items, status), [items, status]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const running = rows.filter((row) => row.status === "running").length;
  const complete = rows.filter((row) => row.status === "completed").length;
  return (
    <div className="native-work">
      <p className="native-work__intro">查看当前任务会话中派出的子智能体和内部任务。</p>
      {error && <div role="alert" className="native-work__error">{error.message} {onRetry && <button type="button" onClick={onRetry}>重试</button>}</div>}
      {loading && <p role="status" className="native-work__hint">正在读取会话记录…</p>}
      {rows.length > 0 ? <>
        <div className="native-work__counts" aria-live="polite"><span>{rows.length} 项</span><span>{running} 进行中</span><span>{complete} 已完成</span></div>
        {(["agent", "task"] as const).map((kind) => {
          const group = rows.filter((row) => row.kind === kind);
          return group.length > 0 && <section className="native-work__group" key={kind} aria-label={kind === "agent" ? "子智能体列表" : "内部任务列表"}>
            <h3>{kind === "agent" ? "子智能体" : "内部任务"}<span>{group.length}</span></h3>
            {group.map((row) => <WorkRow key={row.id} row={row} parent={byId.get(row.parentId ?? "")} />)}
          </section>;
        })}
      </> : !loading && !error && <div className="native-work__empty"><Robot size={28} aria-hidden="true" /><strong>暂无子智能体或内部任务</strong><p>智能体派出子任务或创建待办后，会自动显示在这里。</p></div>}
    </div>
  );
}
