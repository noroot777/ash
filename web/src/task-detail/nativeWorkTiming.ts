import { useEffect, useState } from "react";
import type { NativeWorkItem } from "./nativeWorkModel.ts";

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

// 跟 task-detail/utils.ts 的 formatInstant 同一套写法：MM/DD HH:mm，不带年份也不带秒。
export function nativeWorkDate(at?: string): { date: string; time: string } | null {
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const value = new Date(at);
  const pad = (number: number) => String(number).padStart(2, "0");
  return {
    date: `${pad(value.getMonth() + 1)}/${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
  };
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
  const start = nativeWorkDate(row.startedAt);
  const end = nativeWorkDate(row.endedAt);
  const range = start
    ? `${start.date} ${start.time}${end
      ? `–${end.date === start.date ? "" : `${end.date} `}${end.time}` : " 起"}`
    : end ? `${end.date} ${end.time} 结束` : awaitingStart ? "尚未开始" : "时间未记录";
  const duration = awaitingStart ? "—" : nativeWorkDuration(row, now);
  return { active, awaitingStart, range, duration, hasDuration: duration !== "—" && duration !== "未记录" };
}
