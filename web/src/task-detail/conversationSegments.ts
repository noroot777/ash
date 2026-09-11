// 一回合的 trace 事件 → 气泡正文里的「分段」。
//
// 一颗 agent 气泡不是一整块 Markdown:正文被工具、思考、附件切成若干段,渲染时正文照
// 常显示、工具收进「执行过程」折叠块。切分只看 trace 的事件顺序,但**正文的权威是
// .md**(见 alignedSegments) —— 这里只负责把两者对齐成一串段落。
//
// 从 conversationModel 拆出来的一族:那边管「会话 → 气泡」,这里管「事件 → 段落」。
import type { AgentEvent } from "@ash/shared";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ExecutionEvent } from "../lib/executionTrace.ts";

// 「执行过程」块里的一行(工具 / 思考 / 异常)。形状与渲染都归 lib/executionTrace,
// 普通任务、团队、辩论共用同一份 —— 这里只保留旧名字的别名。
export type AgentAuxEvent = ExecutionEvent;

export type AgentContentSegment = {
  id: string;
  markdown: string;
  events: AgentAuxEvent[];
  attachments: string[];
};

export type AgentTraceEvent = Extract<AgentEvent, { kind: "thinking" | "tool" | "error" }>;
type TracedContentEntry = SessionTraceEntry & {
  event: Exclude<SessionTraceEntry["event"], { kind: "usage" | "run" }>;
};
type TracedAttachmentEntry = TracedContentEntry & {
  event: Extract<SessionTraceEntry["event"], { kind: "attachment" }>;
};

export function auxEvent(event: AgentTraceEvent, at?: string): AgentAuxEvent {
  if (event.kind === "tool") return { kind: "tool", label: event.name, detail: event.detail, ...(at ? { at } : {}), ...(event.nativeWork ? { nativeWork: event.nativeWork } : {}) };
  if (event.kind === "thinking") return { kind: "thinking", label: "思考过程", detail: event.text };
  return { kind: "error", label: event.message };
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
      events: auxEntries.map((entry) => auxEvent(entry.event as AgentTraceEvent, entry.at)),
      attachments: attachmentEntries.map((entry) => entry.event.path),
    }];
  }

  const segments: AgentContentSegment[] = [];
  let current: AgentContentSegment = { id: `${idPrefix}:0`, markdown: "", events: [], attachments: [] };
  const pushCurrent = () => {
    if (!current.markdown && !current.events.length && !current.attachments.length) return;
    segments.push(current);
    current = { id: `${idPrefix}:${segments.length}`, markdown: "", events: [], attachments: [] };
  };
  for (const entry of entries) {
    if (entry.event.kind === "text") {
      current.markdown += entry.event.text;
      continue;
    }
    if (entry.event.kind === "attachment") {
      if (current.markdown) pushCurrent();
      if (!current.attachments.includes(entry.event.path)) current.attachments.push(entry.event.path);
      continue;
    }
    if (current.markdown) pushCurrent();
    current.events.push(auxEvent(entry.event, entry.at));
  }
  pushCurrent();

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
    events: auxEntries.map((entry) => auxEvent(entry.event as AgentTraceEvent, entry.at)),
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
