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
//
// **记录身份**（`seq` + `turnStartedAt`，见 RecordIdentity）：新写下的每一行 sentinel 都带着
// 「这是这条会话的第几条记录、属于哪个回合」，agent 正文每一段开头另有一行 `t:"agent"` 的标记
// 行带同一套身份（老解析器本来就跳过非删除的 `t:"agent"` 行，所以读者不受影响）。trace 的每一条
// 与实时事件带的是同一个号（server/src/session-seq.ts 发号），页面据此归回合、去重，不再按时间
// 和文字去猜。老记录没有这两位，读端照旧。
// 身份是**一条条记录自己说明的**：带号的那条一定出自带身份的回合（写的一头按回合声明，回合中途不会
// 断号，见 server/src/transcript-identity.ts 文件头），没号的那条就是老样子写的 —— 读端逐条按这个分路，
// 不从别的记录、会话的历史去推。
import type { MonitorWakeData } from "./monitor-wake.ts";
import { timelineNoticeOf, type TimelineNotice } from "./timeline-notice.ts";
import { LEGACY_SYS_MARKER } from "./index.ts";
import { systemResumeOf, type SystemResume } from "./system-resume.ts";

/**
 * 一条记录的身份：这条会话的第几条记录（`seq`，trace 与 .md 共用一个号段，实时事件带同一个值），
 * 以及属于哪个回合（回合起点，跟 trace 的 `turnStartedAt`、`session_turns.started_at` 同一个值；
 * null = 写下它的那一刻没有回合在跑）。老记录没有。
 */
export type RecordIdentity = { seq: number; turnStartedAt: string | null };

// 身份那两位挂在每一种段上（老记录缺省）。agent 段的 `at` 是这段正文开头那一刻（标记行写下的），
// `raw` 是盘上这段正文原样（没裁空白，`text` 是裁过的）：同一颗气泡被旁注劈开的几段按原样接回去，
// 一个字不差；实时那一路的增量按它的字数认「哪些字盘上已经有了」。
// clientKey：真人从页面发的那一句，页面先画出来的那份（乐观回显）凭它认回自己。
type Identity = Partial<RecordIdentity>;

export type ConvSeg =
  | Identity & { kind: "agent"; text: string; endedAt?: string; at?: string; raw?: string; deleted?: true }
  // bySystem：走真人回合通道、但作者是后端的那种（验证打回、验收冲突交接）。
  // 它们**必须**是 user 回合（要 followUpFrom 护住任务原来的终态），所以只能另开一位来标。
  // answerIds：这一句承载的是哪几条问答答复（任务问答历史里那条记录的 id，task-answer.ts 在
  // 发出答复时写下）。删除与问答卡都按它认记录，不按答复原文猜 —— 两次答「可以」原文一模一样。
  // 删掉之后它仍留在墓碑行上（它不是正文，是身份）。
  | Identity & { kind: "user"; text: string; at?: string; bySystem?: true; monitorWake?: MonitorWakeData; answerIds?: string[]; clientKey?: string; deleted?: true }
  // level:"notice" = 结算说明（「这一轮为什么落成这个状态」），由 server 结算时写下。
  // 展示端据此上「提示」的语气，而不是让关键词表去猜——说明里天然带着「未完成」这种词。
  // aside:true = 任务时间线旁注（appendTaskTimeline 写的那些：预约审查、验收阶段更新、
  // 预览起停…）。它不是说给 agent 听的话，也不开/不收一个回合——落在哪一秒纯属偶然，
  // 常常正砸在某一回合说到一半的地方，所以展示端不能拿它当回合边界（见 events.ts）。
  // notice = 这条时间线旁注是哪一类事（见 timeline-notice.ts）。老记录没有。
  // resume = 系统续跑的缘由（见 system-resume.ts）。老记录、别的系统注记没有。
  | Identity & { kind: "system"; text: string; at?: string; level?: "notice"; aside?: true; notice?: TimelineNotice; resume?: SystemResume; deleted?: true };

/** 一段连同它在原文里占的行（含首尾，按 `\n` 切出来的行号）。删除就地改写靠它定位。 */
export type SessionSegmentSpan = { seg: ConvSeg; first: number; last: number };

type Sentinel = {
  t?: string; text?: string; at?: string; by?: string; level?: string; aside?: boolean; notice?: unknown;
  monitorWake?: MonitorWakeData; answerIds?: unknown; resume?: unknown; deleted?: boolean;
  seq?: unknown; turnStartedAt?: unknown; clientKey?: unknown;
};

/** sentinel 上的身份（形状不对就当没有：老记录、手改过的行）。 */
export function recordIdentityOf(value: { seq?: unknown; turnStartedAt?: unknown }): RecordIdentity | null {
  if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0) return null;
  return { seq: value.seq, turnStartedAt: typeof value.turnStartedAt === "string" && value.turnStartedAt ? value.turnStartedAt : null };
}

const identityFields = (identity: RecordIdentity | null): Identity => identity ? { ...identity } : {};

/** 一处 agentEnd（回合真正收口的那一刻）。新记录带着它是哪个回合的。 */
export type AgentEndMark = Identity & { at?: string };

const noticeOf = (value: unknown): { notice?: TimelineNotice } => {
  const notice = timelineNoticeOf(value);
  return notice ? { notice } : {};
};

const resumeOf = (value: unknown): { resume?: SystemResume } => {
  const resume = systemResumeOf(value);
  return resume ? { resume } : {};
};

