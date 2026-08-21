import type { Group, Session, Task } from "@ash/shared";
import { agentMix } from "@ash/shared/team";
import { Clock, FolderOpen, Info, MagnifyingGlass, UsersThree } from "@phosphor-icons/react";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { MessageFooter } from "../components/MessageFooter.tsx";
import { FileTreeInspector } from "../files/FileTreeInspector.tsx";
import type { InspectorDescriptor } from "../inspector/index.ts";
import type { IndicatorForTask } from "../lib/useTaskReadState.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { TaskTimeMeta } from "../task-detail/TaskTimeMeta.tsx";
import { parseAttachmentText } from "../task-detail/utils.ts";
import { TeamTimeline } from "./TeamTimeline.tsx";
import { TeamReviewInspector } from "./TeamReviewInspector.tsx";
import { WorkerRail } from "./WorkerRail.tsx";
import {
  teamLeadLabel,
  teamReviewerLabel,
  teamWorkerLabel,
  type LeadTurn,
} from "./teamModel.ts";

export interface TeamInspectorContext {
  task: Task;
  workers: Task[];
  groups: Group[];
  sessions: Session[];
  leadTurns: LeadTurn[];
  selectedWorkerId: string | null;
  onSelectWorker: (taskId: string) => void;
  onOpenReview: () => void;
  onOpenTask: (taskId: string) => void;
  indicatorForTask: IndicatorForTask;
  workerLiveLines: Record<string, string>;
  openFilePath: string | null;
  onOpenFile: (path: string) => void;
}

function ConfigValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="team-info-panel__config-value">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function RoleConfig({
  role,
  executor,
  model,
  effort,
  note,
  disabled = false,
}: {
  role: string;
  executor: string;
  model: string;
  effort: string;
  note?: string;
  disabled?: boolean;
}) {
  return (
    <article className={`team-info-panel__role${disabled ? " is-disabled" : ""}`}>
      <header><span>{role}</span><b title={executor}>{executor}</b></header>
      {!disabled && (
        <dl>
          <ConfigValue label="模型" value={model} />
          <ConfigValue label="智能水平" value={effort} />
        </dl>
      )}
      {note && <p>{note}</p>}
    </article>
  );
}

function TeamInfoPanel({ task, workers, sessions }: Pick<TeamInspectorContext, "task" | "workers" | "sessions">) {
  const objective = parseAttachmentText(task.body);
  const latestSession = [...sessions].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const config = task.team;
  const reviewEnabled = config?.review !== false;
  const inherited = "跟随执行器";

  return (
    <div className="team-info-panel" aria-label="团队信息">
      <ImagePreviewGroup isolated>
        <details className="team-info-panel__section team-info-panel__objective">
          <summary>原始需求</summary>
          <div className="team-info-panel__objective-body">
            {objective.body || objective.paths.length > 0 ? (
              <>
                {objective.body && <MarkdownBody text={objective.body} />}
                <MessageAttachments paths={objective.paths} />
              </>
            ) : <p className="team-info-panel__empty">未记录原始需求。</p>}
          </div>
        </details>
      </ImagePreviewGroup>

      <section className="team-info-panel__section">
        <h2>执行配置</h2>
        <div className="team-info-panel__roles">
          <RoleConfig
            role="调度者"
            executor={teamLeadLabel(task, latestSession)}
            model={task.model || config?.leadModel || inherited}
            effort={task.reasoningEffort || config?.leadReasoningEffort || inherited}
          />
          <RoleConfig
            role="执行者"
            executor={teamWorkerLabel(task)}
            model={config?.workerModel || inherited}
            effort={config?.workerReasoningEffort || inherited}
            note={workers.length ? `${workers.length} 人 · ${agentMix(workers)}` : "尚未派出执行者"}
          />
          <RoleConfig
            role="审查者"
            executor={reviewEnabled ? teamReviewerLabel(task) : "已关闭"}
            model={config?.reviewerModel || inherited}
            effort={config?.reviewerReasoningEffort || inherited}
            disabled={!reviewEnabled}
          />
        </div>
      </section>

      <section className="team-info-panel__section">
        <h2>工作区</h2>
        <dl className="team-info-panel__workspace">
          <ConfigValue label="分支" value={latestSession?.branch || "项目当前分支"} />
          <ConfigValue
            label="worktree"
            value={latestSession?.worktreePath || (task.useWorktree ? "尚未记录" : "共享项目目录")}
          />
          {task.worktreeBase && <ConfigValue label="合入目标" value={task.worktreeBase} />}
        </dl>
        {latestSession && <MessageFooter session={latestSession} />}
        <TaskTimeMeta task={task} />
      </section>
    </div>
  );
}

export const TEAM_INSPECTORS: readonly InspectorDescriptor<TeamInspectorContext>[] = [
  {
    id: "workers",
    title: "执行者",
    icon: <UsersThree size={14} />,
    defaultOpen: true,
    shortcut: "e",
    render: (context) => (
      <WorkerRail
        workers={context.workers}
        groups={context.groups}
        selectedId={context.selectedWorkerId}
        onSelect={context.onSelectWorker}
        indicatorForTask={context.indicatorForTask}
        liveLines={context.workerLiveLines}
      />
    ),
  },
  {
    id: "info",
    title: "信息",
    icon: <Info size={14} />,
    defaultOpen: true,
    shortcut: "i",
    render: (context) => <TeamInfoPanel {...context} />,
  },
  {
    id: "review",
    title: "审查",
    icon: <MagnifyingGlass size={14} />,
    shortcut: "r",
    render: (context) => (
      <TeamReviewInspector
        lead={context.task}
        workers={context.workers}
        onOpenReview={context.onOpenReview}
        onOpenTask={context.onOpenTask}
      />
    ),
  },
  {
    id: "files",
    title: "文件",
    icon: <FolderOpen size={14} />,
    shortcut: "f",
    // 团队共享调度台的工作目录，所以这棵树就是整队人正在改的那份文件。
    render: (context) => (
      <FileTreeInspector
        taskId={context.task.id}
        activePath={context.openFilePath}
        onOpenFile={context.onOpenFile}
      />
    ),
  },
  {
    id: "timeline",
    title: "时间轴",
    icon: <Clock size={14} />,
    render: (context) => (
      <TeamTimeline
        lead={context.task}
        leadTurns={context.leadTurns}
        workers={context.workers}
        groups={context.groups}
        onOpenWorker={context.onSelectWorker}
        defaultOpen
      />
    ),
  },
];
