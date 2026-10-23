import type { AgentEvent } from "@ash/shared";
import type { MarkdownImageSink } from "./markdown-image-stream.js";
import type { NativeActivityBuffer } from "./native-activity-buffer.js";

// 「CLI 吐出一行 → 事件流里出来一条」中间那条流水线,**整个应用只写一次**。
//
// 它原先在十四个地方各抄了一份(parsers.ts 的 textParser、目录里十个内联解析器、
// claude-stream、codex、codex-app-server):`queue` + `resolve` + `finished` + `push` + 末尾
// 那个 `while (true)` 取队列。抄得一模一样,所以每多一档处理就要改十四处 —— 而漏掉一处是
// 静默的。
//
// 真出过事的那一档是**图片记账的时点**:字节必须在「协议读到那一行」那一刻就冻住,而这些
// 入口全都先攒缓冲(token 级增量攒成小块、子智能体活动按 40 字合并)、再排一条消费者自己
// 来取的队列。记账挂在下游取事件那一刻时,中间 agent 完全来得及把同一个路径重拍一遍 ——
// 正文写着「修改前是红色」,存下来的是后来那张蓝图(审查第 5 轮 R1:只把消费端的等待从 0
// 改成 240 ms 就能复现;第 6 轮 R1:默认 generic 队列和短子正文缓冲各一例)。
//
// 所以把顺序钉在这里,而不是要求每个入口「记得在某个 push 之后补个钩子」:
//
//     delta(原始正文增量) ─┐
//                          ├→ images.capture(冻结字节) → 增量合并 → 活动合并
//     push(整条事件) ──────┘        → images.release(交代附件) → queue → drain()
//
// 新写一个解析器只能从 `ctx.events` 拿到这条流水线(见 catalog/types.ts),拿不到裸队列,
// 于是没有「谁家忘了接」这回事。

/** 会被攒成小块再发的两种增量。 */
export type DeltaKind = "text" | "thinking";

export type EventQueueOptions = {
  /** 正文图片账本。不给 = 这条流的正文图片由别处收(见 generic.ts 的 ownsMarkdownImages)。 */
  images?: MarkdownImageSink;
  /** 子智能体活动的合并缓冲(claude / codex app-server 两家有子智能体)。 */
  activity?: NativeActivityBuffer;
  /**
   * 增量攒到多少字才发。缺省 = 不攒,逐条发。
   *
   * 为什么要攒:DeepSeek 一类**把完整 reasoning 正文流回来**的模型,一个词就是一条增量
   * (实测一轮 10 万条、平均 3.6 字符),逐条转成事件会让 SSE、trace 落盘和「执行过程」的
   * 行数放大一百倍。思考取更粗的一档:它在折叠块里只显示一行摘要,不像正文那样要逐字顺滑。
   */
  coalesce?: Partial<Record<DeltaKind, number>>;
};

export type EventQueue = {
  /** 协议读到的一段**原始正文增量**:字节当场冻结,事件按阈值攒着再发。 */
  delta(kind: DeltaKind, text: string): void;
  /** 一条完整事件:攒着的增量先收口,再把它放进流里。 */
  push(event: AgentEvent): void;
  /** 攒着的增量立刻收口(进程退出、回合收尾时)。 */
  flush(): void;
  /** 已经收过尾了吗 —— 终止路径的重入判据,也是 forceFinishOnExit 要问的那一问。 */
  readonly closed: boolean;
  /** 这条流到头了:`drain()` 取完队列就结束。 */
  close(): void;
  /** 解析器把它直接 `yield*` 出去就是事件流本体。 */
  drain(): AsyncIterable<AgentEvent>;
};

export function eventQueue(options: EventQueueOptions = {}): EventQueue {
  const { images, activity, coalesce } = options;
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let buffered: { kind: DeltaKind; text: string } | null = null;

  const wakeUp = () => {
    wake?.();
    wake = null;
  };

  const enqueue = (event: AgentEvent) => {
    const settled = activity ? activity.push(event) : [event];
    for (const one of settled) queue.push(...(images ? images.release(one) : [one]));
    wakeUp();
  };

  const flush = () => {
    const pending = buffered;
    if (!pending) return;
    buffered = null;
    enqueue(pending.kind === "text" ? { kind: "text", text: pending.text } : { kind: "thinking", text: pending.text });
  };

  return {
    delta(kind, text) {
      if (!text) return;
      // **冻结字节就在这一刻**:后面还隔着增量合并、活动合并和整条队列。
      images?.capture(kind === "text" ? { kind: "text", text } : { kind: "thinking", text });
      if (buffered && buffered.kind !== kind) flush();
      const joined = (buffered?.text ?? "") + text;
      buffered = { kind, text: joined };
      const threshold = coalesce?.[kind];
      if (!threshold || joined.length >= threshold || joined.includes("\n")) flush();
    },
    push(event) {
      // 攒着的增量必须排在**任何**后到的事件之前,否则思考会漂到它引出的工具调用后面。
      flush();
      images?.capture(event);
      enqueue(event);
    },
    flush,
    get closed() {
      return closed;
    },
    close() {
      flush();
      closed = true;
      wakeUp();
    },
    async *drain(): AsyncIterable<AgentEvent> {
      while (true) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
