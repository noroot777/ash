import { Cpu, Timer } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { NativeWorkItem } from "./nativeWorkModel.ts";
import { nativeWorkDate, nativeWorkDuration } from "./nativeWorkTiming.ts";

function Timestamp({ at, fallback }: { at?: string; fallback: string }) {
  const value = nativeWorkDate(at);
  return value ? <time dateTime={at}><span>{value.date}</span><b>{value.time}</b></time>
    : <span className="native-work__unrecorded">{fallback}</span>;
}

export function NativeWorkMeta({ row }: { row: NativeWorkItem }) {
  const active = row.status === "running" || row.status === "pending";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !row.startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, row.startedAt]);
  return <div className="native-work__meta">
    <dl className="native-work__model">
      <dt><Cpu size={13} aria-hidden="true" />模型</dt>
      <dd><span>{row.model || row.sessionModel || "未记录"}</span>
        {!row.model && row.sessionModel && <small>会话默认</small>}
      </dd>
    </dl>
    <dl className="native-work__times">
      <div><dt>开始时间</dt><dd><Timestamp at={row.startedAt} fallback="未记录" /></dd></div>
      <div><dt>结束时间</dt><dd><Timestamp at={row.endedAt} fallback={active ? "尚未结束" : "未记录"} /></dd></div>
    </dl>
    <div className="native-work__duration"><span><Timer size={13} aria-hidden="true" />{active ? "已用时" : "总耗时"}</span>
      <strong>{nativeWorkDuration(row, now)}</strong>
    </div>
  </div>;
}
