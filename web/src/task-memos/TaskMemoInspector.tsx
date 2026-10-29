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
import {
  beginMemoWrite,
  finishMemoWrite,
  setMemoComposerDraft,
  setMemoEditDraft,
  useTaskMemoDrafts,
  type MemoSlot,
} from "./taskMemoDrafts.ts";

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export function TaskMemoInspector({ taskId, notify }: { taskId: string; notify: Notify }) {
  const { memos, loaded, loading, error, justAddedId } = useTaskMemos(taskId);
  // 草稿（新建那条、每条的编辑态）**和在途写**都住在 taskMemoDrafts.ts：面板会被自动
  // 切走（任务 status 一变 stateKey 就变），放本地 state 的话几百字跟着卸载一起没，而
  // 「正在保存」跟着卸载重置更糟 —— 回来能接着写，先前那一发回来又把它清掉（第 3 轮
  // F1）。按任务分开存，所以也不会漂到下一条任务的面板上。
  const { composing, edits, busy, pendingOn } = useTaskMemoDrafts(taskId);
  const draft = composing ?? "";
  const setDraft = (text: string) => setMemoComposerDraft(taskId, text);
  const [deleting, setDeleting] = useState<TaskMemo | null>(null);

  // 换任务只清「删哪条」这种一次性意图 —— 草稿按任务存，本来就不会串台。
  useEffect(() => { setDeleting(null); }, [taskId]);

  // 高亮认完就撤（下次再打开这一格不该还亮着）。延一拍，让那条先滚进视野、亮一下再褪。
  useEffect(() => {
    if (!justAddedId) return;
    const timer = window.setTimeout(() => clearTaskMemoHighlight(taskId), 2600);
    return () => window.clearTimeout(timer);
  }, [justAddedId, taskId]);

  /**
   * 跑一发写：占住这个位置 → 执行 → 交还占位，**只清掉自己提交的那一版草稿**。
   *
   * 三件事必须一起做，少一件都是已经实测过的丢字路径：
   *  · 接住失败并提示，别把错误包成「成功」（第 1 轮 F2：503 照样退出编辑态，草稿当场
   *    被旧正文覆盖）；
   *  · 占位住在 store 里，在途期间框子一直禁用（第 3 轮 F1：切走再回来 busy 归零，于是
   *    能写第二版）；
   *  · 清草稿带版本号，不是「写完就清」（第 3 轮 F1 的另一半：旧那一发回来清掉了新写的）。
   */
  const write = async (slot: MemoSlot, run: () => Promise<void>): Promise<void> => {
    const rev = beginMemoWrite(taskId, slot);
    // 这个位置已经有一发在飞 —— 直接放弃，不叠第二发（两发应答逆序会把旧正文盖回去）。
    if (rev === null) return;
    let ok = false;
    try { await run(); ok = true; }
    catch (reason) { notify(message(reason)); }
    finally { finishMemoWrite(taskId, slot, rev, ok); }
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    void write(null, async () => { await addTaskMemo(taskId, text); });
  };

  return (
    <div className="task-memo-inspector" aria-label="任务备忘">
      <InspectorHeadActions>
        <button
          type="button"
          className="task-memo-inspector__add"
          aria-label="写一条备忘"
          aria-expanded={composing !== null}
          disabled={pendingOn(null)}
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
            disabled={pendingOn(null)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              if (!pendingOn(null)) setMemoComposerDraft(taskId, null);
            }}
          />
          <div className="task-memo-composer__actions">
            <button type="button" disabled={pendingOn(null)} onClick={() => setMemoComposerDraft(taskId, null)}>取消</button>
            <button
              type="button"
              className="is-primary"
              disabled={pendingOn(null) || !draft.trim()}
              onClick={() => submit()}
            >
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
              onSave={(body) => write(memo.id, async () => { await editTaskMemo(taskId, memo.id, body); })}
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
          onConfirm={() => void write(deleting.id, async () => {
            await removeTaskMemo(taskId, deleting.id);
            // 这条没了，它的编辑草稿也不该留成孤儿（删除按钮只在读态可见，所以通常是空操作）。
            setMemoEditDraft(taskId, deleting.id, null);
            setDeleting(null);
          })}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
