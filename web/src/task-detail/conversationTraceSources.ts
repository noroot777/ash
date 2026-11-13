// 一颗正文气泡的删除出处，要盖住它画出来的每一步 —— 从 conversationModel.ts 拆出来（单文件 700 行的约定）。
//
// 删一段正文时，服务端只按 .md 的段落边界给它算一个 trace 时间窗（见下面 segmentTraceWindow）。
// 可气泡领的是**一整组** trace：回合中间落下的记录不切回合，记录之后那几步照样归这一回合、
// 画在这颗气泡里，却落在它那段正文的时间窗外面。光报正文段，回合删了、这几步却还留在 trace
// 里（命令和输出原样都在），哪天不再被那段已删的正文领走，就冒成一颗只有过程的气泡。所以
// 窗外那几步另报成 trace 时间段（服务端一次删除两种出处都收，见 server/src/conversation-redact.ts）。
import type { Session } from "@ash/shared";
import type { ConvSeg } from "@ash/shared/session-output";
import { traceKeptOnDelete, traceSpanFingerprint } from "@ash/shared/session-output";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ConversationSource } from "./conversationModel.ts";

/**
 * 服务端**读的时候**补出来的那几条：盘上没有，只在页面拿到的这份里，删除指纹不数它们。
 *
 * 服务端给补出来的条目打了来源记号（`origin`），就只认记号。会话行带不带 `turnEnds` 是同一批服务端
 * 改动带出来的，所以拿它分辨「这是认记号的服务端」：带了就只认记号、一条不猜；没带（老服务端）才退回
 * 下面 readSideTail 那套按形状、按位置的推断 —— 那一套**只给老服务端**，别再扩。
 */
export function readSideEntries(trace: readonly SessionTraceEntry[], session: Pick<Session, "turnEnds">): Set<SessionTraceEntry> {
  if (session.turnEnds === undefined) return readSideTail(trace);
  return new Set(trace.filter((entry) => entry.origin !== undefined));
}

/**
 * 老服务端（没打来源记号）的推断，见 readSideEntries。两处补法都是**接在末尾**的
 * —— 图片账本补回的图（server 的 mergeImageJournal：顶层附件，或子智能体那一层包在 tool 事件
 * 里的附件），之后是子智能体的模型档案（server 的 enrichNativeWorkModels：status 为 unknown 的
 * agent 事件）。所以从末尾往前认这三种形状、认到第一条别的就停：前面那一截就是盘上原样的顺序。
 *
 * 这份认定**只用来算指纹**：服务端按盘上那份重算，数进读侧补出来的条目就对不上。它不决定
 * 哪几步要删 —— 删除覆盖的时间段照旧盖住气泡领到的每一条（见 traceSpanSource）。
 *
 * 它是推断：只看形状、不看位置是不行的（盘上同样存着 status 为 unknown 的 agent 事件、子智能体
 * 交回的图），看了位置也还有一种会认错 —— 盘上 trace 自己恰好以这几种形状收尾（停止、异常
 * 退出、没收到用量的回合都可能）。认错的后果只有一种：真有的那条照样在删除时间段里，指纹却
 * 少数了它，服务端整次拒绝删除（附件不进指纹，认错也不影响，照样删掉）。不会删一半还报删好了。
 */
function readSideTail(trace: readonly SessionTraceEntry[]): Set<SessionTraceEntry> {
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
 * 一截执行过程 → 删除用的 trace 出处。
 *
 * 时间段取这一截里**每一条**可删事件的首尾，读侧补出来的也算进去：认定它是补出来的只是推断，
 * 时间段要是因此缩了，盘上真有的那条就漏在段外，服务端删得「成功」、原文却留着。指纹只数
 * 盘上那份（服务端按 [from, to] 取**整条**盘上 trace 重算）。只剩记账事件（run / usage）的一截
 * 没有要删的，不报。
 *
 * 服务端按时间段删，段里有什么删什么；指纹只能证明「段里的内容跟页面看到的一样」，证明不了
 * 「段里每一条都是这颗气泡的」。别的气泡的步子恰好记在端点那一毫秒（trace 的时刻只精确到
 * 毫秒，不同回合的事件可以同刻），它就落在段里。`owned` 是这颗气泡领到的全部条目：段里只要
 * 有一条可删事件不在其中，这一截就分不开，出处标成 `entangled`、指纹给一个服务端永远算不出
 * 来的值 —— 页面据此整次拒绝（TaskDetail 的删除动作），绕过页面直接交给服务端也只会 409。
 * 不能把别人的那条数进指纹求个对得上：那等于替用户授权删掉另一颗气泡。
 */
export function traceSpanSource(
  sessionId: string,
  trace: readonly SessionTraceEntry[],
  readSide: ReadonlySet<SessionTraceEntry>,
  entries: readonly SessionTraceEntry[],
  owned: ReadonlySet<SessionTraceEntry> = new Set(entries),
): ConversationSource | null {
  const deletable = entries.filter((entry) => !traceKeptOnDelete(entry.event.kind))
    .sort((left, right) => time(left.at) - time(right.at));
  if (!deletable.length) return null;
  const from = deletable[0]!.at;
  const to = deletable.at(-1)!.at;
  const span = trace.filter((entry) => time(entry.at) >= time(from) && time(entry.at) <= time(to));
  if (span.some((entry) => !owned.has(entry) && !traceKeptOnDelete(entry.event.kind))) {
    return { sessionId, trace: { from, to, fingerprint: ENTANGLED }, entangled: true };
  }
  return { sessionId, trace: { from, to, fingerprint: traceSpanFingerprint(span.filter((entry) => !readSide.has(entry))) } };
}

/** 分不开的那一截的指纹：服务端算出来的总是 `trace:<条数>:<哈希>`，对不上这个。 */
const ENTANGLED = "trace:entangled";

/**
 * 气泡领到、却落在它正文时间窗外的那几步，按 trace 里连续的几截报成时间段出处。
 *
 * `trace` 是整条会话的 trace（分组就是从这份里切的，条目是同一批对象）。一截遇到别的气泡的
 * 步子就断开；端点那一毫秒还夹着别人的，由 traceSpanSource 标成分不开。领到的每一条可删事件
 * 都落进某一截，一条不跳 —— 宁可让指纹对不上、整次拒绝，也不能删一半还报删好了。
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
  const deletable = (entry: SessionTraceEntry): boolean => !traceKeptOnDelete(entry.event.kind);
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
  const owned = new Set(claimed);
  return runs.flatMap((entries) => traceSpanSource(sessionId, trace, readSide, entries, owned) ?? []);
}
