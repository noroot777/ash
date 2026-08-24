import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  HandoffExportResult,
  HandoffPreflightResult,
  HandoffTarget,
  ProjectView,
  Task,
} from "@ash/shared";
import { DesktopTower, PaperPlaneTilt, SpinnerGap } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { partitionBulkHandoffTasks } from "./bulkHandoff.ts";

type TransferFailure = { task: Task; reason: string };

function BulkHandoffDialog({
  project,
  target,
  tasks,
  notify,
  onClose,
  onFinished,
}: {
  project: ProjectView;
  target: HandoffTarget;
  tasks: Task[];
  notify: (message: string) => void;
  onClose: () => void;
  onFinished: () => Promise<void> | void;
}) {
  const { eligible, skipped } = useMemo(
    () => partitionBulkHandoffTasks(tasks, project.id),
    [project.id, tasks],
  );
  const sample = eligible[0] ?? null;
  const [preflight, setPreflight] = useState<HandoffPreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [autoResume, setAutoResume] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; title: string } | null>(null);
  const [result, setResult] = useState<{ successes: HandoffExportResult[]; failures: TransferFailure[] } | null>(null);

  const probe = async () => {
    if (!sample || busy) return;
    setBusy(true);
    setPreflightError(null);
    try {
      const next = await api.handoffPreflight(sample.id, target.url);
      setPreflight(next);
      setProjectId(next.suggestedProjectId ?? next.projects[0]?.id ?? "");
    } catch (reason) {
      setPreflight(null);
      setProjectId("");
      setPreflightError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (target.peerFp && sample) void probe();
    // 对已记住身份的机器自动做只读预检；未申请过的机器必须等用户明确按按钮。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample?.id, target.peerFp, target.url]);

  const blocked = preflight?.peer?.peerStatus === "pending" || preflight?.peer?.peerStatus === "blocked";

  const requestApproval = async () => {
    if (busy) return;
    setBusy(true);
    setPreflightError(null);
    try {
      const approval = await api.requestHandoffApproval(target.url);
      const status = approval.peer?.peerStatus;
      if (status === "pending") {
        setPreflight(null);
        notify(`已向「${target.name}」发送接力申请，等待对方接受`);
        return;
      }
      if (status === "blocked") {
        setPreflight(null);
        setPreflightError("目标机已拒绝本机的接力申请，请先在目标机修改接力来源状态");
        return;
      }
      if (!sample) return;
      const next = await api.handoffPreflight(sample.id, target.url);
      setPreflight(next);
      setProjectId(next.suggestedProjectId ?? next.projects[0]?.id ?? "");
    } catch (reason) {
      setPreflightError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!projectId || busy || !eligible.length) return;
    setBusy(true);
    const successes: HandoffExportResult[] = [];
    const failures: TransferFailure[] = [];
    for (let index = 0; index < eligible.length; index += 1) {
      const task = eligible[index];
      setProgress({ done: index, total: eligible.length, title: task.title });
      try {
        successes.push(await api.handoffTask(task.id, {
          targetUrl: target.url,
          targetProjectId: projectId,
          targetName: target.name,
          autoResume,
        }));
      } catch (reason) {
        failures.push({ task, reason: reason instanceof Error ? reason.message : String(reason) });
      }
    }
    setProgress(null);
    setResult({ successes, failures });
    await onFinished();
    setBusy(false);
  };

  const confirm = () => {
    if (result) { onClose(); return; }
    if (preflight && !blocked) { void run(); return; }
    if (target.peerFp && !blocked) { void probe(); return; }
    void requestApproval();
  };

  const confirmLabel = result
    ? "完成"
    : preflight && !blocked
      ? `接力 ${eligible.length} 个任务`
      : target.peerFp && !blocked
        ? "重新检查"
        : blocked
          ? "检查申请状态"
          : "发送接力申请";
  const message = result
    ? `已完成批量接力：成功 ${result.successes.length} 个，失败 ${result.failures.length} 个。`
    : `把本机「${project.name}」项目中 ${eligible.length} 个可接力任务顺序移到「${target.name}」。`;

  return (
    <ConfirmDialog
      title={`接力到 ${target.name}`}
      message={message}
      confirmLabel={confirmLabel}
      busy={busy}
      confirmDisabled={!result && (!eligible.length || (Boolean(preflight) && !blocked && !projectId))}
      onClose={onClose}
      onConfirm={confirm}
    >
      <div className="handoff-bulk-body">
        {!eligible.length && <p className="handoff-bulk-warning">这个项目目前没有可批量接力的顶层单飞任务。</p>}
        {skipped.length > 0 && (
          <details className="handoff-bulk-skipped">
            <summary>另有 {skipped.length} 个任务不会移动</summary>
            <ul>
              {skipped.map(({ task, reason }) => <li key={task.id}><b>{task.title}</b><span>{reason}</span></li>)}
            </ul>
          </details>
        )}
        {preflight && !blocked && (
          <label className="handoff-bulk-field">
            <span>目标项目</span>
            <select value={projectId} disabled={busy} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">选择目标项目</option>
              {preflight.projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </label>
        )}
        {preflight && !blocked && (
          <label className="handoff-bulk-toggle">
            <input type="checkbox" checked={autoResume} disabled={busy} onChange={(event) => setAutoResume(event.target.checked)} />
            <span>迁移完成后在目标机自动续跑</span>
          </label>
        )}
        {blocked && <p className="handoff-bulk-warning">目标机尚未批准本机。请在目标机接受申请后，再点击“检查申请状态”。</p>}
        {preflightError && <p className="handoff-bulk-error">{preflightError}</p>}
        {progress && (
          <div className="handoff-bulk-progress" role="status">
            <SpinnerGap size={15} className="is-spinning" aria-hidden="true" />
            <span>{progress.done + 1}/{progress.total} · {progress.title}</span>
          </div>
        )}
        {result?.failures.length ? (
          <ul className="handoff-bulk-failures">
            {result.failures.map(({ task, reason }) => <li key={task.id}><b>{task.title}</b><span>{reason}</span></li>)}
          </ul>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

export function HandoffMachines({
  project,
  tasks,
  notify,
  onFinished,
}: {
  project: ProjectView | null;
  tasks: Task[];
  notify: (message: string) => void;
  onFinished: () => Promise<void> | void;
}) {
  const [targets, setTargets] = useState<HandoffTarget[]>([]);
  const [selected, setSelected] = useState<HandoffTarget | null>(null);

  const reloadTargets = useCallback(() => {
    let alive = true;
    api.settings()
      .then((settings) => { if (alive) setTargets(settings.handoffTargets); })
      .catch((reason) => notify(reason instanceof Error ? reason.message : "接力目标读取失败"));
    return () => { alive = false; };
  }, [notify]);
  useEffect(() => reloadTargets(), [reloadTargets]);

  const eligibleCount = useMemo(
    () => project ? partitionBulkHandoffTasks(tasks, project.id).eligible.length : 0,
    [project, tasks],
  );
  if (!targets.length) return null;

  return (
    <section className="workspace-task-section workspace-handoff-machines" aria-labelledby="workspace-handoff-machines-title">
      <header className="workspace-task-section-title" id="workspace-handoff-machines-title">其他机器</header>
      <div className="workspace-handoff-machine-list">
        {targets.map((target) => (
          <div className="workspace-handoff-machine" key={target.url}>
            <DesktopTower size={14} aria-hidden="true" />
            <span className="workspace-handoff-machine-copy"><b>{target.name}</b><small>{target.url}</small></span>
            <button
              type="button"
              disabled={!project || eligibleCount === 0}
              aria-label={project ? `将本项目全部任务接力到 ${target.name}` : `接力到 ${target.name}`}
              onClick={() => setSelected(target)}
            >
              <PaperPlaneTilt size={13} weight="bold" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      {selected && project && (
        <BulkHandoffDialog
          project={project}
          target={selected}
          tasks={tasks}
          notify={notify}
          onClose={() => { setSelected(null); reloadTargets(); }}
          onFinished={onFinished}
        />
      )}
    </section>
  );
}
