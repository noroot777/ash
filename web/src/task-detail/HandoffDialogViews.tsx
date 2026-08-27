import type { HandoffExportResult, HandoffPingProject } from "@ash/shared";
import {
  ArrowRight,
  ArrowSquareOut,
  Check,
  ChatCircleDots,
  Code,
  FolderOpen,
  X,
} from "@phosphor-icons/react";

export function HandoffDialogHeader({
  title,
  disabled,
  onClose,
}: {
  title: string;
  disabled: boolean;
  onClose: () => void;
}) {
  return (
    <header className="handoff-dialog-header">
      <span className="handoff-symbol" aria-hidden="true"><i /><i /></span>
      <div>
        <span className="handoff-eyebrow">HANDOFF</span>
        <h2 id="handoff-title">{title}</h2>
      </div>
      <button type="button" className="handoff-dialog-close" disabled={disabled} aria-label="关闭接力弹窗" onClick={onClose}>
        <X size={17} aria-hidden="true" />
      </button>
    </header>
  );
}

export function HandoffRouteCard({
  sourceName = "本机",
  sourcePath,
  targetName,
  targetPath,
}: {
  sourceName?: string;
  sourcePath: string;
  targetName: string;
  targetPath: string;
}) {
  return (
    <div className="handoff-route-card">
      <div className="handoff-route-node">
        <span>从</span>
        <b>{sourceName}</b>
        <small>{sourcePath}</small>
      </div>
      <div className="handoff-route-track" aria-hidden="true"><i /><ArrowRight size={17} /></div>
      <div className="handoff-route-node is-target">
        <span>到</span>
        <b>{targetName}</b>
        <small>{targetPath}</small>
      </div>
    </div>
  );
}

export function HandoffReviewGrid({
  project,
  sessions,
  uploads,
  git,
  autoResume,
  returning = false,
}: {
  project: HandoffPingProject | null;
  sessions: number;
  uploads: number;
  git: "bundle" | "none";
  autoResume: boolean;
  returning?: boolean;
}) {
  return (
    <div className="handoff-review-grid">
      <div className="handoff-review-item">
        <FolderOpen size={15} aria-hidden="true" />
        <span>项目</span><b>{project?.name ?? "待选择"}</b><small>{project?.repoPath ?? "选择接收位置"}</small>
      </div>
      <div className="handoff-review-item">
        <Code size={15} aria-hidden="true" />
        <span>代码</span><b>{git === "bundle" ? "随分支移动" : "沿用目标仓库"}</b><small>{git === "bundle" ? "当前提交与 WIP 一并带走" : "没有可携带的 Git 状态"}</small>
      </div>
      <div className="handoff-review-item">
        <ChatCircleDots size={15} aria-hidden="true" />
        <span>上下文</span><b>{sessions} 份会话</b><small>{uploads ? `另含 ${uploads} 个附件` : "历史与工具状态保持连续"}</small>
      </div>
      <div className="handoff-review-item">
        <ArrowRight size={15} aria-hidden="true" />
        <span>完成后</span><b>{autoResume ? "立即续跑" : "等待手动运行"}</b>
        <small>{returning ? "任务回到来源机，当前机器保留历史" : "仍可在本机代理视图里继续查看"}</small>
      </div>
    </div>
  );
}

export function HandoffProgress({ targetName, returning }: { targetName: string; returning: boolean }) {
  const steps = returning
    ? [["固定当前进度", "等待本轮安全停稳"], ["核对来源身份", "只接受原任务指纹"], ["传回任务上下文", "代码、历史与附件"], ["恢复原机所有权", targetName]]
    : [["固定当前进度", "等待本轮安全停稳"], ["同步 Git 状态", "提交与工作区"], ["移动任务上下文", "历史、附件与工具状态"], ["切换运行位置", targetName]];
  return (
    <div className="handoff-progress" role="status" aria-live="polite">
      <div className="handoff-progress-orbit" aria-hidden="true"><span /><i /></div>
      <span className="handoff-eyebrow">MOVING TASK</span>
      <h3>{returning ? `正在移回 ${targetName}` : `正在接力到 ${targetName}`}</h3>
      <p>
        {returning
          ? "正在安全交回来源机，完成后当前机器只保留历史记录。"
          : "正在安全迁移，完成后会停留在结果页，可从本机代理视图继续查看。"}
      </p>
      <span className="handoff-progress-plan-title">本次将执行</span>
      <ul>
        {steps.map(([label, detail]) => (
          <li key={label}>
            <span><ArrowRight size={12} aria-hidden="true" /></span><div><b>{label}</b><small>{detail}</small></div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HandoffResultPanel({
  result,
  returning,
  targetName,
  onOpenRemote,
}: {
  result: HandoffExportResult;
  returning: boolean;
  targetName: string;
  onOpenRemote: (() => void) | null;
}) {
  return (
    <div className="handoff-result-panel">
      <span className="handoff-result-mark" aria-hidden="true"><Check size={22} weight="bold" /></span>
      <span className="handoff-eyebrow">HANDOFF COMPLETE</span>
      <h3>{returning ? `已移回 ${targetName}` : `已接力到 ${targetName}`}</h3>
      <p>{returning ? "任务已安全交回来源机，当前机器保留历史存档。" : "会话、任务记录和运行位置已经完成切换，本机保留历史存档。"}</p>
      <div className="handoff-result-facts">
        <span><b>{result.sessionsMigrated}</b> 份会话</span>
        <span><b>{result.git === "bundle" ? "已携带" : "未携带"}</b> 代码状态</span>
        <span><b>{result.autoResume ? "已续跑" : "待运行"}</b> 目标任务</span>
      </div>
      {result.notes.length > 0 && (
        <ul className="handoff-notes">{result.notes.map((note) => <li key={note}>{note}</li>)}</ul>
      )}
      {onOpenRemote && (
        <button className="handoff-local-open" type="button" onClick={onOpenRemote}>
          在本机查看远程任务<ArrowSquareOut size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