const answerIdsOf = (value: unknown): { answerIds?: string[] } => {
  const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && !!id) : [];
  return ids.length ? { answerIds: ids } : {};
};

export function parseSessionSpans(out: string): SessionSegmentSpan[] {
  return parseSessionTranscript(out).spans;
}

/** 解析成段，外加每一处 agentEnd（回合收口时刻；页面拿它给没有回合行的回合兜底）。 */
export function parseSessionTranscript(out: string): { spans: SessionSegmentSpan[]; agentEnds: AgentEndMark[] } {
  const spans: SessionSegmentSpan[] = [];
  const agentEnds: AgentEndMark[] = [];
  let buf: string[] = [];
  let bufFirst = -1;
  let bufLast = -1;
  let skippingDiagnostic = false;
  // 下一段正文的身份（它开头那一行标记）。段的行号从标记行算起：删除时整段连标记一起换成墓碑。
  let marker: { identity: RecordIdentity; at?: string; line: number } | null = null;
  const push = (seg: ConvSeg, first: number, last = first) => spans.push({ seg, first, last });
  const flush = () => {
    const raw = buf.join("\n");
    const t = raw.trim();
    if (t) {
      push(
        marker
          ? { kind: "agent", text: t, ...marker.identity, ...(marker.at ? { at: marker.at } : {}), raw }
          : { kind: "agent", text: t },
        marker?.line ?? bufFirst,
        bufLast,
      );
    }
    buf = [];
    bufFirst = -1;
    marker = null;
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
        const identity = recordIdentityOf(j);
        if (j.t === "agentEnd") {
          // Not a new bubble — it stamps where the agent turn that just flushed
          // actually finished, so per-turn 用时 excludes the idle wait that follows.
          const last = spans[spans.length - 1]?.seg;
          if (last?.kind === "agent") last.endedAt = j.at;
          agentEnds.push({ ...identityFields(identity), ...(j.at ? { at: j.at } : {}) });
          return;
        }
        const deleted = j.deleted === true ? { deleted: true as const } : {};
        if (j.t === "agent") {
          // 正常正文是裸 Markdown：带身份的新记录在每段开头多一行标记（身份留给紧跟着的那段正文），
          // 被删掉的正文落成一行墓碑（身份留在墓碑上）。
          if (j.deleted === true) {
            push({ kind: "agent", text: "", deleted: true, ...identityFields(identity), ...(j.at ? { at: j.at } : {}) }, index);
          } else if (identity) {
            marker = { identity, at: j.at, line: index };
          }
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
                ...noticeOf(j.notice),
                ...resumeOf(j.resume),
                ...identityFields(identity),
                ...deleted,
              }
            : {
                kind: "user",
                text: j.text ?? "",
                at: j.at,
                ...(j.by === "system" ? { bySystem: true as const, ...(j.monitorWake ? { monitorWake: j.monitorWake } : {}) } : {}),
                ...answerIdsOf(j.answerIds),
                ...(typeof j.clientKey === "string" && j.clientKey ? { clientKey: j.clientKey } : {}),
                ...identityFields(identity),
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
  return { spans, agentEnds };
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
  // 带身份的那段把身份也算进去：两回合说了一模一样的话，指纹也不同，删这一段不会删到那一段。
  const identity = typeof seg.seq === "number" ? `:${seg.seq}:${seg.turnStartedAt ?? ""}` : "";
  return `${seg.kind}:${at}:${seg.text.length}:${hash.toString(16)}${identity}`;
}

/** trace 里不随删除摘掉的两种记账事件：回合身份 run、用量 usage。 */
export const traceKeptOnDelete = (kind: string): boolean => kind === "run" || kind === "usage";

/**
 * 一段**只有执行过程、没有正文**的气泡（回合失败时常见）的指纹。它在 .md 里没有对应的段，
 * 删除时只能按时间段指名：服务端取同一份 trace 里 [from, to] 之间的事件重算，对上才动手 ——
 * 对不上（又落了新事件、跟别的气泡交错）就整批拒绝，不会多删一条。
 */
export function traceSpanFingerprint(entries: readonly { at: string; event: { kind: string } }[]): string {
  // 图片 attachment 不进指纹：页面拿到的 trace 会从图片账本补回几条盘上没有的（server 的
  // mergeImageJournal），两边数出来的不一样；它们照样落在时间窗里一起摘掉。
  const kept = entries.filter((entry) => !traceKeptOnDelete(entry.event.kind) && entry.event.kind !== "attachment");
  let hash = 0x811c9dc5;
  for (const char of kept.map((entry) => `${entry.at}|${entry.event.kind}`).join("\n")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `trace:${kept.length}:${hash.toString(16)}`;
}

/**
 * 带身份的一截执行过程的指纹（删除按身份指名时用，见 server/src/conversation-redact.ts 的 steps 那一种）：
 * 按 `seq` 认条目，只数盘上那份（没有 `seq` 的是服务端读的时候补出来的，盘上没有）。
 */
export function traceStepsFingerprint(entries: readonly { seq?: number; event: { kind: string } }[]): string {
  const kept = entries.filter((entry) => typeof entry.seq === "number" && !traceKeptOnDelete(entry.event.kind));
  let hash = 0x811c9dc5;
  for (const char of kept.map((entry) => `${entry.seq}|${entry.event.kind}`).join("\n")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `steps:${kept.length}:${hash.toString(16)}`;
}
