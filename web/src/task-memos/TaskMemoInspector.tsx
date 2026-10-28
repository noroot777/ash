// 备忘面板：这个任务里**写给自己看**的那几条（语义与分界见 shared/src/task-memo.ts）。
//
// 入口有两个，都落进同一份缓存（task-memos/taskMemoStore.ts）：头带上的「+」手写一条，
// 以及会话里选中一段后浮条上的「添加到备忘」—— 后者加完会把面板切过来，所以这里要能
// 指出刚进来的是哪条（justAddedId 的高亮）。
import { useEffect, useState } from "react";
import { NotePencil, Plus } from "@phosphor-icons/react";
import { TASK_MEMO_MAX_LEN } from "@ash/shared/task-memo";
import type { TaskMemo } from "@ash/shared/task-memo";
import { InspectorHeadActions } from "../inspector/index.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import type { Notify } from "../lib/notify.ts";
import { TaskMemoCard } from "./TaskMemoCard.tsx";
import { addTaskMemo, clearTaskMemoHighlight, editTaskMemo, removeTaskMemo, useTaskMemos } from "./taskMemoStore.ts";

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export function TaskMemoInspector({ taskId, notify }: { taskId: string; notify: Notify }) {
  const { memos, loaded, loading, error, justAddedId } = useTaskMemos(taskId);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<TaskMemo | null>(null);

  // 换任务就把本地那点临时状态清干净：上一条任务没写完的草稿漂到下一条任务的面板上，
  // 看着像「这个任务里有一条我写过的东西」，而它其实属于别处。
  useEffect(() => {
    setComposing(false);
    setDraft("");
    setDeleting(null);
  }, [taskId]);

  // 高亮认完就撤（下次再打开这一格不该还亮着）。延一拍，让那条先滚进视野、亮一下再褪。
  useEffect(() => {
    if (!justAddedId) return;
    const timer = window.setTimeout(() => clearTaskMemoHighlight(taskId), 2600);
    return () => window.clearTimeout(timer);
  }, [justAddedId, taskId]);

  const guard = async (run: () => Promise<void>) => {
    setBusy(true);
    try { await run(); }
    catch (reason) { notify(message(reason)); }
    finally { setBusy(false); }
  };

  const submit = () => guard(async () => {
    const text = draft.trim();
    if (!text) return;
    await addTaskMemo(taskId, text);
    setDraft("");
    setComposing(false);
  });

  return (
    <div className="task-memo-inspector" aria-label="任务备忘">
      <InspectorHeadActions>
        <button
          type="button"
          className="task-memo-inspector__add"
          aria-label="写一条备忘"
          aria-expanded={composing}
          onClick={() => {
            setComposing((value) => !value);
            setDraft("");
          }}
        >
          <Plus size={13} weight="bold" aria-hidden="true" />
        </button>
      </InspectorHeadActions>

      {error && <p className="task-memo-inspector__error" role="alert">{error}</p>}

      {composing && (
        <div className="task-memo-composer">
          <textarea
            autoFocus
            value={draft}
            rows={5}
            maxLength={TASK_MEMO_MAX_LEN}
            placeholder="这一轮为什么这么定、哪段输出要留着回头看、验收时记得查什么…"
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); setComposing(false); setDraft(""); }
            }}
          />
          <div className="task-memo-composer__actions">
            <button type="button" disabled={busy} onClick={() => { setComposing(false); setDraft(""); }}>取消</button>
            <button type="button" className="is-primary" disabled={busy || !draft.trim()} onClick={() => void submit()}>
              保存
            </button>
          </div>
        </div>
      )}

      {memos.length > 0 ? (
        <div className="task-memo-inspector__list">
          {memos.map((memo) => (
            <TaskMemoCard
              key={memo.id}
              memo={memo}
              busy={busy}
              highlight={memo.id === justAddedId}
              onSave={(body) => guard(async () => { await editTaskMemo(taskId, memo.id, body); })}
              onDelete={() => setDeleting(memo)}
            />
          ))}
        </div>
      ) : !composing && (
        <div className="task-memo-inspector__empty">
          {/* 读不到的时候说「还在读」，别把读取中伪装成「没有备忘」。 */}
          <p>{loaded ? "这个任务还没有备忘。" : loading ? "正在读备忘…" : "还没读到这个任务的备忘。"}</p>
          <p>
            备忘只给你自己看，不会进 agent 的上下文 —— 记下为什么这么定、哪段输出要留着回头看。
          </p>
          <p>
            <NotePencil size={12} aria-hidden="true" /> 在会话里选中一段话，浮条上也有「添加到备忘」。
          </p>
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          danger
          title="删掉这条备忘"
          message={`删掉之后找不回来了。这条写的是：「${deleting.body.slice(0, 60)}${deleting.body.length > 60 ? "…" : ""}」`}
          confirmLabel="删掉"
          busy={busy}
          onConfirm={() => void guard(async () => {
            await removeTaskMemo(taskId, deleting.id);
            setDeleting(null);
          })}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
