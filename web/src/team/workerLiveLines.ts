// 执行者卡片上那一行「此刻在干嘛」。
//
// 从 TeamView 拆出来（那份文件已经顶到 700 行的单文件上限）：它是一块自洽的职责 ——
// 订阅 agent.event，把每条事件压成一行给看板用，别的什么都不做。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, TaskListItem } from "@ash/shared";
import { useServerEvents } from "../lib/events.ts";

/** 一条事件压成一行；返回 null = 这条不值得占那一格（心跳、用量、水位…）。 */
export function liveLineForEvent(event: AgentEvent, textBuffer: string): string | null {
  if (event.kind === "text") {
    return textBuffer.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? null;
  }
  if (event.kind === "tool") return `⚙ ${event.name || "tool"}`;
  if (event.kind === "error") return `✕ ${event.message}`;
  // 结算说明（level:"notice"）以前是条 error，在这一格里跟「执行者崩了」长得一模一样。
  // 现在它走 system 旁注，看板上给它 ⓘ —— 没交卷和崩了是两回事，一眼要分得出轻重。
  if (event.kind === "system" && event.level === "notice") return `ⓘ ${event.text}`;
  return null;
}

/** 每个执行者的最新一行。换团队即清空，别把上一支队伍的状态留在屏幕上。 */
export function useWorkerLiveLines(teamId: string, workers: TaskListItem[]): Record<string, string> {
  const [lines, setLines] = useState<Record<string, string>>({});
  const textBuffers = useRef<Record<string, string>>({});
  const workerIds = useMemo(() => new Set(workers.map((worker) => worker.id)), [workers]);

  useEffect(() => {
    textBuffers.current = {};
    setLines({});
  }, [teamId]);

  useServerEvents(useCallback((event) => {
    if (event.type !== "agent.event" || !workerIds.has(event.taskId)) return;
    let textBuffer = textBuffers.current[event.taskId] ?? "";
    if (event.event.kind === "text") {
      textBuffer = `${textBuffer}${event.event.text}`.slice(-4000);
      textBuffers.current[event.taskId] = textBuffer;
    }
    const line = liveLineForEvent(event.event, textBuffer);
    if (!line) return;
    setLines((current) => current[event.taskId] === line
      ? current
      : { ...current, [event.taskId]: line });
  }, [workerIds]));

  return lines;
}
