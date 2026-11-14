import { useSyncExternalStore } from "react";
import type { Task } from "@ash/shared";
import { api } from "../lib/api.ts";

/**
 * 「这个任务刚被我改过」的那条边界。验收台上的动作（换合入目标、更新基线、释放目录、提交待提交的
 * 合并、验收、打回……）一成功，页面手上那份任务和由它推出来的走向、diff、确认步骤就都不再是当前事实
 * —— 不能指望之后哪一次读取或事件碰巧把它们追平。
 *
 * 所以每个动作成功后一律走 `refreshTaskFacts`：先把这个任务的事实版本往前推一格（走向与 diff 按这个
 * 版本重读，useVersionedRead），再重读任务本身交给宿主。重读没落地之前（pending）主按钮转圈；读失败
 * （error）主按钮锁着、前提列里那一行说清楚并给重试 —— 确认层里的目标是从任务推出来的，任务没追平
 * 就不许确认。之后宿主若从别处拿到了更新过的任务（updatedAt 变了），这份失败自然作废。
 */
type Facts = { version: number; state: "idle" | "pending" | "error"; error: string | null; before: string | null };
const IDLE: Facts = { version: 0, state: "idle", error: null, before: null };
const facts = new Map<string, Facts>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** 动作成功之后调：推版本、重读任务。返回 null = 追平了；否则是读失败的原因（不是动作失败）。 */
export async function refreshTaskFacts(task: Pick<Task, "id" | "updatedAt">, apply: (task: Task) => void): Promise<string | null> {
  const version = (facts.get(task.id) ?? IDLE).version + 1;
  facts.set(task.id, { version, state: "pending", error: null, before: task.updatedAt ?? null });
  emit();
  const settle = (error: string | null) => {
    const current = facts.get(task.id);
    if (current?.version !== version) return;
    facts.set(task.id, { ...current, state: error ? "error" : "idle", error });
    emit();
  };
  try {
    apply(await api.task(task.id));
    settle(null);
    return null;
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    settle(message);
    return message;
  }
}

/**
 * 这个任务此刻的事实版本与追平状态。`updatedAt` 是宿主手上那份任务的：读失败之后宿主若已经拿到了
 * 更新过的任务，那份失败就不再成立。
 */
export function useTaskFacts(taskId: string, updatedAt: string | null | undefined) {
  const current = useSyncExternalStore(subscribe, () => facts.get(taskId) ?? IDLE);
  const outdated = current.state === "error" && (updatedAt ?? null) !== current.before;
  return { version: current.version, pending: current.state === "pending", error: outdated ? null : current.error };
}
