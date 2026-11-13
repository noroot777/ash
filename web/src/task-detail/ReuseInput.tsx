import { useCallback } from "react";
import { PencilSimpleLine } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { useTaskReplyDraft } from "../lib/DraftStore.tsx";
import { focusReplyInput } from "./replyQuote.ts";
import { attachmentsFromPaths, mergeAttachments, reuseDraftText } from "./withdrawDraft.ts";

/**
 * 气泡上「改了再发」：发过的一句连同附件放回对话框，光标落到末尾，改完由用户自己发。
 *
 * 放回去是**合并**而不是覆盖（同撤回，见 withdrawDraft.ts）：输入框里正写着的字一个不丢，
 * 放回的那句排在前面；附件按路径还原成附件卡，图片照样有缩略图，发送时路径原样带上。
 */
export type ReusableInput = { text: string; paths: readonly string[] };

/** 普通任务和团队调度台的对话框共用同一份按任务分的草稿，所以一个 hook 两处都管。 */
export function useReuseInput(taskId: string) {
  const { setText, setAttachments } = useTaskReplyDraft(taskId);
  return useCallback((input: ReusableInput) => {
    setText((current) => reuseDraftText(input.text, current));
    setAttachments((current) => mergeAttachments(attachmentsFromPaths([...input.paths]), current));
    focusReplyInput(taskId);
  }, [setAttachments, setText, taskId]);
}

export function ReuseInputButton({ onReuse, className = "message-reuse-button" }: { onReuse: () => void; className?: string }) {
  const tip = useHoverTip();
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label="改了再发"
        onClick={() => { tip.hide(); onReuse(); }}
        {...tip.anchorProps}
      >
        <PencilSimpleLine size={13} aria-hidden="true" />
      </button>
      <HoverTip at={tip.at}>放回输入框，改了再发</HoverTip>
    </>
  );
}
