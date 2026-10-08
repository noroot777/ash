// 新建面板「创建并排队」的目标选择与落库:状态、候选、分组联动、入队动作。
// 从 TaskComposerPanel 抽出来(单文件 700 行上限),面板只拿 slot 摆进启动设置浮层。
import { useState } from "react";
import type { Group, Task, TaskListItem } from "@ash/shared";
import { Dropdown } from "../components/Dropdown.tsx";
import { api } from "../lib/api.ts";
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

  /** 手动改分组后调用:与目标不一致就清掉目标(跨组不能同队)。 */
  const onGroupChanged = (groupId: string) => {
    if (!afterTarget) return;
    if ((afterTarget.groupId ?? "") !== groupId) {
      setAfterTaskId(null);
      notify("改了分组，已清除排队目标（跨组不能同队）");
    }
  };

  /** 把刚创建的任务排到所选目标之后。创建成功后排队失败不回滚任务:两段结果分开说。
   * 成功时重取任务快照:创建返回里 queueId 还是 null,拿旧快照交回上层会把 SSE 已
   * 送达的队列徽标整行覆盖掉(第 1 轮审查复现「第 7 / 6 位」+「独立任务」)。 */
  const enqueue = async (task: Task): Promise<{ task: Task; message: string }> => {
    const target = afterTarget;
    setAfterTaskId(null);
    try {
      if (!target) throw new Error("目标任务不存在，可能刚被删除");
      await placeTaskAfter(task.id, target);
      const fresh = await api.task(task.id).catch(() => task);
      return { task: fresh, message: `已排在「${target.title || "未命名任务"}」之后，轮到它时自动开始` };
    } catch (error) {
      return { task, message: `任务已创建，但排队失败：${error instanceof Error ? error.message : "未知错误"}` };
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
