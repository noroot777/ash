import { useCallback } from "react";
import { useTaskReplyDraft } from "../lib/DraftStore.tsx";

/**
 * 「把主会话里选中的一段话送进对话框」。
 *
 * 送进侧聊是暂存一份引用（side-chat/sideChatQuote.ts），送进主聊则是**直接写进草稿**：
 * 对话框里没有引用卡这种东西，写成 Markdown 引用块之后用户可以接着改、接着删，
 * 跟自己敲进去的字没有区别。
 */

/** 选文浮条在 ReplyBox 外面，拿不到输入框的 ref，所以按任务 id 登记一处。 */
const inputs = new Map<string, HTMLTextAreaElement>();

/** ReplyBox 挂载时登记自己的输入框；返回值当 effect 的清理函数用。 */
export function registerReplyInput(taskId: string, input: HTMLTextAreaElement | null) {
  if (input) inputs.set(taskId, input);
  return () => {
    if (inputs.get(taskId) === input) inputs.delete(taskId);
  };
}

/**
 * 引用块接到草稿末尾：已有内容原样留着（空一行隔开），引用后面再空一行，
 * 让光标落在引用**下面**而不是引用里面 —— 用户接着敲的是问题，不是引文的续行。
 */
export function appendReplyQuote(current: string, text: string): string {
  const quote = text.replace(/\s+$/u, "").split(/\r\n|\r|\n/u).map((line) => `> ${line}`).join("\n");
  const head = current.replace(/\s+$/u, "");
  return `${head ? `${head}\n\n` : ""}${quote}\n\n`;
}

/**
 * 光标归位到对话框末尾。
 *
 * 推到下一帧再取焦点：textarea 是受控的，setText 要等这一轮渲染提交完才写进 DOM，
 * 当场读 value.length 拿到的还是插入前的长度，光标会停在引用中间。
 */
export function focusReplyInput(taskId: string) {
  requestAnimationFrame(() => {
    const input = inputs.get(taskId);
    if (!input || input.disabled) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = input.scrollHeight;
  });
}

/** 选文浮条上「添加到对话」按的就是这个：写进草稿 + 光标归位。 */
export function useAddReplyQuote(taskId: string) {
  const { setText } = useTaskReplyDraft(taskId);
  return useCallback((text: string) => {
    if (!text.trim()) return;
    setText((current) => appendReplyQuote(current, text));
    focusReplyInput(taskId);
  }, [setText, taskId]);
}
