import { useEffect, useRef } from "react";
import { composerDraftKey, useDraft, type DraftHandle } from "../lib/DraftStore.tsx";
import { attachmentsFromPaths, joinDraftText, mergeAttachments } from "../task-detail/withdrawDraft.ts";
import type { ConversationFork } from "../task-detail/conversationFork.ts";

/**
 * 新建任务框的草稿。
 *
 * 面板本身是主工作区的一个内嵌状态：点侧栏的任务、开聊天、进设置都会把它整个卸载掉。
 * 所以正文和附件不能存在组件里 —— 那样「写到一半去看一眼别的」等于一键清空。草稿放进
 * 全局草稿库（`lib/DraftStore`）按项目存，回来时原样还在，在途的图也接着传。
 *
 * `seed` 是从别处带进来的一份内容（随手记转任务）。它是**一次性投递**：并进草稿之后
 * 立刻回调 `onSeeded`，由调用方把它摘掉。光靠组件里的 ref 判重不够 —— 面板一关 ref 就
 * 没了，同一份种子还挂在上面时再开一次会被并第二遍。并法与对话框撤回同一套：种子在前、
 * 已有草稿在后，附件按路径去重，一个字都不覆盖。
 */
export type ComposerDraft = { body: string; attachments: string[]; noteIds?: string[]; fork?: ConversationFork };

export function useComposerDraft(
  projectId: string,
  seed?: ComposerDraft | null,
  onSeeded?: () => void,
): DraftHandle {
  const key = composerDraftKey(projectId);
  const draft = useDraft(seed?.fork ? `${key}:fork:${seed.fork.sourceTaskId}:${seed.fork.replyId}` : key);
  const seeded = useRef<ComposerDraft | null>(null);
  const { setAttachments, setNoteIds, setText } = draft;
  useEffect(() => {
    if (!seed || seeded.current === seed) return;
    seeded.current = seed;
    setText((current) => joinDraftText(seed.body, current));
    setAttachments((current) => mergeAttachments(attachmentsFromPaths(seed.attachments), current));
    const noteIds = seed.noteIds ?? [];
    if (noteIds.length) setNoteIds((current) => [...new Set([...current, ...noteIds])]);
    if (!seed.fork) onSeeded?.();
  }, [onSeeded, seed, setAttachments, setNoteIds, setText]);
  return draft;
}
