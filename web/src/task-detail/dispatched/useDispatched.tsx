import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { SideDrawer } from "../../components/SideDrawer.tsx";
import { InspectorOverlayProvider } from "../../inspector/index.ts";
import { useTaskBody } from "../../lib/useTaskBody.ts";
import { dispatchedOf } from "../../lib/dispatchTree.ts";

// 详情页上「派出的任务」那一摊：名下有谁（右侧那一格的数据）、点一行从左边推出来的那一屉。
//
// 那一屉跟子智能体、读全文（审查报告、辩论记录）在同一个位置，同一时刻左边只有一屉 ——
// 互斥由宿主（TaskDetail）经 `onOpen` 接上，这里只管自己这一屉。里面是完整的那条任务
// （会话 + 回复框，能直接对它说话），抽屉头上一颗「到这个任务里去」。侧栏里点它照旧是
// 直接进那条任务，不走这里。

export type DispatchedState = {
  tasks: TaskListItem[];
  openId: string | null;
  open: (taskId: string) => void;
};

function DispatchedDrawer({ task, onClose, onGo, render }: {
  task: TaskListItem;
  onClose: () => void;
  onGo: () => void;
  render: (task: Task) => ReactNode;
}) {
  // 抽屉里是完整的 TaskDetail，要正文；列表行不带正文，按需补（同团队执行者抽屉）。
  const full = useTaskBody(task);
  const title = task.title || "未命名任务";
  return (
    <SideDrawer
      variant="worker"
      contentKey={task.id}
      kind="派出的任务"
      title={title}
      ariaLabel={`派出的任务：${title}`}
      closeLabel="关上派出的任务"
      onClose={onClose}
      actions={<button type="button" onClick={onGo}><ArrowSquareOut size={13} aria-hidden="true" />到这个任务里去</button>}
    >
      {/* 这一屉摆不下内容加并排的一栏：里面那一页的 Inspector 一律盖在内容上（见 useTaskDrawers）。 */}
      {full && <InspectorOverlayProvider value>{render(full)}</InspectorOverlayProvider>}
    </SideDrawer>
  );
}

export function useDispatched({ taskId, allTasks, onOpen, onGo, render }: {
  taskId: string;
  allTasks: TaskListItem[];
  /** 推出这一屉之前收起左边别的那几屉。 */
  onOpen?: () => void;
  onGo: (taskId: string) => void;
  render: (task: Task) => ReactNode;
}) {
  const tasks = useMemo(() => dispatchedOf(allTasks, taskId), [allTasks, taskId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => setOpenId(null), [taskId]);
  const open = useCallback((id: string) => {
    onOpenRef.current?.();
    setOpenId(id);
  }, []);
  const close = useCallback(() => setOpenId(null), []);
  const row = openId ? allTasks.find((task) => task.id === openId) : undefined;
  // 开着的那条被删了：一屉空壳没有意义，收起来。
  useEffect(() => {
    if (openId && !row) setOpenId(null);
  }, [openId, row]);
  const drawer = row
    ? <DispatchedDrawer task={row} onClose={close} onGo={() => { close(); onGo(row.id); }} render={render} />
    : null;
  const state = useMemo<DispatchedState>(() => ({ tasks, openId, open }), [open, openId, tasks]);
  return { state, drawer, close };
}
