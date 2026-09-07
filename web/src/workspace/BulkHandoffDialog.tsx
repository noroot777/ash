import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  HandoffApprovalResult,
  HandoffCapabilityGap,
  HandoffExportResult,
  HandoffTarget,
  ProjectView,
  TaskListItem,
} from "@ash/shared";
import { needsPeerKey } from "@ash/shared/handoff";
import { Check, Fingerprint, LockKey, SpinnerGap, Warning } from "@phosphor-icons/react";
import { api, ApiError, type TaskScopedHandoffPreflightResult } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { HandoffPeerKeyField } from "../settings/HandoffPeerKeyField.tsx";
import { HandoffDialogHeader, HandoffRouteCard } from "../task-detail/HandoffDialogViews.tsx";
import { HandoffCapabilityNotice } from "../task-detail/HandoffCapabilityNotice.tsx";
import { BulkHandoffTaskList } from "./BulkHandoffTaskList.tsx";
import {
  bulkIdentityMismatchWarning,
  bulkIdentityUnavailableWarning,
  bulkPreflightAllowsRun,
  bulkPreflightIssue,
  groupBulkHandoffFailures,
  bulkReturnCandidates,
  bulkTargetAddressHintMatches,
  bulkTaskReturnsToTarget,
  bulkTargetProjectId,
  partitionBulkHandoffTasks,
  resolveBulkTargetIdentity,
} from "./bulkHandoff.ts";

type TransferFailure = { task: TaskListItem; reason: string };
type IdentityNotice = { kind: "mismatch" | "unverified"; message: string };
type BusyPhase = "idle" | "approval" | "preflight" | "transferring";

async function targetForBulkTask(task: TaskListItem, selected: HandoffTarget): Promise<HandoffTarget> {
  // 接入任务的 marker.peerUrl 是这条任务最近一次导入时恢复的回程地址；设置项可能
  // 已经过期。批量入口也必须像单任务弹窗一样逐任务解析，不能整批复用侧栏地址。
  return task.handoff?.direction === "in" ? api.handoffReturnTarget(task.id) : selected;
}

const sameTargetFingerprint = (left?: string | null, right?: string | null) =>
  Boolean(left && right && left.toLowerCase() === right.toLowerCase());

async function probeBulkTask(task: TaskListItem, selected: HandoffTarget): Promise<{
  taskTarget: HandoffTarget;
  probe: TaskScopedHandoffPreflightResult;
}> {
  const taskTarget = await targetForBulkTask(task, selected);
  const options = task.handoff?.direction === "in" ? { allowReturnFallback: false } : undefined;
  try {
    return { taskTarget, probe: await api.handoffPreflight(task.id, taskTarget.url, options) };
  } catch (reason) {
    const canUseRegisteredFallback = task.handoff?.direction === "in"
      && !bulkTargetAddressHintMatches(taskTarget.url, selected.url)
      && sameTargetFingerprint(task.handoff.peerFp, selected.peerFp);
    if (!canUseRegisteredFallback) throw reason;
    return { taskTarget: selected, probe: await api.handoffPreflight(task.id, selected.url, options) };
  }
}

function approvalText(result: HandoffApprovalResult): string {
  const identity = result.peer ? `目标机身份 ${result.peer.short}。` : "目标机没有提供可核对的身份。";
  if (result.peer?.peerStatus === "pending") return `${identity}申请已送达，等待对方接受。`;
  if (result.peer?.peerStatus === "blocked") return `${identity}对方已拒绝本机的接力申请。`;
  if (result.peer?.peerStatus === "approved") return `${identity}对方已经接受申请。`;
  if (result.peer?.peerStatus === "open") return `${identity}对方没有开启接力审批。`;
  return `${identity}目标机版本过旧，无法确认申请状态。`;
}

const isSharedReturnFailure = (message: string): boolean =>
  /连不上对端|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|连接中断|超时|身份和上次不一样|没有报出身份/i
    .test(message);

