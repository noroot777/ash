// 「这张审查截图过了保留期、已经删掉了」——全站一份。
//
// 为什么是一份跨组件的登记而不是从调用点一层层传下去：引用这些截图的地方不止审查格里那份
// 报告，还有会话里「打开报告」弹出来的那一份、报告里链到的另一份 .md、对话正文里贴的证据
// 地址——而且可能是**别的任务**的证据。它们手上都只有一个地址，没有那一轮的状态。图片加载
// 失败（`onError`）又连状态码都拿不到，分不出「过期删了」和「临时取不到」——前者该说「已过
// 保留期」，后者才配「再试一次」。
//
// 所以按地址里的**任务编号**认：这个任务的过期清单有两个来源，都是服务端的事实——
//   · 自由工作流状态（useFreeWorkflowState 读到就登记，随状态版本一起更新）；
//   · 没人读过它的状态时，现取 `/free-workflow/expired-screenshots`。「本地没登记」只能说明
//     「还不知道」，不能当成「没过期」（审查第 1 轮 F2：从别的任务里点开旧报告，过期图一直
//     报「图取不到、再试一次」）。
// 已知的清单也可能过时（页面开着时清扫跑了）：同源证据图加载失败就重取一次这个任务的清单。
//
// 认地址按**规范化后的身份**（任务、审查、轮次按数、文件名按段用 `/` 拼），跟服务端证据接口
// 同一口径：同一张图可能是相对路径解出来的、绝对路径改写来的、或者用户复制证据地址贴回来的，
// 写法不一定一字不差（`round=01`、`shots\a.png`）。
import { useEffect, useSyncExternalStore } from "react";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";

const ENDPOINT = /\/tasks\/([^/]+)\/free-workflow\/review-file$/;

type Identity = { taskId: string; key: string };

const byTask = new Map<string, ReadonlySet<string>>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

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

function record(taskId: string, rounds: { runId: string; round: number; names: string[] }[]): void {
  const next = new Set<string>();
  for (const round of rounds) {
    for (const name of round.names) {
      const key = keyOf(round.runId, round.round, name);
      if (key) next.add(key);
    }
  }
  const current = byTask.get(taskId);
  if (current && current.size === next.size && [...next].every((key) => current.has(key))) return;
  byTask.set(taskId, next);
  version++;
  for (const listener of listeners) listener();
}

/** 读到一份自由工作流状态：换下这个任务的登记。内容没变就不惊动任何渲染点。 */
export function recordExpiredEvidence(taskId: string, state: Pick<FreeWorkflowApiState, "reviews">): void {
  record(taskId, state.reviews.flatMap((run) => run.rounds.map((round) => ({
    runId: run.id,
    round: round.round,
    names: round.expiredScreenshots ?? [],
  }))));
}

const stale = new Set<string>();

/**
 * 现取这个任务的过期清单（同一时刻只取一次）。取失败就仍是「不知道」，下次有人问再取。
 *
 * `fresh`：要的是「此刻之后」的清单。正在取的那一趟可能是在图片报错之前发出的，拿它的结果
 * 交差就会漏掉刚发生的清扫（首屏挂载时取一次、图片随即 410 的那一下），所以排一趟在它之后。
 */
function load(taskId: string, fresh = false): void {
  if (inFlight.has(taskId)) {
    if (fresh) stale.add(taskId);
    return;
  }
  const request = api.freeReviewExpiredScreenshots(taskId)
    .then((result) => record(taskId, result.rounds))
    .catch(() => undefined)
    .finally(() => {
      inFlight.delete(taskId);
      if (stale.delete(taskId)) load(taskId);
    });
  inFlight.set(taskId, request);
}

/** 同源证据图取不到了：这个任务的清单可能已经过时，重取一次。 */
export function refreshExpiredEvidence(url: string | null | undefined): void {
  const identity = identityOf(url);
  if (identity) load(identity.taskId, true);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isExpiredEvidence(url: string | null | undefined): boolean {
  const identity = identityOf(url);
  return !!identity && !!byTask.get(identity.taskId)?.has(identity.key);
}

/** 渲染点用：这个地址指的那张截图是不是过了保留期。还不知道那个任务的清单就去取，取到了跟着重画。 */
export function useExpiredEvidence(url: string | null | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  const taskId = identityOf(url)?.taskId ?? null;
  useEffect(() => {
    if (taskId && !byTask.has(taskId)) load(taskId);
  }, [taskId]);
  return isExpiredEvidence(url);
}
