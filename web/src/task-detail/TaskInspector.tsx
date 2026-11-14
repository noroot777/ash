import { useMemo } from "react";
import type { Group, Session, Task, TaskListItem, TaskStatus } from "@ash/shared";
import { isUserSettableStatus, TASK_STATUS_LABELS, taskDisplayStatus } from "@ash/shared";
import { ArrowSquareOut, Warning } from "@phosphor-icons/react";
import { Dropdown } from "../components/Dropdown.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { TaskLabelsEditor } from "../components/TaskLabelsEditor.tsx";
import { taskParentLink } from "../components/TaskOrigin.tsx";
import { InspKv, InspNote, InspRow } from "../inspector/parts.tsx";
import { TaskChangeSummary } from "./TaskChangeSummary.tsx";
import { InfoFollowUps, InfoResumePrompt, type InfoFollowUp } from "./info/InfoAsk.tsx";
import { InfoQueue } from "./info/InfoQueue.tsx";
import { InfoRunRows, InfoSessionRows } from "./info/InfoRunRows.tsx";
import { InfoSchedule } from "./info/InfoSchedule.tsx";
import { EMPTY_RUN_FACTS, type InfoRunFacts } from "./info/infoRunFacts.ts";

const STATUS_ORDER: TaskStatus[] = [
  "running", "idle", "paused", "awaiting_review", "queued", "backlog", "done", "failed", "canceled",
];

/**
 * 右侧「信息」格。全是「标签 值」一种行、一种字号：上一组是能改的（追问、状态、分组、标签、
 * 调度、队列、续跑指令），下一组是事实（来源、时间、用量、上下文、改动、分支、目录、会话、
 * resume）。分节只靠留白。原始需求是会话流里的第一颗气泡，每一回合的用量在那一回合尾的
 * 「更多」菜单里，都不在这里重复。
 *
 * 执行器/模型/智能水平不在这里露面：它们跑到一半就能改，这里写下的只会是「此刻的配置」而
 * 不是「这段历史里谁在跑」。当前配置看对话框底部那颗三段胶囊；真正跑过的执行器见「用量」。
 */
export function TaskInspector({
  task,
  groups,
  sessions,
  allTasks,
  followUps = [],
  runFacts = EMPTY_RUN_FACTS,
  onOpenTask,
  onOpenReview,
  onPatch,
  onQueueChanged,
  onTasksSynced,
  notify,
}: {
  task: Task;
  groups: Group[];
  sessions: Session[];
  allTasks: TaskListItem[];
  followUps?: InfoFollowUp[];
  /** 最近一轮的用量、上下文、是不是正在压缩（见 info/infoRunFacts.ts）。 */
  runFacts?: InfoRunFacts;
  onOpenTask: (taskId: string) => void;
  onOpenReview: () => void;
  onPatch: (patch: Partial<Task>) => Promise<void>;
  onQueueChanged: (updatedTask?: Task) => void;
  /** 入队响应波及的全体成员快照(含前驱)整批上交,由上层按 updatedAt 合并进任务列表。 */
  onTasksSynced: (tasks: Task[]) => void;
  notify: (message: string) => void;
}) {
  const readOnly = task.parentId !== null || !!task.archived;
  const latestSession = useMemo(
    () => [...sessions].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0],
    [sessions],
  );

  const patch = async (value: Partial<Task>, message = "任务属性已更新") => {
    try {
      await onPatch(value);
      notify(message);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const saveResumePrompt = async (value: string) => {
    try {
      await onPatch({ resumePrompt: value || null });
      notify(value ? "续跑指令已保存" : "续跑指令已清空");
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  // 状态那一行说的是人话：在等答复、在验证、验收过了，都照任务头那套叫法写；下拉里能选的
  // 仍只有能手动设的那几种，加上当前这一个。
  const statusOptions = STATUS_ORDER.filter((status) => isUserSettableStatus(status) || status === task.status);
  const display = taskDisplayStatus(task.status, task.stage, !!task.question).label;
  const parent = taskParentLink(task, allTasks);

  return (
    <div className="task-inspector insp-pane" aria-label="任务信息">
      <ImagePreviewGroup isolated>
        <InspKv label="任务属性">
          <InfoFollowUps followUps={followUps} />
          <InspRow label="状态">
            <Dropdown
              className="insp-dropdown"
              label="状态"
              value={task.status}
              options={statusOptions.map((status) => ({
                value: status,
                label: status === task.status ? display : TASK_STATUS_LABELS[status],
              }))}
              disabled={readOnly}
              filterable={false}
              onChange={(status) => void patch({ status: status as TaskStatus })}
            />
            {task.archived && <span className="insp-faint">已归档</span>}
          </InspRow>
          {task.parentId !== null && parent && (
            <InspRow label="团队">
              <button type="button" className="insp-val" aria-label={`打开所属团队${parent.task ? `「${parent.task.title}」` : ""}；属性由团队任务统一管理`} onClick={() => onOpenTask(parent.taskId)}>
                <span className="insp-cut">{parent.task?.title ?? "所属团队"}</span>
                <ArrowSquareOut size={12} aria-hidden="true" />
              </button>
            </InspRow>
          )}
          <InspRow label="分组">
            <Dropdown
              className="insp-dropdown"
              label="分组"
              value={task.groupId ?? ""}
              options={[
                { value: "", label: "无分组" },
                ...groups.map((group) => ({
                  value: group.id,
                  label: group.name,
                  detail: group.mode === "parallel" ? "并行" : "串行",
                })),
              ]}
              disabled={readOnly}
              filterable={groups.length > 6}
              filterPlaceholder="筛选分组…"
              placeholder="无分组"
              onChange={(groupId) => void patch({ groupId: groupId || null })}
            />
          </InspRow>
          <InspRow label="标签">
            <TaskLabelsEditor
              key={task.id}
              labels={task.labels}
              disabled={readOnly}
              onChange={(labels, change) => void patch(
                { labels },
                change.kind === "add" ? "标签已添加" : "标签已移除",
              )}
            />
          </InspRow>
          <InfoSchedule taskId={task.id} notify={notify} disabled={task.parentId !== null || !!task.archived} />
          <InfoQueue
            task={task}
            groups={groups}
            allTasks={allTasks}
            onQueueChanged={onQueueChanged}
            onTasksSynced={onTasksSynced}
            notify={notify}
          />
          <InfoResumePrompt
            value={task.resumePrompt ?? ""}
            editable={task.parentId === null && task.status === "paused" && !task.question}
            onSave={saveResumePrompt}
          />
        </InspKv>
      </ImagePreviewGroup>

      {latestSession?.versionWarning && (
        <InspNote tone="warn" icon={<Warning weight="fill" />}>{latestSession.versionWarning}</InspNote>
      )}

      <InspKv label="执行信息">
        <InfoRunRows task={task} sessions={sessions} facts={runFacts} notify={notify} />
        <TaskChangeSummary task={task} allTasks={allTasks} onOpenReview={onOpenReview} />
        <InfoSessionRows task={task} session={latestSession} notify={notify} />
      </InspKv>
    </div>
  );
}
