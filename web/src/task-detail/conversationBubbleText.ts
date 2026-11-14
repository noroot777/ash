// 带身份那一路一颗气泡的正文与执行过程 → 整颗正文 + 展示分段（conversationAssembler 收尾时调）。
//
// 一颗气泡只有**一份原文**：盘上那几段正文的原样字符（.md 里的 raw，不裁空白）接上实时到的增量（按
// `textOffset` 去掉盘上已有的字）。执行过程的每一步记着「它之前已经有多少个字」—— 由服务端给的锚点换算
// （trace 那一行与实时事件都带着 `textAt`：哪段正文写到第几个字，见 shared/src/session-output.ts 的
// TextAnchor），不拿本地此刻读到了多少字去猜：正文与 trace 是分两次读的，读到的进度不一样。
// 整颗正文、展示分段、复制和导出全从这一份原文派生：按每一步的位置把原文切成几块正文条目、
// 跟步骤交错排好，交给落盘重建那一路同一个分段函数（contentSegments）。切出来的正文条目拼起来就是整颗
// 正文本身，分段函数不必再拿两份文字去对齐。
//
// 所以中途打开页面、从头看实时、刷新以后，三路喂给分段函数的是同一份原文和同一串位置，切法一样；不会
// 因为快照里那一段为了展示裁过空白，后到的字就接到裁过的那一份上（`Hello ` + `world` 接成 `Helloworld`、
// 标题吞掉下一段、未闭合的代码块被一步工具拆开）。
//
// 展示时只去掉原文**开头的空行**和**末尾的空白**；开头那一行的缩进留着（它可能是一段缩进代码）。
import type { SessionTraceEntry } from "../lib/api.ts";
import { contentSegments, type AgentContentSegment } from "./conversationSegments.ts";

/** 一步执行过程，连同它之前原文里已经有多少个字。 */
export type PlacedStep = { entry: SessionTraceEntry; at: number };

const LEADING_BLANK_LINES = /^(?:[ \t]*\n)+/;

/**
 * 原文 + 按位置排好的步骤（读的时候补出来的那几条已经按时刻插进去了）→ 整颗正文与展示分段。
 * 步骤的位置不会往回退：后一步落在前一步之前的（落盘的 trace 比 .md 读得晚、正文条目多几个字）按前一步算。
 */
export function bubbleText(raw: string, steps: readonly PlacedStep[], idPrefix: string): { markdown: string; segments: AgentContentSegment[] } {
  const lead = LEADING_BLANK_LINES.exec(raw)?.[0].length ?? 0;
  const markdown = raw.slice(lead).trimEnd();
  const entries: SessionTraceEntry[] = [];
  let cursor = 0;
  let floor = 0;
  const text = (to: number) => {
    if (to > cursor) entries.push({ at: "", turnStartedAt: "", event: { kind: "text", text: markdown.slice(cursor, to) } } as SessionTraceEntry);
    cursor = Math.max(cursor, to);
  };
  for (const step of steps) {
    floor = Math.max(floor, step.at);
    text(Math.min(markdown.length, Math.max(0, floor - lead)));
    entries.push(step.entry);
  }
  text(markdown.length);
  return { markdown, segments: contentSegments(entries, markdown, idPrefix) };
}
