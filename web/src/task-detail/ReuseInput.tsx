import { useCallback } from "react";
import { PencilSimpleLine } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { nextTextVersion, useTaskReplyDraft } from "../lib/DraftStore.tsx";
import { focusReplyInput } from "./replyQuote.ts";
import { attachmentsFromPaths, reuseDraft } from "./withdrawDraft.ts";

/**
 * 气泡上「改了再发」：发过的一句连同附件放回对话框，光标落到末尾，改完由用户自己发。
 *
 * 放回去是**合并**而不是覆盖（同撤回，见 withdrawDraft.ts）：输入框里正写着的字一个不丢，
 * 放回的那句排在前面；附件按路径还原成附件卡，图片照样有缩略图，发送时路径原样带上。
 * 放回就是认领：正文换新版本、附件换新的选择记号，在途或迟到的旧发送结算时都清不走它
 * （见 clearSentDraft / dropSentAttachments）。
 * `source` 是这一句在会话里的身份，连点判重靠它（见 reuseDraft）。
 */
export type ReusableInput = { source: string; text: string; paths: readonly string[] };

/** 普通任务和团队调度台的对话框共用同一份按任务分的草稿，所以一个 hook 两处都管。 */
export function useReuseInput(taskId: string) {
  const { update, afterSend } = useTaskReplyDraft(taskId);
  return useCallback(async (input: ReusableInput) => {
    // 有发送正在飞就先等它结算完：排在它后面放回，连点判得准（草稿已经清了就不是连点）。
    // 归属不靠这个顺序，靠正文版本和选择记号。
    await afterSend();
    // 新版本、新选择在 updater 外面备好，updater 本身是纯的（StrictMode 会重放它）。
    const restored = attachmentsFromPaths([...input.paths]);
    const version = nextTextVersion();
    update((current) => {
      const next = reuseDraft(input, restored, current, current.reuse, version);
      return { ...current, text: next.text, attachments: next.attachments, textVersion: next.textVersion, reuse: next.mark };
    });
    focusReplyInput(taskId);
  }, [afterSend, taskId, update]);
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
