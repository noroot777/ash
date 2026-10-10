import { useMemo } from "react";
import { Pulse } from "@phosphor-icons/react";
import type { InspectorDescriptor } from "../inspector/index.ts";
import { useTaskMonitors } from "./useTaskMonitors.ts";

/**
 * 「哨兵」那一格的活信号：标题上的数量和图标按「此刻真有几个在盯着」给。
 *
 * 开合不在这儿管——这一格跟信息、文件那几格一样**默认开着**（`TASK_INSPECTORS` /
 * `TEAM_INSPECTORS` 里写死）。它不只是 agent 行为的回看面板：手动起一个哨兵只有这一个
 * 入口，藏起来就得先知道它在「+」菜单里才找得到。
 */
export function withMonitorTab<Context>(
  descriptors: readonly InspectorDescriptor<Context>[],
  counts: { live: number },
): readonly InspectorDescriptor<Context>[] {
  return descriptors.map((descriptor) => {
    if (descriptor.id !== "monitors") return descriptor;
    return {
      ...descriptor,
      // 数字按**在盯着**算：那是此刻真有几个进程在后台烧回合，归零就不显示。
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
  const inspectors = useMemo(() => withMonitorTab(descriptors, { live }), [descriptors, live]);
  return { inspectors, monitors };
}
