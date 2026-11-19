// 普通任务详情页的 Inspector 栈：**哪几格存在**（三层 hook 依次往描述符表上贴东西）
// 和**默认开哪几格**（tabPolicy）。单独一个文件是为了守住 700 行，顺带把这条叠法
// 集中到一处 —— 顺序错了症状很隐晦（下一层拿到的是上一层没加工过的表）。
import { createElement, useMemo, useRef } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { useSubagents } from "./useSubagents.tsx";
import { useMonitorInspector } from "../monitors/useMonitorInspector.tsx";
import { endedMonitorIds } from "../monitors/monitorTray.ts";
import { useTaskMemoTab } from "../task-memos/useTaskMemoTab.tsx";
import { useFreeWorkflowState } from "../free-workflow/useFreeWorkflowState.ts";
import { TASK_INSPECTORS } from "./taskInspectors.tsx";
import type { useConversation } from "../lib/useConversation.ts";
import { latestRunFacts } from "./info/infoRunFacts.ts";
import { surfaceTabWhenUsed } from "../inspector/index.ts";
import { dispatchFacts } from "../lib/dispatchTree.ts";
import { useDispatchFolds } from "./dispatched/dispatchFolds.ts";
import { startDispatchArrivals, observeDispatchArrivals, type DispatchArrivals } from "./dispatched/dispatchArrivals.ts";
import { CountedIcon } from "./dispatched/CountedIcon.tsx";
import { useTaskRuntime } from "../task-runtime/useTaskRuntime.ts";

// 这几档 stage 下默认落在「审议」那一格：到了这一步，用户要看的就是审查那摊事。
const REVIEW_FOCUS_STAGES = new Set(["verifying", "verified", "verify_failed", "awaiting_acceptance"]);

