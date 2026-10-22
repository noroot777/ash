// 一回合的 trace 事件 → 气泡正文里的「分段」。
//
// 一颗 agent 气泡不是一整块 Markdown:正文被工具、思考切成若干段,渲染时正文照常显示、
// 工具收进「执行过程」折叠块。切分只看 trace 的事件顺序,但**正文的权威是 .md**
// (见 alignedSegments) —— 这里只负责把两者对齐成一串段落。
//
// **执行事件的布局不许改变 Markdown 的语法边界。** 每一段最后都各自过一遍渲染器,所以
// 切点一旦落在块中间,同一份正文在「整条消息」和「分段」两种口径下解析结果就不一样:
// 一对反引号被切开之后,后半段里的写法示例会被真的画成图片;真截图的写法被切开之后,
// 两段谁都不认它(审查第 2 轮 F2、第 3 轮 R2 实测:整条消息 0 个图片节点、切成两段各认
// 出 1 个)。所以切点统一由 shared 的 stableBlockBoundary 挪到顶层块边界上,附件事件
// 则压根不切段。
//
// 从 conversationModel 拆出来的一族:那边管「会话 → 气泡」,这里管「事件 → 段落」。
import type { AgentEvent } from "@ash/shared";
import { stableBlockBoundary } from "@ash/shared/markdown-images";
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
   * 「正文第几处 `![](…)` 引用对上哪一份拷贝」——服务端落盘时逐处标的（见 shared 的
   * attachment 事件）。`attachments` 按 path 去重、只管铺卡片；这里**逐处引用一条**，
   * 一处都不少：同一份拷贝挂着两个名字是两条，同一个路径被重拍过是两条，**没存下副本
   * 的那处也有一条**（`path` 缺省）。配对只认它，不认文件名、不认出场顺序（见 turnImages）。
   */
  attachmentSources?: AttachmentSource[];
};

/**
 * `path` 缺省 = 这处引用确实没有副本；`ref` 缺省 = 老数据（当时还没有逐处身份）。
 * `lost: true` = 服务端当时**读到了字节、写盘失败了**，这一刻的画面丢了（见 shared 的
 * attachment 事件）——那一处只能显式作废，不能拿「现在的文件」顶上。
 */
export type AttachmentSource = { path?: string; source: string; ref?: number; pos?: number; lost?: boolean };

/**
 * 执行事件要插进正文中间了,切点落在哪 —— 返回 0 = 这一刻切不动,别切。
 *
 * 两种情形:
 *   · **后面还会来正文**(`final` 为假):只许切在顶层块边界上(理由见文件头)。还没写完的
 *     那一块(未闭合的围栏、还在写的段落、没合上的反引号)跟着下一段走,各段正文拼回去一
 *     个字不差;整段正文就是一个没写完的块时返回 0 —— 干脆不切,事件挂在这一段上,卡片渲
 *     染在这一段正文之前(见 turnDocument 的步骤偏移),顺序仍然说得通:那一块是在这一
 *     步之后才写完的。
 *   · **后面不会再来正文了**:这一段的正文已经是完整的一份 Markdown,切在它**末尾**是安
 *     全的 —— 新开那一段压根没有正文,两种口径下的解析结果不可能不一样。少了这一档,「正
 *     文说完、最后调一次工具」就不另起一段了(段落没有收尾空行,恒被判成「还没写完」),
 *     而那颗卡片本该排在正文后面。
 *
 * 直播那一路(conversationLiveTurns)永远传假:下一片正文随时会来,算不出「不会再来」。
 */
export function eventSplitAt(markdown: string, final: boolean): number {
  if (!markdown) return 0;
  return final ? markdown.length : stableBlockBoundary(markdown);
}

/**
 * 这一段在正文里画得出东西吗 —— **正文布局的唯一口径**,直播分段、落盘重建、折叠展开
 * 三条路都问这一个函数。
 *
 * 为什么需要它:子智能体往同一串 events 里塞的 activity / result / agent 通知和带
 * parentId 的嵌套调用,渲染侧四个入口都先 filter 一道 `isVisibleExecutionEvent`,一个字
 * 都不画。可它们仍会被切成**自己的一段**,上一版于是在正文后面多出一个空 `<section>`,
 * 空的也占间距,scrollHeight 跟着涨,贴底逻辑看见底边下移就把正在读的人拽到底(审查第 6
 * 轮 F1)。现在正文只渲染一次、步骤按偏移插进去(见 turnDocument),画不出东西的步骤压根
 * 不进 DOM;这个谓词仍是折叠块「折进去有没有东西」的口径。
 *
 * 注意事件本身**不能丢**:子智能体抽屉的数据(`buildNativeWork`)就是从
 * `segments[].events` 里提的。所以口径是「不让它单独成段」,不是「不要它」。
 */
