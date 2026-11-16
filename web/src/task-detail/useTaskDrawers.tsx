import type { Task, TaskListItem } from "@ash/shared";
import { useLeftDrawerHost } from "../components/LeftDrawer.tsx";
import type { useConversation } from "../lib/useConversation.ts";
import { useTaskInspectorStack } from "./useTaskInspectorStack.ts";

export function useTaskDrawers({ task, allTasks, conversation }: {
  task: Task;
  allTasks: TaskListItem[];
  conversation: ReturnType<typeof useConversation>;
}) {
  const leftDrawer = useLeftDrawerHost({ resetKey: task.id, onOpen: () => stack.subagents.closeAgent() });
  const stack = useTaskInspectorStack(task, allTasks, conversation, leftDrawer.close);
  const closeDrawers = () => { stack.subagents.closeAgent(); leftDrawer.close(); };
  return { ...stack, leftDrawer, closeDrawers, drawers: <>{stack.subagents.drawer}{leftDrawer.drawer}</> };
}
