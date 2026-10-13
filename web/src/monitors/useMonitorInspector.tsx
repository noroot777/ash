import { useMemo } from "react";
import { Pulse } from "@phosphor-icons/react";
import {
  INSPECTOR_USED_ICON_CLASS,
  retireInspectorTab,
  surfaceTabWhenUsed,
  type InspectorDescriptor,
} from "../inspector/index.ts";
import { useTaskMonitors } from "./useTaskMonitors.ts";

// 哨兵从「常驻默认面板」改成「用过才浮现」（和子智能体同一条规矩）。只改 `defaultOpen`
// 治不了存量：旧默认早把它钉进了每个任务的 `openTabs`，而 `applyTabPolicy` 是并集语义，
// 钉进去的就再也摘不掉。按 migrationId 摘一次——真挂过哨兵的任务下次进去它会自己再冒
// 出来，之后用户手动开的也不会被下一次语义换挡又关掉。
retireInspectorTab("monitors-surface-on-use", /^(?:ash|harness-next):inspector:/, "monitors");

/**
 * 「哨兵」那一格的开合与活信号。
 *
 * 开合按**这个任务挂过哨兵没有**给（`surfaceTabWhenUsed`）：挂过才自己冒到图标条上并带底色，
 * 没挂过就留在「+」菜单和 `I M` 里等人去开——手动起哨兵仍然只有这一格里那个「+」，所以它
 * 可以不默认开着，但绝不能像上一版的子智能体那样整格不给。
 *
 * 标题和图标上的数字另算：那是**此刻真有几个在烧回合**，跟「挂过没有」不是一回事（结束的
 * 那几张是存档，还要看得见，但不该再冒充活信号）。
 */
export function withMonitorTab<Context>(
  descriptors: readonly InspectorDescriptor<Context>[],
  counts: { live: number; used: number },
): readonly InspectorDescriptor<Context>[] {
  return surfaceTabWhenUsed(descriptors, "monitors", counts.used > 0, (descriptor) => ({
    // 数字按**在盯着**算：那是此刻真有几个进程在后台烧回合，归零就不显示。
    title: counts.live > 0 ? `${descriptor.title}（${counts.live}）` : descriptor.title,
    icon: counts.live > 0
      ? <Pulse size={14} weight="fill" className={`monitor-rail-icon--live ${INSPECTOR_USED_ICON_CLASS}`} />
      : counts.used > 0
        ? <Pulse size={14} weight="bold" className={INSPECTOR_USED_ICON_CLASS} />
        : descriptor.icon,
  }));
}

export function useMonitorInspector<Context>(
  descriptors: readonly InspectorDescriptor<Context>[],
  taskId: string,
) {
  const monitors = useTaskMonitors(taskId);
  const live = monitors.monitors.filter((monitor) => monitor.status === "running").length;
  // 「用过」算的是全部记录而不是在跑的那几个：已经结束的哨兵是这个任务干过什么的凭证，
  // 跑完就把那一格收走等于把证据也收走了。
  const used = monitors.monitors.length;
  const inspectors = useMemo(() => withMonitorTab(descriptors, { live, used }), [descriptors, live, used]);
  return { inspectors, monitors };
}
