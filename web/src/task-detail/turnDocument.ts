// 一条 agent 气泡:若干分段 → **一份文档 + 几个步骤位置**。
//
// 分段(conversationSegments)回答的是「工具调用插在正文的第几个字之后」,它从来不是
// 「几份正文」。可上一版真把它当成几份正文渲染了 —— 每段各自过一遍渲染器,于是整篇文档
// 级的定义(链接引用定义、脚注定义)只要跨过一个工具步骤就两头落空:前一段没有定义、后一
// 段没有引用它的正文,那张截图谁都画不出来,而附件卡片已经被认领走(审查第 3 轮 R2 实测:
// 页面 0 图 0 卡片,同一份正文完整渲染则有 1 张红图)。
//
// 所以这里把分段**折算**成一份文档:
//   · 正文拼回去,配图也在整条消息上配一次(turnImageDocument);
//   · 每一段的执行事件 + 附件卡片变成一个「步骤」,带着它在正文里的偏移;
//   · 折叠(执行过程)只是「前几个步骤 + 前面那截正文收起来」,仍在同一棵语法树里完成。
// 渲染侧照着偏移把步骤插进顶层块之间(见 components/markdownLayout)。
import { isVisibleExecutionEvent, type ExecutionEvent } from "../lib/executionTrace.ts";
import type { AgentContentSegment } from "./conversationModel.ts";
import { turnImageDocument } from "./turnImages.ts";
import { handsOnPivot, splitTurnSegments } from "./turnFold.ts";

/** 正文中间的一步:这一步的执行事件、这一步交上来的附件卡片,以及它排在正文哪儿。 */
export type TurnStop = {
  id: string;
  /** 这一步之后那段正文在**改写后**的整条正文里的起点。 */
  offset: number;
  events: ExecutionEvent[];
  attachments: string[];
};

export type TurnDocument = {
  /** 整条消息的正文(图已经配好)。 */
  text: string;
  /** 全部步骤,按正文顺序。前 `fold.stops` 个属于「执行过程」折叠块。 */
  stops: TurnStop[];
  /**
   * 折叠块:前 `stops` 个步骤、以及偏移 < `offset` 的顶层块收进去。null = 这一回合不折
   * (还在飞、折不出结论、或者折进去一个字都看不见)。
   */
  fold: { stops: number; offset: number } | null;
};

const hasContent = (stop: TurnStop): boolean =>
  stop.attachments.length > 0 || stop.events.some(isVisibleExecutionEvent);

export function turnDocument(
  segments: AgentContentSegment[],
  { live, taskId }: { live: boolean; taskId?: string },
): TurnDocument {
  const { markdown, claimed, remap } = turnImageDocument(
    segments.map((segment) => segment.markdown).join(""),
    segments.flatMap((segment) => segment.attachmentSources ?? []),
    taskId,
  );
  // 正文认领走的那几份拷贝不再铺卡片 —— 它们已经画在正文里了。
  const cards = (paths: string[]): string[] => (
    claimed.size ? paths.filter((path) => !claimed.has(path)) : paths
  );
  // 每一段正文在原文里的起点,改写之后挪到新坐标上。
  const starts: number[] = [];
  let consumed = 0;
  for (const segment of segments) {
    starts.push(remap(consumed));
    consumed += segment.markdown.length;
  }

  // 跑的时候不折 —— 连「切成过程 / 结论」这一步都不做(见 turnFold)。折叠是个重组动作:
  // 它会把已经说出口、已经露在外面的正文一并收进过程块,跑的中途干这件事,用户正读的内容
  // 说没就没。这一回合收口那一下才折,位置从此不再变。
  const flat = (): TurnDocument => ({
    text: markdown,
    stops: segments.map((segment, index) => ({
      id: segment.id,
      offset: starts[index] ?? 0,
      events: segment.events,
      attachments: cards(segment.attachments),
    })),
    fold: null,
  });
  if (live) return flat();

  // `process` 为空 = 这一回合没得折(没动过手),或者折完一个字都不剩 —— 两种都维持平铺。
  const { process, conclusion } = splitTurnSegments(segments);
  if (!process.length) return flat();
  // 切点常落在**一段之内**:最后一次动手的那几个事件归过程,紧跟着的正文和附件归结论
  // (见 splitTurnSegments)。所以那一段在这里是**两个步骤**,偏移相同。
  const pivot = handsOnPivot(segments);
  // 过程块里排在切点之后的还有一个「记账调用」步骤(splitTurnSegments 并进来的),它没有
  // 正文,所以偏移跟切点那一段同一个。
  const folded: TurnStop[] = process.map((segment, index) => ({
    id: segment.id,
    offset: starts[Math.min(index, pivot)] ?? 0,
    events: segment.events,
    attachments: cards(segment.attachments),
  }));
  const offset = starts[pivot] ?? markdown.length;
  // 折进去一个字都看不见就不折:只有画不出来的后台通知、又没有正文被收进去时,折叠条底下
  // 是一片空白,用户只能对着它猜发生了什么(与上一版 `process.some(可见)` 同一口径)。
  if (offset <= 0 && !folded.some(hasContent)) return flat();
  const rest: TurnStop[] = conclusion.map((segment, index) => ({
    id: segment.id,
    offset: starts[pivot + index] ?? markdown.length,
    events: segment.events,
    attachments: cards(segment.attachments),
  }));
  return { text: markdown, stops: [...folded, ...rest], fold: { stops: folded.length, offset } };
}
