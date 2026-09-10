import { useEffect, useState } from "react";
import type { NativeWorkItem } from "./nativeWorkModel.ts";
import { nativeWorkDate, nativeWorkDuration } from "./nativeWorkTiming.ts";

function Timestamp({ at, fallback }: { at?: string; fallback: string }) {
  const value = nativeWorkDate(at);
  return value ? <time dateTime={at}><span>{value.date}</span>{" "}<span>{value.time}</span></time>
    : <span className="native-work__unrecorded">{fallback}</span>;
}

export function NativeWorkMeta({ row }: { row: NativeWorkItem }) {
  const active = row.status === "running";
  const awaitingStart = row.status === "pending" && !row.startedAt;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !row.startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, row.startedAt]);
  return <div className="native-work__meta">
    {row.kind === "agent" && <dl className="native-work__model">
      <dt>模型</dt>
      <dd><span>{row.model || row.sessionModel || "未记录"}</span>
        {!row.model && row.sessionModel && <small>会话默认</small>}
      </dd>
    </dl>}
    <dl className="native-work__times">
      <div><dt>开始时间</dt><dd><Timestamp at={row.startedAt} fallback={awaitingStart ? "尚未开始" : "未记录"} /></dd></div>
      <div><dt>结束时间</dt><dd><Timestamp at={row.endedAt} fallback={awaitingStart ? "—" : active ? "尚未结束" : "未记录"} /></dd></div>
    </dl>
    <div className="native-work__duration"><span>时间跨度</span>
      <span className="native-work__duration-value">{awaitingStart ? "—" : nativeWorkDuration(row, now)}</span>
    </div>
    {!row.startedAt && row.endedAt && <p className="native-work__timing-note">未记录开始时间，无法计算跨度。</p>}
  </div>;
}
