import { useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { MarkdownBody } from "./MarkdownBody.tsx";

/**
 * 一段 agent 写的长正文，默认折起来，标题上报字数。
 *
 * 为什么要它：驳回理由和辩论发言是 agent 写给**对手**看的技术论述（真实样本 1000~3500
 * 字、一段到底、满篇路径行号），而它们出现的位置是**用户要拍板**的那张卡。一墙字拍上来，
 * 用户连「有几个选项」都看不见（用户 2026-10-20：「一大篇文字都看不懂」）。
 *
 * 折叠**不解决「看不懂」**——展开之后还是那一墙字，所以它只是配角：正文旁边必须另有一句
 * 人话摘要（`PLAIN_SUMMARY_GUIDE`，落在结构化字段里）。折叠负责的是「别挡路」。
 *
 * `open` 只作初始值：老数据没有摘要，这时正文是用户唯一能读到的东西，必须摊开——折起来
 * 就成了「什么都没有」。
 */
export function FoldedProse({ label, text, open: initiallyOpen = false, tone = null }: {
  label: string;
  text: string;
  open?: boolean;
  /** 配色档：`defer` 是「认可但越界」那一段，视觉上与「不认这条」分开。 */
  tone?: "defer" | null;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  // 字数按去掉空白算：中文正文里空白几乎只有排版用的换行，算进去会虚报一两成。
  const chars = text.replace(/\s+/g, "").length;
  return (
    <div className={`folded-prose${open ? " is-open" : ""}${tone ? ` is-${tone}` : ""}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <CaretRight size={10} weight="bold" aria-hidden="true" />
        <b>{label}</b>
        <em>{chars} 字</em>
      </button>
      {open && <MarkdownBody text={text} />}
    </div>
  );
}
