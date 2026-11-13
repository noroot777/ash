import type { Session, Task, TaskListItem } from "@ash/shared";
import { agentMix } from "@ash/shared/team";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { InspKv, InspRow } from "../inspector/parts.tsx";
import { InfoRunRows, InfoSessionRows } from "../task-detail/info/InfoRunRows.tsx";
import { EMPTY_RUN_FACTS } from "../task-detail/info/infoRunFacts.ts";
import type { Notify } from "../lib/notify.ts";
import { teamLeadLabel, teamReviewerLabel, teamWorkerLabel } from "./teamModel.ts";

const INHERITED = "跟随执行器";

/**
 * 一个角色一行：谁来当，后面淡一档写它改过的模型、智能水平（都跟随执行器就不写）。
 * 全称指上去再看。
 */
function RoleRow({ role, executor, model, effort, off = false }: {
  role: string;
  executor: string;
  model: string;
  effort: string;
  off?: boolean;
}) {
  const tip = useHoverTip();
  const extras = [model !== INHERITED ? model : "", effort !== INHERITED ? `智能水平 ${effort}` : ""].filter(Boolean);
  if (off) {
    return <InspRow label={role}><span className="insp-faint">已关闭</span></InspRow>;
  }
  return (
    <InspRow label={role}>
      <span className="insp-cut insp-has-tip" tabIndex={0} {...tip.anchorProps}>
        {executor}
        {extras.length > 0 && <span className="insp-faint"> · {extras.join(" · ")}</span>}
      </span>
      <HoverTip at={tip.at}>{`${executor} · 模型 ${model} · 智能水平 ${effort}`}</HoverTip>
    </InspRow>
  );
}

/**
 * 团队的「信息」格，跟单飞任务那一格同一副版式：「标签 值」一种行——先是三个角色各由谁来当、
 * 派出了几个人，再是工作区（分支、目录、合入目标、会话），最后是来源、时间、用量。原始需求是
 * 调度流里的第一颗气泡。
 */
export function TeamInfoPanel({ task, workers, sessions, notify }: {
  task: Task;
  workers: TaskListItem[];
  sessions: Session[];
  notify?: Notify;
}) {
  const latestSession = [...sessions].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const config = task.team;
  const reviewEnabled = config?.review !== false;
  const say = (message: string) => notify?.(message);

  return (
    <div className="team-info-panel insp-pane" aria-label="团队信息">
      <InspKv label="执行配置">
        <RoleRow
          role="调度者"
          executor={teamLeadLabel(task, latestSession)}
          model={task.model || config?.leadModel || INHERITED}
          effort={task.reasoningEffort || config?.leadReasoningEffort || INHERITED}
        />
        <RoleRow
          role="执行者"
          executor={teamWorkerLabel(task)}
          model={config?.workerModel || INHERITED}
          effort={config?.workerReasoningEffort || INHERITED}
        />
        <InspRow label="派出">
          {workers.length
            ? <span className="insp-cut"><span className="insp-num">{workers.length} 人</span><span className="insp-faint"> · {agentMix(workers)}</span></span>
            : <span className="insp-faint">还没派出执行者</span>}
        </InspRow>
        <RoleRow
          role="审查者"
          executor={teamReviewerLabel(task)}
          model={config?.reviewerModel || INHERITED}
          effort={config?.reviewerReasoningEffort || INHERITED}
          off={!reviewEnabled}
        />
      </InspKv>

      <InspKv label="工作区">
        {latestSession ? <InfoSessionRows task={task} session={latestSession} notify={say} /> : (
          <>
            <InspRow label="分支"><span className="insp-faint">项目当前分支</span></InspRow>
            <InspRow label="目录"><span className="insp-faint">{task.useWorktree ? "尚未记录" : "共享项目目录"}</span></InspRow>
          </>
        )}
        {task.useWorktree && (
          <InspRow label="合入目标" className="team-info-target">
            <span className="insp-cut">{task.acceptedTargetBranch || task.mergeTargetBranch || task.worktreeBase || "未确定（验收时解析）"}</span>
          </InspRow>
        )}
      </InspKv>

      <InspKv label="执行信息">
        <InfoRunRows task={task} sessions={sessions} facts={EMPTY_RUN_FACTS} />
      </InspKv>
    </div>
  );
}
