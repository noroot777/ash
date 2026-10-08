// 新建面板「创建并排队」的目标选择与落库:状态、候选、分组联动、入队动作。
// 从 TaskComposerPanel 抽出来(单文件 700 行上限),面板只拿 slot 摆进启动设置浮层。
import { useState } from "react";
import type { Group, Task, TaskListItem } from "@ash/shared";
import { Dropdown } from "../components/Dropdown.tsx";
import { placeTaskAfter, queueAfterOptions } from "../lib/queueAfter.ts";

export function useQueueAfter({ tasks, groups, projectId, notify, onFollowGroup }: {
  tasks: TaskListItem[];
  groups: Group[];
  projectId: string;
  notify: (message: string) => void;
  /** 选中目标后把新任务的分组跟过去(后端要求同队同组)。 */
  onFollowGroup: (groupId: string) => void;
}) {
  const [afterTaskId, setAfterTaskId] = useState<string | null>(null);
  const afterTarget = afterTaskId ? tasks.find((item) => item.id === afterTaskId) ?? null : null;

  const pick = (value: string) => {
    setAfterTaskId(value || null);
    const target = tasks.find((item) => item.id === value);
    if (target) onFollowGroup(target.groupId ?? "");
  };

  /** 手动改分组后调用:与目标不一致就清掉目标(跨组不能同队),返回是否清了。
   * silent 给「新建分组」这类自己要发合并提示的调用方,免得连发两条 toast。 */
  const onGroupChanged = (groupId: string, opts?: { silent?: boolean }): boolean => {
    if (!afterTarget) return false;
    if ((afterTarget.groupId ?? "") === groupId) return false;
    setAfterTaskId(null);
    if (!opts?.silent) notify("改了分组，已清除排队目标（跨组不能同队）");
    return true;
  };

  /** 把刚创建的任务排到所选目标之后。创建成功后排队失败不回滚任务:两段结果分开说。
   * 入队后的权威快照直接来自插入/建队响应(服务端已 bump updatedAt):没有「成功后
   * 再 GET、GET 失败回退创建前快照把已确认入队显示成独立任务」的窗口(第 4 轮审查)。
   * members 是这次变更波及的全体成员(含前驱,它的位次/updatedAt 也变了),调用方
   * 应整批交给 onTasksSynced 走统一合并;覆盖与否由 createdTaskMerge 按 updatedAt
   * 裁决,响应在途期间的更晚变更不会被盖。 */
  const enqueue = async (task: Task): Promise<{ task: Task; members: Task[]; message: string }> => {
    const target = afterTarget;
    setAfterTaskId(null);
    try {
      if (!target) throw new Error("目标任务不存在，可能刚被删除");
      const placed = await placeTaskAfter(task.id, target);
      return {
        task: placed.task ?? task,
        members: placed.tasks,
        message: `已排在「${target.title || "未命名任务"}」之后，轮到它时自动开始`,
      };
    } catch (error) {
      return { task, members: [], message: `任务已创建，但排队失败：${error instanceof Error ? error.message : "未知错误"}` };
    }
  };

  const slot = (
    <div className="composer-field composer-queue-after">
      <span>接在谁后面</span>
      <Dropdown label="接在某任务之后" value={afterTaskId ?? ""} placeholder="选择一个任务…"
        filterPlaceholder="筛选任务…"
        options={queueAfterOptions({ tasks, groups, projectId })}
        onChange={pick} />
      <p className="studio-help">
        {afterTarget
          ? `将归入${afterTarget.groupId ? `分组「${groups.find((group) => group.id === afterTarget.groupId)?.name ?? "未知分组"}」` : "「无分组」"}，分组跟着它走。`
          : "同一队列必须同组；已结束且不在队列里的任务不可选。"}
      </p>
    </div>
  );

  return { afterTaskId, clear: () => setAfterTaskId(null), onGroupChanged, enqueue, slot };
}
