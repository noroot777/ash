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
 * `open` 是**这份内容的默认档**，不是「首次挂载时的档」：老数据没有摘要，这时正文是用户
 * 唯一能读到的东西，必须摊开——折起来就成了「什么都没有」。
 */
export function FoldedProse({ label, text, open: initiallyOpen = false, tone = null }: {
  label: string;
  text: string;
  open?: boolean;
  /** 配色档：`defer` 是「认可但越界」那一段，视觉上与「不认这条」分开。 */
  tone?: "defer" | null;
}) {
  // 展开状态挂在**这份内容**上，不挂在「组件这个位置」上。`useState(initiallyOpen)` 只在
  // 首次挂载时取值，而历史报告抽屉切换轮次时复用的是同一个 FoldedProse 位置
  // （FreeWorkflowInspector 的 reason/defer 两处）：甲轮手动展开会跟着切到乙轮，乙轮那条
  // 该默认摊开的老记录反倒是收起的 —— 用户以为「这条没写理由」（第 1 轮审查 N1 实测）。
  //
  // 身份直接用正文本身：内容一换就回到这份内容自己的默认档，内容没换（父级重渲染）就保留
  // 用户刚才的手动操作。**不用调用方传 key**——这一屏有 5 个调用点，靠每处记得传就是在等
  // 下一处漏传；两份内容真的一字不差时共用展开状态也正是对的。
  const [manual, setManual] = useState<{ of: string; open: boolean } | null>(null);
  const open = manual?.of === text ? manual.open : initiallyOpen;
  // 字数按去掉空白算：中文正文里空白几乎只有排版用的换行，算进去会虚报一两成。
  const chars = text.replace(/\s+/g, "").length;
  return (
    <div className={`folded-prose${open ? " is-open" : ""}${tone ? ` is-${tone}` : ""}`}>
      <button type="button" aria-expanded={open} onClick={() => setManual({ of: text, open: !open })}>
        <CaretRight size={10} weight="bold" aria-hidden="true" />
        <b>{label}</b>
        <em>{chars} 字</em>
      </button>
      {open && <MarkdownBody text={text} />}
    </div>
  );
}
