import type { ReactNode } from "react";

/**
 * 回复框此刻被另一件事借用（等你裁定时框顶那一行，见 free-workflow/DisputeRulingDock.tsx）。
 *
 * 只有一处打字的地方、一颗发送键：借用时不另起一个输入框，而是把这一个框的正文、提示和发送键换掉，
 * 还回去就是平常的回复框。`take` 为 null = 框顶那一行在，但还没选哪一档，框照常发普通消息。
 */
export type ReplyOverride = {
  /** 框顶那一行。 */
  head: ReactNode;
  /** 选了一档：正文换成那一档的话（`input`），或整块换掉（`body`，辩论的来回数）。 */
  take: null
    | { input: { value: string; placeholder: string; label: string; onChange: (value: string) => void } }
    | { body: ReactNode };
  /** 选了一档时顶替发送键的那颗。 */
  send: ReactNode;
  submit: () => void;
  /** Esc：回到平常的回复框。 */
  cancel: () => void;
};
