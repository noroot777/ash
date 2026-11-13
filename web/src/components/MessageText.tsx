import { useId, useLayoutEffect, useRef, useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
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
 * 截成两行的引文，真被截掉了才在尾巴上给一颗展开键。
 *
 * 展开收起只认那颗键，引文正文本身不接点击：正文要能选（选文取正文时按钮会被当成界面装置
 * 剔掉，正文做成按钮就选不进去了），而点一下就改排版的正文接不住双击 —— 第一下 click 时
 * 还没有选区，排版一变，第二下就落到挪过位置的另一句话上，选中的是别人的字。
 */
function MessageQuote({ text }: { text: string }) {
  const body = useRef<HTMLSpanElement>(null);
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  // 展开之后就量不出「截没截」了，得一直能收回去。
  const toggles = open || clipped;
  return <blockquote className={`message-quote${open ? " is-open" : ""}`}>
    <span ref={body} id={bodyId} className="message-quote__text">{text}</span>
    {toggles && <button
      type="button"
      className="message-quote__toggle"
      aria-expanded={open}
      aria-controls={bodyId}
      aria-label={open ? "收起引文" : "展开引文"}
      onClick={() => setOpen((value) => !value)}
    ><CaretDown size={11} weight="bold" /></button>}
  </blockquote>;
}
