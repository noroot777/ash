// 「这张审查截图过了保留期、已经删掉了」——全站一份。
//
// 为什么是一份跨组件的登记而不是从调用点一层层传下去：引用这些截图的地方不止审查格里那份
// 报告，还有会话里「打开报告」弹出来的那一份、报告里链到的另一份 .md、对话正文里贴的证据
// 地址、点开之后的灯箱——而且可能是**别的任务**的证据。它们手上都只有一个地址，没有那一轮的
// 状态。图片加载失败（`onError`）又连状态码都拿不到，分不出「过期删了」和「临时取不到」——
// 前者该说「已过保留期」，后者才配「再试一次」。所以按地址里的任务编号，在这一层维护每个
// 任务的过期清单。
//
// 这份清单是**服务端事实的一份副本**，必须守住两条（审查第 1、2 轮实测过它们各自怎么坏）：
//
// 一、**新旧只认服务端修订号**。来源有两条：整份自由工作流状态（useFreeWorkflowState 收下
//    一份就登记）和只取清单的轻量接口；两者带的是同一个 `stateVersion`（服务端
//    expiredScreenshotsState）。只收比现有更新的那份，相等也不收——按到达顺序裁决的话，
//    迟到的旧清单会把整份状态刚报出的过期抹掉，而整份状态的同版本轮询又再也纠正不回来。
//
// 二、**副本会过时，刷新时机放在这一层，不靠哪个界面碰巧报错**。凡是有渲染点引用着的任务：
//    · 引用挂载时（打开报告、重新打开）重取；
//    · 服务端宣布这个任务的审查状态变了（清扫删了图会发）立刻重取；
//    · 定时重取，接住不发事件的变化（接力把图带回来、有人手动删）和上一趟没取成的；
//    · 同源证据图取不到时重取（内嵌图、灯箱都接了）。
//    「本地没登记」只能说明「还不知道」，不能当成「没过期」；取失败就维持原样，等下一次。
//
// 认地址按**规范化后的身份**（任务、审查、轮次按数、文件名按段用 `/` 拼），跟服务端证据接口
// 同一口径：同一张图可能是相对路径解出来的、绝对路径改写来的、或者用户复制证据地址贴回来的，
// 写法不一定一字不差（`round=01`、`shots\a.png`）。
import { useEffect, useSyncExternalStore } from "react";
import type { FreeReviewExpiredScreenshots } from "@ash/shared";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { subscribeEvents } from "../lib/events.ts";

const ENDPOINT = /\/tasks\/([^/]+)\/free-workflow\/review-file$/;
/** 有引用时多久重取一次。比审查状态的轮询慢得多：它只兜「不发事件的变化」。 */
export const EXPIRED_EVIDENCE_REVALIDATE_MS = 20_000;

type Identity = { taskId: string; key: string };
type Entry = { version: number; keys: ReadonlySet<string> };

const byTask = new Map<string, Entry>();
const inFlight = new Set<string>();
const stale = new Set<string>();
const refs = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribeEvents: (() => void) | null = null;

function keyOf(runId: string, round: number | string, name: string): string | null {
  const roundNo = Number(round);
  const parts = name.split(/[\\/]/);
  if (!runId || !Number.isInteger(roundNo) || roundNo <= 0 || parts.some((part) => !part || part === "." || part === "..")) return null;
  return `${runId}\u0000${roundNo}\u0000${parts.join("/")}`;
}

function identityOf(url: string | null | undefined): Identity | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    return null;
  }
  if (parsed.origin !== window.location.origin) return null;
  const encoded = ENDPOINT.exec(parsed.pathname)?.[1];
  if (!encoded) return null;
  let taskId: string;
  try {
    taskId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const params = parsed.searchParams;
  const key = keyOf(params.get("run") ?? "", params.get("round") ?? "", params.get("name") ?? "");
  return key ? { taskId, key } : null;
}

/** 两条来源共用的唯一入口：比现有登记新才收（见文件头第一条）。 */
function record(taskId: string, snapshot: FreeReviewExpiredScreenshots): void {
  const current = byTask.get(taskId);
  if (current && current.version >= snapshot.stateVersion) return;
  const keys = new Set<string>();
  for (const round of snapshot.rounds) {
    for (const name of round.names) {
      const key = keyOf(round.runId, round.round, name);
      if (key) keys.add(key);
    }
  }
  const same = current && current.keys.size === keys.size && [...keys].every((key) => current.keys.has(key));
  byTask.set(taskId, { version: snapshot.stateVersion, keys: same ? current.keys : keys });
  if (same) return;
  version++;
  for (const listener of listeners) listener();
}

/** 收下一份整份自由工作流状态（调用方已经按同一个修订号挡过旧的）。 */
export function recordExpiredEvidence(taskId: string, state: Pick<FreeWorkflowApiState, "reviews" | "stateVersion">): void {
  record(taskId, {
    stateVersion: state.stateVersion,
    rounds: state.reviews.flatMap((run) => run.rounds.map((round) => ({
      runId: run.id,
      round: round.round,
      names: round.expiredScreenshots ?? [],
    }))),
  });
}

/**
 * 现取这个任务的过期清单（同一时刻只取一趟）。`fresh`：要的是「此刻之后」的清单——正在取的
 * 那一趟可能发在变化之前，拿它交差会漏掉刚发生的事，所以排一趟在它之后。
 */
function load(taskId: string, fresh = false): void {
  if (inFlight.has(taskId)) {
    if (fresh) stale.add(taskId);
    return;
  }
  inFlight.add(taskId);
  void api.freeReviewExpiredScreenshots(taskId)
    .then((snapshot) => record(taskId, snapshot))
    .catch(() => undefined)
    .finally(() => {
      inFlight.delete(taskId);
      if (stale.delete(taskId)) load(taskId);
    });
}

/** 同源证据图取不到了：这个任务的清单可能已经过时，重取一次。不是证据地址的什么都不做。 */
export function refreshExpiredEvidence(url: string | null | undefined): void {
  const identity = identityOf(url);
  if (identity) load(identity.taskId, true);
}

/** 有渲染点引用着这个任务：开始盯它（定时 + 服务端事件），挂载这一下本身也重取一次。 */
function retain(taskId: string): () => void {
  refs.set(taskId, (refs.get(taskId) ?? 0) + 1);
  load(taskId);
  if (!timer) timer = setInterval(() => { for (const id of refs.keys()) load(id); }, EXPIRED_EVIDENCE_REVALIDATE_MS);
  unsubscribeEvents ??= subscribeEvents((event) => {
    if ((event.type === "task.review" || event.type === "task.status") && refs.has(event.taskId)) load(event.taskId, true);
  });
  return () => {
    const left = (refs.get(taskId) ?? 1) - 1;
    if (left > 0) {
      refs.set(taskId, left);
      return;
    }
    refs.delete(taskId);
    if (refs.size) return;
    if (timer) clearInterval(timer);
    timer = null;
    unsubscribeEvents?.();
    unsubscribeEvents = null;
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isExpiredEvidence(url: string | null | undefined): boolean {
  const identity = identityOf(url);
  return !!identity && !!byTask.get(identity.taskId)?.keys.has(identity.key);
}

/** 渲染点用：这个地址指的那张截图是不是过了保留期。引用期间这一层负责让答案跟着服务端走。 */
export function useExpiredEvidence(url: string | null | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  const taskId = identityOf(url)?.taskId ?? null;
  useEffect(() => (taskId ? retain(taskId) : undefined), [taskId]);
  return isExpiredEvidence(url);
}
