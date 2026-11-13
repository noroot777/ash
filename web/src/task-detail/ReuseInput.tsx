import { useCallback } from "react";
import { PencilSimpleLine } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { useTaskReplyDraft } from "../lib/DraftStore.tsx";
import { focusReplyInput } from "./replyQuote.ts";
import type { UploadAttachment } from "./Attachments.tsx";
import { reuseDraft, type ReuseMark } from "./withdrawDraft.ts";

/**
 * 气泡上「改了再发」：发过的一句连同附件放回对话框，光标落到末尾，改完由用户自己发。
 *
 * 放回去是**合并**而不是覆盖（同撤回，见 withdrawDraft.ts）：输入框里正写着的字一个不丢，
 * 放回的那句排在前面；附件按路径还原成附件卡，图片照样有缩略图，发送时路径原样带上。
 * 放回的附件是一次新的选择，正在飞的发送结算时摘不走它（见 dropSentAttachments）。
 * `source` 是这一句在会话里的身份，连点判重靠它（见 reuseDraft）。
 */
export type ReusableInput = { source: string; text: string; paths: readonly string[] };

/** 每份草稿上一次放回的记号。按草稿分，跟着页面这一次会话活，刷新即清——同草稿本身。 */
const marks = new Map<string, ReuseMark>();

/** 放回这一句之后草稿该是什么样；顺手记下这一次，供下一次判连点。 */
export function reuseInto(scope: string, input: ReusableInput, current: { text: string; attachments: UploadAttachment[] }): ReuseMark {
  const mark = reuseDraft(input, current, marks.get(scope) ?? null);
  marks.set(scope, mark);
  return mark;
}

/** 普通任务和团队调度台的对话框共用同一份按任务分的草稿，所以一个 hook 两处都管。 */
export function useReuseInput(taskId: string) {
  const { update, afterSend } = useTaskReplyDraft(taskId);
  return useCallback(async (input: ReusableInput) => {
    // 有发送正在飞就先等它结算完：它会清掉逐字没动的正文，排在它后面放回，同一条连点
    // 才判得准（草稿已经清了就不是连点）。附件不靠这个顺序，靠选择记号。
    await afterSend();
    update((current) => {
      const mark = reuseInto(`reply:${taskId}`, input, current);
      return mark.text === current.text && mark.attachments === current.attachments
        ? current
        : { ...current, text: mark.text, attachments: mark.attachments };
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
