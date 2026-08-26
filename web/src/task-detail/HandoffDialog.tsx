import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  HandoffApprovalResult,
  HandoffExportResult,
  HandoffTarget,
  Task, TaskListItem,
  TaskHandoff,
} from "@ash/shared";
import { Fingerprint, PaperPlaneTilt, SpinnerGap, Warning } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api, ApiError, type TaskScopedHandoffPreflightResult } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { handoffTargetsForTask, nextUntriedHandoffTarget } from "./handoffTargetPolicy.ts";
import {
  HandoffDialogHeader,
  HandoffProgress,
  HandoffResultPanel,
  HandoffReviewGrid,
  HandoffRouteCard,
} from "./HandoffDialogViews.tsx";

// 任务接力对话框:选目标机 → 预检(探测对端、匹配项目、盘点可搬运的东西)→ 执行。
// 执行会先停掉正在跑的任务,再打包 git 分支和 CLI 会话文件推给对端,所以预检结果里
// 把「会先停任务」「能搬走多少」如实摆出来,让用户看清楚再按。
export function HandoffDialog({
  task,
  notify,
  onClose,
  onTaskUpdate,
  onOpenRemote,
}: {
  task: TaskListItem;
  notify: (message: string) => void;
  onClose: () => void;
  onTaskUpdate: (task: Task) => void;
  onOpenRemote: (task: TaskListItem, target: HandoffTarget) => void;
}) {
  const scrim = useRef<HTMLDivElement>(null);
  // out+pending = 上次接力应答丢失,这次打开对话框是「原样重放收口」:目标机、对端项目、
  // autoResume 一律沿用 pending 标记冻结的第一次参数(服务端同样硬校验,换参数 409)。
  // 换 transferId 重发会把同一任务复制到多台机器——要换目标,先在横幅上移除接力标记。
  const pendingHandoff = task.handoff?.direction === "out" && task.handoff.pending ? task.handoff : null;
  const inboundHandoff = task.handoff?.direction === "in" ? task.handoff : null;
  const pendingReturn = pendingHandoff
    && Object.prototype.hasOwnProperty.call(pendingHandoff, "returnTransferId") ? pendingHandoff : null;
  const returningHandoff = inboundHandoff ?? pendingReturn;
  const actionName = returningHandoff ? "移回" : "接力";
  // null = 设置还没读回来;[] = 读回来了但一个目标都没配过。
  const [targets, setTargets] = useState<HandoffTarget[] | null>(null);
  const [targetUrl, setTargetUrl] = useState("");
  const [preflight, setPreflight] = useState<TaskScopedHandoffPreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [autoResume, setAutoResume] = useState(pendingHandoff?.autoResume ?? true);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [approval, setApproval] = useState<HandoffApprovalResult | null>(null);
  const [draftTargetName, setDraftTargetName] = useState("");
  const [draftTargetUrl, setDraftTargetUrl] = useState("");
  const [result, setResult] = useState<HandoffExportResult | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const attemptedReturnTargets = useRef(new Set<string>());
  const automaticReturnFallback = useRef(true);

  useDismissable({ enabled: !busy, containerRef: scrim, onClose });

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.settings(),
      inboundHandoff ? api.handoffReturnTarget(task.id).catch(() => null) : Promise.resolve(null),
    ])
      .then(([settings, automaticReturnTarget]) => {
        if (!alive) return;
        const available = pendingReturn?.peerUrl
          ? [{
              name: pendingReturn.peerName ?? pendingReturn.peerUrl,
              url: pendingReturn.peerUrl,
              peerFp: pendingReturn.peerFp,
            }]
          : handoffTargetsForTask(settings.handoffTargets, inboundHandoff, automaticReturnTarget);
        setTargets(available);
        attemptedReturnTargets.current.clear();
        automaticReturnFallback.current = true;
        if (pendingHandoff?.peerUrl) setTargetUrl(pendingHandoff.peerUrl);
        else if (available[0]) setTargetUrl(available[0].url);
      })
      .catch((reason) => {
        if (!alive) return;
        setTargets([]);
        notify(reason instanceof Error ? reason.message : "接力目标读取失败");
      });
    return () => { alive = false; };
    // 接力标记只取对话框打开那一刻的值,任务更新不重读设置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify]);

  const target = targets?.find((item) => item.url === targetUrl) ?? null;
  const shouldAutoPreflight = Boolean(target?.peerFp || pendingHandoff);

  // 从未申请过的目标停在显式「申请接力」；已经记住身份的目标说明用户至少明确申请过
  // 一次，重开对话框可以直接检查审批状态并预检，避免日常接力每次都重复点申请。
  useEffect(() => {
    let alive = true;
    setApplying(false);
    setPreflight(null);
    setPreflightError(null);
    setProjectId("");
    setApproval(null);
    if (!targetUrl || !shouldAutoPreflight) return () => { alive = false; };
    setApplying(true);
    api.handoffPreflight(task.id, targetUrl)
      .then((probe) => {
        if (!alive) return;
        setPreflight(probe);
        setProjectId(pendingHandoff?.targetProjectId ?? probe.suggestedProjectId ?? probe.projects[0]?.id ?? "");
      })
      .catch((reason) => {
        if (!alive) return;
        attemptedReturnTargets.current.add(normalizedHandoffUrl(targetUrl));
        const fallback = inboundHandoff && !pendingHandoff && automaticReturnFallback.current
          ? nextUntriedHandoffTarget(targets ?? [], attemptedReturnTargets.current)
          : null;
        if (fallback) {
          const failedCount = attemptedReturnTargets.current.size;
          setFallbackNotice(failedCount === 1
            ? `来源机原地址不可达，已自动改用「${fallback.name}」（${fallback.url}）继续检查。`
            : `已有 ${failedCount} 个来源机地址不可达，已自动改用「${fallback.name}」（${fallback.url}）继续检查。`);
          setTargetUrl(fallback.url);
          return;
        }
        setPreflightError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (alive) setApplying(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoPreflight, targetUrl, task.id]);

  // 重放收口时冻结的目标机可能已经不在设置列表里(被删过),补一个选项让它仍可见可选。
  const targetOptions = pendingHandoff?.peerUrl && !(targets ?? []).some((item) => item.url === pendingHandoff.peerUrl)
    ? [{ name: pendingHandoff.peerName ?? pendingHandoff.peerUrl, url: pendingHandoff.peerUrl }, ...(targets ?? [])]
    : targets ?? [];
  const missingFiles = preflight ? preflight.local.sessions - preflight.local.sessionFilesFound : 0;
  const selectedProject = preflight?.projects.find((project) => project.id === projectId) ?? null;
  // 对端还没批准本机(或已拒绝):后端在打包前也会 409,这里先把按钮按住,省掉一次白等。
  const blockedByPeer = preflight?.peer?.peerStatus === "pending" || preflight?.peer?.peerStatus === "blocked";

  const addTarget = async () => {
    const name = draftTargetName.trim();
    const url = draftTargetUrl.trim().replace(/\/+$/, "");
    if (!name || !HANDOFF_URL_RE.test(url) || busy) return;
    setBusy(true);
    try {
      const settings = await api.settings();
      if (settings.handoffTargets.some((item) => item.url.replace(/\/+$/, "") === url)) {
        throw new Error("这个远程主机地址已经添加过了");
      }
      const next = await api.patchSettings({ handoffTargets: [...settings.handoffTargets, { name, url }] });
      setTargets(next.handoffTargets);
      setTargetUrl(url);
      setDraftTargetName("");
      setDraftTargetUrl("");
      notify("远程主机已添加，请发送接力申请");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "远程主机添加失败");
    } finally {
      setBusy(false);
    }
  };

  const manualReturnUrl = () => {
    const url = draftTargetUrl.trim().replace(/\/+$/, "");
    return inboundHandoff?.peerFp && HANDOFF_URL_RE.test(url) ? url : null;
  };

  const useManualReturnTarget = () => {
    const url = manualReturnUrl();
    if (!url || !inboundHandoff?.peerFp || busy) return;
    // 只把用户补的地址留在当前弹窗里，不写入整机设置。真正预检仍从任务 marker 取
    // peerFp 做身份核对，所以换一个地址不会把任务转送给第三台机器。
    setTargets([{
      name: inboundHandoff.peerName || "来源机器",
      url,
      peerFp: inboundHandoff.peerFp,
    }]);
    automaticReturnFallback.current = false;
    attemptedReturnTargets.current.clear();
    setFallbackNotice(null);
    setTargetUrl(url);
  };

  const manualReturnTargetFields = inboundHandoff?.peerFp ? (
    <>
      <label htmlFor="handoff-return-source-url">来源机 ash 地址</label>
      <input
        id="handoff-return-source-url"
        value={draftTargetUrl}
        disabled={busy}
        placeholder={targetUrl || "http://mac-mini.local:4317"}
        onChange={(event) => setDraftTargetUrl(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") useManualReturnTarget(); }}
      />
      <small>仅用于这次移回，不会新增整机信任；连接后仍必须与任务记录的来源指纹一致。</small>
      <Button
        variant="secondary"
        disabled={busy || !HANDOFF_URL_RE.test(draftTargetUrl.trim())}
        onClick={useManualReturnTarget}
      >
        检查来源机
      </Button>
    </>
  ) : (
    <p className="handoff-error">
      <Warning size={13} aria-hidden="true" />
      这条旧记录没有来源机指纹，无法安全判断该移回哪台机器。请从来源机重新接力一次。
    </p>
  );

  const requestApproval = async () => {
    if (!targetUrl || busy) return;
    setBusy(true);
    setApplying(true);
    setPreflight(null);
    setPreflightError(null);
    setProjectId("");
    try {
      const requestResult = await api.requestHandoffApproval(targetUrl);
      setApproval(requestResult);
      const status = requestResult.peer?.peerStatus;
      if (status === "pending") {
        notify("接力申请已发送，请等待对方接受申请后再接力");
        return;
      }
      if (status === "blocked") {
        notify("对方已拒绝这台机器的接力申请");
        return;
      }
      const probe = await api.handoffPreflight(task.id, targetUrl);
      setPreflight(probe);
      setProjectId(pendingHandoff?.targetProjectId ?? probe.suggestedProjectId ?? probe.projects[0]?.id ?? "");
      notify(status === "approved" ? "对方已接受申请，可以选择项目并接力" : "目标机已就绪，可以继续接力");
    } catch (reason) {
      setPreflightError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApplying(false);
      setBusy(false);
    }
  };

  const checkTarget = async () => {
    const drafted = manualReturnUrl();
    if (drafted && normalizedHandoffUrl(drafted) !== normalizedHandoffUrl(targetUrl)) {
      useManualReturnTarget();
      return;
    }
    if (!targetUrl || busy) return;
    setBusy(true);
    setApplying(true);
    setPreflight(null);
    setPreflightError(null);
    setProjectId("");
    try {
      const probe = await api.handoffPreflight(task.id, targetUrl);
      setPreflight(probe);
      setProjectId(pendingHandoff?.targetProjectId ?? probe.suggestedProjectId ?? probe.projects[0]?.id ?? "");
    } catch (reason) {
      setPreflightError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApplying(false);
      setBusy(false);
    }
  };

  const run = async () => {
    if (!projectId || busy) return;
    setBusy(true);
    setTransferring(true);
    try {
      const exported = await api.handoffTask(task.id, {
        targetUrl,
        targetProjectId: projectId,
        ...(target?.name ? { targetName: target.name } : {}),
        autoResume,
      });
      setResult(exported);
      // 接力已落持久标记(task.handoff)、状态也停成了终态——拉回最新任务刷新横幅和按钮。
      try {
        onTaskUpdate(await api.task(task.id));
      } catch {
        // 刷新失败不挡结果展示,SSE 大概率也会把更新推过来。
      }
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      // 网络类失败会在本机留下“送达未确认”的 pending 标记——照样拉回任务,
      // 让横幅立刻可见,用户按横幅上的指引重试或移除。
      try {
        onTaskUpdate(await api.task(task.id));
      } catch {
        // SSE 大概率也会把更新推过来。
      }
    } finally {
      setTransferring(false);
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="task-modal-scrim"
      ref={scrim}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="task-confirm-dialog handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <HandoffDialogHeader
          title={returningHandoff ? "移回来源机器" : "移动这个任务"}
          disabled={busy}
          onClose={onClose}
        />
        {result ? (
          <HandoffResultPanel
            result={result}
            returning={Boolean(returningHandoff)}
            targetName={target?.name ?? "对端"}
            onOpenRemote={!returningHandoff && target ? () => {
                  onClose();
                  onOpenRemote(task, target);
                } : null}
          />
        ) : transferring ? (
          <HandoffProgress targetName={target?.name ?? preflight?.target.host ?? "目标机器"} returning={Boolean(returningHandoff)} />
        ) : inboundHandoff && targets && targets.length === 0 ? (
          <div className="handoff-quick-add">
            <p>
              无法自动定位来源机器{inboundHandoff.peerName ? `「${inboundHandoff.peerName}」` : ""}的可回连地址。
              旧接力记录没有保存端口，请填写来源机当前的 ash 地址。
            </p>
            {manualReturnTargetFields}
          </div>
        ) : targets && targets.length === 0 && !pendingHandoff ? (
          <div className="handoff-quick-add">
            <p>还没有远程主机。在这里直接添加，保存后再向对方发送接力申请。</p>
            <label htmlFor="handoff-new-target-name">远程主机名称</label>
            <input
              id="handoff-new-target-name"
              value={draftTargetName}
              disabled={busy}
              placeholder="如 家里的台式机"
              onChange={(event) => setDraftTargetName(event.target.value)}
            />
            <label htmlFor="handoff-new-target-url">ash 地址</label>
            <input
              id="handoff-new-target-url"
              value={draftTargetUrl}
              disabled={busy}
              placeholder="http://192.168.1.50:4317"
              onChange={(event) => setDraftTargetUrl(event.target.value)}
            />
            <Button
              variant="primary"
              disabled={busy || !draftTargetName.trim() || !HANDOFF_URL_RE.test(draftTargetUrl.trim())}
              onClick={() => void addTarget()}
            >
              添加远程主机
            </Button>
          </div>
        ) : (
          <>
            <p>
              {returningHandoff
                ? "把这个任务连同 git 分支、CLI 会话历史移回最初交出它的机器。目标已按来源机指纹锁定，不能转送到第三台机器。"
                : "把这个任务连同 git 分支、CLI 会话历史整体迁到另一台 ash 上继续跑。"}
              {preflight?.local.running ? "任务正在运行,接力会先把它停下来。" : ""}
            </p>
            {pendingHandoff && (
              <p className="handoff-error">
                <Warning size={13} aria-hidden="true" />
                {pendingReturn
                  ? "上次移回没收到确认，这次会按同一来源机、原项目和续跑选项原样重放。若要放弃本次移回，请先关闭弹窗并使用横幅上的“核验后在本机继续”；系统会先确认原机尚未接回任务。"
                  : "上次接力没收到确认，这次会按同一目标机、项目和续跑选项原样重放。若要放弃本次接力，请先关闭弹窗并使用横幅上的“核验后在本机继续”；系统会先确认对端尚未收到任务。"}
              </p>
            )}
            <div className="handoff-field">
              <label htmlFor="handoff-target">{returningHandoff ? "来源机器" : "目标机器"}</label>
              <select
                id="handoff-target"
                value={targetUrl}
                disabled={busy || targets === null || !!pendingHandoff}
                onChange={(event) => {
                  automaticReturnFallback.current = false;
                  attemptedReturnTargets.current.clear();
                  setFallbackNotice(null);
                  setTargetUrl(event.target.value);
                }}
              >
                {targetOptions.map((item) => (
                  <option key={item.url} value={item.url}>{item.name}（{item.url}）</option>
                ))}
              </select>
            </div>
            {approval && !preflight && (
              <p className={`handoff-peer-line${approval.peer?.peerStatus === "pending" || approval.peer?.peerStatus === "blocked" ? " is-warn" : ""}`}>
                <Fingerprint size={13} aria-hidden="true" />
                <span>{approvalMessage(approval)}</span>
              </p>
            )}
            {preflightError && (
              <p className="handoff-error"><Warning size={13} aria-hidden="true" />预检失败:{preflightError}</p>
            )}
            {fallbackNotice && (
              <p className="handoff-peer-line is-warn"><Warning size={13} aria-hidden="true" /><span>{fallbackNotice}</span></p>
            )}
            {inboundHandoff && returnAddressMayHelp(preflightError) && (
              <div className="handoff-quick-add handoff-return-override">
                <p>如果来源机地址已经变化，可在这里临时改用当前地址。</p>
                {manualReturnTargetFields}
              </div>
            )}
            {applying && targetUrl && (
              <p className="handoff-probing"><SpinnerGap size={13} className="is-spinning" aria-hidden="true" />正在探测对端…</p>
            )}
            {preflight && (
              <>
                <HandoffRouteCard
                  sourcePath="当前任务工作区"
                  targetName={target?.name ?? preflight.target.host}
                  targetPath={selectedProject?.repoPath ?? "选择目标项目"}
                />
                {preflight.peer ? (
                  <p className={`handoff-peer-line${preflight.peer.peerStatus === "pending" || preflight.peer.peerStatus === "blocked" ? " is-warn" : ""}`}>
                    <Fingerprint size={13} aria-hidden="true" />
                    <span>
                      目标机身份 <b>{preflight.peer.short}</b>
                      {preflight.peer.trust === "first-seen"
                        ? "（第一次核对这台机器：和对端设置页上的指纹对一下，明确申请后本机会记住它）"
                        : returningHandoff && preflight.taskScopedReturn
                          ? "（与这条任务接入时记录的来源指纹一致，无需重复审批）"
                          : returningHandoff
                            ? "（与这条任务接入时记录的来源指纹一致；原机存档不可用，本次按普通接力审批）"
                            : "（和上次记住的一致）"}
                      {preflight.peer.peerStatus === "pending"
                        ? "。申请已送达，等待对方接受后再接力。"
                        : preflight.peer.peerStatus === "blocked"
                          ? "。对端把本机列为已拒绝的接力来源。"
                          : ""}
                    </span>
                  </p>
                ) : (
                  <p className="handoff-peer-line is-warn">
                    <Warning size={13} aria-hidden="true" />
                    <span>目标机没有报出身份（版本过旧），这次接力无法核对「对面是不是原来那台机器」。</span>
                  </p>
                )}
                {preflight.peer && !preflight.peer.encrypted && (
                  <p className="handoff-peer-line is-warn">
                    <Warning size={13} aria-hidden="true" />
                    <span>
                      这次<b>明文传输</b>
                      {preflight.peer.canEncrypt
                        ? "（本机在「设置 → 默认规则 → 接力传输加密」里关掉了加密）"
                        : "（目标机版本过旧，收不了加密载荷）"}
                      。同网段抓包能读到整个仓库和会话历史。
                    </span>
                  </p>
                )}
                <div className="handoff-field">
                  <label htmlFor="handoff-project">对端项目（主机 {preflight.target.host}）</label>
                  <select
                    id="handoff-project"
                    value={projectId}
                    disabled={busy || !!pendingHandoff?.targetProjectId}
                    onChange={(event) => setProjectId(event.target.value)}
                  >
                    <option value="">选择任务要落到的项目…</option>
                    {pendingHandoff?.targetProjectId
                      && !preflight.projects.some((project) => project.id === pendingHandoff.targetProjectId)
                      && (
                        <option value={pendingHandoff.targetProjectId}>
                          上次接力的项目（{pendingHandoff.targetProjectId}）
                        </option>
                      )}
                    {preflight.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}（{project.repoPath}{project.isRepo ? "" : " · 非 git"}）
                      </option>
                    ))}
                  </select>
                </div>
                <HandoffReviewGrid
                  project={selectedProject}
                  sessions={preflight.local.sessionFilesFound}
                  uploads={preflight.local.uploads}
                  git={preflight.local.git}
                  autoResume={autoResume}
                  returning={Boolean(returningHandoff)}
                />
                {(missingFiles > 0 || preflight.local.uploads > 0 || preflight.local.pendingMessages > 0 || preflight.local.schedule) && (
                  <ul className="handoff-summary">
                    {missingFiles > 0 && <li>{missingFiles} 个 CLI 会话找不到文件，到目标机后会全新起跑</li>}
                    {preflight.local.uploads > 0 && (
                      <li>附件中的本机绝对路径会自动改写为目标机路径</li>
                    )}
                    {preflight.local.pendingMessages > 0 && (
                      <li>待发送消息 {preflight.local.pendingMessages} 条随任务迁移,到期后在对端投递;本机的原件会取消并留档在时间线</li>
                    )}
                    {preflight.local.schedule && (
                      <li>定时计划({preflight.local.schedule === "cron" ? "周期" : "一次性"})随任务迁移,今后由对端触发</li>
                    )}
                  </ul>
                )}
                {preflight.local.notes.length > 0 && (
                  <ul className="handoff-notes">
                    {preflight.local.notes.map((note) => <li key={note}>{note}</li>)}
                  </ul>
                )}
                <label className="handoff-check">
                  <input
                    type="checkbox"
                    checked={autoResume}
                    disabled={busy || pendingHandoff?.autoResume !== undefined}
                    onChange={(event) => setAutoResume(event.target.checked)}
                  />
                  导入完成后在对端立即续跑
                </label>
              </>
            )}
          </>
        )}
        {!transferring && <footer>
          <button type="button" disabled={busy} onClick={onClose}>{result ? "关闭" : "取消"}</button>
          {!result && targetOptions.length > 0 && (
            <button
              className="is-primary"
              type="button"
              disabled={busy || applying || !targetUrl || (!!preflight && !blockedByPeer && !projectId)}
              onClick={() => void (preflight && !blockedByPeer ? run() : target?.peerFp ? checkTarget() : requestApproval())}
            >
              {applying
                ? target?.peerFp ? `正在检查${returningHandoff ? "来源机" : "目标机"}…` : `正在发送${actionName}申请…`
                : busy
                ? `${actionName}中…(打包并传输,可能要一会儿)`
                : !preflight || blockedByPeer
                  ? approval?.peer?.peerStatus === "pending" || approval?.peer?.peerStatus === "blocked" || blockedByPeer
                    ? `检查${actionName}申请状态`
                    : target?.peerFp ? `重新检查${inboundHandoff ? "来源机" : "目标机"}` : `申请${actionName}`
                  : pendingHandoff
                    ? "原样重发,幂等收口"
                    : preflight?.local.running
                      ? `停止并${actionName}`
                      : `开始${actionName}`}
            </button>
          )}
        </footer>}
      </section>
    </div>,
    document.body,
  );
}

const HANDOFF_URL_RE = /^https?:\/\/\S+$/;
const normalizedHandoffUrl = (url: string) => url.trim().replace(/\/+$/, "");
const forceHandoffReason = (reason: unknown): string | null => {
  if (!(reason instanceof ApiError) || typeof reason.body !== "object" || reason.body === null) return null;
  return "needsForce" in reason.body && reason.body.needsForce === true ? reason.message : null;
};
const returnAddressMayHelp = (message: string | null) => Boolean(message && (
  /连不上对端|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|连接中断|超时/i.test(message)
  || /身份和上次不一样|没有报出身份/.test(message)
));

const approvalMessage = (result: HandoffApprovalResult) => {
  const identity = result.peer ? `目标机身份 ${result.peer.short}。` : "目标机没有提供可核对的身份。";
  const status = result.peer?.peerStatus;
  if (status === "pending") return `${identity}申请已发送，必须等对方接受后才可以接力。`;
  if (status === "approved") return `${identity}对方已经接受申请。`;
  if (status === "open") return `${identity}对方没有开启接力审批，可以继续。`;
  if (status === "blocked") return `${identity}对方已拒绝这台机器的申请。`;
  return `${identity}目标机版本过旧，无法确认申请状态。`;
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
