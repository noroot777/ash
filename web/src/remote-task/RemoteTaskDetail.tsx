import { useCallback, useEffect, useMemo, useState } from "react";
import type { HandoffTarget, Task, TaskListItem } from "@ash/shared";
import { TASK_STATUS_LABELS } from "@ash/shared";
import { ArrowCounterClockwise, ArrowUp, DesktopTower, SpinnerGap } from "@phosphor-icons/react";
import { api, type RemoteTaskSnapshot } from "../lib/api.ts";
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
}: {
  archive: TaskListItem;
  target: HandoffTarget;
  onLocalOwnership: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<RemoteTaskSnapshot | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returning, setReturning] = useState(false);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await api.remoteTaskSnapshot(archive.id, target.url);
      setSnapshot(next);
      setError(null);
    } catch (reason) {
      const local = await api.task(archive.id).catch(() => null);
      if (local && (local.handoff?.direction !== "out" || local.handoff.pending)) {
        onLocalOwnership(local);
        return;
      }
      setError(reason instanceof Error ? reason : new Error(String(reason)));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [archive.id, onLocalOwnership, target.url]);

  useEffect(() => {
    setSnapshot(null);
    setTimeline([]);
    setError(null);
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

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

  const returnHome = async () => {
    if (returning) return;
    setReturning(true);
    try {
      const result = await api.remoteTaskReturn(archive.id, target.url);
      setReturnOpen(false);
      notify("任务已移回本机");
      onLocalOwnership(result.task);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReturning(false);
    }
  };

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
          <button type="button" onClick={() => setReturnOpen(true)}>移回本机…</button>
        )}
      </section>

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

      {returnOpen && (
        <ConfirmDialog
          title="把任务移回本机？"
          message={`任务将从「${target.name}」接力回本机，远端列表中的这条任务随后会消失。`}
          confirmLabel="移回本机"
          busy={returning}
          onConfirm={() => void returnHome()}
          onClose={() => { if (!returning) setReturnOpen(false); }}
        />
      )}
    </div>
  );
}
