// 「这张审查截图过了保留期、已经删掉了」——全站一份。
//
// 为什么是一份跨组件的登记而不是从调用点一层层传下去：引用这些截图的地方不止审查格里那份
// 报告，还有会话里「打开报告」弹出来的那一份、报告里链到的另一份 .md、对话正文里贴的证据
// 地址。它们手上都只有一个**地址**，没有那一轮的状态。而图片加载失败（`onError`）连状态码
// 都拿不到，分不出「过期删了」和「临时取不到」——前者该说「已过保留期」，后者才配「再试
// 一次」。所以服务端在自由工作流状态里给出每一轮删掉了哪几张（`expiredScreenshots`），这里
// 按地址认：读到状态的那一刻登记，渲染点拿地址来问。
//
// 认地址按**解码后的四元组**（任务、审查、轮次、文件名），不按字符串：同一张图可能是相对
// 路径解出来的、绝对路径改写来的、或者用户复制证据地址贴回来的，三者编码不一定一字不差。
import { useSyncExternalStore } from "react";
import type { FreeWorkflowApiState } from "../lib/api.ts";

const ENDPOINT = /\/tasks\/([^/]+)\/free-workflow\/review-file$/;

const byTask = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (runId: string, round: number | string, name: string) => `${runId}\u0000${round}\u0000${name}`;

/** 读到一份自由工作流状态：换下这个任务的登记。内容没变就不惊动任何渲染点。 */
export function recordExpiredEvidence(taskId: string, state: Pick<FreeWorkflowApiState, "reviews">): void {
  const next = new Set<string>();
  for (const run of state.reviews) {
    for (const round of run.rounds) {
      for (const name of round.expiredScreenshots ?? []) next.add(keyOf(run.id, round.round, name));
    }
  }
  const current = byTask.get(taskId);
  if ((current?.size ?? 0) === next.size && [...next].every((key) => current?.has(key))) return;
  if (next.size) byTask.set(taskId, next);
  else byTask.delete(taskId);
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isExpiredEvidence(url: string | null | undefined): boolean {
  if (!url || !byTask.size) return false;
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    return false;
  }
  if (parsed.origin !== window.location.origin) return false;
  const taskId = ENDPOINT.exec(parsed.pathname)?.[1];
  if (!taskId) return false;
  const params = parsed.searchParams;
  let task: string;
  try {
    task = decodeURIComponent(taskId);
  } catch {
    return false;
  }
  return byTask.get(task)?.has(keyOf(params.get("run") ?? "", params.get("round") ?? "", params.get("name") ?? "")) ?? false;
}

/** 渲染点用：这个地址指的那张截图是不是过了保留期（状态晚到也会跟着重画）。 */
export function useExpiredEvidence(url: string | null | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  return isExpiredEvidence(url);
}
