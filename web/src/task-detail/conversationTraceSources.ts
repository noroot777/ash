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
 * 这一条可能是服务端**读的时候**补出来的、盘上没有：子智能体那一层的图（tool 事件包着的
 * attachment，补自图片账本，server 的 mergeImageJournal），子智能体的模型档案（status 为
 * unknown 的 agent 事件，补自 CLI 自己的会话文件，server 的 enrichNativeWorkModels）。
 */
const maybeReadSide = (entry: SessionTraceEntry): boolean => {
  const work = entry.event.kind === "tool" ? entry.event.nativeWork : undefined;
  return (work?.type === "activity" && work.event.kind === "attachment")
    || (work?.type === "agent" && work.status === "unknown");
};

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
 * 气泡领到、却落在它正文时间窗外的那几步，按 trace 里连续的几截报成时间段出处。
 *
 * `trace` 是整条会话的 trace（分组就是从这份里切的，条目是同一批对象）。服务端按 [from, to]
 * 取**整条** trace 重算指纹，所以一截遇到别人的步子就断开，指纹也按整条 trace 在这一段里的
 * 条目算 —— 不会顺手删到别的气泡。
 *
 * 页面拿到的 trace 比盘上多几条（见 maybeReadSide）。顶层附件不进指纹，没关系；其余几种
 * 指纹数得到、盘上却可能没有 —— 报进去服务端就认成「内容变了」，把整次删除拒掉，连正文都
 * 删不成，刷新也没用。所以截到它就断开：它和跟它同一毫秒的条目（服务端按时刻取段，同一毫秒
 * 分不开）不进任何一截；只剩附件的那一截也不报。宁可删完 trace 里留下这几步（仍被那段已删
 * 的正文领着，不会冒出来），也不能让删除本身失败。
 */
export function strayTraceSources(
  sessionId: string,
  trace: readonly SessionTraceEntry[],
  claimed: readonly SessionTraceEntry[],
  window: Window,
): ConversationSource[] {
  const inWindow = (entry: SessionTraceEntry): boolean => {
    const at = time(entry.at);
    return at > window.after && at <= window.until;
  };
  const stray = new Set(claimed.filter((entry) => !traceKeptOnDelete(entry.event.kind) && !inWindow(entry)));
  if (!stray.size) return [];
  const unsafeAt = new Set(trace.filter(maybeReadSide).map((entry) => time(entry.at)));
  const ordered = trace.filter((entry) => !traceKeptOnDelete(entry.event.kind))
    .sort((left, right) => time(left.at) - time(right.at));
  const runs: SessionTraceEntry[][] = [];
  let run: SessionTraceEntry[] | null = null;
  for (const entry of ordered) {
    if (!stray.has(entry) || unsafeAt.has(time(entry.at))) { run = null; continue; }
    if (!run) runs.push(run = []);
    run.push(entry);
  }
  return runs
    .filter((entries) => entries.some((entry) => entry.event.kind !== "attachment"))
    .map((entries) => {
      const from = entries[0]!.at;
      const to = entries.at(-1)!.at;
      const span = trace.filter((entry) => time(entry.at) >= time(from) && time(entry.at) <= time(to));
      return { sessionId, trace: { from, to, fingerprint: traceSpanFingerprint(span) } };
    });
}