export function segmentHasVisibleContent(segment: AgentContentSegment): boolean {
  if (segment.markdown) return true;
  if (segment.attachments.length) return true;
  return segment.events.some(isVisibleExecutionEvent);
}

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
  return { kind: "error", label: text(event.message) };
}

function attachmentSources(entries: TracedAttachmentEntry[]): AttachmentSource[] | undefined {
  const sources = entries
    .filter((entry) => !!entry.event.source)
    .map((entry) => ({ path: entry.event.path, source: entry.event.source!, ref: entry.event.ref, pos: entry.event.pos, lost: entry.event.lost }));
  return sources.length ? sources : undefined;
}

/** 铺得出卡片的那几张（没有 path 的 attachment 只是「这处引用没副本」的交代）。 */
function attachmentPaths(entries: TracedAttachmentEntry[]): string[] {
  return entries.map((entry) => entry.event.path).filter((path): path is string => !!path);
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
    return [{
      id: `${idPrefix}:0`,
      markdown: fallbackMarkdown,
      events: auxEvents(auxEntries),
      attachments: [...new Set(attachmentPaths(attachmentEntries))],
      attachmentSources: attachmentSources(attachmentEntries),
    }];
  }

  const segments: AgentContentSegment[] = [];
  let current: AgentContentSegment = { id: `${idPrefix}:0`, markdown: "", events: [], attachments: [] };
  const newCurrent = () => ({ id: `${idPrefix}:${segments.length}`, markdown: "", events: [], attachments: [] });
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
    current = newCurrent();
  };
  const splitForEvent = (final: boolean) => {
    const cut = eventSplitAt(current.markdown, final);
    if (!cut) return;
    const tail = current.markdown.slice(cut);
    current.markdown = current.markdown.slice(0, cut);
    pushCurrent();
    current.markdown = tail;
  };
  // 后面还会不会再来正文 —— 回放整串事件时这是算得出来的,`eventSplitAt` 要用它。
  const lastText = entries.reduce((last, entry, index) => entry.event.kind === "text" ? index : last, -1);
  for (const [index, entry] of entries.entries()) {
    if (entry.event.kind === "text") {
      current.markdown += entry.event.text;
      continue;
    }
    if (entry.event.kind === "attachment") {
      // **附件不切段**。卡片铺在那一段正文下面,位置本来就不靠切段表达;而切了段,同一条
      // 消息的正文就被分成两份分别解析 —— 一对反引号被切开之后,里面的写法示例在后半段
      // 里成了「真图」(审查第 2 轮 F2 实测:它真的显示出了截图)。执行事件的布局不许改变
      // Markdown 的语法边界,所以这里只收集,不动分段。
      if (entry.event.path && !current.attachments.includes(entry.event.path)) current.attachments.push(entry.event.path);
      if (entry.event.source) {
        (current.attachmentSources ??= []).push({ path: entry.event.path, source: entry.event.source, ref: entry.event.ref, pos: entry.event.pos, lost: entry.event.lost });
      }
      continue;
    }
    const event = auxEvent(entry.event, entry.at);
    // 画不出来的通知不另起一段(见 segmentHasVisibleContent):单独成段就是正文后面
    // 那个空 section。事件照旧挂在当前段上,抽屉那边仍取得到。
    if (current.markdown && isVisibleExecutionEvent(event)) splitForEvent(index > lastText);
    current.events = appendExecutionEvent(current.events, event);
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
    attachments: attachmentPaths(attachmentEntries),
    // 关联**不能跟着分段一起丢**。这一支是「trace 与权威正文真发散」的兜底:正文照旧
    // 整块显示,而每一处引用对应哪一份拷贝跟分段无关 —— 丢了它,正文那几句就配不上已经
    // 存着的正确副本,读时兜底又会拿**当前**文件去画(说的是红图、画出来是蓝图,
    // 审查第 1 轮 F1 实测 B)。
    attachmentSources: attachmentSources(attachmentEntries),
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
