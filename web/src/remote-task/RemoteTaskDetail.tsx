import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HandoffTarget, Task, TaskListItem } from "@ash/shared";
import { isAcceptedStage, TASK_STATUS_LABELS } from "@ash/shared";
import { ArrowCounterClockwise, ArrowUp, DesktopTower, SpinnerGap } from "@phosphor-icons/react";
import { api, type RemoteTaskSnapshot } from "../lib/api.ts";
import type { RemoteReturns } from "./useRemoteReturns.ts";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { ConversationFeed } from "../task-detail/ConversationFeed.tsx";
import { buildConversationItems, type TimelineEntry } from "../task-detail/conversationModel.ts";
import { QuestionCard } from "../task-detail/QuestionCard.tsx";

const POLL_MS = 2_000;

export function RemoteTaskDetail({
  archive,
  target,
  onLocalOwnership,
  notify,
  returns,
}: {
  archive: TaskListItem;
  target: HandoffTarget;
  onLocalOwnership: (task: Task) => void;
  notify: (message: string) => void;
  returns: RemoteReturns;
}) {
  const [snapshot, setSnapshot] = useState<RemoteTaskSnapshot | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [returnDialog, setReturnDialog] = useState<"normal" | "resume" | null>(null);
  const [returnWaitSeconds, setReturnWaitSeconds] = useState(0);
  const operation = returns.get(archive, target);
  const returning = operation?.status === "pending";
  const returnOpen = returnDialog !== null;
  const returnError = operation?.status === "failed" ? operation.error : null;
  const capabilityBlock = operation?.capabilityMessage;
  const showCapabilityDialog = returnDialog === "resume" && Boolean(capabilityBlock);
  const returnStartedAt = returning ? operation.startedAt : null;
  const returnTarget = operation?.target ?? target;
  const refreshVersion = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 这个框沿用 .task-reply-box 的样式(resize: none,没有拖动条),高度就全交给行数自动撑。
  useAutoGrowTextarea(inputRef, { value: text });

  const refresh = useCallback(async (quiet = false) => {
    const version = refreshVersion.current;
    if (!quiet) setLoading(true);
    try {
      const next = await api.remoteTaskSnapshot(archive.id, target.url);
      if (refreshVersion.current !== version) return;
      setSnapshot(next);
      setError(null);
    } catch (reason) {
      if (refreshVersion.current !== version) return;
      const local = await api.task(archive.id).catch(() => null);
      if (refreshVersion.current !== version) return;
      if (local && (local.handoff?.direction !== "out" || local.handoff.pending)) {
        onLocalOwnership(local);
        return;
      }
      setError(reason instanceof Error ? reason : new Error(String(reason)));
    } finally {
      if (!quiet && refreshVersion.current === version) setLoading(false);
    }
  }, [archive.id, onLocalOwnership, target.url]);

  useEffect(() => {
    setSnapshot(null);
    setTimeline([]);
    setError(null);
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(true), POLL_MS);
    return () => {
      refreshVersion.current += 1;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    setReturnDialog(null);
  }, [archive.id, archive.handoff?.transferId, target.url]);

  useEffect(() => {
    if (returnStartedAt === null) return;
    const updateElapsed = () => setReturnWaitSeconds(Math.floor((Date.now() - returnStartedAt) / 1_000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [returnStartedAt]);

  useEffect(() => {
    if (operation?.status === "succeeded") onLocalOwnership(operation.task);
  }, [onLocalOwnership, operation]);

  const task = snapshot?.task ?? archive;
  const items = useMemo(() => buildConversationItems(snapshot?.persisted ?? [], snapshot?.sessions ?? [], timeline), [snapshot, timeline]);
  const canReply = task.mode === "single" || task.mode === "team";

  const send = async () => {
    const message = text.trim();
    if (!message || sending || !canReply) return;
    const at = new Date().toISOString();
    setSending(true);
    setSendError(null);
    try {
      await api.remoteTaskReply(archive.id, target.url, message);
      setTimeline((current) => [...current, {
        kind: "user",
        id: `remote:optimistic:${at}`,
        text: message,
        attachments: [],
        at,
        source: "optimistic",
      }]);
      setText("");
      await refresh(true);
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  const returnHome = (ignoreCapabilityGaps = false) => {
    setReturnDialog("resume");
    void returns.start(archive, target, ignoreCapabilityGaps);
  };

  const returnProgress = returning && (
    <div className="remote-return-progress" role="status">
      <strong>正在等待移回确认 · 已等待 {returnWaitSeconds} 秒</strong>
      <p>已请求「{returnTarget.name}」打包并回传任务，处理可能需要几分钟。目前尚未收到完成确认。</p>
      <p>可以收起弹窗继续查看任务；后台等待不会取消迁移，也不会重新发送请求。</p>
      {!returnOpen && <button type="button" onClick={() => setReturnDialog("resume")}>查看移回进度</button>}
    </div>
  );

  const returnFailure = !returning && (returnError || (!returnOpen && capabilityBlock)) && (
    <div className="remote-return-error" role="alert">
      <strong>{returnError ? "移回未完成" : "移回需要确认"}</strong>
      <p>{returnError ?? capabilityBlock}</p>
      <p>移回需要「{target.name}」主动连接本机。若提示连接失败，请确认本机 ash 正在运行，且来源地址能从对端访问；能查看远程会话不代表回程连通。</p>
      {!returnOpen && (
        <div className="remote-return-actions">
          <button type="button" onClick={() => setReturnDialog("resume")}>{returnError ? "重试移回" : "查看移回确认"}</button>
          <button type="button" onClick={() => returns.dismiss(archive, target)}>知道了</button>
        </div>
      )}
    </div>
  );

  return (
    <div className="task-detail remote-task-detail">
      <header className="task-detail-header remote-task-header">
        <span className="task-detail-kind">远程任务</span>
        <strong className="task-detail-title is-readonly">{task.title || "未命名任务"}</strong>
        <span className="task-detail-status">{task.question ? "等答复" : TASK_STATUS_LABELS[task.status]}</span>
        <button type="button" className="remote-task-refresh" onClick={() => void refresh()} disabled={loading} aria-label="刷新远程会话">
          <ArrowCounterClockwise size={14} className={loading ? "is-spinning" : ""} aria-hidden="true" />
        </button>
      </header>

      <section className={`remote-task-route${error ? " is-offline" : ""}`} aria-label="远程执行位置">
        <DesktopTower size={16} weight="fill" aria-hidden="true" />
        <div>
          <b>{target.name}{error ? " · 连接异常" : " · 在线"}</b>
          <span>界面在本机打开；上下文从该机器同步，回复也由该机器继续执行。</span>
        </div>
        {snapshot?.returnAvailable && (
          <button type="button" onClick={() => setReturnDialog(returning ? "resume" : "normal")}>移回本机…</button>
        )}
      </section>

      {!returnOpen && <>{returnProgress}{returnFailure}</>}

      <div className="task-detail-body">
        <section className="task-detail-main" aria-label="远程任务会话">
          <ConversationFeed
            task={task}
            items={items}
            sessions={snapshot?.sessions ?? []}
            loading={loading}
            error={error}
            footer={task.question ? (
              <QuestionCard
                task={task}
                onAnswer={async (answer) => {
                  await api.remoteTaskAnswer(archive.id, target.url, answer);
                  notify("已发送答复，任务正在远端续跑");
                  await refresh(true);
                }}
              />
            ) : undefined}
          />
          <div className="task-reply-shell remote-task-reply">
            {sendError && <p className="task-reply-error">{sendError}</p>}
            <div className="task-reply-box">
              <textarea
                ref={inputRef}
                value={text}
                rows={3}
                disabled={!snapshot || sending || !canReply || Boolean(task.question)}
                placeholder={task.question ? "请先答复上方问题" : canReply ? `回复将发送到 ${target.name} 执行` : "该类型任务暂不支持从代理视图回复"}
                aria-label="回复远程任务"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="task-reply-actions">
                <span>上下文与执行位置：{target.name} · ⌘↵ 发送</span>
                <button className="task-send-button" type="button" disabled={!snapshot || sending || !text.trim() || !canReply || Boolean(task.question)} onClick={() => void send()} aria-label="发送到远程任务">
                  {sending ? <SpinnerGap size={15} className="is-spinning" /> : <ArrowUp size={15} weight="bold" />}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      {returnOpen && !showCapabilityDialog && (
        <ConfirmDialog
          title="把任务移回本机？"
          message={`任务将从「${target.name}」接力回本机，远端列表中的这条任务随后会消失。`
            + (isAcceptedStage(task.stage) ? "它已经验收完成：移回后不会自动续跑。" : "")}
          confirmLabel={returnError ? "重试移回" : "移回本机"}
          busy={returning}
          allowCloseWhenBusy
          cancelLabel={returning ? "后台等待" : "取消"}
          onConfirm={() => void returnHome()}
          onClose={() => setReturnDialog(null)}
        >
          {returnProgress}
          {returnFailure}
        </ConfirmDialog>
      )}

      {returnOpen && showCapabilityDialog && (
        <ConfirmDialog
          title="本机跑不动这个任务的执行器"
          message={`${capabilityBlock}\n\n仍然移回的话，任务会回到本机，但直接运行会失败；`
            + "先在本机装上它要用的智能体，或者移回后把任务改成本机有的再运行。"}
          confirmLabel={returnError ? "仍然重试移回" : "仍然移回"}
          busy={returning}
          allowCloseWhenBusy
          cancelLabel={returning ? "后台等待" : "取消"}
          onConfirm={() => void returnHome(true)}
          onClose={() => setReturnDialog(null)}
        >
          {returnProgress}
          {returnFailure}
        </ConfirmDialog>
      )}
    </div>
  );
}
