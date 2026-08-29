import { useState } from "react";
import type { Task, TaskHandoff } from "@ash/shared";
import { PaperPlaneTilt, Warning } from "@phosphor-icons/react";
import { api, ApiError } from "../lib/api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

// 从 HandoffDialog.tsx 拆出来的原因只有一个:那份文件顶到了单文件 700 行的上限。
// 两者是同一条链路的两半 —— 对话框负责「把任务交出去」,横幅负责「交出去之后这条
// 任务在本机长什么样」,所以它们共用 handoff.css 里同一段样式。

const forceHandoffReason = (reason: unknown): string | null => {
  if (!(reason instanceof ApiError) || typeof reason.body !== "object" || reason.body === null) return null;
  return "needsForce" in reason.body && reason.body.needsForce === true ? reason.message : null;
};

// 任务详情顶部的持久横幅:接力标记落在 tasks.handoff 上,刷新后仍然看得出这个任务
// 已经交出去了(或是从别的机器接过来的)。确认送达后本机只留不可运行的历史数据，
// 移回必须从对端那份发起；pending（送达未知）恢复本机前也必须先由目标机确认撤销。
export function HandoffBanner({
  taskId,
  handoff,
  notify,
  onTaskUpdate,
}: {
  taskId: string;
  handoff: TaskHandoff;
  notify: (message: string) => void;
  onTaskUpdate: (task: Task) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [forceReason, setForceReason] = useState<string | null>(null);
  const out = handoff.direction === "out";
  const returned = handoff.direction === "returned";
  const pendingReturn = out && handoff.pending
    && Object.prototype.hasOwnProperty.call(handoff, "returnTransferId");
  const peer = handoff.peerName ? `「${handoff.peerName}」` : "另一台机器";
  const clear = async (force = false) => {
    setBusy(true);
    try {
      const cleared = await api.clearHandoff(taskId, force);
      onTaskUpdate(await api.task(taskId));
      notify(cleared.forced
        ? "已强制恢复本机任务；请在对端恢复联网后确认没有第二份任务继续运行"
        : pendingReturn ? "已安全撤销本次移回，任务继续留在本机" : "对端确认未收到，任务已安全恢复为本机可运行");
      setConfirmOpen(false);
      setForceReason(null);
    } catch (reason) {
      const fallback = forceHandoffReason(reason);
      if (!force && fallback) {
        setForceReason(fallback);
        return;
      }
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`task-handoff-banner${handoff.pending ? " is-pending" : ""}`}>
      {handoff.pending ? <Warning size={13} aria-hidden="true" /> : <PaperPlaneTilt size={13} aria-hidden="true" />}
      <span>
        {out
          ? handoff.pending
            ? pendingReturn
              ? `${new Date(handoff.at).toLocaleString()} 移回${peer}后没收到确认,原机可能已接回这份任务。原样再移回一次会自动幂等收口;需要留在本机时,系统会先向原机核验并登记撤销。`
              : `${new Date(handoff.at).toLocaleString()} 接力到${peer}后没收到确认,对端可能已收到这份任务。原样再接力一次会自动幂等收口;需要留在本机时,系统会先向对端核验并登记撤销。`
            : `${new Date(handoff.at).toLocaleString()} 已接力到${peer},本机这份只是历史存档。`
          : returned
            ? `${new Date(handoff.at).toLocaleString()} 已从${peer}移回本机，最新上下文已接回；现在可继续运行或再次接力。`
            : `${new Date(handoff.at).toLocaleString()} 从${peer}接力而来(会话文件 ${handoff.sessions} 份,代码${handoff.git === "bundle" ? "已随分支带来" : "未随任务携带"})。`}
      </span>
      {out && handoff.pending && (
        <button
          type="button"
          className="task-handoff-clear"
          disabled={busy}
          onClick={() => { setForceReason(null); setConfirmOpen(true); }}
        >
          核验后在本机继续…
        </button>
      )}
      {confirmOpen && (
        <ConfirmDialog
          title={forceReason ? "强制恢复可能产生双任务" : pendingReturn ? "撤销本次移回" : "核验并恢复本机任务"}
          message={forceReason
            ? `${forceReason} 强制恢复只会清除本机标记，无法让对端丢弃副本；对端现在或以后重新联网时，可能形成两份可运行任务。只有你准备好手工检查并停止另一份时才继续。`
            : pendingReturn
              ? "系统会先联系原机：只有原机确认尚未接回任务并登记忽略旧请求后，才会撤销本次移回；如果原机已经接回，会阻止恢复本机旧副本。"
              : "系统会先联系目标机：只有目标机确认尚未收到任务并登记忽略旧请求后，才会恢复本机；如果目标机已经收到，会阻止产生第二份可运行任务。"}
          confirmLabel={forceReason ? "承担风险，强制恢复" : "核验并在本机继续"}
          danger
          busy={busy}
          onConfirm={() => void clear(Boolean(forceReason))}
          onClose={() => { setConfirmOpen(false); setForceReason(null); }}
        />
      )}
    </div>
  );
}