const failureTaskLabel = (tasks: TaskListItem[]): string => tasks.length === 1
  ? tasks[0].title
  : `${tasks.length} 个任务：${tasks.map((task) => task.title).join("、")}`;

export function BulkHandoffDialog({
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
  // 冻结本次批量清单；身份解析可以更新分区，但 SSE 不能把已搬走任务反列进成功页。
  const [frozenTasks] = useState(tasks);
  const [returnCandidates] = useState(() => bulkReturnCandidates(frozenTasks, project.id));
  const addressHintFingerprint = target.peerFp ?? returnCandidates.find((task) => task.handoff?.peerUrl
    && bulkTargetAddressHintMatches(task.handoff.peerUrl, target.url))?.handoff?.peerFp ?? null;
  const [resolvedReturnFingerprint, setResolvedReturnFingerprint] = useState<string | null>(addressHintFingerprint);
  const [identityResolving, setIdentityResolving] = useState(
    !target.peerFp && returnCandidates.length > 0,
  );
  const [identityNotice, setIdentityNotice] = useState<IdentityNotice | null>(null);
  const batchFingerprint = target.peerFp ?? resolvedReturnFingerprint;
  const taskSelectedTarget = target.peerFp || !batchFingerprint
    ? target
    : { ...target, peerFp: batchFingerprint };
  const returnOnlyMode = !target.peerFp && Boolean(resolvedReturnFingerprint);
  // 清单只含此刻还在跑的任务：接力是把活挪到别的机器上继续，不是搬项目历史。
  const { eligible, skipped } = useMemo(() => partitionBulkHandoffTasks(
    frozenTasks,
    project.id,
    batchFingerprint,
    returnOnlyMode,
  ), [batchFingerprint, frozenTasks, project.id, returnOnlyMode]);
  const returnOnly = eligible.length > 0 && eligible.every(
    (task) => bulkTaskReturnsToTarget(task, batchFingerprint),
  );
  const canProbeWithoutApproval = Boolean(target.peerFp) || returnOnly;
  const actionName = returnOnly ? "移回" : "接力";
  const sample = eligible[0] ?? null;
  const mounted = useRef(true);
  const modalScrim = useRef<HTMLDivElement>(null);
  const autoProbeAttempted = useRef(false);
  const [firstProbe, setFirstProbe] = useState<TaskScopedHandoffPreflightResult | null>(null);
  const [firstProbeTaskId, setFirstProbeTaskId] = useState<string | null>(null);
  const [preflights, setPreflights] = useState<Map<string, TaskScopedHandoffPreflightResult>>(new Map());
  const [taskTargets, setTaskTargets] = useState<Map<string, HandoffTarget>>(new Map());
  const [preflightFailures, setPreflightFailures] = useState<TransferFailure[]>([]);
  const [checkedAll, setCheckedAll] = useState(false);
  // 能力握手拦下的那些任务(目标机没装它们要用的智能体)。整批共用一个「仍然接力」,
  // 与补 key 同待遇 —— 没勾就把它们**跳过**,而不是拦住整批:一个任务缺 CLI 不该
  // 挡住其余那些目标机明明跑得动的任务。
  const [capabilityAck, setCapabilityAck] = useState(false);
  const [approval, setApproval] = useState<HandoffApprovalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 整批都卡在「对端是多人实例但不认识你」时,补 key 的入口也得在这儿 —— 与单任务
  // 对话框同一个控件、同一条写入路径(见 settings/HandoffPeerKeyField.tsx)。
  const [peerKeyRequired, setPeerKeyRequired] = useState(false);
  // 打包阶段(而不是预检阶段)被「对端不认识你」挡住的那几条。补完 key 只重试它们:
  // 同一批里先走完的任务已经真的搬到对端了,再搬一次会撞上「这条任务已经接力出去」。
  const [peerKeyBlocked, setPeerKeyBlocked] = useState<Set<string>>(new Set());
  const [projectId, setProjectId] = useState("");
  const [autoResume, setAutoResume] = useState(true);
  const [phase, setPhase] = useState<BusyPhase>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number; taskId: string } | null>(null);
  const [result, setResult] = useState<{ successes: HandoffExportResult[]; failures: TransferFailure[] } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!identityResolving) return;
    let alive = true;
    api.handoffTargetIdentity(target.url)
      .then((identity) => {
        if (!alive) return;
        const resolution = resolveBulkTargetIdentity(returnCandidates, target.url, identity.fingerprint);
        if (resolution.returnFingerprint) {
          setResolvedReturnFingerprint(resolution.returnFingerprint);
          setIdentityNotice(null);
        } else if (resolution.mismatchExpectedFingerprints.length > 0) {
          setResolvedReturnFingerprint(null);
          setIdentityNotice({
            kind: "mismatch",
            message: bulkIdentityMismatchWarning(
              resolution.mismatchExpectedFingerprints,
              identity.fingerprint,
            ),
          });
        } else {
          setResolvedReturnFingerprint(null);
          setIdentityNotice(null);
        }
      })
      .catch(() => {
        if (alive) setIdentityNotice({ kind: "unverified", message: bulkIdentityUnavailableWarning() });
      })
      .finally(() => { if (alive) setIdentityResolving(false); });
    return () => { alive = false; };
  }, [identityResolving, returnCandidates, target.url]);

  const rememberFirstProbe = (
    taskId: string,
    taskTarget: HandoffTarget,
    probe: TaskScopedHandoffPreflightResult,
    failures: TransferFailure[] = [],
  ) => {
    setFirstProbe(probe);
    setFirstProbeTaskId(taskId);
    setPreflights(new Map([[taskId, probe]]));
    setTaskTargets(new Map([[taskId, taskTarget]]));
    setPreflightFailures(failures);
    if (probe.peer?.trust === "matched") setIdentityNotice(null);
    setCheckedAll(probe.projects.length > 0
      && bulkPreflightAllowsRun(1, failures.length, eligible.length));
    setProjectId(probe.suggestedProjectId ?? probe.projects[0]?.id ?? "");
  };

  const probeFirst = useCallback(async () => {
    if (!sample || phase !== "idle") return;
    setPhase("preflight");
    setError(null);
    setPeerKeyRequired(false);
    const failures: TransferFailure[] = [];
    try {
      for (let index = 0; index < eligible.length; index += 1) {
        if (!mounted.current) return;
        const task = eligible[index];
        setProgress({ done: index, total: eligible.length, taskId: task.id });
        try {
          const { taskTarget, probe } = await probeBulkTask(task, taskSelectedTarget);
          const issue = bulkPreflightIssue(probe, "");
          if (issue && probe.projects.length === 0
            && probe.peer?.peerStatus !== "pending" && probe.peer?.peerStatus !== "blocked") {
            failures.push({ task, reason: issue });
            continue;
          }
          if (mounted.current) rememberFirstProbe(task.id, taskTarget, probe, failures);
          return;
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason);
          if (needsPeerKey(reason instanceof ApiError ? reason.body : null)) setPeerKeyRequired(true);
          failures.push({ task, reason: message });
          if (returnOnly && isSharedReturnFailure(message)) {
            failures.push(...eligible.slice(index + 1).map((remaining) => ({ task: remaining, reason: message })));
            break;
          }
        }
      }
      if (!mounted.current) return;
      setFirstProbe(null);
      setFirstProbeTaskId(null);
      setPreflights(new Map());
      setTaskTargets(new Map());
      setPreflightFailures(failures);
      setProjectId("");
      setError(failures[0]?.reason ?? "没有任务通过预检");
    } finally {
      if (mounted.current) { setProgress(null); setPhase("idle"); }
    }
    // rememberFirstProbe only writes state derived from this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchFingerprint, eligible.length, phase, returnOnly, sample?.id, target.url]);

  useEffect(() => {
    if (!identityResolving && canProbeWithoutApproval && sample
      && !firstProbe && phase === "idle" && !autoProbeAttempted.current) {
      autoProbeAttempted.current = true;
      void probeFirst();
    }
  }, [canProbeWithoutApproval, firstProbe, identityResolving, phase, probeFirst, sample]);

  const blocked = firstProbe?.peer?.peerStatus === "pending" || firstProbe?.peer?.peerStatus === "blocked";
  const busy = phase !== "idle";
  const canClose = !busy || phase === "approval" || phase === "preflight";
  useDismissable({ enabled: canClose, containerRef: modalScrim, onClose });

  const requestApproval = async () => {
    if (busy) return;
    setPhase("approval");
    setError(null);
    setPeerKeyRequired(false);
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
      const probeTask = eligible.find((task) => task.id === firstProbeTaskId) ?? sample;
      if (!probeTask) return;
      setProgress({ done: 0, total: eligible.length, taskId: probeTask.id });
      const { taskTarget, probe } = await probeBulkTask(probeTask, taskSelectedTarget);
      if (mounted.current) rememberFirstProbe(probeTask.id, taskTarget, probe);
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setPeerKeyRequired(needsPeerKey(reason instanceof ApiError ? reason.body : null));
    } finally {
      if (mounted.current) { setProgress(null); setPhase("idle"); }
    }
  };

  const preflightAll = async () => {
    if (!firstProbe || (needsBatchProject && !projectId) || busy) return;
    setPhase("preflight");
    setError(null);
    setPeerKeyRequired(false);
    // 上次有失败时必须真正重探全部任务，不能继续复用旧 probe；否则目标项目刚修好，
    // “重新检查”仍会拿旧项目清单再次失败，看起来像按钮没作用。
    const checked = preflightFailures.length > 0
      ? new Map<string, TaskScopedHandoffPreflightResult>()
      : new Map(preflights);
    const resolvedTargets = preflightFailures.length > 0
      ? new Map<string, HandoffTarget>()
      : new Map(taskTargets);
    setPreflightFailures([]);
    const failures: TransferFailure[] = [];
    for (let index = 0; index < eligible.length; index += 1) {
      if (!mounted.current) return;
      const task = eligible[index];
      setProgress({ done: index, total: eligible.length, taskId: task.id });
      try {
        let taskTarget = resolvedTargets.get(task.id);
        let probe = checked.get(task.id);
        if (!taskTarget || !probe) {
          const resolved = await probeBulkTask(task, taskSelectedTarget);
          taskTarget = resolved.taskTarget;
          probe = resolved.probe;
        }
        const targetProjectId = bulkTargetProjectId(task, probe, projectId);
        const issue = bulkPreflightIssue(probe, targetProjectId);
        if (issue) throw new Error(issue);
        resolvedTargets.set(task.id, taskTarget);
        checked.set(task.id, probe);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (needsPeerKey(reason instanceof ApiError ? reason.body : null)) setPeerKeyRequired(true);
        failures.push({ task, reason: message });
        if (returnOnly && isSharedReturnFailure(message)) {
          failures.push(...eligible.slice(index + 1).map((remaining) => ({ task: remaining, reason: message })));
          break;
        }
      }
    }
    if (!mounted.current) return;
    setPreflights(checked);
    setTaskTargets(resolvedTargets);
    setPreflightFailures(failures);
    setCheckedAll(bulkPreflightAllowsRun(checked.size, failures.length, eligible.length));
    setProgress(null);
    setPhase("idle");
  };

  /**
   * 逐条打包推走。`carry` 是本批次此前已经攒下的成功/失败 —— 补完 key 重试时,先前
   * 真的搬走的那几条必须原样留在结果里,不能被第二趟覆盖掉。
   */
  const transfer = async (batch: TaskListItem[], carry: {
    successes: HandoffExportResult[];
    failures: TransferFailure[];
  }) => {
    setPhase("transferring");
    const successes = [...carry.successes];
    const failures = [...carry.failures];
    const keyBlocked = new Set<string>();
    for (let index = 0; index < batch.length; index += 1) {
      const task = batch[index];
      setProgress({ done: index, total: batch.length, taskId: task.id });
      try {
        const taskTarget = taskTargets.get(task.id) ?? await targetForBulkTask(task, target);
        const probe = preflights.get(task.id);
        const targetProjectId = probe ? bulkTargetProjectId(task, probe, projectId) : projectId;
        if (!targetProjectId) throw new Error("目标项目不可用，请重新检查");
        successes.push(await api.handoffTask(task.id, {
          targetUrl: taskTarget.url,
          targetProjectId,
          targetName: taskTarget.name,
          autoResume,
          ...(capabilityAck ? { ignoreCapabilityGaps: true } : {}),
        }));
      } catch (reason) {
        // 打包阶段撞上「对端不认识你」同样能当场补 key(整批共用一把)。这时**不能**把
        // 结果页当终点:它只写着「已完成:成功 0 失败 N」和一个「完成」按钮,而这批活
        // 其实差一把 key 就能接着跑完。
        if (needsPeerKey(reason instanceof ApiError ? reason.body : null)) keyBlocked.add(task.id);
        failures.push({ task, reason: reason instanceof Error ? reason.message : String(reason) });
      }
    }
    if (!mounted.current) return;
    setProgress(null);
    setPeerKeyBlocked(keyBlocked);
    setPeerKeyRequired(keyBlocked.size > 0);
    setResult({ successes, failures });
    await onFinished();
    if (mounted.current) setPhase("idle");
  };

  const run = () => {
    const runnable = eligible.filter((task) => isRunnable(task.id));
    if ((needsBatchProject && !projectId) || busy || !runnable.length || !checkedAll) return;
    void transfer(runnable, { successes: [], failures: [...preflightFailures] });
  };

  /** 结果页上补完 key:只重试「就差这把 key」的那几条,已经搬过去的不动。 */
  const retryAfterKey = () => {
    if (busy || !result) return;
    const retryTasks = eligible.filter((task) => peerKeyBlocked.has(task.id));
    if (!retryTasks.length) { setPeerKeyRequired(false); return; }
    setPeerKeyRequired(false);
    setPeerKeyBlocked(new Set());
    void transfer(retryTasks, {
      successes: result.successes,
      failures: result.failures.filter((failure) => !peerKeyBlocked.has(failure.task.id)),
    });
  };

  // 每个任务带走什么已经逐行写在清单里，这里只汇总服务端给的额外提醒。
  const notes = useMemo(
    () => [...new Set([...preflights.values()].flatMap((row) => row.local.notes))],
    [preflights],
  );
  // 能力握手:哪些任务目标机跑不动,以及去重后的落差明细(整批共用一个提示块)。
  const capabilityBlockedIds = useMemo(
    () => new Set([...preflights.entries()].filter(([, row]) => row.capability?.blocking).map(([taskId]) => taskId)),
    [preflights],
  );
  const capabilityGaps = useMemo(() => {
    const seen = new Map<string, HandoffCapabilityGap>();
    for (const row of preflights.values()) {
      for (const gap of row.capability?.gaps ?? []) seen.set(`${gap.kind}-${gap.agentType}-${gap.model ?? ""}`, gap);
    }
    return [...seen.values()];
  }, [preflights]);
  const capabilitySkipped = capabilityAck ? 0 : capabilityBlockedIds.size;
  /** 这一批真正会搬的:预检过、有目标机,且没被能力闸挡住(挡住的按跳过处理)。 */
  const isRunnable = (taskId: string) => preflights.has(taskId) && taskTargets.has(taskId)
    && (capabilityAck || !capabilityBlockedIds.has(taskId));
  const readyTasks = eligible.filter((task) => isRunnable(task.id));
  const needsBatchProject = !returnOnly;
  const projectOptions = returnOnly ? [] : firstProbe?.projects ?? [];
  const selectedProject = projectOptions.find((candidate) => candidate.id === projectId) ?? null;
  const fixedReturnProjectCount = new Set([...preflights.entries()].flatMap(([taskId, probe]) => {
    const task = eligible.find((candidate) => candidate.id === taskId);
    return task?.handoff?.direction === "in" && probe.taskScopedReturn
      ? probe.projects.slice(0, 1).map((candidate) => candidate.id)
      : [];
  })).size;
  const groupedResultFailures = useMemo(
    () => groupBulkHandoffFailures(result?.failures ?? []),
    [result],
  );
  const identityMismatch = identityNotice?.kind === "mismatch";
  // 身份核对通过又加密时不值得占两张卡：压成一行元信息，出问题才展开成警告。
  const peerQuiet = Boolean(firstProbe?.peer && firstProbe.peer.trust === "matched" && firstProbe.peer.encrypted);

  const confirm = () => {
    if (identityResolving || identityMismatch) return;
    if (result) { onClose(); return; }
    if (!firstProbe || blocked) {
      if (canProbeWithoutApproval && !blocked) void probeFirst();
      else void requestApproval();
      return;
    }
    if (!checkedAll) { void preflightAll(); return; }
    void run();
  };

  const confirmLabel = result
    // 卡在缺 key 时这批活并没有做完,主按钮不能写「完成」—— 往下走的入口是那个 key
    // 输入框,这颗只是「不补了,就到这儿」。
    ? peerKeyRequired ? "不补了，结束这批" : "完成"
    : identityResolving
      ? "正在核对来源机…"
    : identityMismatch
      ? "先核对目标机身份"
    : !firstProbe || blocked
      ? canProbeWithoutApproval && !blocked ? `重新检查${returnOnly ? "来源机" : "目标机"}` : blocked ? `检查${actionName}申请状态` : `发送${actionName}申请`
      : !checkedAll
        ? `${preflightFailures.length > 0 ? "重新检查" : "检查"} ${eligible.length} 个${actionName}任务`
        : `停止并${actionName} ${readyTasks.length} 个任务${
            preflightFailures.length + capabilitySkipped
              ? `（跳过 ${preflightFailures.length + capabilitySkipped} 个）`
              : ""
          }`;
  const message = result
    ? peerKeyRequired
      ? `已${actionName} ${result.successes.length} 个；另外 ${peerKeyBlocked.size} 个卡在「对端不认识你」，补上下面这把 key 就能接着搬，已经过去的不会再搬一次。`
      : `已完成批量${actionName}：成功 ${result.successes.length} 个，失败 ${result.failures.length} 个。`
    : returnOnly
      ? `把本机「${project.name}」项目中 ${eligible.length} 个正在跑的接入任务顺序移回「${target.name}」。`
      : `把本机「${project.name}」项目中 ${eligible.length} 个正在跑的任务顺序${actionName}到「${target.name}」。`;

  return createPortal(
    <div
      className="task-modal-scrim"
      ref={modalScrim}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && canClose) onClose(); }}
    >
      <section className="task-confirm-dialog handoff-dialog handoff-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <HandoffDialogHeader
          title={identityResolving
            ? `核对 ${target.name}`
            : identityMismatch ? `身份不匹配 · ${target.name}` : `${returnOnly ? "移回到" : "接力到"} ${target.name}`}
          disabled={!canClose}
          onClose={onClose}
        />
        {identityResolving ? (
          <div className="handoff-bulk-body">
            <div className="handoff-bulk-progress" role="status">
              <SpinnerGap size={15} className="is-spinning" aria-hidden="true" />
              <span>正在读取目标机公开身份；不会发送接力申请或任务信息…</span>
            </div>
            <p className="handoff-bulk-scope">弹窗已经打开，可随时取消；目标机离线时会在短暂超时后改用本地地址提示。</p>
          </div>
        ) : result ? (
          <div className="handoff-result-panel handoff-bulk-result">
            <span className={`handoff-result-mark${peerKeyRequired ? " is-warn" : ""}`} aria-hidden="true">
              {peerKeyRequired ? <Warning size={22} weight="bold" /> : <Check size={22} weight="bold" />}
            </span>
            <span className="handoff-eyebrow">{peerKeyRequired ? "BATCH PAUSED" : "BATCH COMPLETE"}</span>
            <h3>批量{actionName}{peerKeyRequired ? "没做完" : "已完成"}</h3>
            <p>{message}</p>
            <div className="handoff-result-facts">
              <span><b>{result.successes.length}</b> 个成功</span>
              <span><b>{result.failures.length}</b> 个失败</span>
              <span><b>{eligible.length}</b> 个任务</span>
            </div>
            {groupedResultFailures.length > 0 && (
              <ul className="handoff-bulk-failures">{groupedResultFailures.map(({ tasks: failedTasks, reason }) => (
                <li key={reason}><b>{failureTaskLabel(failedTasks)}</b><span>{reason}</span></li>
              ))}</ul>
            )}
            {/* 预检过了、打包阶段才发现对端不认识你(key 被停用/重置)。这批活差的只是
                一把 key,所以补填的入口必须也长在结果页上 —— 否则用户只看得到「已完成:
                成功 0 个」和一个「完成」按钮,没有任何能往下走的地方。 */}
            {peerKeyRequired && (
              <HandoffPeerKeyField
                url={target.url}
                hasKey={Boolean(target.hasKey)}
                mode="block"
                disabled={busy}
                saveLabel={`保存并${actionName}剩下的 ${peerKeyBlocked.size} 个`}
                notify={notify}
                onSaved={retryAfterKey}
              />
            )}
            {phase === "transferring" && (
              <div className="handoff-bulk-progress" role="status">
                <SpinnerGap size={15} className="is-spinning" aria-hidden="true" />
                <span>{`正在${actionName}剩下的任务 · ${(progress?.done ?? 0) + 1}/${progress?.total ?? 0}`}</span>
              </div>
            )}
          </div>
        ) : (
          <>
            <HandoffRouteCard
              sourcePath={`${project.name} · ${eligible.length} 个任务`}
              targetName={target.name}
              targetPath={returnOnly && fixedReturnProjectCount > 0
                ? checkedAll
                  ? `按任务归位 · ${fixedReturnProjectCount} 个原项目`
                  : "按任务归位 · 原项目待逐项确认"
                : selectedProject?.repoPath ?? target.url}
            />
            <div className="handoff-bulk-body">
        {identityNotice && (
          <p className="handoff-bulk-warning" role="alert">
            <Warning size={13} aria-hidden="true" />
            <span>{identityNotice.message}</span>
          </p>
        )}
        {eligible.length > 0 ? (
          <BulkHandoffTaskList
            tasks={eligible}
            preflights={preflights}
            failures={preflightFailures}
            activeTaskId={phase === "preflight" || phase === "transferring" ? progress?.taskId ?? null : null}
            transferring={phase === "transferring"}
            actionName={actionName}
            targetName={target.name}
          />
        ) : (
          <p className="handoff-bulk-warning">这个项目现在没有正在跑的任务可{actionName}。已经收工的任务留在本机就行；真要单独搬某一条，去它的任务详情用单任务接力。</p>
        )}
        {preflightFailures.length > 0 && (
          <p className="handoff-bulk-meta is-alert">{checkedAll
            ? `${preflightFailures.length} 个任务没通过检查，本次跳过；其余 ${readyTasks.length} 个照常${actionName}。`
            : `${preflightFailures.length} 个任务检查失败，原因见上面各行。处理后点“重新检查”。`}</p>
        )}
        {firstProbe && !blocked && needsBatchProject && (
          <label className="handoff-bulk-field">
            <span>目标项目（主机 {firstProbe.target.host}）</span>
            <select value={projectId} disabled={busy} onChange={(event) => { setProjectId(event.target.value); setCheckedAll(false); setPreflightFailures([]); }}>
              <option value="">选择目标项目</option>
              {projectOptions.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}（{candidate.repoPath}{candidate.isRepo ? "" : " · 非 git"}）</option>)}
            </select>
          </label>
        )}
        {firstProbe && !blocked && !needsBatchProject && (
          <div className="handoff-bulk-field handoff-bulk-project-fixed">
            <span>目标项目</span>
            <strong>每个任务将自动回到它在来源机上的原项目</strong>
          </div>
        )}
        {firstProbe && !blocked && (
          <label className="handoff-bulk-toggle">
            <input type="checkbox" checked={autoResume} disabled={busy} onChange={(event) => setAutoResume(event.target.checked)} />
            <span>{actionName}完成后在目标机自动续跑</span>
          </label>
        )}
        {checkedAll && capabilityGaps.length > 0 && (
          <HandoffCapabilityNotice
            capability={{
              status: "gaps",
              unknownReason: null,
              gaps: capabilityGaps,
              blocking: capabilityBlockedIds.size > 0,
            }}
            acknowledged={capabilityAck}
            onAcknowledge={setCapabilityAck}
            blockedCount={capabilityBlockedIds.size}
          />
        )}
        {notes.length > 0 && checkedAll && <ul className="handoff-bulk-notes">{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
        {blocked && <p className="handoff-bulk-warning">目标机尚未批准本机。请在目标机接受申请后，再点击“检查申请状态”。</p>}
        {error && <p className="handoff-bulk-error">{error}</p>}
        {peerKeyRequired && (
          <HandoffPeerKeyField
            url={target.url}
            hasKey={Boolean(target.hasKey)}
            mode="block"
            disabled={busy}
            saveLabel="保存并重新检查"
            notify={notify}
            onSaved={() => {
              setPeerKeyRequired(false);
              autoProbeAttempted.current = false;
              void probeFirst();
            }}
          />
        )}
        {(phase === "approval" || phase === "transferring") && (
          <div className="handoff-bulk-progress" role="status">
            <SpinnerGap size={15} className="is-spinning" aria-hidden="true" />
            <span>
              {phase === "approval"
                ? "正在联系目标机…"
                : `正在${actionName} · ${(progress?.done ?? 0) + 1}/${progress?.total ?? eligible.length}`}
            </span>
          </div>
        )}
        {approval && !firstProbe && <p className="handoff-bulk-peer"><Fingerprint size={13} aria-hidden="true" /><span>{approvalText(approval)}</span></p>}
        {peerQuiet ? (
          <p className="handoff-bulk-meta">
            <LockKey size={12} aria-hidden="true" />
            <span>目标机身份 {firstProbe!.peer!.short} 已核对，仓库和会话加密传输。</span>
          </p>
        ) : (
          <>
            {firstProbe?.peer ? (
              <p className={`handoff-bulk-peer${blocked ? " is-warn" : ""}`}>
                <Fingerprint size={13} aria-hidden="true" />
                <span>目标机身份 <b>{firstProbe.peer.short}</b>{firstProbe.peer.trust === "first-seen" ? "（第一次核对，请和对端设置页指纹比对）" : "（和已记住的身份一致）"}</span>
              </p>
            ) : firstProbe ? (
              <p className="handoff-bulk-peer is-warn"><Warning size={13} aria-hidden="true" /><span>目标机没有报出身份，无法核对对端是不是原来的机器，也无法加密；整个仓库和会话历史会明文传输。</span></p>
            ) : null}
            {firstProbe?.peer && !firstProbe.peer.encrypted && (
              <p className="handoff-bulk-peer is-warn">
                <Warning size={13} aria-hidden="true" />
                <span>这次会明文传输整个仓库和会话历史，同网段抓包可读取内容。</span>
              </p>
            )}
          </>
        )}
        {(eligible.length > 0 || skipped.length > 0) && (
          <p className="handoff-bulk-meta is-quiet">
            <span>
              {eligible.length > 0
                && `每个任务带走完整 CLI 会话、附件与可带走的 Git 状态，本机这份确认${actionName}后从列表消失。`}
              {skipped.length > 0 && ` 项目里另外 ${skipped.length} 个任务不参与本次${actionName}。`}
            </span>
          </p>
        )}
            </div>
          </>
        )}
        <footer>
          <button type="button" disabled={!canClose} onClick={onClose}>{result ? "关闭" : "取消"}</button>
          <button
            className="is-primary"
            type="button"
            disabled={identityResolving || identityMismatch || busy || (!result && (!eligible.length
              || (Boolean(firstProbe) && !blocked && needsBatchProject && !projectId)))}
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
