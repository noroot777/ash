import { forwardRef, useCallback, useRef, useState, type TextareaHTMLAttributes } from "react";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** 自动撑高到几行为止，再多在框内滚；缺省跟 useAutoGrowTextarea 一样。 */
  maxLines?: number;
};

/**
 * 随内容长高、没有拖拽角的输入框（docs/ui-ux-audit feed-12）。`rows` 是空着时的最少行数，
 * 高度只由 useAutoGrowTextarea 写——任务回复框那种带外部拖动条的仍直接用钩子。
 * 非受控（defaultValue）的框没有 value 可跟，就在每次输入时重量一遍。
 */
export const AutoTextarea = forwardRef<HTMLTextAreaElement, Props>(function AutoTextarea(
  { maxLines, onInput, ...props },
  forwarded,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const [typed, setTyped] = useState("");
  const setRef = useCallback((el: HTMLTextAreaElement | null) => {
    inner.current = el;
    if (typeof forwarded === "function") forwarded(el);
    else if (forwarded) forwarded.current = el;
  }, [forwarded]);
  const controlled = props.value !== undefined;
  useAutoGrowTextarea(inner, { value: controlled ? String(props.value) : typed, maxLines });
  const handleInput: NonNullable<Props["onInput"]> = (event) => {
    if (!controlled) setTyped(event.currentTarget.value);
    onInput?.(event);
  };
  return <textarea ref={setRef} {...props} onInput={handleInput} />;
});
