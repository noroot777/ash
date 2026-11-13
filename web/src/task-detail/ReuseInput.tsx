import { useCallback } from "react";
import { PencilSimpleLine } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { useTaskReplyDraft } from "../lib/DraftStore.tsx";
import { focusReplyInput } from "./replyQuote.ts";
import { attachmentsFromPaths, mergeAttachments, reuseDraftText, type ReuseMark } from "./withdrawDraft.ts";

/**
 * 气泡上「改了再发」：发过的一句连同附件放回对话框，光标落到末尾，改完由用户自己发。
 *
 * 放回去是**合并**而不是覆盖（同撤回，见 withdrawDraft.ts）：输入框里正写着的字一个不丢，
 * 放回的那句排在前面；附件按路径还原成附件卡，图片照样有缩略图，发送时路径原样带上。
 * `source` 是这一句在会话里的身份，连点判重靠它（见 reuseDraftText）。
 */
export type ReusableInput = { source: string; text: string; paths: readonly string[] };

/** 每份草稿上一次放回的记号。按草稿分，跟着页面这一次会话活，刷新即清——同草稿本身。 */
const marks = new Map<string, ReuseMark>();

/** 放回这一句之后草稿该是什么正文；顺手记下这一次，供下一次判连点。 */
export function reuseInto(scope: string, input: Pick<ReusableInput, "source" | "text">, current: string): string {
  const mark = reuseDraftText(input.text, current, input.source, marks.get(scope) ?? null);
  marks.set(scope, mark);
  return mark.text;
}

/** 普通任务和团队调度台的对话框共用同一份按任务分的草稿，所以一个 hook 两处都管。 */
export function useReuseInput(taskId: string) {
  const { setText, setAttachments, afterSend } = useTaskReplyDraft(taskId);
  return useCallback(async (input: ReusableInput) => {
    // 有发送正在飞就先等它结算完：它会按发送那一刻的那一份摘草稿（同一路径的图、逐字没动的正文），
    // 排在它后面放回，刚放回的才不会被它当成「已发出去的那份」摘掉（第 1 轮审查实测）。
    await afterSend();
    setText((current) => reuseInto(`reply:${taskId}`, input, current));
    setAttachments((current) => mergeAttachments(attachmentsFromPaths([...input.paths]), current));
    focusReplyInput(taskId);
  }, [afterSend, setAttachments, setText, taskId]);
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
