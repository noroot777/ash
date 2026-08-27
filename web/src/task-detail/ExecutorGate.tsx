// 「这一轮会换掉执行器」的确认闸(§八「不静默替换」)。
//
// 共享项目里 B 可以在 A 的任务上运行/重跑/回复/继续讨论,而任务身上钉着的执行器是 A 的
// 私有资源 —— B 解析不到它,那一轮会落到 B 自己的默认执行器上,烧的是 B 的 key。
// **换执行器可能换模型档位,产出会变**,所以不能静默替换:动手之前先问一句。
//
// 判据不在前端算:`GET /tasks/:id/executor-preflight` 用的是真正起跑时同一条
// `pickProfile` 判据。前端自己比对 executorId 在不在我的列表里,迟早会跟后端分叉。
//
// **为什么闸装在 App 层而不是每个页面各挂一个**:第 6 轮审查里 duet 详情页和命令面板
// 各自绕过了它 —— 一个「每处都要记得包一层」的约定,漏掉时没有任何提示,而漏掉的后果
// (静默换人烧自己的 key)从界面上完全看不出来。装成一个 Provider 之后,新表面只要
// `useExecutorGate()` 就自带这道闸;命令面板那种「点完立刻关掉自己」的入口也用得上 ——
// 对话框活在 App 上,不跟着调用方一起卸载。
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
// 运行时值只能走子路径(index.ts 只转发类型 —— 服务端直跑 .ts 源码)。
import type { ExecutorDowngradeItem } from "@ash/shared";
import { EXECUTOR_SLOT_LABELS } from "@ash/shared/multiuser";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** 包在任何「会起一轮」的动作外面。返回 false = 用户点了取消,调用方**什么都别做**。 */
export type ConfirmExecutorSwap = (taskId: string) => Promise<boolean>;

const ExecutorGateContext = createContext<ConfirmExecutorSwap | null>(null);

/** 没有 Provider 时一律放行:这道闸是提醒,不是权限(测试里单独渲染某个组件也不该炸)。 */
export const useExecutorGate = (): ConfirmExecutorSwap =>
  useContext(ExecutorGateContext) ?? (async () => true);

const lineOf = (item: ExecutorDowngradeItem): string => {
  const who = EXECUTOR_SLOT_LABELS[item.slot];
  const head = who ? `${who}:` : "";
  const from = `原执行器「${item.fromName}」(${item.fromType})`
    + (item.fromOwner ? `属于 ${item.fromOwner}` : "已经不在了")
    + "，你用不了它。";
  const to = item.toName
    ? `本轮将改用你的「${item.toName}」，烧的是你自己的 key。`
    : "而你还没有这个类型的默认执行器 —— 继续多半会直接失败，先去「设置 → 执行器」配一个。";
  return head + from + to;
};

export function ExecutorGateProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<ExecutorDowngradeItem[] | null>(null);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const confirmExecutorSwap = useCallback<ConfirmExecutorSwap>(async (taskId) => {
    let downgrades: ExecutorDowngradeItem[] = [];
    try {
      downgrades = (await api.executorPreflight(taskId)).downgrades;
    } catch {
      return true; // 探测失败(网络抖动、老服务端没这个端点)一律放行
    }
    if (!downgrades.length) return true;
    setPending(downgrades);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    setPending(null);
    resolveRef.current?.(ok);
    resolveRef.current = null;
  }, []);

  return (
    <ExecutorGateContext.Provider value={confirmExecutorSwap}>
      {children}
      {pending ? (
        <ConfirmDialog
          title={pending.length > 1 ? `这一轮会换掉 ${pending.length} 个执行器` : "这一轮会换一个执行器"}
          message={
            pending.map(lineOf).join("\n")
            + "\n\n换执行器可能连模型档位一起换，产出会跟原来不一样。"
          }
          confirmLabel="仍然继续"
          onClose={() => settle(false)}
          onConfirm={() => settle(true)}
        />
      ) : null}
    </ExecutorGateContext.Provider>
  );
}
