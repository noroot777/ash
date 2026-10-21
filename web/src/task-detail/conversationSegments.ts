// 一回合的 trace 事件 → 气泡正文里的「分段」。
//
// 一颗 agent 气泡不是一整块 Markdown:正文被工具、思考、附件切成若干段,渲染时正文照
// 常显示、工具收进「执行过程」折叠块。切分只看 trace 的事件顺序,但**正文的权威是
// .md**(见 alignedSegments) —— 这里只负责把两者对齐成一串段落。
//
// 从 conversationModel 拆出来的一族:那边管「会话 → 气泡」,这里管「事件 → 段落」。
import type { AgentEvent } from "@ash/shared";
import type { SessionTraceEntry } from "../lib/api.ts";
import { appendExecutionEvent, isVisibleExecutionEvent, type ExecutionEvent } from "../lib/executionTrace.ts";

// 「执行过程」块里的一行(工具 / 思考 / 异常)。形状与渲染都归 lib/executionTrace,
// 普通任务、团队、辩论共用同一份 —— 这里只保留旧名字的别名。
export type AgentAuxEvent = ExecutionEvent;

export type AgentContentSegment = {
  id: string;
  markdown: string;
  events: AgentAuxEvent[];
  attachments: string[];
  /**
   * 这一段**停在一条过程提示上**:上游在重试/还没回话,提示之后一个字都还没来。
   *
   * 由归约层按事件顺序维护(直播追加与落盘重建两路都写它),展示层只读 —— 别再从段落的
   * 成品结构反推「提示之后有没有恢复」。反推过两次都错在同一个地方:正文、附件、事件在
   * 一段里是**混在一起的累积结果**,读不出谁先谁后,于是「末段有附件」就被当成了恢复
   * (第 3 轮审查 F2)。
   */
  awaiting?: boolean;
};

/**
 * 这一段在正文里画得出东西吗 —— **正文布局的唯一口径**,直播分段、落盘重建、折叠展开
 * 三条路都问这一个函数。
 *
 * 为什么需要它:子智能体往同一串 events 里塞的 activity / result / agent 通知和带
 * parentId 的嵌套调用,渲染侧四个入口都先 filter 一道 `isVisibleExecutionEvent`,一个字
 * 都不画。可它们仍会被切成**自己的一段**,于是正文后面多出一个空 `<section>` ——
 * 空的也占 7px(`.task-agent-segment + .task-agent-segment`),scrollHeight 跟着涨,
 * 贴底逻辑看见底边下移就把正在读的人拽到底(审查第 6 轮 F1)。
 *
 * 注意事件本身**不能丢**:子智能体抽屉的数据(`buildNativeWork`)就是从
 * `segments[].events` 里提的。所以口径是「不让它单独成段」,不是「不要它」。
 */
export function segmentHasVisibleContent(segment: AgentContentSegment): boolean {
  if (segment.markdown) return true;
  if (segment.attachments.length) return true;
  return segment.events.some(isVisibleExecutionEvent);
}

/**
 * 这一串段落此刻**还卡在上游等回话**吗 —— 折叠条上那句「正在重试」要不要常驻(用处见
 * ExecutionSummaryLine 的 `awaiting`)。
 *
 * 只读归约层记下的那一位(见 AgentContentSegment.awaiting):提示置上、随后任何一条输出
 * 置回,顺序由写入那一刻决定。
 */
export function awaitingUpstream(segments: AgentContentSegment[]): boolean {
  return segments.at(-1)?.awaiting === true;
}

/**
 * 这一条执行过程事件进段之后,这一段还在等上游吗 —— 提示置上,别的一概置回。
 *
 * 直播追加与落盘重建共用它(两路各算一份就会漂)。画不出来的子智能体通知也算恢复:
 * 它同样是上游真的吐出来的东西,这一位答的是「还有没有在等」,不是「画不画得出来」。
 */
export const awaitingAfterEvent = (event: AgentAuxEvent): boolean => event.kind === "notice";

export type AgentTraceEvent = Extract<AgentEvent, { kind: "thinking" | "tool" | "error" }>;
type TracedContentEntry = SessionTraceEntry & {
  event: Exclude<SessionTraceEntry["event"], { kind: "usage" | "run" }>;
};
type TracedAttachmentEntry = TracedContentEntry & {
  event: Extract<SessionTraceEntry["event"], { kind: "attachment" }>;
};

