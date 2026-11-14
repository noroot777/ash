import { useEffect, useSyncExternalStore } from "react";
import type { Task } from "@ash/shared";
import { api } from "../lib/api.ts";
import { CATCH_UP_DEADLINE_MS } from "../lib/catchUp.ts";

/**
 * 「这个任务刚被我改过」的那条边界。验收台上的动作（换合入目标、更新基线、释放目录、提交待提交的
 * 合并、验收、打回……）一成功，页面手上那份任务和由它推出来的走向、diff、确认步骤就都不再是当前事实
 * —— 不能指望之后哪一次读取或事件碰巧把它们追平。
 *
 * 所以每个动作成功后一律走 `refreshTaskFacts`：先把这个任务的事实版本往前推一格（走向与 diff 按这个
 * 版本重读，useVersionedRead），再重读任务本身交给宿主。重读没落地之前（pending）主按钮转圈；读失败
 * （error）主按钮锁着、前提列里那一行说清楚并给重试 —— 确认层里的目标是从任务推出来的，任务没追平
 * 就不许确认。
 *
 * **放开它的只有动作成功之后才发出的那一次读取**（第 4 轮审查）：宿主从别处收到的任务快照比动作前新，
 * 不等于它覆盖了这次写入 —— 早于这次写入的中间版本照样比动作前新，拿它放行，确认层就会写着旧目标。
 * 写入回执里没有能比的版本，所以宿主手上的任务一变新，这里做的是**立刻重发一次读取**（接替还在途的
 * 那一发），由那一次的结果放行；它自己不算数。
 *
 * 这份等待必须有出路（第 3 轮审查）：传输层没有期限，一发挂住的读取会让主按钮永远转圈，而这份状态
 * 放在模块里、退出再进来照样挂着。所以每一发有期限（CATCH_UP_DEADLINE_MS），到点掐断、转成读失败，
 * 那一行给重试；被接替的那一发，它的调用方拿到的是接替者的结局。
 */
type Apply = (task: Task) => void;
type Facts = { version: number; attempt: number; state: "idle" | "pending" | "error"; error: string | null; before: string | null; apply: Apply | null };
const IDLE: Facts = { version: 0, attempt: 0, state: "idle", error: null, before: null, apply: null };
const DEADLINE_MESSAGE = "读取超时";
const facts = new Map<string, Facts>();
const inflight = new Map<string, { attempt: number; controller: AbortController; result: Promise<string | null> }>();
let attempts = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** 动作成功之后调：推版本、重读任务。返回 null = 追平了；否则是读失败的原因（不是动作失败）。 */
export function refreshTaskFacts(task: Pick<Task, "id" | "updatedAt">, apply: Apply): Promise<string | null> {
  return reread(task.id, (facts.get(task.id) ?? IDLE).version + 1, task.updatedAt ?? null, apply);
}

/** 发一次读取并接替还在途的那一发。`before` = 发出这一次时宿主手上那份任务的 updatedAt。 */
function reread(taskId: string, version: number, before: string | null, apply: Apply): Promise<string | null> {
  const attempt = ++attempts;
  facts.set(taskId, { version, attempt, state: "pending", error: null, before, apply });
  emit();
  inflight.get(taskId)?.controller.abort();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, CATCH_UP_DEADLINE_MS);
  const settle = (error: string | null) => {
    const current = facts.get(taskId);
    if (current?.attempt !== attempt) return;
    facts.set(taskId, { ...current, state: error ? "error" : "idle", error });
    emit();
  };
  const result = (async (): Promise<string | null> => {
    try {
      const next = await api.task(taskId, controller.signal);
      if (controller.signal.aborted) throw new Error(DEADLINE_MESSAGE);
      apply(next);
      settle(null);
      return null;
    } catch (reason) {
      const newer = inflight.get(taskId);
      // 被更晚的一次读取接替：结局以那一次为准。
      if (!timedOut && newer && newer.attempt !== attempt) return newer.result;
      const message = timedOut ? DEADLINE_MESSAGE : reason instanceof Error ? reason.message : String(reason);
      settle(message);
      return message;
    } finally {
      clearTimeout(timer);
      if (inflight.get(taskId)?.attempt === attempt) inflight.delete(taskId);
    }
  })();
  inflight.set(taskId, { attempt, controller, result });
  return result;
}

const newer = (value: string | null, than: string | null) =>
  !!value && (!than || Date.parse(value) > Date.parse(than));

/**
 * 这个任务此刻的事实版本与追平状态。`updatedAt` 是宿主手上那份任务的：还没追平时它变新了，就立刻
 * 重发一次读取（见文件头），等待与失败都只由那一次读取的结果结算。只认「更新」不认「不同」，几处宿主
 * 手上的快照新旧不一也不会来回互相接替。
 */
export function useTaskFacts(taskId: string, updatedAt: string | null | undefined) {
  const current = useSyncExternalStore(subscribe, () => facts.get(taskId) ?? IDLE);
  const host = updatedAt ?? null;
  useEffect(() => {
    if (current.state === "idle" || !current.apply || !newer(host, current.before)) return;
    void reread(taskId, current.version, host, current.apply);
  }, [taskId, host, current]);
  return { version: current.version, pending: current.state === "pending", error: current.state === "error" ? current.error : null };
}