export function useTaskInspectorStack(
  task: Task,
  allTasks: TaskListItem[],
  conversation: ReturnType<typeof useConversation>,
  /** 推出子智能体抽屉之前收起读全文那一屉（同一个位置，互斥）。 */
  onOpenSubagent?: () => void,
  tasksReady = true,
) {
  // 子智能体：列表在 Inspector 里，执行详情从左侧抽屉推出来（与团队模式点执行者同一套外壳）。
  const subagents = useSubagents(TASK_INSPECTORS, {
    taskId: task.id,
    items: conversation.items,
    status: task.status,
    loading: conversation.refreshing,
    error: conversation.error ?? conversation.traceError,
    onRetry: conversation.refetch,
  }, { onOpen: onOpenSubagent });
  // 哨兵那一格：数据在这一层拉（看的是别的面板时也要知道有几个在盯着，图标条上那点活信号靠它）。
  const monitorTab = useMonitorInspector(subagents.inspectors, task.id);
  // 备忘那一格只改标题/图标（有几条），开合仍按 TASK_INSPECTORS 的 defaultOpen —— 理由
  // 见 task-memos/useTaskMemoTab.tsx：手写第一条的入口只在那一格里。
  const memoTab = useTaskMemoTab(monitorTab.inspectors, task.id);
  // 子任务：名下有才冒到图标条上，图标带个数（数据就是任务列表，派出去一条当场就有）。数和它
  // 变不变色跟侧栏那一行行尾的数是同一份关系事实（dispatchFacts）：名下整棵有在等答复、失败的就变色。
  // 「有要你处理的」不从数里推：直接派出的那几条全归档了、再往下一层还在等，数是 0 照样得冒出来、
  // 照样变色（同侧栏 DispatchTreeRows 那一处）。
  const { dispatchedCount, dispatchedWarn, dispatchedShown } = useMemo(() => {
    const facts = dispatchFacts(allTasks);
    return { dispatchedCount: facts.count(task.id), dispatchedWarn: facts.needsYou(task.id), dispatchedShown: facts.hasBelow(task.id) };
  }, [allTasks, task]);
  const dispatchedFolds = useDispatchFolds(task.id);
  const arrivals = useRef<DispatchArrivals | null>(null);
  arrivals.current = arrivals.current?.taskId === task.id
    ? observeDispatchArrivals(arrivals.current, allTasks)
    : startDispatchArrivals(task.id, allTasks, Date.now());
  const arrivalRevision = arrivals.current.revision;
  const dispatchedTab = useMemo(() => surfaceTabWhenUsed(memoTab, "dispatched", dispatchedShown, (descriptor) => ({
    icon: dispatchedShown
      ? createElement(CountedIcon, { icon: descriptor.icon, count: dispatchedCount, warn: dispatchedWarn })
      : descriptor.icon,
  })), [dispatchedCount, dispatchedShown, dispatchedWarn, memoTab]);
  // 审查链状态在这一层订阅：竖轨上「审议」那一格的主色点要它（审查在跑），任务页别处
  // （验收后快照入口、「继续本轮审查」的可用性）也用同一份，一个任务只挂一条 2.5s 轮询。
  const free = useFreeWorkflowState(task.id, task.workflowMode === "free");
  const reviewing = task.workflowMode === "free"
    ? (free.state?.reviews ?? []).some((run) => run.status === "reviewing")
    : task.stage === "verifying";
  // 服务、浏览器：托管过服务（浏览器还多一种：服务起来了、能去看）才上条；在跑的点主色，停了的灰点。
  const runtime = useTaskRuntime(task.id);
  const { service, browser } = runtime.state;
  const serviceDot = service ? service.running ? "run" as const : "has" as const : null;
  const browserDot = browser ? browser.status === "ready" ? "run" as const : "has" as const : null;
  const serviceUsed = !!service;
  const browserUsed = !!browser || runtime.serviceReady;
  const inspectors = useMemo(() => {
    const runtimeTabs = surfaceTabWhenUsed(
      surfaceTabWhenUsed(dispatchedTab, "service", serviceUsed, () => ({ dot: serviceDot })),
      "browser", browserUsed, () => ({ dot: browserDot }),
    );
    return runtimeTabs.map((descriptor) => (descriptor.id === "review"
      ? { ...descriptor, dot: reviewing ? "run" as const : null }
      : descriptor));
  }, [dispatchedTab, reviewing, serviceUsed, browserUsed, serviceDot, browserDot]);

  // 回复框上方那块里还在盯的哨兵（MonitorTrayRow）：两种来源都列、ash 的排前面。ash 那几个才会把任务
  // 叫醒 —— claude 内置 Monitor 的只读投影就算还显示 running 也唤不醒任何人（它的通知只注回那条已经
  // 结束的会话）。但内置那几个也不能当不存在：agent 明明在对话里说了「已挂监听」，那一行要替它说清
  // 那句话到底成不成立。
  const liveMonitors = useMemo(() => {
    const running = monitorTab.monitors.monitors.filter((m) => m.status === "running");
    return [...running.filter((m) => m.kind === "ash"), ...running.filter((m) => m.kind !== "ash")];
  }, [monitorTab.monitors.monitors]);
  const ended = useMemo(() => endedMonitorIds(monitorTab.monitors.monitors, monitorTab.monitors.listed),
    [monitorTab.monitors.listed, monitorTab.monitors.monitors]);

  const reviewFocused = REVIEW_FOCUS_STAGES.has(task.stage ?? "")
    || allTasks.some((candidate) => candidate.reviewOf === task.id);
  const inspectorPolicy = useMemo(() => ({
    stateKey: `single:all-tabs-v9:${task.status}:${reviewFocused ? "review" : "info"}`,
    requiredTabId: "info",
    // 停在这几格上时**不要**被自动切走。判据是「用户主动打开它在干活」：侧聊在跟人对话，
    // 备忘可能正编辑着一条几百字的。stateKey 含 status，任务一跑完就换挡，于是「写到一半
    // 任务结束了，右边自己跳回信息」—— 草稿本身已经挪进 taskMemoDrafts.ts 不会丢，但人
    // 被甩走一次仍然是错的（独立审查第 2 轮 F1）。
    preserveActiveTabIds: ["side-chat", "memos"],
    // 顺序由 TASK_INSPECTORS 定，这里只说「默认哪几格开着」。
    //
    // 新增一格只加进这张表是不够的：存量用户的 `openTabs` 躺在 localStorage 里，
    // `applyTabPolicy` 只在 `stateKey` 变过一次时才拿这张表去并集。所以**加面板要连
    // 带把 `all-tabs-vN` 往上跳一版**，否则老用户永远看不到它（生成物那一格就是这么
    // 差点漏掉的）。
    defaultOpenTabIds: ["info", "files", "artifacts", "scm", "memos", "side-chat", "workflow", "review", "preview"],
    defaultActiveTabId: reviewFocused ? "review" : "info",
    focusOnEntry: dispatchedShown ? "dispatched" : undefined,
    entryReady: tasksReady,
    focusRequest: { key: String(arrivalRevision), tabId: "dispatched" },
  }), [arrivalRevision, dispatchedShown, reviewFocused, task.status, tasksReady]);

  // 「信息」格里最近一轮的用量、上下文、压缩中：取自会话流里最新那条回复（直播值比会话行新）。
  const runFacts = useMemo(() => latestRunFacts(conversation.items), [conversation.items]);

  return { subagents, monitorTab, inspectors, inspectorPolicy, liveMonitors, endedMonitorIds: ended, free, runFacts, dispatchedFolds, runtime };
}
