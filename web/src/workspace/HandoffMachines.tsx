import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  HandoffApprovalResult,
  HandoffExportResult,
  HandoffPreflightResult,
  HandoffTarget,
  ProjectView,
  TaskListItem,
} from "@ash/shared";
import { Check, DesktopTower, Fingerprint, LockKey, PaperPlaneTilt, SpinnerGap, Warning } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { HandoffDialogHeader, HandoffRouteCard } from "../task-detail/HandoffDialogViews.tsx";
import { outboundTasksForTarget, partitionBulkHandoffTasks } from "./bulkHandoff.ts";

type TransferFailure = { task: TaskListItem; reason: string };
type BusyPhase = "idle" | "approval" | "preflight" | "transferring";

async function targetForBulkTask(task: Task, selected: HandoffTarget): Promise<HandoffTarget> {
  // 接入任务的 marker.peerUrl 是这条任务最近一次导入时恢复的回程地址；设置项可能
  // 已经过期。批量入口也必须像单任务弹窗一样逐任务解析，不能整批复用侧栏地址。
  return task.handoff?.direction === "in" ? api.handoffReturnTarget(task.id) : selected;
}

function approvalText(result: HandoffApprovalResult): string {
  const identity = result.peer ? `目标机身份 ${result.peer.short}。` : "目标机没有提供可核对的身份。";
  if (result.peer?.peerStatus === "pending") return `${identity}申请已送达，等待对方接受。`;
  if (result.peer?.peerStatus === "blocked") return `${identity}对方已拒绝本机的接力申请。`;
  if (result.peer?.peerStatus === "approved") return `${identity}对方已经接受申请。`;
  if (result.peer?.peerStatus === "open") return `${identity}对方没有开启接力审批。`;
  return `${identity}目标机版本过旧，无法确认申请状态。`;
}

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
  tasks: TaskListItem[];
  notify: (message: string) => void;
  onClose: () => void;
  onFinished: () => Promise<void> | void;
}) {
  // 对话框打开时冻结本次批量清单。正式接力会让 tasks 通过 SSE 实时变成 out；如果继续
  // 跟着重算，成功页会把刚搬走的任务反列成「不可接力」，甚至冒出“没有任务”的警告。
  const [{ eligible, skipped }] = useState(() => partitionBulkHandoffTasks(tasks, project.id, target.peerFp));
  const returnOnly = eligible.length > 0 && eligible.every(
    (task) => task.handoff?.direction === "in" && Boolean(task.handoff.peerFp)
      && task.handoff.peerFp === target.peerFp,
  );
  const actionName = returnOnly ? "移回" : "接力";
  const sample = eligible[0] ?? null;
  const mounted = useRef(true);
  const modalScrim = useRef<HTMLDivElement>(null);
  const autoProbeAttempted = useRef(false);
  const [firstProbe, setFirstProbe] = useState<HandoffPreflightResult | null>(null);
  const [preflights, setPreflights] = useState<Map<string, HandoffPreflightResult>>(new Map());
  const [taskTargets, setTaskTargets] = useState<Map<string, HandoffTarget>>(new Map());
  const [preflightFailures, setPreflightFailures] = useState<TransferFailure[]>([]);
  const [checkedAll, setCheckedAll] = useState(false);
  const [approval, setApproval] = useState<HandoffApprovalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [autoResume, setAutoResume] = useState(true);
  const [phase, setPhase] = useState<BusyPhase>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number; title: string } | null>(null);
  const [result, setResult] = useState<{ successes: HandoffExportResult[]; failures: TransferFailure[] } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const rememberFirstProbe = (taskId: string, taskTarget: HandoffTarget, probe: HandoffPreflightResult) => {
    setFirstProbe(probe);
    setPreflights(new Map([[taskId, probe]]));
    setTaskTargets(new Map([[taskId, taskTarget]]));
    setPreflightFailures([]);
    setCheckedAll(eligible.length === 1);
    setProjectId(probe.suggestedProjectId ?? probe.projects[0]?.id ?? "");
  };

  const probeFirst = useCallback(async () => {
    if (!sample || phase !== "idle") return;
    setPhase("preflight");
    setProgress({ done: 0, total: eligible.length, title: sample.title });
    setError(null);
    try {
      const taskTarget = await targetForBulkTask(sample, target);
      const probe = await api.handoffPreflight(sample.id, taskTarget.url);
      if (mounted.current) rememberFirstProbe(sample.id, taskTarget, probe);
    } catch (reason) {
      if (mounted.current) {
        setFirstProbe(null);
        setPreflights(new Map());
        setTaskTargets(new Map());
        setProjectId("");
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (mounted.current) { setProgress(null); setPhase("idle"); }
    }
    // rememberFirstProbe only writes state derived from this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible.length, phase, sample?.id, target.url]);

  useEffect(() => {
    if (target.peerFp && sample && !firstProbe && phase === "idle" && !autoProbeAttempted.current) {
      autoProbeAttempted.current = true;
      void probeFirst();
    }
  }, [firstProbe, phase, probeFirst, sample, target.peerFp]);

  const blocked = firstProbe?.peer?.peerStatus === "pending" || firstProbe?.peer?.peerStatus === "blocked";
  const busy = phase !== "idle";
  const canClose = !busy || phase === "approval" || phase === "preflight";
  useDismissable({ enabled: canClose, containerRef: modalScrim, onClose });
  const runningCount = eligible.filter((task) => task.status === "running" || task.status === "queued").length;

  const requestApproval = async () => {
    if (busy) return;
    setPhase("approval");
    setError(null);
    try {
      const nextApproval = await api.requestHandoffApproval(target.url);
      if (!mounted.current) return;
      setApproval(nextApproval);
      const status = nextApproval.peer?.peerStatus;
      if (status === "pending") {
        notify(`已向「${target.name}」发送${actionName}申请，等待对方接受`);
        return;
      }
      if (status === "blocked") {
        setError("目标机已拒绝本机的接力申请，请先在目标机修改接力来源状态");
        return;
      }
      if (!sample) return;
      setProgress({ done: 0, total: eligible.length, title: sample.title });
      const taskTarget = await targetForBulkTask(sample, target);
      const probe = await api.handoffPreflight(sample.id, taskTarget.url);
      if (mounted.current) rememberFirstProbe(sample.id, taskTarget, probe);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) { setProgress(null); setPhase("idle"); }
    }
  };

  const preflightAll = async () => {
    if (!firstProbe || !projectId || busy) return;
    setPhase("preflight");
    setError(null);
    // 上次有失败时必须真正重探全部任务，不能继续复用旧 probe；否则目标项目刚修好，
    // “重新检查”仍会拿旧项目清单再次失败，看起来像按钮没作用。
    const checked = preflightFailures.length > 0
      ? new Map<string, HandoffPreflightResult>()
      : new Map(preflights);
    const resolvedTargets = preflightFailures.length > 0
      ? new Map<string, HandoffTarget>()
      : new Map(taskTargets);
    setPreflightFailures([]);
    const failures: TransferFailure[] = [];
    for (let index = 0; index < eligible.length; index += 1) {
      if (!mounted.current) return;
      const task = eligible[index];
      setProgress({ done: index, total: eligible.length, title: task.title });
      try {
        const taskTarget = resolvedTargets.get(task.id) ?? await targetForBulkTask(task, target);
        const probe = checked.get(task.id) ?? await api.handoffPreflight(task.id, taskTarget.url);
        if (!probe.projects.some((candidate) => candidate.id === projectId)) {
          throw new Error("目标项目已不可用，请重新选择");
        }
        resolvedTargets.set(task.id, taskTarget);
        checked.set(task.id, probe);
      } catch (reason) {
        failures.push({ task, reason: reason instanceof Error ? reason.message : String(reason) });
      }
    }
    if (!mounted.current) return;
    setPreflights(checked);
    setTaskTargets(resolvedTargets);
    setPreflightFailures(failures);
    setCheckedAll(failures.length === 0 && checked.size === eligible.length);
    setProgress(null);
    setPhase("idle");
  };

  const run = async () => {
    if (!projectId || busy || !eligible.length || !checkedAll) return;
    setPhase("transferring");
    const successes: HandoffExportResult[] = [];
    const failures: TransferFailure[] = [];
    for (let index = 0; index < eligible.length; index += 1) {
      const task = eligible[index];
      setProgress({ done: index, total: eligible.length, title: task.title });
      try {
        const taskTarget = taskTargets.get(task.id) ?? await targetForBulkTask(task, target);
        successes.push(await api.handoffTask(task.id, {
          targetUrl: taskTarget.url,
          targetProjectId: projectId,
          targetName: taskTarget.name,
          autoResume,
        }));
      } catch (reason) {
        failures.push({ task, reason: reason instanceof Error ? reason.message : String(reason) });
      }
    }
    if (!mounted.current) return;
    setProgress(null);
    setResult({ successes, failures });
    await onFinished();
    if (mounted.current) setPhase("idle");
  };

  const aggregate = useMemo(() => {
    const rows = [...preflights.values()];
    return {
      sessions: rows.reduce((sum, row) => sum + row.local.sessions, 0),
      sessionFilesFound: rows.reduce((sum, row) => sum + row.local.sessionFilesFound, 0),
      uploads: rows.reduce((sum, row) => sum + row.local.uploads, 0),
      pendingMessages: rows.reduce((sum, row) => sum + row.local.pendingMessages, 0),
      scheduled: rows.filter((row) => row.local.schedule).length,
      gitBundles: rows.filter((row) => row.local.git === "bundle").length,
      notes: [...new Set(rows.flatMap((row) => row.local.notes))],
    };
  }, [preflights]);

  const confirm = () => {
    if (result) { onClose(); return; }
    if (!firstProbe || blocked) {
      if (target.peerFp && !blocked) void probeFirst();
      else void requestApproval();
      return;
    }
    if (!checkedAll) { void preflightAll(); return; }
    void run();
  };

  const confirmLabel = result
    ? "完成"
    : !firstProbe || blocked
      ? target.peerFp && !blocked ? `重新检查${returnOnly ? "来源机" : "目标机"}` : blocked ? `检查${actionName}申请状态` : `发送${actionName}申请`
      : !checkedAll
        ? `${preflightFailures.length > 0 ? "重新检查" : "检查"} ${eligible.length} 个${actionName}任务`
        : runningCount > 0
          ? `停止并${actionName} ${eligible.length} 个任务`
          : `${actionName} ${eligible.length} 个任务`;
  const message = result
    ? `已完成批量${actionName}：成功 ${result.successes.length} 个，失败 ${result.failures.length} 个。`
    : returnOnly
      ? `把本机「${project.name}」项目中 ${eligible.length} 个接入任务顺序移回「${target.name}」。`
      : `把本机「${project.name}」项目中 ${eligible.length} 个可接力任务顺序移到「${target.name}」。`;

  const selectedProject = firstProbe?.projects.find((candidate) => candidate.id === projectId) ?? null;

  return createPortal(
    <div
      className="task-modal-scrim"
      ref={modalScrim}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && canClose) onClose(); }}
    >
      <section className="task-confirm-dialog handoff-dialog handoff-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <HandoffDialogHeader
          title={`${returnOnly ? "移回到" : "接力到"} ${target.name}`}
          disabled={!canClose}
          onClose={onClose}
        />
        {result ? (
          <div className="handoff-result-panel handoff-bulk-result">
            <span className="handoff-result-mark" aria-hidden="true"><Check size={22} weight="bold" /></span>
            <span className="handoff-eyebrow">BATCH COMPLETE</span>
            <h3>批量{actionName}已完成</h3>
            <p>{message}</p>
            <div className="handoff-result-facts">
              <span><b>{result.successes.length}</b> 个成功</span>
              <span><b>{result.failures.length}</b> 个失败</span>
              <span><b>{eligible.length}</b> 个任务</span>
            </div>
            {result.failures.length > 0 && (
              <ul className="handoff-bulk-failures">{result.failures.map(({ task, reason }) => <li key={task.id}><b>{task.title}</b><span>{reason}</span></li>)}</ul>
            )}
          </div>
        ) : (
          <>
            <HandoffRouteCard
              sourcePath={`${project.name} · ${eligible.length} 个任务`}
              targetName={target.name}
              targetPath={selectedProject?.repoPath ?? target.url}
            />
            <p className="handoff-bulk-lede">{message}</p>
            <div className="handoff-bulk-body">
        <p className="handoff-bulk-scope">会迁移完整 CLI 会话、附件与可带走的 Git 状态；本机任务确认{actionName}后会从任务列表消失。</p>
        {runningCount > 0 && (
          <p className="handoff-bulk-warning"><Warning size={13} aria-hidden="true" />其中 {runningCount} 个任务正在运行或排队，正式{actionName}会先停止它们。</p>
        )}
        {!eligible.length && <p className="handoff-bulk-warning">这个项目目前没有可批量接力的顶层单飞任务。展开下方列表可查看原因。</p>}
        {skipped.length > 0 && (
          <details className="handoff-bulk-skipped" open={!eligible.length}>
            <summary>另有 {skipped.length} 个任务不会移动</summary>
            <ul>{skipped.map(({ task, reason }) => <li key={task.id}><b>{task.title}</b><span>{reason}</span></li>)}</ul>
          </details>
        )}
        {approval && !firstProbe && <p className="handoff-bulk-peer"><Fingerprint size={13} aria-hidden="true" /><span>{approvalText(approval)}</span></p>}
        {firstProbe?.peer ? (
          <p className={`handoff-bulk-peer${blocked ? " is-warn" : ""}`}>
            <Fingerprint size={13} aria-hidden="true" />
            <span>目标机身份 <b>{firstProbe.peer.short}</b>{firstProbe.peer.trust === "first-seen" ? "（第一次核对，请和对端设置页指纹比对）" : "（和已记住的身份一致）"}</span>
          </p>
        ) : firstProbe ? (
          <p className="handoff-bulk-peer is-warn"><Warning size={13} aria-hidden="true" /><span>目标机没有报出身份，无法核对对端是不是原来的机器，也无法加密；整个仓库和会话历史会明文传输。</span></p>
        ) : null}
        {firstProbe?.peer && (
          <p className={`handoff-bulk-peer${firstProbe.peer.encrypted ? "" : " is-warn"}`}>
            {firstProbe.peer.encrypted ? <LockKey size={13} aria-hidden="true" /> : <Warning size={13} aria-hidden="true" />}
            <span>{firstProbe.peer.encrypted ? "仓库和会话将加密传输。" : "这次会明文传输整个仓库和会话历史，同网段抓包可读取内容。"}</span>
          </p>
        )}
        {firstProbe && !blocked && (
          <label className="handoff-bulk-field">
            <span>目标项目（主机 {firstProbe.target.host}）</span>
            <select value={projectId} disabled={busy} onChange={(event) => { setProjectId(event.target.value); setCheckedAll(false); setPreflightFailures([]); }}>
              <option value="">选择目标项目</option>
              {firstProbe.projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}（{candidate.repoPath}{candidate.isRepo ? "" : " · 非 git"}）</option>)}
            </select>
          </label>
        )}
        {checkedAll && (
          <ul className="handoff-bulk-summary">
            <li>
              已逐个检查 {preflights.size} 个任务：CLI 会话 {aggregate.sessions} 个，找到会话文件 {aggregate.sessionFilesFound} 份
              {aggregate.sessions > aggregate.sessionFilesFound ? `，缺失 ${aggregate.sessions - aggregate.sessionFilesFound} 份（对端会全新起跑对应会话）` : ""}
            </li>
            <li>{aggregate.gitBundles} 个任务会携带 Git 分支或未提交改动，附件共 {aggregate.uploads} 个</li>
            {aggregate.pendingMessages > 0 && <li>待发送消息 {aggregate.pendingMessages} 条会迁移到目标机</li>}
            {aggregate.scheduled > 0 && <li>带定时计划的任务 {aggregate.scheduled} 个，之后由目标机触发</li>}
          </ul>
        )}
        {aggregate.notes.length > 0 && checkedAll && <ul className="handoff-bulk-notes">{aggregate.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
        {firstProbe && !blocked && (
          <label className="handoff-bulk-toggle">
            <input type="checkbox" checked={autoResume} disabled={busy} onChange={(event) => setAutoResume(event.target.checked)} />
            <span>{actionName}完成后在目标机自动续跑</span>
          </label>
        )}
        {blocked && <p className="handoff-bulk-warning">目标机尚未批准本机。请在目标机接受申请后，再点击“检查申请状态”。</p>}
        {error && <p className="handoff-bulk-error">{error}</p>}
        {(progress || phase === "approval") && (
          <div className="handoff-bulk-progress" role="status">
            <SpinnerGap size={15} className="is-spinning" aria-hidden="true" />
            <span>
              {phase === "approval"
                ? "正在联系目标机…"
                : `${phase === "transferring" ? `正在${actionName}` : "正在预检"} · ${progress!.done + 1}/${progress!.total} · ${progress!.title}`}
            </span>
          </div>
        )}
        {preflightFailures.length > 0 && (
          <div className="handoff-bulk-blocked">
            <p>有 {preflightFailures.length} 个任务预检失败，未开始迁移。处理后可点击“重新检查”。</p>
            <ul>{preflightFailures.map(({ task, reason }) => <li key={task.id}><b>{task.title}</b><span>{reason}</span></li>)}</ul>
          </div>
        )}
            </div>
          </>
        )}
        <footer>
          <button type="button" disabled={!canClose} onClick={onClose}>{result ? "关闭" : "取消"}</button>
          <button
            className="is-primary"
            type="button"
            disabled={busy || (!result && (!eligible.length || (Boolean(firstProbe) && !blocked && !projectId)))}
            onClick={confirm}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function HandoffMachines({
  project,
  tasks,
  selectedRemoteTaskId,
  onRemoteTask,
  notify,
  onFinished,
}: {
  project: ProjectView | null;
  tasks: TaskListItem[];
  selectedRemoteTaskId: string | null;
  onRemoteTask: (task: TaskListItem, target: HandoffTarget) => void;
  notify: (message: string) => void;
  onFinished: () => Promise<void> | void;
}) {
  const [targets, setTargets] = useState<HandoffTarget[]>([]);
  const [selected, setSelected] = useState<HandoffTarget | null>(null);

  const reloadTargets = useCallback(() => {
    let alive = true;
    api.settings()
      .then((settings) => { if (alive) setTargets(settings.handoffTargets); })
      .catch((reason) => { if (alive) notify(reason instanceof Error ? reason.message : "接力目标读取失败"); });
    return () => { alive = false; };
  }, [notify]);
  useEffect(() => reloadTargets(), [reloadTargets]);

  const outboundByTarget = useMemo(() => new Map(targets.map((target) => [
    target.url,
    project ? outboundTasksForTarget(tasks, project.id, target.url, target.peerFp) : [],
  ])), [project, targets, tasks]);

  if (!targets.length || !project) return null;

  return (
    <section className="workspace-task-section workspace-handoff-machines" aria-labelledby="workspace-handoff-machines-title">
      <header className="workspace-task-section-title" id="workspace-handoff-machines-title">其他机器</header>
      <div className="workspace-handoff-machine-list">
        {targets.map((target) => {
          const outbound = outboundByTarget.get(target.url) ?? [];
          return (
            <div className="workspace-handoff-machine-group" key={target.url}>
              <div className="workspace-handoff-machine">
                <DesktopTower size={14} aria-hidden="true" />
                <span className="workspace-handoff-machine-copy">
                  <b>{target.name}</b>
                </span>
                <button
                  type="button"
                  aria-label={`将本项目全部任务接力到 ${target.name}`}
                  onClick={() => setSelected(target)}
                >
                  <PaperPlaneTilt size={13} weight="bold" aria-hidden="true" />
                </button>
              </div>
              {outbound.length > 0 && (
                <div className="workspace-handoff-task-list" aria-label={`${target.name}上的接力任务`}>
                  {outbound.map((task) => (
                    <button
                      className={`workspace-handoff-task${selectedRemoteTaskId === task.id ? " is-selected" : ""}`}
                      type="button"
                      aria-current={selectedRemoteTaskId === task.id ? "page" : undefined}
                      onClick={() => onRemoteTask(task, target)}
                      key={task.id}
                    >
                      <i aria-hidden="true" />
                      <span>{task.title || "未命名任务"}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {selected && (
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
