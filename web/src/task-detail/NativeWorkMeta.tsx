import { Fragment } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { NativeWorkItem } from "./nativeWorkModel.ts";
import { nativeWorkDate, useNativeWorkTiming } from "./nativeWorkTiming.ts";

function Timestamp({ at, fallback }: { at?: string; fallback: string }) {
  const value = nativeWorkDate(at);
  return value ? <time dateTime={at}><span>{value.date}</span>{" "}<span>{value.time}</span></time>
    : <span className="native-work__unrecorded">{fallback}</span>;
}

function modelLabel(row: NativeWorkItem): string | null {
  return row.kind === "agent"
    ? row.model || (row.requestedModel !== "inherit" && row.requestedModel) || "未记录" : null;
}

/** 模型还没上报时显示的是调用方点的名，标出来免得当成实跑的那个。 */
function ModelHint({ row }: { row: NativeWorkItem }) {
  return !row.model && row.requestedModel && row.requestedModel !== "inherit"
    ? <small>调用指定</small> : null;
}

/** 列表卡片里那条：默认只给时间摘要，点开才是具体的开始与结束。 */
export function NativeWorkMeta({ row }: { row: NativeWorkItem }) {
  const { active, awaitingStart, range, duration, hasDuration } = useNativeWorkTiming(row);
  const model = modelLabel(row);
  return <div className="native-work__meta">
    {model && <dl className="native-work__model">
      <dt>模型</dt><dd><span>{model}</span><ModelHint row={row} /></dd>
    </dl>}
    <details className="native-work__timing">
      <summary aria-label={`时间详情：${range}${hasDuration ? `，时间跨度：${duration}` : ""}`}>
        <span className="native-work__time-range">{range}</span>
        {hasDuration && <><span aria-hidden="true">·</span><span className="native-work__duration-value">{duration}</span></>}
        <CaretDown size={10} aria-hidden="true" />
      </summary>
      <dl className="native-work__times">
        <div><dt>开始时间</dt><dd><Timestamp at={row.startedAt} fallback={awaitingStart ? "尚未开始" : "未记录"} /></dd></div>
        <div><dt>结束时间</dt><dd><Timestamp at={row.endedAt} fallback={awaitingStart ? "—" : active ? "尚未结束" : "未记录"} /></dd></div>
      </dl>
      {!row.startedAt && row.endedAt && <p className="native-work__timing-note">未记录开始时间，无法计算跨度。</p>}
    </details>
  </div>;
}

/**
 * 执行详情抬头里、标题底下那一条：来源会话 · 模型 · 时间 · 跨度。
 * 这些原先是正文顶上一块要点开的「模型与时间」两列表格；抬头右半边一直空着，
 * 于是顺着副标题横向摊开——填上那片空白，也不必再把读者的视线掰成表格。
 */
export function NativeWorkHeadline({ row }: { row: NativeWorkItem }) {
  const { range, duration, hasDuration } = useNativeWorkTiming(row);
  const model = modelLabel(row);
  // 分隔点是真节点而不是 ::before：伪元素不进 innerText，复制出来和读屏念到的会是糊成一团的
  // 「codex@fixturegpt-5.6-sol」。
  const parts = [
    <span key="session">{row.sessionLabel}</span>,
    model ? <span key="model">{model}<ModelHint row={row} /></span> : null,
    <span key="range" className="native-agent__headline-time">{range}</span>,
    hasDuration ? <span key="duration" className="native-agent__headline-time">{duration}</span> : null,
  ].filter((part) => part !== null);
  return <p className="native-agent__headline">
    {parts.map((part, index) => <Fragment key={part.key}>
      {index > 0 && <span className="native-agent__headline-dot" aria-hidden="true">·</span>}
      {part}
    </Fragment>)}
  </p>;
}
