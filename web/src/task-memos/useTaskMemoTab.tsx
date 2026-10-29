// 「备忘」那一格在图标条上的装饰：有几条、有没有。
//
// **故意不走「用过才浮现」**（子智能体/哨兵那套 `surfaceTabWhenUsed`）：那两格各自还有别的
// 入口能让人知道它存在（会话里的子智能体行、agent 自己挂的哨兵），而备忘**手写一条的入口
// 只在这一格里**——没写过就不给这一格，等于这条路只能从会话选文进去，第一条永远写不出来。
// 所以这里只改标题和图标颜色，开合仍由 TASK_INSPECTORS 的 `defaultOpen` 说了算。
//
// 数据来自共享的那份缓存（taskMemoStore.ts），所以这一发读取跟面板里那一份是同一个请求：
// 详情页挂着它 → 图标条当场知道有没有；用户点开面板时数据已经在手里，不再闪一下空态。
import { useMemo } from "react";
import { NotePencil } from "@phosphor-icons/react";
import { INSPECTOR_USED_ICON_CLASS, type InspectorDescriptor } from "../inspector/index.ts";
import { useTaskMemos } from "./taskMemoStore.ts";

export function useTaskMemoTab<Context>(
  descriptors: readonly InspectorDescriptor<Context>[],
  taskId: string,
): readonly InspectorDescriptor<Context>[] {
  const { memos } = useTaskMemos(taskId);
  const count = memos.length;
  return useMemo(() => descriptors.map((descriptor) => (descriptor.id === "memos"
    ? {
      ...descriptor,
      title: count > 0 ? `${descriptor.title}（${count}）` : descriptor.title,
      icon: count > 0
        ? <NotePencil size={14} weight="fill" className={`task-memo-rail-icon--has ${INSPECTOR_USED_ICON_CLASS}`} />
        : descriptor.icon,
    }
    : descriptor)), [count, descriptors]);
}
