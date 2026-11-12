// 「子智能体」那一格的排法和每行的几段字。纯函数，好单测。
import type { NativeWorkItem } from "./nativeWorkModel.ts";
import { fieldValues } from "./NativeWorkMeta.tsx";
import { nativeWorkDuration } from "./nativeWorkTiming.ts";
import { formatInstant } from "./utils.ts";

export interface AgentListRow {
  row: NativeWorkItem;
  /** 跟上一行不是同一轮派出去的：两行之间多留一点空，不写「第几批」。 */
  batchStart: boolean;
}

/**
 * 一行一个子智能体。在跑的那几个排在最前；其余按派出去的那一轮分组，新的一轮在上，
 * 同一轮里按派出的先后。
 */
export function agentListRows(rows: readonly NativeWorkItem[]): AgentListRow[] {
  const agents = rows.filter((row) => row.kind === "agent");
  const turnOrder = new Map<string, number>();
  for (const row of agents) {
    const turn = row.dispatchTurn ?? row.id;
    if (!turnOrder.has(turn)) turnOrder.set(turn, turnOrder.size);
  }
  const turnOf = (row: NativeWorkItem) => turnOrder.get(row.dispatchTurn ?? row.id) ?? 0;
  const running = agents.filter((row) => row.status === "running");
  const rest = agents
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.status !== "running")
    .sort((a, b) => turnOf(b.row) - turnOf(a.row) || a.index - b.index)
    .map(({ row }) => row);
  const ordered = [...running, ...rest];
  return ordered.map((row, index) => {
    const previous = ordered[index - 1];
    // 在跑的那一组算一轮；之后按派出的回合分。
    const group = (item: NativeWorkItem) => (item.status === "running" ? "running" : `turn-${turnOf(item)}`);
    return { row, batchStart: !!previous && group(previous) !== group(row) };
  });
}

/** 右边那几个字：在跑和跑完了的是用时，别的状态只换这几个字。 */
export function agentSideText(row: NativeWorkItem, now: number): { text: string; tone: "live" | "bad" | "plain" } {
  const took = nativeWorkDuration(row, now);
  const known = took !== "未记录";
  switch (row.status) {
    case "running": return { text: known ? took : "在跑", tone: "live" };
    case "completed": return { text: known ? took : "已完成", tone: "plain" };
    case "failed": return { text: "失败", tone: "bad" };
    case "stopped": return { text: "已停止", tone: "plain" };
    case "pending": return { text: "待处理", tone: "plain" };
    default: return { text: "状态未知", tone: "plain" };
  }
}

/** 在跑的那一行底下那一句：它此刻在做什么。最近一条动态优先，没有就拿最后一次工具调用。 */
export function agentDoing(row: NativeWorkItem): string | null {
  if (row.status !== "running") return null;
  const firstLine = (text: string) => text.replace(/[*_`#>]/g, "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (row.message && firstLine(row.message)) return firstLine(row.message);
  const last = [...(row.activity ?? [])].reverse().find((event) => event.kind === "tool" || event.kind === "text");
  if (!last) return null;
  if (last.kind === "tool") return firstLine(`${last.name}${last.detail ? ` ${last.detail}` : ""}`).slice(0, 160) || null;
  return last.kind === "text" ? firstLine(last.text) || null : null;
}

/**
 * 点开以后那一行出处：类型 · 模型 · 智能水平 · 几点派的（再加上没跑完时跑了多久、由谁派的、
 * 哪一路会话）。模型和智能水平实跑值优先，没上报就退到派活时点的名并标「调用指定」，
 * 两样都没有就不占位。
 */
export function agentProvenance(
  row: NativeWorkItem,
  opts: { now?: number; parentTitle?: string; showSession?: boolean } = {},
): string[] {
  const fields = fieldValues(row).filter((field) => !field.unknown);
  const dispatched = formatInstant(row.startedAt);
  const took = nativeWorkDuration(row, opts.now ?? Date.now());
  const sideShowsDuration = row.status === "running" || row.status === "completed";
  return [
    row.agentType || null,
    ...fields.map((field) => {
      const value = field.label === "智能水平" ? `智能水平 ${field.value}` : field.value;
      return field.requestedOnly ? `${value}（调用指定）` : value;
    }),
    dispatched ? `${dispatched} 派出` : null,
    !sideShowsDuration && took !== "未记录" ? `跑了 ${took}` : null,
    opts.parentTitle ? `由「${opts.parentTitle}」派出` : null,
    opts.showSession ? row.sessionLabel : null,
  ].filter((piece): piece is string => !!piece);
}

/** 待办那一行右边的数：做完几项 / 一共几项。 */
export function todoCount(rows: readonly NativeWorkItem[]): { done: number; total: number } {
  const tasks = rows.filter((row) => row.kind === "task");
  return { done: tasks.filter((row) => row.status === "completed").length, total: tasks.length };
}
