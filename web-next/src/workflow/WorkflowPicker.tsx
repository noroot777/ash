// 挑一条起手式。三处用它：全局默认、项目默认、新建任务。
//
// 三级作用域是「往下落一级」而不是「谁覆盖谁」，所以空值那一项的文案必须说清楚
// **落到哪儿去**（项目层落到全局、全局层落到出厂推荐），不能都写成一句「默认」。
//
// 库本身是全局的一份，所以缓存也是模块级的一份 + 一组订阅者：设置页里增删改、编排器里
// 「存成起手式」，改完都得让**已经挂着的**每个下拉都跟上。只把缓存置空是不够的——那只
// 对下一次挂载生效，当前这个下拉里照样没有刚存进去的那条（于是刚存完就选不中它）。
import { useEffect, useState } from "react";
import type { WorkflowItem } from "@harness/shared/workflow";
import { api } from "../lib/api.ts";
import { workflowSummary } from "./workflowModel.ts";

let cache: WorkflowItem[] | null = null;
const listeners = new Set<(items: WorkflowItem[]) => void>();

export async function loadWorkflows(force = false): Promise<WorkflowItem[]> {
  if (!cache || force) cache = await api.workflows();
  return cache;
}

/**
 * 起手式库本身改了之后（设置页里增删改、编排器里存成起手式）重新拉一遍，并通知所有
 * 挂着的下拉。**await 它再去选中新存的那条**，否则那一刻 items 里还没有它，选中值会被
 * 当成悬空 id 回落到默认那条 —— 用户刚编排好的线就这么没了。
 */
export async function forgetWorkflows(): Promise<WorkflowItem[]> {
  cache = null;
  try {
    const items = await loadWorkflows(true);
    for (const notify of listeners) notify(items);
    return items;
  } catch {
    return [];
  }
}

export function useWorkflows(): WorkflowItem[] {
  const [items, setItems] = useState<WorkflowItem[]>(cache ?? []);
  useEffect(() => {
    let alive = true;
    const notify = (list: WorkflowItem[]) => { if (alive) setItems(list); };
    listeners.add(notify);
    void loadWorkflows().then(notify).catch(() => {});
    return () => { alive = false; listeners.delete(notify); };
  }, []);
  return items;
}

export function WorkflowPicker({
  value, items, inheritLabel, disabled, id, onChange,
}: {
  /** 空串 = 没显式选，跟着上一级走 */
  value: string;
  items: WorkflowItem[];
  inheritLabel: string;
  disabled?: boolean;
  id?: string;
  onChange: (workflowId: string) => void;
}) {
  // 停用的不进候选，但**已经选中的那条即便停用了也得列出来**，否则下拉会显示成空、
  // 看着像「没设过」，用户一存就把原来的设置抹了。
  const options = items.filter((item) => !item.disabled || item.id === value);
  return (
    <select
      id={id}
      className="wf-picker"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{inheritLabel}</option>
      {options.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}{item.disabled ? "（已停用）" : ""} · {workflowSummary(item.def)}
        </option>
      ))}
    </select>
  );
}
