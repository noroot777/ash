// 「这一轮会换掉执行器」的确认闸(§八)。
//
// 共享项目里 B 可以在 A 的任务上回复/重跑/派审,而任务身上钉着的执行器是 A 的私有
// 资源 —— B 解析不到它,那一轮会落到 B 自己的默认执行器上,烧的是 B 的 key。
// **换执行器可能换模型档位,产出会变**,所以不能静默替换:动手之前先问一句。
//
// 判据不在前端算:`GET /tasks/:id/executor-preflight` 用的是真正起跑时同一条
// `pickProfile` 判据。前端自己比对 executorId 在不在我的列表里,迟早会跟后端分叉。
import { useCallback, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

export type ExecutorDowngrade = {
  fromName: string;
  fromType: string;
  fromOwner: string | null;
  toName: string | null;
};

export function useExecutorDowngradeConfirm(taskId: string) {
  const [pending, setPending] = useState<ExecutorDowngrade | null>(null);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  /**
   * 包在任何「会起一轮」的动作外面。返回 false = 用户点了取消,调用方**什么都别做**。
   * 探测失败(网络抖动、老服务端没这个端点)一律放行:这道闸是提醒,不是权限。
   */
  const confirmRun = useCallback(async (): Promise<boolean> => {
    let downgrade: ExecutorDowngrade | null = null;
    try {
      downgrade = (await api.executorPreflight(taskId)).downgrade;
    } catch {
      return true;
    }
    if (!downgrade) return true;
    setPending(downgrade);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, [taskId]);

  const settle = useCallback((ok: boolean) => {
    setPending(null);
    resolveRef.current?.(ok);
    resolveRef.current = null;
  }, []);

  const dialog = pending ? (
    <ConfirmDialog
      title="这一轮会换一个执行器"
      message={
        `原执行器「${pending.fromName}」(${pending.fromType})` +
        (pending.fromOwner ? `属于 ${pending.fromOwner}` : "已经不在了") +
        "，你用不了它。" +
        (pending.toName
          ? `本轮将改用你的「${pending.toName}」，烧的是你自己的 key。`
          : "而你还没有这个类型的默认执行器 —— 继续多半会直接失败，先去「设置 → 执行器」配一个。") +
        "\n\n换执行器可能连模型档位一起换，产出会跟原来不一样。"
      }
      confirmLabel="仍然继续"
      onClose={() => settle(false)}
      onConfirm={() => settle(true)}
    />
  ) : null;

  return { confirmRun, dialog };
}
