import { useLayoutEffect, useRef, useState } from "react";
import { splitMessageQuotes } from "../lib/messageQuotes.ts";
import "./message-text.css";

/**
 * 用户消息的正文：引文淡一档、左边一道竖线、截成两行，正文照原样（纯文本，不走 Markdown）。
 * 跟答过的提问卡里那段问题引文是同一种长相。每一段都是容器的直接子元素，正文仍是 `<p>`，
 * 容器原有的 `> p` 排版不用改。
 */
export function MessageText({ text }: { text: string }) {
  return <>
    {splitMessageQuotes(text).map((block, index) => block.kind === "quote"
      ? <MessageQuote key={index} text={block.text} />
      : <p key={index}>{block.text}</p>)}
  </>;
}

/**
 * 截成两行的引文，真被截掉了才能点开看全。
 *
 * 不做成按钮：截断只是视觉上的，全文一直在 DOM 里（读屏照读全文），引文也还是正文——按钮里
 * 的字选不中，选文取正文时也会被当成界面装置剔掉。点击时已经选中了字就不切换：那一下是拖选
 * 或双击选词的收尾，不是要展开。
 */
function MessageQuote({ text }: { text: string }) {
  const ref = useRef<HTMLQuoteElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  // 展开之后就量不出「截没截」了，得一直能点回去。
  const toggles = open || clipped;
  return <blockquote
    ref={ref}
    className={`message-quote${open ? " is-open" : ""}${toggles ? " is-toggle" : ""}`}
    onClick={toggles ? () => {
      if (window.getSelection()?.isCollapsed === false) return;
      setOpen((value) => !value);
    } : undefined}
  >{text}</blockquote>;
}
