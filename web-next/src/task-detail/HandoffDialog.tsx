import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  HandoffExportResult,
  HandoffPreflightResult,
  HandoffTarget,
  Task,
  TaskHandoff,
} from "@harness/shared";
import { ArrowSquareOut, PaperPlaneTilt, SpinnerGap, Warning } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";

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
  // null = 设置还没读回来;[] = 读回来了但一个目标都没配过。
  const [targets, setTargets] = useState<HandoffTarget[] | null>(null);
  const [targetUrl, setTargetUrl] = useState("");
  const [preflight, setPreflight] = useState<HandoffPreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [autoResume, setAutoResume] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HandoffExportResult | null>(null);

  useDismissable({ enabled: !busy, containerRef: scrim, onClose });

  useEffect(() => {
    let alive = true;
    api.settings()
      .then((settings) => {
        if (!alive) return;
        setTargets(settings.handoffTargets);
        if (settings.handoffTargets[0]) setTargetUrl(settings.handoffTargets[0].url);
      })
      .catch((reason) => {
        if (!alive) return;
        setTargets([]);
        notify(reason instanceof Error ? reason.message : "接力目标读取失败");
      });
    return () => { alive = false; };
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
        setProjectId(probe.suggestedProjectId ?? "");
      })
      .catch((reason) => {
        if (alive) setPreflightError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { alive = false; };
  }, [task.id, targetUrl]);

  const target = targets?.find((item) => item.url === targetUrl) ?? null;
  const missingFiles = preflight ? preflight.local.sessions - preflight.local.sessionFilesFound : 0;

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
        ) : targets && targets.length === 0 ? (
          <p>
            还没有配置接力目标。先到「设置 → 默认规则」里添加另一台 harness 的地址
            (形如 http://192.168.1.50:4317),再回来接力。
          </p>
        ) : (
          <>
            <p>
              把这个任务连同 git 分支、CLI 会话历史整体迁到另一台 harness 上继续跑。
              {preflight?.local.running ? "任务正在运行,接力会先把它停下来。" : ""}
            </p>
            <div className="handoff-field">
              <label htmlFor="handoff-target">目标机器</label>
              <select
                id="handoff-target"
                value={targetUrl}
                disabled={busy || targets === null}
                onChange={(event) => setTargetUrl(event.target.value)}
              >
                {(targets ?? []).map((item) => (
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
                <div className="handoff-field">
                  <label htmlFor="handoff-project">对端项目（主机 {preflight.target.host}）</label>
                  <select
                    id="handoff-project"
                    value={projectId}
                    disabled={busy}
                    onChange={(event) => setProjectId(event.target.value)}
                  >
                    <option value="">选择任务要落到的项目…</option>
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
                    disabled={busy}
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
          {!result && (targets?.length ?? 0) > 0 && (
            <button
              className="is-primary"
              type="button"
              disabled={busy || !preflight || !projectId}
              onClick={() => void run()}
            >
              {busy ? "接力中…(打包并传输,可能要一会儿)" : preflight?.local.running ? "停止并接力" : "开始接力"}
            </button>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

// 任务详情顶部的持久横幅:接力标记落在 tasks.handoff 上,刷新后仍然看得出这个任务
// 已经交出去了(或是从别的机器接过来的)。
export function HandoffBanner({ handoff }: { handoff: TaskHandoff }) {
  const out = handoff.direction === "out";
  const link = out && handoff.peerUrl
    ? `${handoff.peerUrl.replace(/\/+$/, "")}/tasks/${encodeURIComponent(handoff.peerTaskId)}`
    : null;
  const peer = handoff.peerName ? `「${handoff.peerName}」` : "另一台机器";
  return (
    <div className="task-handoff-banner">
      <PaperPlaneTilt size={13} aria-hidden="true" />
      <span>
        {out
          ? `${new Date(handoff.at).toLocaleString()} 已接力到${peer},本机这份只是历史存档。`
          : `${new Date(handoff.at).toLocaleString()} 从${peer}接力而来(会话文件 ${handoff.sessions} 份,代码${handoff.git === "bundle" ? "已随分支带来" : "未随任务携带"})。`}
      </span>
      {link && (
        <a href={link} target="_blank" rel="noreferrer">
          在对端打开<ArrowSquareOut size={12} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}
