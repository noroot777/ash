// 「正文里的图」那条流的**收口**:withMarkdownImages / settleMarkdownImages。
// 从 markdown-image-stream.ts 拆出来只为守 700 行上限;账本本体与出口语义都在那边。
import type { AgentEvent } from "@ash/shared";
import { markdownImageSink, type MarkdownImageAccounting, type MarkdownImageSink } from "./markdown-image-stream.js";

/**
 * 给**任意**事件流补上「正文里提到的那张本机图片」。
 *
 * 生产路径上的入口是 event-queue.ts 的 EventQueue:捕获必须排在增量合并、活动合并和队列
 * **之前**,而一层流包装只看得见「事件已经出来了」那一刻。这个函数是**兜底加语义参考**
 * —— 没走那条流水线的事件(解析器自己 yield 的)由 settleMarkdownImages 补记一次账。
 */
export function withMarkdownImages(
  events: AsyncIterable<AgentEvent>,
  cwd?: string,
  accounting?: MarkdownImageAccounting,
): AsyncIterable<AgentEvent> {
  return settleMarkdownImages(events, markdownImageSink(cwd, accounting));
}

/**
 * 已经在入口处记过账的那条流:负责**收口** —— 正常收尾、上游抛错、提前中断三条路都得
 * 有个了结。
 *
 * 抛错那条路必须在重新抛出**之前**把图交代完:上游一抛,正常收尾的那几句全被跳过(审查
 * 第 5 轮 R3)。消费者这时还在取事件(异常是它调 next() 时才抛到它手里的),所以这几条
 * attachment 送得出去。
 *
 * 消费者自己抛错/提前 break 那条路**没法再 yield**(调用方已经不取了),所以它只走 finally
 * 里的清理 —— 那一档靠两件事兜住:交代是**跟着正文一起发**的(语法一定型就发,不等回合
 * 收尾),以及 dispose 不删「语法已经认下它」的拷贝(见那里的注释)。
 */
export async function* settleMarkdownImages(
  events: AsyncIterable<AgentEvent>,
  sink: MarkdownImageSink,
): AsyncIterable<AgentEvent> {
  try {
    try {
      for await (const event of events) {
        // 已经从 EventQueue 走过账的原样放行;没走过的在这儿补记一次(见 sink.noted)。
        if (sink.noted(event)) {
          yield event;
          continue;
        }
        sink.capture(event);
        yield* sink.release(event);
      }
    } catch (error) {
      for (const event of sink.close()) yield event;
      throw error;
    }
    for (const event of sink.close()) yield event;
  } finally {
    sink.dispose();
  }
}
