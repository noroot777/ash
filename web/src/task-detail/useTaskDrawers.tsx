// 普通任务详情页左边那几屉：子智能体执行详情、读全文（审查报告、辩论记录）、派出的任务。
//
// 三屉在同一个位置（盖住中间那一栏，右侧 Inspector 仍然看得见、点得着），**同一时刻只有一屉**：
// 谁推出来，谁先把另外两屉收起。接线集中在这里而不是散在 TaskDetail 里，一是守 700 行，二是
// 这条互斥能被回归测试按原样挂起来测（scripts/fixtures/task-drawers.tsx），不用在夹具里抄一份。
import type { ReactNode } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { useLeftDrawerHost } from "../components/LeftDrawer.tsx";
import type { useConversation } from "../lib/useConversation.ts";
import { useDispatched } from "./dispatched/useDispatched.tsx";
import { useTaskInspectorStack } from "./useTaskInspectorStack.ts";

export function useTaskDrawers({ task, allTasks, conversation, onOpenTask, renderTask }: {
  task: Task;
  allTasks: TaskListItem[];
  conversation: ReturnType<typeof useConversation>;
  onOpenTask: (taskId: string) => void;
  /** 派出的任务那一屉里画什么（TaskDetail 自己，抽屉模式）。由宿主给，免得这里反过来引它。 */
  renderTask: (task: Task) => ReactNode;
}) {
  const leftDrawer = useLeftDrawerHost({ resetKey: task.id, onOpen: () => { stack.subagents.closeAgent(); dispatched.close(); } });
  // Inspector 栈（哪几格存在、默认开哪几格）整块在 useTaskInspectorStack.ts。
  const stack = useTaskInspectorStack(task, allTasks, conversation, () => { leftDrawer.close(); dispatched.close(); });
  const dispatched = useDispatched({
    taskId: task.id, allTasks, onOpen: () => { stack.subagents.closeAgent(); leftDrawer.close(); }, onGo: onOpenTask, render: renderTask,
  });
  // 中间那一栏换内容时（审查、文件、diff、预览），左边开着的那一屉跟着收起来 —— 它盖在主区上面，
  // 不收的话用户点了别的只会看到原来那份详情。
  const closeDrawers = () => { stack.subagents.closeAgent(); leftDrawer.close(); dispatched.close(); };
  const drawers = <>{stack.subagents.drawer}{leftDrawer.drawer}{dispatched.drawer}</>;
  return { ...stack, leftDrawer, dispatched, closeDrawers, drawers };
}
