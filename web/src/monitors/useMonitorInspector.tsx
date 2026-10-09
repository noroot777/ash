import { useMemo } from "react";
import { Pulse } from "@phosphor-icons/react";
import type { InspectorDescriptor } from "../inspector/index.ts";
import { useTaskMonitors, visibleMonitors } from "./useTaskMonitors.ts";

/**
 * 「哨兵」那一格的开合规则。
 *
 * 这一格**始终存在**（从「+」菜单里一直找得到，否则没起过哨兵的任务就再也没有手动起一个
 * 的入口），但只有真有哨兵时才算默认开——于是没用过这功能的人图标条上不会常年多一格，
 * 而第一个哨兵挂上去的那一刻它会自己冒出来（`InspectorHost` 认的就是「这一格刚变成默认开」）。
 */
export function withMonitorTab<Context>(
  descriptors: readonly InspectorDescriptor<Context>[],
  counts: { current: number; live: number },
): readonly InspectorDescriptor<Context>[] {
  return descriptors.map((descriptor) => {
    if (descriptor.id !== "monitors") return descriptor;
    return {
      ...descriptor,
      // 「默认开」按**当前**算（含刚结束的那几分钟）：一个哨兵刚跑完就把面板收走，
      // 恰恰是在用户最想看结果的那一刻把结果拿走了。
      defaultOpen: counts.current > 0,
      // 标题上的数字按**在盯着**算：那是此刻真有几个进程在后台烧回合，归零就不显示。
      title: counts.live > 0 ? `哨兵（${counts.live}）` : descriptor.title,
      icon: counts.live > 0
        ? <Pulse size={14} weight="fill" className="monitor-rail-icon--live" />
        : descriptor.icon,
    };
  });
}

export function useMonitorInspector<Context>(
  descriptors: readonly InspectorDescriptor<Context>[],
  taskId: string,
) {
  const monitors = useTaskMonitors(taskId);
  const live = monitors.monitors.filter((monitor) => monitor.status === "running").length;
  const current = visibleMonitors(monitors.monitors).length;
  const inspectors = useMemo(
    () => withMonitorTab(descriptors, { current, live }),
    [current, descriptors, live],
  );
  return { inspectors, monitors };
}
