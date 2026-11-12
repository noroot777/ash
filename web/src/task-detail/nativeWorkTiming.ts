import { useEffect, useState } from "react";
import type { NativeWorkItem } from "./nativeWorkModel.ts";
import { formatInstant, formatInstantRange } from "./utils.ts";

export function nativeWorkDuration(row: NativeWorkItem, now: number): string {
  const start = row.startedAt ? Date.parse(row.startedAt) : NaN;
  const end = row.endedAt ? Date.parse(row.endedAt)
    : row.status === "running" ? now : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "未记录";
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时 ${Math.floor(seconds % 3600 / 60)}分`;
  return `${Math.floor(seconds / 86400)}天 ${Math.floor(seconds % 86400 / 3600)}小时 ${Math.floor(seconds % 3600 / 60)}分`;
}

/**
 * 起止区间，与任务检查器里那条同一个写法（`11/06 14:05 → 14:59`）；一个时刻都没记下就是空串，
 * 让列表卡片自己决定空着——「尚未开始」「时间未记录」那类说明留给展开后的时间详情。
 */
export function nativeWorkRange(row: NativeWorkItem): string {
  if (formatInstant(row.startedAt)) return formatInstantRange(row.startedAt, row.endedAt);
  const end = formatInstant(row.endedAt);
  return end ? `${end} 结束` : "";
}

/** 抬头那一条和列表卡片读同一份时间：跑着的时候跨度自己每秒往前走。 */
export function useNativeWorkTiming(row: NativeWorkItem) {
  const active = row.status === "running";
  const awaitingStart = row.status === "pending" && !row.startedAt;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !row.startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, row.startedAt]);
  const range = nativeWorkRange(row) || (awaitingStart ? "尚未开始" : "时间未记录");
  const duration = awaitingStart ? "—" : nativeWorkDuration(row, now);
  return { active, awaitingStart, range, duration, hasDuration: duration !== "—" && duration !== "未记录" };
}
