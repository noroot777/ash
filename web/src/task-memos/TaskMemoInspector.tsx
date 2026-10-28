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
import { setMemoComposerDraft, setMemoEditDraft, useTaskMemoDrafts } from "./taskMemoDrafts.ts";

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export function TaskMemoInspector({ taskId, notify }: { taskId: string; notify: Notify }) {
  const { memos, loaded, loading, error, justAddedId } = useTaskMemos(taskId);
  // 草稿（新建那条、每条的编辑态）住在 taskMemoDrafts.ts：面板会被自动切走（任务 status
  // 一变 stateKey 就变），放本地 state 的话几百字跟着卸载一起没。按任务分开存，所以也
  // 不会漂到下一条任务的面板上。
  const { composing, edits } = useTaskMemoDrafts(taskId);
  const draft = composing ?? "";
  const setDraft = (text: string) => setMemoComposerDraft(taskId, text);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<TaskMemo | null>(null);

  // 换任务只清「删哪条」这种一次性意图 —— 草稿按任务存，本来就不会串台。
  useEffect(() => { setDeleting(null); }, [taskId]);

  // 高亮认完就撤（下次再打开这一格不该还亮着）。延一拍，让那条先滚进视野、亮一下再褪。
  useEffect(() => {
    if (!justAddedId) return;
    const timer = window.setTimeout(() => clearTaskMemoHighlight(taskId), 2600);
    return () => window.clearTimeout(timer);
  }, [justAddedId, taskId]);

  // 接住失败并提示，**并把成败回给调用点**。返回 void 的话（本轮第一版）错误就被包成了
  // 「成功」：保存失败照样退出编辑态，effect 再把草稿换回旧正文，几百字一条当场丢光
  // （独立审查第 1 轮注入 503 实测）。所以这里的返回值不是可选的礼貌。
  const guard = async (run: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try { await run(); return true; }
    catch (reason) { notify(message(reason)); return false; }
    finally { setBusy(false); }
  };

  // 收起 composer 排在 await **之后**：写失败时那几百字还留在框里。
  const submit = () => guard(async () => {
    const text = draft.trim();
    if (!text) return;
    await addTaskMemo(taskId, text);
    setMemoComposerDraft(taskId, null);
  });

  return (
    <div className="task-memo-inspector" aria-label="任务备忘">
      <InspectorHeadActions>
        <button
          type="button"
          className="task-memo-inspector__add"
          aria-label="写一条备忘"
          aria-expanded={composing !== null}
          onClick={() => setMemoComposerDraft(taskId, composing === null ? "" : null)}
        >
          <Plus size={13} weight="bold" aria-hidden="true" />
        </button>
      </InspectorHeadActions>

      {error && <p className="task-memo-inspector__error" role="alert">{error}</p>}

      {composing !== null && (
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
              if (event.key === "Escape") { event.stopPropagation(); setMemoComposerDraft(taskId, null); }
            }}
          />
          <div className="task-memo-composer__actions">
            <button type="button" disabled={busy} onClick={() => setMemoComposerDraft(taskId, null)}>取消</button>
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
              draft={memo.id in edits ? edits[memo.id] : null}
              onDraft={(next) => setMemoEditDraft(taskId, memo.id, next)}
              onSave={(body) => guard(async () => { await editTaskMemo(taskId, memo.id, body); })}
              onDelete={() => setDeleting(memo)}
            />
          ))}
        </div>
      ) : composing === null && (
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
