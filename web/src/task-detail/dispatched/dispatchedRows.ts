import { taskDisplayStatus, type TaskListItem } from "@ash/shared";
import { awaitsRuling, hasFailed } from "../../lib/taskAttention.ts";
import { taskLook, type TaskLook } from "../../lib/taskLook.ts";
import { taskDurationInfo } from "../utils.ts";

// 右侧「子任务」那一格一行里的几样字：状态词、那一行小字、这一批是一个接一个还是同时。
// 单独成文件是为了让判据能被回归测试直接钉住，组件那边只负责画。

export type DispatchedTone = "ask" | "bad" | null;

/**
 * 状态词用产品里现有的叫法，不造新词：等答复跟侧栏行尾那两三个字同一句「等你答复」，
 * 做完没验收跟侧栏那颗环同一句「待验收」，其余照任务头那套（运行中、排队中、暂停中……）。
 * 只有需要你处理的几种带颜色：等你答复 / 等你裁定（琥珀）、失败 / 验证没过（红）。
 */
export function dispatchedWord(task: TaskListItem, look: TaskLook = taskLook(task)): { word: string; tone: DispatchedTone } {
  if (look.indicator !== taskLook(task).indicator && look.phrase) return { word: look.phrase.word, tone: look.phrase.tone };
  if (task.question) return { word: "等你答复", tone: "ask" };
  if (awaitsRuling(task)) return { word: "等你裁定", tone: "ask" };
  const display = taskDisplayStatus(task.status, task.stage, false);
  if (hasFailed(task)) return { word: display.label, tone: "bad" };
  if (taskLook(task).indicator === "unaccepted") return { word: "待验收", tone: null };
  if (task.queueId != null && task.queuePosition != null && (task.status === "queued" || task.status === "backlog")) return { word: `排第 ${task.queuePosition + 1}`, tone: null };
  return { word: display.label, tone: null };
}

/** 那一行小字：谁在干（执行器）、干了多久。 */
export function dispatchedMeta(task: TaskListItem, now = Date.now()): string {
  if (task.question) return task.question;
  const indicator = taskLook(task).indicator;
  if (!indicator || !["active", "working", "attention", "error", "stalled"].includes(indicator)) return "";
  const executor = task.executorLabel || task.agentType || null;
  const duration = taskDurationInfo(task, now);
  return [executor, duration ? `${duration.label} ${duration.text}` : null].filter(Boolean).join(" · ");
}

/**
 * 这一批怎么跑，看得出来才写：全在同一条队列里 = 一个接一个；一条都不在队列里 = 同时。
 * 混着的（几批派法不一样）就不写 —— 写哪一种都是半句假话。
 */
export function dispatchedOrder(tasks: readonly TaskListItem[]): "一个接一个" | "同时" | null {
  if (tasks.length < 2) return null;
  const queues = new Set(tasks.map((task) => task.queueId ?? null));
  if (queues.size !== 1) return null;
  return queues.has(null) ? "同时" : "一个接一个";
}
