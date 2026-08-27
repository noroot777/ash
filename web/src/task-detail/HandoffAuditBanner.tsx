import type { HandoffAudit } from "@ash/shared";
import { Warning } from "@phosphor-icons/react";

export function HandoffAuditBanner({ audit }: { audit: HandoffAudit }) {
  const peer = audit.peerName ? `「${audit.peerName}」` : "对端机器";
  return (
    <div className="task-handoff-banner is-pending" role="status">
      <Warning size={13} aria-hidden="true" />
      <span>
        风险记录 · {new Date(audit.at).toLocaleString()}：
        {audit.returning
          ? `曾在无法核验原机状态时强制撤销移回，${peer}可能已有副本。`
          : `曾在无法核验目标机状态时强制恢复本机任务，${peer}可能已有副本。`}
        对端恢复联网后，请人工确认只运行一份任务。
      </span>
    </div>
  );
}
