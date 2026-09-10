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

export function nativeWorkDate(at?: string): { date: string; time: string } | null {
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const value = new Date(at);
  const pad = (number: number) => String(number).padStart(2, "0");
  return {
    date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`,
  };
}
