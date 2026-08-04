// 挑一条起手式。三处用它：全局默认、项目默认、新建任务。
//
// 三级作用域是「往下落一级」而不是「谁覆盖谁」，所以空值那一项的文案必须说清楚
// **落到哪儿去**（项目层落到全局、全局层落到出厂推荐），不能都写成一句「默认」。
import { useEffect, useState } from "react";
import type { WorkflowItem } from "@harness/shared/workflow";
import { api } from "../lib/api.ts";
import { workflowSummary } from "./workflowModel.ts";

let cache: WorkflowItem[] | null = null;

export async function loadWorkflows(force = false): Promise<WorkflowItem[]> {
  if (!cache || force) cache = await api.workflows();
  return cache;
}

/** 起手式库本身改了之后（设置页里增删改），把缓存打掉。 */
export function forgetWorkflows(): void {
  cache = null;
}

export function useWorkflows(): WorkflowItem[] {
  const [items, setItems] = useState<WorkflowItem[]>(cache ?? []);
  useEffect(() => {
    let alive = true;
    void loadWorkflows().then((list) => { if (alive) setItems(list); }).catch(() => {});
    return () => { alive = false; };
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
