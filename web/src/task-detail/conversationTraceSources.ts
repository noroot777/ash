// 一颗正文气泡的删除出处，要盖住它画出来的每一步 —— 从 conversationModel.ts 拆出来（单文件 700 行的约定）。
//
// 删一段正文时，服务端只按 .md 的段落边界给它算一个 trace 时间窗（见下面 segmentTraceWindow）。
// 可气泡领的是**一整组** trace：回合中间落下的记录不切回合，记录之后那几步照样归这一回合、
// 画在这颗气泡里，却落在它那段正文的时间窗外面。光报正文段，回合删了、这几步却还留在 trace
// 里（命令和输出原样都在），哪天不再被那段已删的正文领走，就冒成一颗只有过程的气泡。所以
// 窗外那几步另报成 trace 时间段（服务端一次删除两种出处都收，见 server/src/conversation-redact.ts）。
import type { ConvSeg } from "@ash/shared/session-output";
import { traceKeptOnDelete, traceSpanFingerprint } from "@ash/shared/session-output";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ConversationSource } from "./conversationModel.ts";

/**
 * 服务端**读的时候**补出来的那几条：盘上没有，只在页面拿到的这份里。两处补法都是**接在末尾**的
 * —— 图片账本补回的图（server 的 mergeImageJournal：顶层附件，或子智能体那一层包在 tool 事件
 * 里的附件），之后是子智能体的模型档案（server 的 enrichNativeWorkModels：status 为 unknown 的
 * agent 事件）。所以从末尾往前认这三种形状、认到第一条别的就停：前面那一截就是盘上原样的顺序。
 *
 * 这份认定决定了出处里的指纹：服务端按盘上那份重算，数进读侧补出来的条目就对不上。只看形状、
 * 不看位置是不行的 —— 盘上同样存着 status 为 unknown 的 agent 事件、子智能体交回的图。会认错的
 * 只有一种：盘上 trace 自己恰好以这几种形状收尾（回合正常收口时末条是用量，2026-11-13 全库
 * 2237 条会话一条都没有）。那时落在一截中间的会让指纹对不上、服务端整次拒绝；落在一截边上的
 * 会漏删。
 */
export function readSideTail(trace: readonly SessionTraceEntry[]): Set<SessionTraceEntry> {
  const readSide = new Set<SessionTraceEntry>();
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const entry = trace[index]!;
    const work = entry.event.kind === "tool" ? entry.event.nativeWork : undefined;
    const appended = entry.event.kind === "attachment"
      || (work?.type === "activity" && work.event.kind === "attachment")
      || (work?.type === "agent" && work.status === "unknown");
    if (!appended) break;
    readSide.add(entry);
  }
  return readSide;
}

/** trace 里的时间窗 (after, until]，毫秒。 */
type Window = { after: number; until: number };

const time = (at: string | undefined): number => {
  const parsed = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/**
 * 删掉第 `index` 段正文时，服务端顺手从 trace 里摘掉的时间窗 —— 照抄
 * server/src/conversation-redact.ts 的 redactTranscript：从前面最近一处边界（插话时刻，或
 * 上一段正文的收口）开到后面紧跟的那一条插话；后面紧跟的是另一段正文时收在本段的 agentEnd。
 * 两边算出来的窗口不一致，这里就会把服务端本来会删的几步当成窗外再报一遍（无害），或者
 * 漏报（删完冒出只有过程的气泡）。
 */
export function segmentTraceWindow(segments: readonly ConvSeg[], index: number): Window {
  const after = Math.max(Number.NEGATIVE_INFINITY, ...segments.slice(0, index)
    .map((prev) => time(prev.kind === "agent" ? prev.endedAt : prev.at))
    .filter(Number.isFinite));
  const seg = segments[index];
  const next = segments[index + 1];
  const until = next && next.kind !== "agent" ? time(next.at)
    : next && seg?.kind === "agent" ? time(seg.endedAt) : Number.NaN;
  return { after, until: Number.isFinite(until) ? until : Number.POSITIVE_INFINITY };
}

/**
 * 一截执行过程 → 删除用的 trace 出处。时间段取这一截里盘上那几条的首尾；服务端按 [from, to]
 * 取**整条**盘上 trace 重算指纹，所以指纹也按整条 trace 里落在这一段、盘上有的条目算。盘上一条
 * 可删的都没有（全是读侧补出来的、或只剩记账事件）就没有出处可报 —— 盘上本来也没有要删的。
 */
export function traceSpanSource(
  sessionId: string,
  trace: readonly SessionTraceEntry[],
  readSide: ReadonlySet<SessionTraceEntry>,
  entries: readonly SessionTraceEntry[],
): ConversationSource | null {
  const onDisk = entries.filter((entry) => !readSide.has(entry) && !traceKeptOnDelete(entry.event.kind))
    .sort((left, right) => time(left.at) - time(right.at));
  if (!onDisk.length) return null;
  const from = onDisk[0]!.at;
  const to = onDisk.at(-1)!.at;
  const span = trace.filter((entry) => !readSide.has(entry) && time(entry.at) >= time(from) && time(entry.at) <= time(to));
  return { sessionId, trace: { from, to, fingerprint: traceSpanFingerprint(span) } };
}

/**
 * 气泡领到、却落在它正文时间窗外的那几步，按 trace 里连续的几截报成时间段出处。
 *
 * `trace` 是整条会话的 trace（分组就是从这份里切的，条目是同一批对象）。一截遇到别的气泡的
 * 步子就断开，不会顺手删到别人。盘上可删的每一条都落进某一截：读侧补出来的不算（盘上没有），
 * 除此之外一条不跳 —— 宁可让指纹对不上、服务端整次拒绝，也不能删一半还报删好了。
 */
export function strayTraceSources(
  sessionId: string,
  trace: readonly SessionTraceEntry[],
  readSide: ReadonlySet<SessionTraceEntry>,
  claimed: readonly SessionTraceEntry[],
  window: Window,
): ConversationSource[] {
  const inWindow = (entry: SessionTraceEntry): boolean => {
    const at = time(entry.at);
    return at > window.after && at <= window.until;
  };
  const deletable = (entry: SessionTraceEntry): boolean => !readSide.has(entry) && !traceKeptOnDelete(entry.event.kind);
  const stray = new Set(claimed.filter((entry) => deletable(entry) && !inWindow(entry)));
  if (!stray.size) return [];
  const ordered = trace.filter(deletable).sort((left, right) => time(left.at) - time(right.at));
  const runs: SessionTraceEntry[][] = [];
  let run: SessionTraceEntry[] | null = null;
  for (const entry of ordered) {
    if (!stray.has(entry)) { run = null; continue; }
    if (!run) runs.push(run = []);
    run.push(entry);
  }
  return runs.flatMap((entries) => traceSpanSource(sessionId, trace, readSide, entries) ?? []);
}
