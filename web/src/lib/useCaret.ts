import { useState, type CompositionEvent, type SyntheticEvent } from "react";

/**
 * 一个 textarea 此刻的光标在哪、输入法是不是还在组字。斜杠菜单按**光标前**那一段认（lib/slashMatch.ts），
 * 组字途中不弹（拼音还没上屏，`/p` 不是用户要的命令）。
 *
 * 记的是「量的时候正文是哪一份」：正文被别处改掉（撤回放回框里、选中一条补全、发完清空）而光标还没再量过，
 * 就按文末算——那几处本来就把光标放在末尾，量不到不会比猜更准。
 */
export function useCaret(value: string) {
  const [mark, setMark] = useState<{ value: string; at: number | null } | null>(null);
  const [composing, setComposing] = useState(false);
  const read = (element: HTMLTextAreaElement) => {
    const { selectionStart, selectionEnd } = element;
    // 选着一段字时不认光标：那是要改、要删那一段，不是在敲命令。
    setMark({ value: element.value, at: selectionStart === selectionEnd ? selectionStart : null });
  };
  const at = mark && mark.value === value ? mark.at : value.length;
  return {
    /** null = 选着一段字，或输入法在组字：这时什么菜单都不弹。 */
    at: composing ? null : at,
    /** 接在 onChange 里（光标随打字走）。 */
    read,
    /** 程序改了正文、要把光标放到哪：先记下，再等它画出来后真放过去。 */
    place: (element: HTMLTextAreaElement | null, text: string, caret: number) => {
      setMark({ value: text, at: caret });
      requestAnimationFrame(() => {
        if (!element) return;
        element.focus();
        element.setSelectionRange(caret, caret);
      });
    },
    inputProps: {
      onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => read(event.currentTarget),
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => {
        setComposing(false);
        read(event.currentTarget);
      },
    },
  };
}
