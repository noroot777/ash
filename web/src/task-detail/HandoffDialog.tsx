import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  HandoffApprovalResult,
  HandoffExportResult,
  HandoffTarget,
  Task, TaskListItem,
} from "@ash/shared";
import { needsPeerKey } from "@ash/shared/handoff";
import { isAcceptedStage } from "@ash/shared";
import { Fingerprint, SpinnerGap, Warning } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api, ApiError, type TaskScopedHandoffPreflightResult } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { HandoffPeerKeyField } from "../settings/HandoffPeerKeyField.tsx";
import { handoffTargetsForTask, nextUntriedHandoffTarget } from "./handoffTargetPolicy.ts";
import { HandoffReturnView, type HandoffReturnPhase } from "./HandoffReturnView.tsx";
import { HandoffCapabilityNotice } from "./HandoffCapabilityNotice.tsx";
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
  // null = 设置还没读回来;[] = 读回来了但一个目标都没配过。
  const [targets, setTargets] = useState<HandoffTarget[] | null>(null);
  const [targetUrl, setTargetUrl] = useState("");
  const [preflight, setPreflight] = useState<TaskScopedHandoffPreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  // 这次失败是不是「对端是多人实例但不认识你」。是的话就地给一个输入框把 key 补上,
  // 别再把人支去设置页 —— 自用模式的设置页里以前根本没有这个输入框(本任务的起因)。
  const [peerKeyRequired, setPeerKeyRequired] = useState(false);
  const [projectId, setProjectId] = useState("");
  // 已验收的任务到了对面也不会自己跑起来（服务端硬闸在 handoff-import：续跑会把验收章
  // 连同合并快照整套摘掉）。所以这里默认不勾、也不让勾 —— 留一个勾了不生效的框，只会让
  // 人以为「我明明勾了」。pending 重放那一档仍以冻结的第一次参数为准。
  const accepted = isAcceptedStage(task.stage);
  const [autoResume, setAutoResume] = useState(pendingHandoff?.autoResume ?? !accepted);
  const autoResumeLocked = pendingHandoff?.autoResume !== undefined || accepted;
  const [busy, setBusy] = useState(false);
  // 能力握手拦下时(目标机没装任务要用的智能体),用户明确勾过「仍然接力」没有。
  // 每次重新预检都清掉 —— 换了目标机之后,上一台的确认不该继续替这一台背书。
  const [capabilityAck, setCapabilityAck] = useState(false);
  const [applying, setApplying] = useState(false);
  const [approval, setApproval] = useState<HandoffApprovalResult | null>(null);
  const [draftTargetName, setDraftTargetName] = useState("");
  const [draftTargetUrl, setDraftTargetUrl] = useState("");
  const [result, setResult] = useState<HandoffExportResult | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  // 「重新检查」要连地址发现一起重来:来源机可能刚开机,或用户刚在设置里改了地址。
  const [reloadKey, setReloadKey] = useState(0);
  const attemptedReturnTargets = useRef(new Set<string>());
  const automaticReturnFallback = useRef(true);

  useDismissable({ enabled: !busy, containerRef: scrim, onClose });

  useEffect(() => {
    let alive = true;
    // 清单一律走 `/handoff/targets`,不读 `GET /settings` 里那份:多人模式下目标机是
    // **按人**存的(app_settings 那份是自用模式的公共清单,多人实例里通常是空的),而且
    // 只有这条路会报 hasKey —— 预检被「对端不认识你」拦下时,要靠它说清是「还没配 key」
    // 还是「配了但对端不认」。
    Promise.all([
      api.handoffTargets(),
      inboundHandoff ? api.handoffReturnTarget(task.id).catch(() => null) : Promise.resolve(null),
    ])
      .then(([known, automaticReturnTarget]) => {
        if (!alive) return;
        const available = pendingReturn?.peerUrl
          ? [{
              name: pendingReturn.peerName ?? pendingReturn.peerUrl,
              url: pendingReturn.peerUrl,
              peerFp: pendingReturn.peerFp,
            }]
          : handoffTargetsForTask(known, inboundHandoff, automaticReturnTarget);
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
  }, [notify, reloadKey]);

  const target = targets?.find((item) => item.url === targetUrl) ?? null;
  const shouldAutoPreflight = Boolean(target?.peerFp || pendingHandoff);

  // 失败收口:文案照旧显示,另外记下服务端给的机器可读原因(应答体里的 code)。
  // 「缺对端账号 key」是唯一一种**当场就能修好**的失败,所以它要能变成一个输入框,
  // 而不是一句让人去别处找的话。
  const failWith = (reason: unknown) => {
    setPreflightError(reason instanceof Error ? reason.message : String(reason));
    setPeerKeyRequired(needsPeerKey(reason instanceof ApiError ? reason.body : null));
  };

  // 从未申请过的目标停在显式「申请接力」；已经记住身份的目标说明用户至少明确申请过
  // 一次，重开对话框可以直接检查审批状态并预检，避免日常接力每次都重复点申请。
  useEffect(() => {
    let alive = true;
    setApplying(false);
    setPreflight(null);
    setPreflightError(null);
    setPeerKeyRequired(false);
    setCapabilityAck(false);
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
        failWith(reason);
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
  // 能力握手拦住且用户还没勾「仍然接力」。收口重试(pendingHandoff)不受这道闸约束 ——
  // 服务端同样放行:那时对端可能已经导入成功了,拦住只会把任务永远钉在 pending 上。
  const blockedByCapability = Boolean(
    preflight?.capability?.blocking && !capabilityAck && !pendingHandoff,
  );
  // 移回只有三种状态:还在找来源机 / 找到了可以按确认 / 连不上。中间的选择项一个都没有。
  const returnPhase: HandoffReturnPhase = preflight
    ? "ready"
    : preflightError || (targets !== null && targets.length === 0)
      ? "unreachable"
      : "locating";
  const returnNotes = preflight
    ? [
        ...(missingFiles > 0 ? [`${missingFiles} 个 CLI 会话找不到文件，回到来源机后会全新起跑`] : []),
        ...(preflight.local.pendingMessages > 0
          ? [`待发送消息 ${preflight.local.pendingMessages} 条随任务移回，本机原件会取消并留档`] : []),
        ...(preflight.local.schedule ? ["定时计划随任务移回，今后由来源机触发"] : []),
        ...(blockedByPeer ? ["来源机还没批准本机（或已拒绝），需要先在它的「接力来源」里放行"] : []),
        ...(!projectId ? ["来源机没有报出这条任务的原项目，暂时无法移回"] : []),
        ...preflight.local.notes,
      ]
    : [];
  const returnReady = returnPhase === "ready" && !blockedByPeer && !blockedByCapability && Boolean(projectId);

  const addTarget = async () => {
    const name = draftTargetName.trim();
    const url = draftTargetUrl.trim().replace(/\/+$/, "");
    if (!name || !HANDOFF_URL_RE.test(url) || busy) return;
    setBusy(true);
    try {
      // 走 `/handoff/targets` 而不是 PATCH /settings:多人模式下清单按人存,那条路会被
      // 直接 403 拒掉(凭证不能进那份会整份吐回前端的设置)。
      const known = await api.handoffTargets();
      if (known.some((item) => item.url.replace(/\/+$/, "") === url)) {
        throw new Error("这个远程主机地址已经添加过了");
      }
      setTargets(await api.addHandoffTarget({ name, url }));
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

  // 移回没有「填地址」这一步:地址由服务端按来源指纹探,探不到就重来一次,而不是
  // 把一个输入框推给用户——他手上并不比系统多知道什么。
  const relocateReturnTarget = () => {
    if (busy) return;
    setTargets(null);
    setTargetUrl("");
    setPreflight(null);
    setPreflightError(null);
    setFallbackNotice(null);
    setCapabilityAck(false);
    attemptedReturnTargets.current.clear();
    automaticReturnFallback.current = true;
    setReloadKey((key) => key + 1);
  };

  const requestApproval = async () => {
    if (!targetUrl || busy) return;
    setBusy(true);
    setApplying(true);
    setPreflight(null);
    setPreflightError(null);
    setPeerKeyRequired(false);
    setCapabilityAck(false);
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
      failWith(reason);
    } finally {
      setApplying(false);
      setBusy(false);
    }
  };

  const checkTarget = async () => {
    if (!targetUrl || busy) return;
    setBusy(true);
    setApplying(true);
    setPreflight(null);
    setPreflightError(null);
    setPeerKeyRequired(false);
    setCapabilityAck(false);
    setProjectId("");
    try {
      const probe = await api.handoffPreflight(task.id, targetUrl);
      setPreflight(probe);
      setProjectId(pendingHandoff?.targetProjectId ?? probe.suggestedProjectId ?? probe.projects[0]?.id ?? "");
    } catch (reason) {
      failWith(reason);
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
        ...(capabilityAck ? { ignoreCapabilityGaps: true } : {}),
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
      // 打包阶段也可能撞上「对端不认识你」(key 被对端重置/停用了):同样在这里给出
      // 补 key 的入口,不然用户只剩一句 toast,还是不知道去哪儿改。
      setPeerKeyRequired(needsPeerKey(reason instanceof ApiError ? reason.body : null));
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
        ) : returningHandoff ? (
          <>
            <HandoffReturnView
              phase={returnPhase}
              fallbackNotice={fallbackNotice}
              peerName={returningHandoff.peerName ? `「${returningHandoff.peerName}」` : "最初交出它的机器"}
              peerUrl={targetUrl || null}
              peer={preflight?.peer ?? null}
              taskScopedReturn={Boolean(preflight?.taskScopedReturn)}
              running={Boolean(preflight?.local.running)}
              notes={returnNotes}
              errorMessage={preflightError ?? "没有找到它现在的地址。"}
              identityMissing={!returningHandoff.peerFp}
              autoResume={autoResume}
              autoResumeLocked={autoResumeLocked}
              accepted={accepted}
              replay={Boolean(pendingReturn)}
              busy={busy}
              onAutoResumeChange={setAutoResume}
            />
            {/* 移回同样要过能力握手:任务在本机可能已经换过智能体,原机未必有它 ——
                「回原机」不天然意味着原机跑得动它现在这副样子。 */}
            <HandoffCapabilityNotice
              capability={preflight?.capability}
              acknowledged={capabilityAck}
              onAcknowledge={setCapabilityAck}
            />
            {/* 移回同样会撞上「来源机是多人实例但不认识你」——地址是系统探出来的,可 key
                只有人能填,所以这条路上也要有输入框。 */}
            {peerKeyRequired && targetUrl && (
              <HandoffPeerKeyField
                url={targetUrl}
                hasKey={Boolean(target?.hasKey)}
                mode="block"
                disabled={busy || applying}
                saveLabel="保存并重新检查"
                notify={notify}
                onSaved={(next) => {
                  setTargets(next);
                  setPeerKeyRequired(false);
                  void checkTarget();
                }}
              />
            )}
          </>
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
            {/* 移回时服务端可能要按指纹探几个候选地址才知道来源机在哪，别让下拉空着干等。 */}
            {targets === null && (
              <p className="handoff-probing">
                <SpinnerGap size={13} className="is-spinning" aria-hidden="true" />
                {returningHandoff ? "正在定位来源机器…" : "正在读取远程主机…"}
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
            {/* 「对端是多人实例但不认识你」是唯一一种当场能修好的失败:填一把 key 就继续,
                不用关掉对话框跑去设置页(自用模式的设置页里以前也没有这个输入框)。 */}
            {peerKeyRequired && targetUrl && (
              <HandoffPeerKeyField
                url={targetUrl}
                hasKey={Boolean(target?.hasKey)}
                mode="block"
                disabled={busy || applying}
                saveLabel="保存并重新检查"
                notify={notify}
                onSaved={(next) => {
                  setTargets(next);
                  setPeerKeyRequired(false);
                  void checkTarget();
                }}
              />
            )}
            {fallbackNotice && (
              <p className="handoff-peer-line is-warn"><Warning size={13} aria-hidden="true" /><span>{fallbackNotice}</span></p>
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
                <HandoffCapabilityNotice
                  capability={preflight.capability}
                  acknowledged={capabilityAck}
                  onAcknowledge={setCapabilityAck}
                />
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
                    disabled={busy || autoResumeLocked}
                    onChange={(event) => setAutoResume(event.target.checked)}
                  />
                  导入完成后在对端立即续跑
                </label>
                {accepted && (
                  <p className="handoff-peer-line">
                    <Warning size={13} aria-hidden="true" />
                    <span>任务已验收，到对端不会自动续跑 —— 续跑会把验收结论和合并快照整套摘掉。</span>
                  </p>
                )}
              </>
            )}
          </>
        )}
        {!transferring && <footer>
          <button type="button" disabled={busy} onClick={onClose}>{result ? "关闭" : "取消"}</button>
          {!result && returningHandoff && returningHandoff.peerFp && (
            <button
              className="is-primary"
              type="button"
              disabled={busy || returnPhase === "locating" || (returnPhase === "ready" && !returnReady)}
              onClick={() => void (returnReady ? run() : relocateReturnTarget())}
            >
              {busy
                ? "移回中…(打包并传输,可能要一会儿)"
                : returnPhase === "locating"
                  ? "正在联系来源机…"
                  : returnPhase === "unreachable"
                    ? "重新检查"
                    : pendingReturn
                      ? "原样重发,幂等收口"
                      : preflight?.local.running
                        ? "停止并移回"
                        : "确认移回"}
            </button>
          )}
          {!result && !returningHandoff && targetOptions.length > 0 && (
            <button
              className="is-primary"
              type="button"
              disabled={busy || applying || !targetUrl || (!!preflight && !blockedByPeer && !projectId) || blockedByCapability}
              onClick={() => void (preflight && !blockedByPeer ? run() : target?.peerFp ? checkTarget() : requestApproval())}
            >
              {applying
                ? target?.peerFp ? "正在检查目标机…" : "正在发送接力申请…"
                : busy
                ? "接力中…(打包并传输,可能要一会儿)"
                : !preflight || blockedByPeer
                  ? approval?.peer?.peerStatus === "pending" || approval?.peer?.peerStatus === "blocked" || blockedByPeer
                    ? "检查接力申请状态"
                    : target?.peerFp ? "重新检查目标机" : "申请接力"
                  : pendingHandoff
                    ? "原样重发,幂等收口"
                    : preflight?.local.running
                      ? "停止并接力"
                      : "开始接力"}
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
const approvalMessage = (result: HandoffApprovalResult) => {
  const identity = result.peer ? `目标机身份 ${result.peer.short}。` : "目标机没有提供可核对的身份。";
  const status = result.peer?.peerStatus;
  if (status === "pending") return `${identity}申请已发送，必须等对方接受后才可以接力。`;
  if (status === "approved") return `${identity}对方已经接受申请。`;
  if (status === "open") return `${identity}对方没有开启接力审批，可以继续。`;
  if (status === "blocked") return `${identity}对方已拒绝这台机器的申请。`;
  return `${identity}目标机版本过旧，无法确认申请状态。`;
};
