// 会话 .md 的解析：把一份落盘正文拆回有序的一段段（agent 正文 / 真人或后端的插话 / 系统注记）。
//
// A persisted session .md is mostly agent Markdown, but backend continues and
// 你→@agent replies are interleaved as their own turns. New runs write each as a
// \x1e + JSON sentinel line (carrying a timestamp); older runs used inline
// 〔系统〕…/〔你 → @x〕… markers. Split the blob back into ordered segments so each
// turn renders as its own bubble instead of bleeding into the agent text around it.
// Shared by web (TaskDetail)、mobile (log.ts)、MCP read_task_transcript 与服务端各读者，
// so they never drift apart.
//
// **被删除的消息**（server/src/conversation-redact.ts）在盘上就地抹掉正文，只留一行带
// `deleted:true` 的 sentinel 占住原来的位置：段落的序号、回合边界、trace 的切点都不因
// 删除而挪动。默认解析把它们滤掉 —— 任何读正文的人（下一轮重建上下文、追问列表、重试
// 取上一条输入、MCP 读转录）都天然读不到；只有要按原位排版的界面传 `keepDeleted`。
import type { MonitorWakeData } from "./monitor-wake.ts";
import { LEGACY_SYS_MARKER } from "./index.ts";

export type ConvSeg =
  | { kind: "agent"; text: string; endedAt?: string; deleted?: true }
  // bySystem：走真人回合通道、但作者是后端的那种（验证打回、验收冲突交接）。
  // 它们**必须**是 user 回合（要 followUpFrom 护住任务原来的终态），所以只能另开一位来标。
  | { kind: "user"; text: string; at?: string; bySystem?: true; monitorWake?: MonitorWakeData; deleted?: true }
  // level:"notice" = 结算说明（「这一轮为什么落成这个状态」），由 server 结算时写下。
  // 展示端据此上「提示」的语气，而不是让关键词表去猜——说明里天然带着「未完成」这种词。
  // aside:true = 任务时间线旁注（appendTaskTimeline 写的那些：预约审查、验收阶段更新、
  // 预览起停…）。它不是说给 agent 听的话，也不开/不收一个回合——落在哪一秒纯属偶然，
  // 常常正砸在某一回合说到一半的地方，所以展示端不能拿它当回合边界（见 events.ts）。
  | { kind: "system"; text: string; at?: string; level?: "notice"; aside?: true; deleted?: true };

/** 一段连同它在原文里占的行（含首尾，按 `\n` 切出来的行号）。删除就地改写靠它定位。 */
export type SessionSegmentSpan = { seg: ConvSeg; first: number; last: number };

type Sentinel = {
  t?: string; text?: string; at?: string; by?: string; level?: string; aside?: boolean;
  monitorWake?: MonitorWakeData; deleted?: boolean;
};

export function parseSessionSpans(out: string): SessionSegmentSpan[] {
  const spans: SessionSegmentSpan[] = [];
  let buf: string[] = [];
  let bufFirst = -1;
  let bufLast = -1;
  let skippingDiagnostic = false;
  const push = (seg: ConvSeg, first: number, last = first) => spans.push({ seg, first, last });
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) push({ kind: "agent", text: t }, bufFirst, bufLast);
    buf = [];
    bufFirst = -1;
  };
  out.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    // Backend failure diagnostics are persisted beside the conversation so they
    // remain available in the raw run artifacts. They are not agent speech,
    // though, and rendering them inline makes a normal transcript look like a
    // stream of repeated reconnect errors. Keep them out of conversation bubbles.
    if (!skippingDiagnostic && trimmed === "> **执行诊断**") {
      flush();
      skippingDiagnostic = true;
      return;
    }
    if (skippingDiagnostic) {
      if (!trimmed) {
        skippingDiagnostic = false;
        return;
      }
      if (!line.startsWith("\x1e")) return;
      skippingDiagnostic = false;
    }
    // 老会话专用：2026-08-31 之前，结算说明是直接写进正文的一段引用块，于是「续聊回合
    // 异常结束(…)」这句会糊在 agent 的话里当正文渲染 —— 只能按前缀藏掉。现在结算说明落成
    // 独立的 system 旁注行（带 level:"notice"），根本不进气泡，新会话不需要这道过滤。
    if (trimmed.startsWith("> 续聊回合异常结束(")) return;
    if (line.startsWith("\x1e")) {
      let j: Sentinel | null = null;
      try { j = JSON.parse(line.slice(1)) as Sentinel; } catch { /* not a turn line — ordinary text */ }
      if (j) {
        flush();
        if (j.t === "agentEnd") {
          // Not a new bubble — it stamps where the agent turn that just flushed
          // actually finished, so per-turn 用时 excludes the idle wait that follows.
          const last = spans[spans.length - 1]?.seg;
          if (last?.kind === "agent") last.endedAt = j.at;
          return;
        }
        const deleted = j.deleted === true ? { deleted: true as const } : {};
        if (j.t === "agent") {
          // 只有被删掉的 agent 正文才会落成 sentinel（正常正文是裸 Markdown）。
          if (j.deleted === true) push({ kind: "agent", text: "", deleted: true }, index);
          return;
        }
        push(
          j.t === "system"
            ? {
                kind: "system",
                text: j.deleted === true ? "" : j.text || LEGACY_SYS_MARKER,
                at: j.at,
                ...(j.level === "notice" ? { level: "notice" as const } : {}),
                ...(j.aside === true ? { aside: true as const } : {}),
                ...deleted,
              }
            : {
                kind: "user",
                text: j.text ?? "",
                at: j.at,
                ...(j.by === "system" ? { bySystem: true as const, ...(j.monitorWake ? { monitorWake: j.monitorWake } : {}) } : {}),
                ...deleted,
              },
          index,
        );
        return;
      }
    }
    if (trimmed === LEGACY_SYS_MARKER) {
      flush();
      push({ kind: "system", text: LEGACY_SYS_MARKER }, index);
      return;
    }
    // Legacy reply marker — best-effort (only the first line is recoverable, since
    // old multi-line replies weren't fenced); the rest folds into the next bubble.
    const m = /^〔你 → @[^〕]*〕([\s\S]*)$/.exec(trimmed);
    if (m) {
      flush();
      push({ kind: "user", text: m[1] ?? "" }, index);
      return;
    }
    if (bufFirst < 0) bufFirst = index;
    bufLast = index;
    buf.push(line);
  });
  flush();
  return spans;
}

/**
 * 解析成段。默认**不含被删除的段** —— 读正文的人一律不该看见它们；要按原位排版（序号与
 * trace 切点对齐）的界面传 `keepDeleted: true`，自己决定怎么藏。
 */
export function parseSessionOutput(out: string, options: { keepDeleted?: boolean } = {}): ConvSeg[] {
  const segs = parseSessionSpans(out).map((span) => span.seg);
  return options.keepDeleted ? segs : segs.filter((seg) => !seg.deleted);
}

/**
 * 一段的指纹：删除请求拿「第几段 + 指纹」指名，服务端重新解析后两样都对上才动手 ——
 * 页面上那份正文可能已经旧了（又落了新内容、别处删过一段），光凭序号会删错。
 */
export function segmentFingerprint(seg: ConvSeg): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seg.text.length; index += 1) {
    hash ^= seg.text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const at = seg.kind === "agent" ? "" : seg.at ?? "";
  return `${seg.kind}:${at}:${seg.text.length}:${hash.toString(16)}`;
}