/**
 * trace 事件 → 执行过程那一行。
 *
 * `label` 兜底成空串是**故意的**：服务端已经把缺 `name` 的 tool 事件判成坏行并回 500
 * （server/src/transcript.ts 的 `validTraceEvent`），但那是新判据，历史落盘、接力过来的
 * 快照都可能递一条没名字的进来。下游拿 label 去 `split` / `startsWith`（executionTrace.ts、
 * nativeWorkModel.ts），一条坏记录就能把整个任务页卸载成白屏——直播和刷新两路都在这里
 * 汇合，兜一次就够（第 5 轮审查）。
 */
export function auxEvent(event: AgentTraceEvent, at?: string): AgentAuxEvent {
  const text = (value: unknown): string => typeof value === "string" ? value : "";
  if (event.kind === "tool") return { kind: "tool", label: text(event.name), detail: event.detail, ...(at ? { at } : {}), ...(event.nativeWork ? { nativeWork: event.nativeWork } : {}) };
  if (event.kind === "thinking") return { kind: "thinking", label: "思考过程", detail: event.text };
  // level:"notice" = 这条不是故障,是过程里的一句提示(上游在重试、还在等回话)。整句话
  // 走 detail 而不是 label:label 在行内是不收缩的工具名那一格,一条几十字的提示塞进去
  // 会把整行撑爆;detail 那一格本来就是「这一步具体在干什么」,超长自己省略。
  if (event.level === "notice") return { kind: "notice", label: "提示", detail: text(event.message), ...(at ? { at } : {}) };
  return { kind: "error", label: text(event.message) };
}

// 相邻的思考过程合并成一行(见 appendExecutionEvent) —— 整块 trace 一次算完。
function auxEvents(entries: SessionTraceEntry[]): AgentAuxEvent[] {
  return entries.reduce<AgentAuxEvent[]>(
    (events, entry) => appendExecutionEvent(events, auxEvent(entry.event as AgentTraceEvent, entry.at)),
    [],
  );
}

export function contentSegments(
  traced: SessionTraceEntry[],
  fallbackMarkdown: string,
  idPrefix: string,
): AgentContentSegment[] {
  // usage 只是这一回合的账,不是执行过程的一步 —— 漏掉这道过滤它会被 auxEvent
  // 当成未知事件渲染成一行异常。
  const entries = traced.filter((entry): entry is TracedContentEntry => (
    entry.event.kind !== "usage" && entry.event.kind !== "run"
  ));
  const auxEntries = entries.filter((entry) => entry.event.kind !== "text" && entry.event.kind !== "attachment");
  const attachmentEntries = entries.filter(
    (entry): entry is TracedAttachmentEntry => entry.event.kind === "attachment",
  );
  if (!entries.some((entry) => entry.event.kind === "text")) {
    // 一段都没切时(整轮压根没有正文),等待状态由**最后一条**事件决定 —— 附件也算一条输出。
    const last = entries.at(-1);
    const lastAux = last && last.event.kind !== "attachment" && last.event.kind !== "text"
      ? auxEvent(last.event, last.at)
      : null;
    return [{
      id: `${idPrefix}:0`,
      markdown: fallbackMarkdown,
      events: auxEvents(auxEntries),
      attachments: attachmentEntries.map((entry) => entry.event.path),
      awaiting: !!lastAux && awaitingAfterEvent(lastAux),
    }];
  }

  const segments: AgentContentSegment[] = [];
  let current: AgentContentSegment = { id: `${idPrefix}:0`, markdown: "", events: [], attachments: [], awaiting: false };
  const newCurrent = () => ({ id: `${idPrefix}:${segments.length}`, markdown: "", events: [], attachments: [], awaiting: false });
  const pushCurrent = () => {
    if (segmentHasVisibleContent(current)) {
      segments.push(current);
      current = newCurrent();
      return;
    }
    /* 画不出东西的段不进正文布局 —— 空的也占 7px 间距。但事件**不能丢**:子智能体抽屉
       的数据(buildNativeWork)就是从 segments[].events 里提的,所以并回上一段,而不是
       直接 return 把它扔掉。还没有上一段就留在 current 里,等后面的内容进来同段;
       一直等到最后也没有内容进来,由下面的收尾兜住(审查第 7 轮 B5)。 */
    const previous = segments.at(-1);
    if (!previous) return;
    for (const event of current.events) previous.events = appendExecutionEvent(previous.events, event);
    // 并进去的那几条是**更晚**发生的,所以等待状态也跟着过去。
    previous.awaiting = current.awaiting;
    current = newCurrent();
  };
  for (const entry of entries) {
    if (entry.event.kind === "text") {
      current.markdown += entry.event.text;
      current.awaiting = false;
      continue;
    }
    if (entry.event.kind === "attachment") {
      if (current.markdown) pushCurrent();
      if (!current.attachments.includes(entry.event.path)) current.attachments.push(entry.event.path);
      current.awaiting = false;
      continue;
    }
    const event = auxEvent(entry.event, entry.at);
    // 画不出来的通知不另起一段(见 segmentHasVisibleContent):单独成段就是正文后面
    // 那个空 section。事件照旧挂在当前段上,抽屉那边仍取得到。
    if (current.markdown && isVisibleExecutionEvent(event)) pushCurrent();
    current.events = appendExecutionEvent(current.events, event);
    current.awaiting = awaitingAfterEvent(event);
  }
  pushCurrent();
  /* 收尾:**数据优先于布局**。整段 trace 里一个字都没有、只有画不出来的后台通知时,
     上面那条「并回上一段」无处可并(压根没有上一段),事件就卡在 current 里 —— 直接
     返回等于把子智能体那条线的 raw 记录丢了(审查第 7 轮 B5)。
     所以这里原样留下这一段:它画不出东西,渲染侧的 segmentHasVisibleContent 不会给它
     出 section,不占高度;而 buildNativeWork 仍从 segments[].events 里取得到数据。
     分段函数只负责**保全记录**,"画不画"交给展示谓词 —— 两件事不该挤在一层。 */
  if (current.events.length || current.attachments.length) segments.push(current);

  const structuredMarkdown = segments.map((segment) => segment.markdown).join("");
  if (structuredMarkdown.trim() === fallbackMarkdown.trim()) return segments;
  const aligned = alignedSegments(segments, fallbackMarkdown);
  if (aligned) return aligned;
  // Partially written/legacy trace is still useful, but it cannot safely split
  // the body. Keep one process block with the intact Markdown rather than drop or
  // duplicate text.
  return [{
    id: `${idPrefix}:fallback`,
    markdown: fallbackMarkdown || structuredMarkdown,
    events: auxEvents(auxEntries),
    attachments: attachmentEntries.map((entry) => entry.event.path),
  }];
}

