import { useEffect, useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { NativeWorkItem } from "./nativeWorkModel.ts";
import { nativeWorkDate, nativeWorkDuration } from "./nativeWorkTiming.ts";

function Timestamp({ at, fallback }: { at?: string; fallback: string }) {
  const value = nativeWorkDate(at);
  return value ? <time dateTime={at}><span>{value.date}</span>{" "}<span>{value.time}</span></time>
    : <span className="native-work__unrecorded">{fallback}</span>;
}

export function NativeWorkMeta({ row, compact = false }: { row: NativeWorkItem; compact?: boolean }) {
  const active = row.status === "running";
  const awaitingStart = row.status === "pending" && !row.startedAt;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !row.startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, row.startedAt]);
  const start = nativeWorkDate(row.startedAt);
  const end = nativeWorkDate(row.endedAt);
  const range = start
    ? `${start.date} ${start.time.slice(0, 5)}${end
      ? `–${end.date === start.date ? "" : `${end.date} `}${end.time.slice(0, 5)}` : " 起"}`
    : end ? `${end.date} ${end.time.slice(0, 5)} 结束` : awaitingStart ? "尚未开始" : "时间未记录";
  const duration = awaitingStart ? "—" : nativeWorkDuration(row, now);
  const hasDuration = duration !== "—" && duration !== "未记录";
  const times = <>
    <dl className="native-work__times">
      <div><dt>开始时间</dt><dd><Timestamp at={row.startedAt} fallback={awaitingStart ? "尚未开始" : "未记录"} /></dd></div>
      <div><dt>结束时间</dt><dd><Timestamp at={row.endedAt} fallback={awaitingStart ? "—" : active ? "尚未结束" : "未记录"} /></dd></div>
    </dl>
    {!row.startedAt && row.endedAt && <p className="native-work__timing-note">未记录开始时间，无法计算跨度。</p>}
  </>;
  return <div className="native-work__meta">
    {row.kind === "agent" && <dl className="native-work__model">
      <dt>模型</dt>
      <dd><span>{row.model || (row.requestedModel !== "inherit" && row.requestedModel) || "未记录"}</span>
        {!row.model && row.requestedModel && row.requestedModel !== "inherit" && <small>调用指定</small>}
      </dd>
    </dl>}
    {compact ? <details className="native-work__timing">
      <summary aria-label={`时间详情：${range}${hasDuration ? `，时间跨度：${duration}` : ""}`}>
        <span className="native-work__time-range">{range}</span>
        {hasDuration && <><span aria-hidden="true">·</span><span className="native-work__duration-value">{duration}</span></>}
        <CaretDown size={10} aria-hidden="true" />
      </summary>
      {times}
    </details> : <>
      {times}
      <div className="native-work__duration"><span>时间跨度</span>
        <span className="native-work__duration-value">{duration}</span>
      </div>
    </>}
  </div>;
}
