// 「信息」格里的队列：排着队时一行「第 n / m 位」加「查看队列」、一行「下一个」；还能入队时
// 一行「排在某任务之后…」；已经结束、进不了队列的任务，这一行不出。
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Group, Task, TaskListItem } from "@ash/shared";
import { Dropdown } from "../../components/Dropdown.tsx";
import { InspRow } from "../../inspector/parts.tsx";
import { InspMainButton } from "../../inspector/InspHead.tsx";
import { api } from "../../lib/api.ts";
import { canJoinQueue, placeTaskAfter, queueAfterOptions } from "../../lib/queueAfter.ts";
import { blocker, refreshTaskActions, shown, useTaskActions } from "../../lib/useTaskActions.ts";
import { QueueDrawer } from "../QueueDrawer.tsx";

export function InfoQueue({
  task,
  groups,
  allTasks,
  onQueueChanged,
  onTasksSynced,
  notify,
}: {
  task: Task;
  groups: Group[];
  allTasks: TaskListItem[];
  onQueueChanged: (updatedTask?: Task) => void;
  onTasksSynced: (tasks: Task[]) => void;
  notify: (message: string) => void;
}) {
  const [queueItems, setQueueItems] = useState<{ taskId: string; title: string }[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [requeueing, setRequeueing] = useState(false);
  const queuePosition = queueItems.findIndex((item) => item.taskId === task.id);
  const nextQueueItem = queuePosition >= 0 ? queueItems[queuePosition + 1] : undefined;

  // 队列成员或顺序变了也要重读:只依赖自己的 queueId/位置的话,中间插人时自己的
  // 位置纹丝不动,「第 n / m 位」「下一个」会停在旧值(第 1 轮审查复现)。列表经
  // SSE 实时更新,从它派生一个成员签名当依赖。
  const queueSignature = task.queueId == null ? "" : allTasks
    .filter((item) => item.queueId === task.queueId)
    .map((item) => `${item.id}:${item.queuePosition}`)
    .join(",");

  useEffect(() => {
    let alive = true;
    if (!task.queueId) setQueueItems([]);
    else api.queue(task.queueId).then((queue) => { if (alive) setQueueItems(queue.items); }).catch(() => undefined);
    return () => { alive = false; };
  }, [task.id, task.queueId, task.queuePosition, queueSignature, queueOpen]);

  // 出不出、点不点得了照服务端的判据（lib/useTaskActions.ts），跟任务头更多菜单里那一项同一份。
  const requeueVerdict = useTaskActions(task.id)?.requeue;
  const requeueBlocked = blocker(requeueVerdict);

  const requeue = async () => {
    if (!task.queueId) return;
    setRequeueing(true);
    try {
      const response = await api.requeueTask(task.id);
      onQueueChanged(response.task);
      void api.queue(task.queueId).then((queue) => setQueueItems(queue.items)).catch(() => undefined);
      notify(response.movedToEnd ? "已重新排队并移到队尾" : "已重新排队");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      void refreshTaskActions(task.id);
    } finally {
      setRequeueing(false);
    }
  };

  // 「排在某任务之后」:目标在队列就紧随其后插入,不在就建一条 [目标, 本任务]。
  // 响应里的成员快照(含前驱和本任务)**只走 onTasksSynced 一条按版本合并的路**;
  // 不再对本任务另调 onQueueChanged(placed.task)——那条带参分支最终是无条件覆盖,
  // 迟到的旧入队响应会反转 SSE 已送达的移出(第 6 轮审查双页面真实复现)。也不再
  // 「成功后 GET」:那条路没有错误处理,断流+GET 失败时入队成功却显示成独立任务
  // (第 5 轮审查);只有响应没带快照(老服务端)才退回无参 onQueueChanged 兜底刷新。
  const joinQueueAfter = async (targetId: string) => {
    const target = allTasks.find((item) => item.id === targetId);
    if (!target) return;
    try {
      const placed = await placeTaskAfter(task.id, target);
      // 运行中的任务入队不打断当前回合,提示也不能说「轮到它时自动开始」——它已经在跑,
      // 照抄待办文案会被读成「刚才那下把任务停了」。
      const live = task.status === "running" || task.status === "queued";
      notify(`已排在「${target.title || "未命名任务"}」之后${live ? "；当前运行不受影响" : "，轮到它时自动开始"}`);
      if (placed.tasks.length) onTasksSynced(placed.tasks);
      else onQueueChanged();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (task.queueId) {
    return (
      <>
        <InspRow label="队列">
          <span className="insp-num">第 {queuePosition >= 0 ? queuePosition + 1 : (task.queuePosition ?? 0) + 1} / {queueItems.length || "?"} 位</span>
          <button type="button" className="insp-val is-end" aria-haspopup="dialog" onClick={() => setQueueOpen(true)}>
            查看队列 · {queueItems.length || "…"} 个任务
          </button>
        </InspRow>
        <InspRow label="下一个"><span className="insp-cut">{nextQueueItem?.title ?? "队尾"}</span></InspRow>
        {shown(requeueVerdict) && (
          <InspRow label="">
            <InspMainButton size="sm" action={{ label: requeueing ? "处理中…" : "重新排队", disabled: requeueing, blocked: requeueBlocked, onClick: () => void requeue() }} />
          </InspRow>
        )}
        {/* 抽屉是盖住整页的一层，挂到 body 上：这里是一组 dt/dd 中间，不该夹一块别的东西。 */}
        {queueOpen && createPortal(
          <QueueDrawer
            queueId={task.queueId}
            currentTaskId={task.id}
            allTasks={allTasks}
            onClose={() => setQueueOpen(false)}
            onChanged={() => { onQueueChanged(); void api.queue(task.queueId!).then((queue) => setQueueItems(queue.items)); }}
          />,
          document.body,
        )}
      </>
    );
  }
  if (!canJoinQueue(task)) return null;
  return (
    <InspRow label="队列">
      <Dropdown
        className="insp-dropdown task-inspector-queue-after"
        label="排在某任务之后"
        value=""
        placeholder="排在某任务之后…"
        filterPlaceholder="筛选任务…"
        options={queueAfterOptions({
          tasks: allTasks,
          groups,
          projectId: task.projectId,
          excludeId: task.id,
          subjectGroupId: task.groupId ?? null,
          subjectRunning: task.status === "running",
        })}
        onChange={(targetId) => void joinQueueAfter(targetId)}
      />
    </InspRow>
  );
}
