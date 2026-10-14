import type { ReactNode } from "react";
import type { InspectorDescriptor } from "./types.ts";

/**
 * 「用过才浮现」的那几格（子智能体、哨兵）共用的一条规矩。
 *
 * 面板**一直在**：「+」菜单里列着、`I` 加首字母也开得出来。变的只是 `defaultOpen`——
 * 这个任务真用过它，才由 InspectorHost 把它冒到图标条上（不抢当前焦点），并给图标打上
 * {@link INSPECTOR_USED_ICON_CLASS} 的底色。
 *
 * 两头都踩过坑：常驻图标条的那一格（哨兵以前那样），大多数任务点进去只有一句空话；
 * 没用过就整格不给（子智能体以前那样）又让人以为功能根本不存在——「+」菜单翻遍了也
 * 找不到，而哨兵那一格里的「+」还是手动起哨兵唯一的入口。留在菜单里、用过才上条，
 * 两件事就都占着了。
 */
export const INSPECTOR_USED_ICON_CLASS = "inspector-rail-icon--used";

/**
 * 把 `id` 那一格改成「用过才浮现」。`decorate` 只管标题和图标（数量、读取不全之类的
 * 装饰各家自己给），开合一律按 `used` 走，省得两处各写一遍又各漂一点。
 */
export function surfaceTabWhenUsed<Context>(
  descriptors: readonly InspectorDescriptor<Context>[],
  id: string,
  used: boolean,
  decorate?: (descriptor: InspectorDescriptor<Context>) => { title?: string; icon?: ReactNode },
): readonly InspectorDescriptor<Context>[] {
  return descriptors.map((descriptor) => (descriptor.id === id
    ? { ...descriptor, ...decorate?.(descriptor), defaultOpen: used }
    : descriptor));
}
