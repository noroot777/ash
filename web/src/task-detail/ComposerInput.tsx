// 平常回复框里那个输入框（任务页、团队页、远程任务页同一个）。
//
// 答题卡展开时，平常的框连同它开出来的浮层整个不挂（QuestionSlot.tsx）：选执行器、发送设置、截图批注
// 这些都是 portal 到 body 上的，藏一个 `hidden` 的祖先挡不住它们。收起时框换一个新节点回来——撑高的
// 记账和「会话里点添加到对话、光标送回这个框」的登记都得跟着这个节点本身挂载，不然新框不再长高、
// 光标也送不回来。所以这两件事住在这里，不住在宿主里。
import { useEffect, type RefObject, type TextareaHTMLAttributes } from "react";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";
import { registerReplyInput } from "./replyQuote.ts";

export function ComposerInput({ inputRef, value, pinned = null, quoteTarget, ...rest }: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  /** 顶边拖动条拖出来的高度；null = 跟着行数撑。 */
  pinned?: number | null;
  /** 会话里的「添加到对话」往哪个任务的框里送光标；不给 = 这个框不接（replyQuote.ts）。 */
  quoteTarget?: string;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value">) {
  useAutoGrowTextarea(inputRef, { value, pinned });
  useEffect(() => quoteTarget ? registerReplyInput(quoteTarget, inputRef.current) : undefined, [quoteTarget, inputRef]);
  return <textarea ref={inputRef} value={value} {...rest} />;
}
