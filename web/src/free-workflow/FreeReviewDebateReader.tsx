import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import type { FreeReviewDebate } from "@ash/shared";
import { useDismissable } from "../lib/useDismissable.ts";
import { FreeReviewDebateTranscript } from "./FreeReviewDebateTranscript.tsx";
import { debateStatusText } from "./debateModel.ts";

/**
 * 辩论全文的阅读态。
 *
 * 为什么要单独一层：辩论正文原本只在审查面板那一栏里渲染，而那栏只有 ~540px 宽——七段
 * 发言在里面被压成一根 542 × 10692px 的细条，得滚二十屏（用户 2026-09-24 实测）。正文
 * 的归属没错（报告、驳回理由、四个出口都在那张卡上），错的是读不下去。所以不搬家，只
 * 给它一个够宽的读法。
 *
 * 入口有两个——时间线上那张折叠卡、审查面板里的驳回卡——但只有这一个组件：两个入口两
 * 套排版的话，同一段话会长出两种样子。
 *
 * 层语义整个交给 `useDismissable`（点遮罩、Esc 关最上面那层、焦点还回去），这里不另加
 * 特判：它已经在捕获阶段吃掉 Esc 并 `stopPropagation`，直接听 document 的全局快捷键收
 * 不到；而自己再拦一道的话，阅读态之上再开确认框时，一下 Esc 会把两层一起关掉。
 */
export function FreeReviewDebateReader({
  debate,
  title,
  ordinal = null,
  onClose,
}: {
  debate: FreeReviewDebate;
  /** 「第 1 轮审查意见 · 顶级审查」这类出处，读的时候得知道辩的是哪一份报告。 */
  title: string;
  ordinal?: number | null;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useDismissable({ enabled: true, containerRef: box, onClose });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  return createPortal(
    <div
      className="debate-reader"
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-label={`审查意见辩论全文：${title}`}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <article className="debate-reader__sheet">
        <header>
          <div>
            <b>审查意见辩论{ordinal ? ` · 第 ${ordinal} 次` : ""}</b>
            <small>{title} · {debateStatusText(debate)}</small>
          </div>
          <button type="button" onClick={onClose} aria-label="退出阅读（Esc）">
            <X size={14} />Esc
          </button>
        </header>
        <div className="debate-reader__body">
          <FreeReviewDebateTranscript debate={debate} variant="reading" />
        </div>
      </article>
    </div>,
    document.body,
  );
}
