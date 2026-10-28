// 普通任务详情页的 Inspector 栈：**哪几格存在**（三层 hook 依次往描述符表上贴东西）
// 和**默认开哪几格**（tabPolicy）。单独一个文件是为了守住 700 行，顺带把这条叠法
// 集中到一处 —— 顺序错了症状很隐晦（下一层拿到的是上一层没加工过的表）。
import { useMemo } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { useSubagents } from "./useSubagents.tsx";
import { useMonitorInspector } from "../monitors/useMonitorInspector.tsx";
import { useTaskMemoTab } from "../task-memos/useTaskMemoTab.tsx";
import { TASK_INSPECTORS } from "./taskInspectors.tsx";
import type { useConversation } from "../lib/useConversation.ts";

// 这几档 stage 下默认落在「审查」那一格：到了这一步，用户要看的就是审查那摊事。
const REVIEW_FOCUS_STAGES = new Set(["verifying", "verified", "verify_failed", "awaiting_acceptance"]);

export function useTaskInspectorStack(
  task: Task,
  allTasks: TaskListItem[],
  conversation: ReturnType<typeof useConversation>,
) {
  // 子智能体：列表在 Inspector 里，执行详情从左侧抽屉推出来（与团队模式点执行者同一套外壳）。
  const subagents = useSubagents(TASK_INSPECTORS, {
    taskId: task.id,
    items: conversation.items,
    status: task.status,
    loading: conversation.refreshing,
    error: conversation.error ?? conversation.traceError,
    onRetry: conversation.refetch,
  });
  // 哨兵那一格：数据在这一层拉（看的是别的面板时也要知道有几个在盯着，图标条上那点活信号靠它）。
  const monitorTab = useMonitorInspector(subagents.inspectors, task.id);
  // 备忘那一格只改标题/图标（有几条），开合仍按 TASK_INSPECTORS 的 defaultOpen —— 理由
  // 见 task-memos/useTaskMemoTab.tsx：手写第一条的入口只在那一格里。
  const inspectors = useTaskMemoTab(monitorTab.inspectors, task.id);

  // 会话区那张卡把两种来源**分开**数（同 MonitorInspector 的分段）：ash 那几个才是「在等」
  // —— claude 内置 Monitor 的只读投影就算还显示 running 也唤不醒任何人（它的通知只注回那
  // 条已经结束的会话）。但内置那几个也不能当不存在：agent 明明在对话里说了「已挂监听」，
  // 卡片要替它说清那句话到底成不成立。
  const liveMonitors = useMemo(
    () => monitorTab.monitors.monitors.filter((m) => m.kind === "ash" && m.status === "running"),
    [monitorTab.monitors.monitors],
  );
  const liveBuiltinCount = useMemo(
    () => monitorTab.monitors.monitors.filter((m) => m.kind === "claude" && m.status === "running").length,
    [monitorTab.monitors.monitors],
  );

  const reviewFocused = REVIEW_FOCUS_STAGES.has(task.stage ?? "")
    || allTasks.some((candidate) => candidate.reviewOf === task.id);
  const inspectorPolicy = useMemo(() => ({
    stateKey: `single:all-tabs-v7:${task.status}:${reviewFocused ? "review" : "info"}`,
    requiredTabId: "info",
    // 停在这几格上时**不要**被自动切走。判据是「用户主动打开它在干活」：侧聊在跟人对话，
    // 备忘可能正编辑着一条几百字的。stateKey 含 status，任务一跑完就换挡，于是「写到一半
    // 任务结束了，右边自己跳回信息」—— 草稿本身已经挪进 taskMemoDrafts.ts 不会丢，但人
    // 被甩走一次仍然是错的（独立审查第 2 轮 F1）。
    preserveActiveTabIds: ["side-chat", "memos"],
    // 顺序由 TASK_INSPECTORS 定，这里只说「默认哪几格开着」。
    //
    // 子智能体和哨兵**故意不在这张表里**：那两格走「用过才浮现」（inspector/usedTabs.tsx），
    // 开合由各自的 hook 按本任务用没用过翻 `defaultOpen`，再由 InspectorHost 冒上来。写进
    // 这张表会让它们在每次语义换挡时被无条件并集回去，等于把那条规矩拆了。
    //
    // 新增一格只加进这张表是不够的：存量用户的 `openTabs` 躺在 localStorage 里，
    // `applyTabPolicy` 只在 `stateKey` 变过一次时才拿这张表去并集。所以**加面板要连
    // 带把 `all-tabs-vN` 往上跳一版**，否则老用户永远看不到它（生成物那一格就是这么
    // 差点漏掉的）。
    defaultOpenTabIds: ["info", "files", "artifacts", "scm", "memos", "side-chat", "workflow", "review", "preview"],
    defaultActiveTabId: reviewFocused ? "review" : "info",
  }), [reviewFocused, task.status]);

  return { subagents, monitorTab, inspectors, inspectorPolicy, liveMonitors, liveBuiltinCount };
}
