import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  HandoffExportResult,
  HandoffPreflightResult,
  HandoffTarget,
  Task,
  TaskHandoff,
} from "@ash/shared";
import { ArrowSquareOut, Fingerprint, PaperPlaneTilt, SpinnerGap, Warning } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { handoffTaskHref } from "../workspace/workspaceHistory.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

// 任务接力对话框:选目标机 → 预检(探测对端、匹配项目、盘点可搬运的东西)→ 执行。
// 执行会先停掉正在跑的任务,再打包 git 分支和 CLI 会话文件推给对端,所以预检结果里
// 把「会先停任务」「能搬走多少」如实摆出来,让用户看清楚再按。
export function HandoffDialog({
  task,
  notify,
  onClose,
  onTaskUpdate,
}: {
  task: Task;
  notify: (message: string) => void;
  onClose: () => void;
  onTaskUpdate: (task: Task) => void;
}) {
  const scrim = useRef<HTMLDivElement>(null);
  // out+pending = 上次接力应答丢失,这次打开对话框是「原样重放收口」:目标机、对端项目、
  // autoResume 一律沿用 pending 标记冻结的第一次参数(服务端同样硬校验,换参数 409)。
  // 换 transferId 重发会把同一任务复制到多台机器——要换目标,先在横幅上移除接力标记。
  const pendingHandoff = task.handoff?.direction === "out" && task.handoff.pending ? task.handoff : null;
  // null = 设置还没读回来;[] = 读回来了但一个目标都没配过。
  const [targets, setTargets] = useState<HandoffTarget[] | null>(null);
  const [targetUrl, setTargetUrl] = useState("");
  const [preflight, setPreflight] = useState<HandoffPreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [autoResume, setAutoResume] = useState(pendingHandoff?.autoResume ?? true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HandoffExportResult | null>(null);

  useDismissable({ enabled: !busy, containerRef: scrim, onClose });

  useEffect(() => {
    let alive = true;
    api.settings()
      .then((settings) => {
        if (!alive) return;
        setTargets(settings.handoffTargets);
        if (pendingHandoff?.peerUrl) setTargetUrl(pendingHandoff.peerUrl);
        else if (settings.handoffTargets[0]) setTargetUrl(settings.handoffTargets[0].url);
      })
      .catch((reason) => {
        if (!alive) return;
        setTargets([]);
        notify(reason instanceof Error ? reason.message : "接力目标读取失败");
      });
    return () => { alive = false; };
    // pendingHandoff 只取对话框打开那一刻的值,任务更新不重读设置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify]);

  // 换目标就重新预检;预检只读,不停任务不动文件。
  useEffect(() => {
    if (!targetUrl) return;
    let alive = true;
    setPreflight(null);
    setPreflightError(null);
    setProjectId("");
    api.handoffPreflight(task.id, targetUrl)
      .then((probe) => {
        if (!alive) return;
        setPreflight(probe);
        setProjectId(pendingHandoff?.targetProjectId ?? probe.suggestedProjectId ?? "");
      })
      .catch((reason) => {
        if (alive) setPreflightError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, targetUrl]);

  const target = targets?.find((item) => item.url === targetUrl) ?? null;
  // 重放收口时冻结的目标机可能已经不在设置列表里(被删过),补一个选项让它仍可见可选。
  const targetOptions = pendingHandoff?.peerUrl && !(targets ?? []).some((item) => item.url === pendingHandoff.peerUrl)
    ? [{ name: pendingHandoff.peerName ?? pendingHandoff.peerUrl, url: pendingHandoff.peerUrl }, ...(targets ?? [])]
    : targets ?? [];
  const missingFiles = preflight ? preflight.local.sessions - preflight.local.sessionFilesFound : 0;
  // 对端还没批准本机(或已拒绝):后端在打包前也会 409,这里先把按钮按住,省掉一次白等。
  const blockedByPeer = preflight?.peer?.peerStatus === "pending" || preflight?.peer?.peerStatus === "blocked";

  const run = async () => {
    if (!projectId || busy) return;
    setBusy(true);
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
      // 网络类失败会在本机留下「接力未确认」的 pending 标记——照样拉回任务,
      // 让横幅立刻可见,用户按横幅上的指引重试或移除。
      try {
        onTaskUpdate(await api.task(task.id));
      } catch {
        // SSE 大概率也会把更新推过来。
      }
    } finally {
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
        <header>
          <span><PaperPlaneTilt size={16} weight="fill" /></span>
          <h2 id="handoff-title">接力到另一台机器</h2>
        </header>
        {result ? (
          <>
            <p>
              已把任务交给{target?.name ? `「${target.name}」` : "对端"}:迁移会话文件 {result.sessionsMigrated} 份,
              代码{result.git === "bundle" ? "已随分支带过去" : "未随任务携带"};
              {result.autoResume ? "对端已自动续跑。" : "对端不会自动续跑,需要在对端手动点「运行」。"}
              本机这份任务保留为历史存档。
            </p>
            {result.notes.length > 0 && (
              <ul className="handoff-notes">
                {result.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            )}
            <p>
              <a className="handoff-remote-link" href={result.remoteUrl} target="_blank" rel="noreferrer">
                在对端打开这个任务<ArrowSquareOut size={12} aria-hidden="true" />
              </a>
            </p>
          </>
        ) : targets && targets.length === 0 && !pendingHandoff ? (
          <p>
            还没有配置接力目标。先到「设置 → 默认规则」里添加另一台 ash 的地址
            (形如 http://192.168.1.50:4317),再回来接力。
          </p>
        ) : (
          <>
            <p>
              把这个任务连同 git 分支、CLI 会话历史整体迁到另一台 ash 上继续跑。
              {preflight?.local.running ? "任务正在运行,接力会先把它停下来。" : ""}
            </p>
            {pendingHandoff && (
              <p className="handoff-error">
                <Warning size={13} aria-hidden="true" />
                上次接力没收到确认,这次是原样重放收口:目标机、对端项目和续跑选项沿用第一次发送的参数,不能更改。确认对端没收到、想换目标,先在任务横幅上移除接力标记。
              </p>
            )}
            <div className="handoff-field">
              <label htmlFor="handoff-target">目标机器</label>
              <select
                id="handoff-target"
                value={targetUrl}
                disabled={busy || targets === null || !!pendingHandoff}
                onChange={(event) => setTargetUrl(event.target.value)}
              >
                {targetOptions.map((item) => (
                  <option key={item.url} value={item.url}>{item.name}（{item.url}）</option>
                ))}
              </select>
            </div>
            {preflightError && (
              <p className="handoff-error"><Warning size={13} aria-hidden="true" />预检失败:{preflightError}</p>
            )}
            {!preflight && !preflightError && targetUrl && (
              <p className="handoff-probing"><SpinnerGap size={13} className="is-spinning" aria-hidden="true" />正在探测对端…</p>
            )}
            {preflight && (
              <>
                {preflight.peer ? (
                  <p className={`handoff-peer-line${preflight.peer.peerStatus === "pending" || preflight.peer.peerStatus === "blocked" ? " is-warn" : ""}`}>
                    <Fingerprint size={13} aria-hidden="true" />
                    <span>
                      目标机身份 <b>{preflight.peer.short}</b>
                      {preflight.peer.trust === "first-seen"
                        ? "（第一次连这台机器：和对端设置页上显示的那串核对一下，接力成功后本机会记住它）"
                        : "（和上次记住的一致）"}
                      {preflight.peer.peerStatus === "pending"
                        ? "。对端还没批准本机，去它的「设置 → 默认规则 → 接力来源」放行后再接力。"
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
                <ul className="handoff-summary">
                  <li>
                    CLI 会话 {preflight.local.sessions} 个,找到会话文件 {preflight.local.sessionFilesFound} 份
                    {missingFiles > 0 ? `;找不到文件的 ${missingFiles} 个到对端会全新起跑` : ""}
                  </li>
                  <li>
                    {preflight.local.git === "bundle"
                      ? "代码:worktree 分支(含未提交改动的 WIP 提交)会打包带走"
                      : "代码:没有可带的 git 状态,对端按任务正文重新开工"}
                  </li>
                  {preflight.local.uploads > 0 && (
                    <li>上传附件 {preflight.local.uploads} 个随任务带走,文中路径自动改写为对端路径</li>
                  )}
                  {preflight.local.pendingMessages > 0 && (
                    <li>待发送消息 {preflight.local.pendingMessages} 条随任务迁移,到期后在对端投递;本机的原件会取消并留档在时间线</li>
                  )}
                  {preflight.local.schedule && (
                    <li>定时计划({preflight.local.schedule === "cron" ? "周期" : "一次性"})随任务迁移,今后由对端触发</li>
                  )}
                </ul>
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
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>{result ? "关闭" : "取消"}</button>
          {!result && targetOptions.length > 0 && (
            <button
              className="is-primary"
              type="button"
              disabled={busy || !preflight || !projectId || blockedByPeer}
              onClick={() => void run()}
            >
              {busy
                ? "接力中…(打包并传输,可能要一会儿)"
                : pendingHandoff
                  ? "原样重发,幂等收口"
                  : preflight?.local.running
                    ? "停止并接力"
                    : "开始接力"}
            </button>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

// 任务详情顶部的持久横幅:接力标记落在 tasks.handoff 上,刷新后仍然看得出这个任务
// 已经交出去了(或是从别的机器接过来的)。接力出去的任务被服务端硬拦启动,横幅上的
// 「在本机继续」是唯一逃生门——走确认框,因为对端那份不会消失,两边并跑会分叉。
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
  const out = handoff.direction === "out";
  const link = out && !handoff.pending
    ? handoffTaskHref(taskId, handoff)
    : null;
  const peer = handoff.peerName ? `「${handoff.peerName}」` : "另一台机器";
  const clear = async () => {
    setBusy(true);
    try {
      await api.clearHandoff(taskId);
      onTaskUpdate(await api.task(taskId));
      notify("已移除接力标记,任务恢复为本机可运行");
      setConfirmOpen(false);
    } catch (reason) {
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
            ? `${new Date(handoff.at).toLocaleString()} 接力到${peer}后没收到确认,对端可能已收到这份任务。原样再接力一次会自动幂等收口;确认对端没收到,再移除标记在本机继续。`
            : `${new Date(handoff.at).toLocaleString()} 已接力到${peer},本机这份只是历史存档。`
          : `${new Date(handoff.at).toLocaleString()} 从${peer}接力而来(会话文件 ${handoff.sessions} 份,代码${handoff.git === "bundle" ? "已随分支带来" : "未随任务携带"})。`}
      </span>
      {link && (
        <a href={link} target="_blank" rel="noreferrer">
          在对端打开<ArrowSquareOut size={12} aria-hidden="true" />
        </a>
      )}
      {out && (
        <button
          type="button"
          className="task-handoff-clear"
          disabled={busy}
          onClick={() => setConfirmOpen(true)}
        >
          在本机继续…
        </button>
      )}
      {confirmOpen && (
        <ConfirmDialog
          title="移除接力标记"
          message={handoff.pending
            ? "对端可能已经收到这份任务。移除标记后本机恢复可运行,但如果对端其实收到了,两台机器会各跑一份、改动会分叉。确定要在本机继续吗?"
            : `任务已接力到${peer},对端那份不会消失。移除标记后本机恢复可运行,两边同时跑会分叉。确定要在本机继续吗?`}
          confirmLabel="移除标记,在本机继续"
          danger
          busy={busy}
          onConfirm={() => void clear()}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