/**
 * trace 与 .md 对同一段正文的**原子边界并不总是一致**，于是拼出来的整串常常差一点点，
 * 逐字相等这道闸就把整条回合打回单段（几百次工具糊成一个块，正文一句都拆不开）。
 *
 * 现场最常见的一种：旁注（预约审查…）落盘时 .md 已经把「我」冲进了上一段，而 trace 把
 * 相邻 delta 合并成了一条、时间戳落在旁注之后，于是这一段的 trace 正文比 .md 多一个
 * 「我」字。全库 1881 段里有 172 段是这种一方包含另一方的关系。
 *
 * 只要一方包含另一方，两串就能按偏移对上：**.md 是正文的权威**（它决定这颗气泡该显示
 * 哪些字），trace 只用来定位工具插在正文的第几个字之后。按 trace 的切点换算到 .md 坐标
 * 上重新分段即可。真发散（trace 被截断之类）返回 null，照旧退回单段。
 *
 * 不变量：各段正文拼回去必须**恰好等于** `fallbackMarkdown.trim()` —— 一个字都不能丢、
 * 不能重。最后一段兜到末尾就是为了保证这一点。
 */
function alignedSegments(
  segments: AgentContentSegment[],
  fallbackMarkdown: string,
): AgentContentSegment[] | null {
  const body = fallbackMarkdown.trim();
  const raw = segments.map((segment) => segment.markdown).join("");
  const flat = raw.trim();
  // 兜底气泡那一路会拿空正文来调（trace-only），此时对齐没有意义：indexOf("") 恒为 0,
  // 会把每一段的正文都抹成空串。
  if (!body || !flat) return null;

  const ahead = flat.indexOf(body);
  const behind = body.indexOf(flat);
  const delta = ahead >= 0 ? ahead : behind >= 0 ? -behind : null;
  if (delta === null) return null;

  const lead = raw.length - raw.trimStart().length;
  let consumed = 0;
  let previous = 0;
  return segments.map((segment, index) => {
    consumed += segment.markdown.length;
    const cut = index === segments.length - 1
      ? body.length
      : Math.min(Math.max(consumed - lead - delta, previous), body.length);
    const markdown = body.slice(previous, cut);
    previous = cut;
    return { ...segment, markdown };
  });
}
