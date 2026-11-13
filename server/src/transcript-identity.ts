// 会话正文流（`<会话>.md` 的写入流）上的记录身份 —— 发号的那一头（读的那一头在
// shared/src/session-output.ts，号是什么见那里的 RecordIdentity）。
//
// 一条流**绑定**之后（`bindTranscript`），从它写下去的每一行 sentinel、每一段正文开头的标记行都带
// 「这条会话的第几条记录 + 哪个回合」；没绑定的流（团队调度台、duet 的正文）照旧不带，页面对那几
// 种会话一直走老读法。绑定的只有单飞那一路（orchestrator / task-run / reattach 起流的地方）。
//
// **一条会话在跑的时候只有一个写者。**回合之外的追加者（任务时间线旁注、会话轮换注记）原先各自
// 另开一条追加流，跟正在流式写正文的那条交错落盘 —— 旁注砸进一段正文中间，读出来就是两段正文，
// 而后一段谁的身份都没有。所以这里登记着每条会话此刻在跑的那条流（`liveTranscript`），那些追加者
// 有它就从它写：正文写到哪儿、哪一段已经收口、trace 里攒着的正文要不要先落（`onRecord`），全在
// 同一个写者手里。
import { nextRecordSeq } from "./session-seq.js";
import { now } from "./util.js";
import type { RecordIdentity } from "@ash/shared/session-output";

type Binding = {
  taskId: string;
  sessionId: string;
  /** 这条流此刻在哪个回合（单飞一条流就是一个回合）。 */
  turnStartedAt: string | null;
  /** 正在写的那一段正文：它的号、已经写了多少字。sentinel 一写就收口。 */
  prose: { seq: number; offset: number } | null;
  /** 写下一行记录之前先做的事：单飞把 trace 里攒着的正文先落，两份文件在同一处切开。 */
  beforeRecord?: () => void;
};

// 同 transcript.ts 的 TURN_SENTINEL（那边 import 这里，反过来 import 就成环了）。
const TURN_SENTINEL = "\x1e";

const bindings = new WeakMap<NodeJS.WritableStream, Binding>();
const live = new Map<string, NodeJS.WritableStream>();

export function bindTranscript(
  out: NodeJS.WritableStream,
  owner: { taskId: string; sessionId: string; turnStartedAt?: string | null },
): void {
  bindings.set(out, { taskId: owner.taskId, sessionId: owner.sessionId, turnStartedAt: owner.turnStartedAt ?? null, prose: null });
  live.set(owner.sessionId, out);
  const release = () => { if (live.get(owner.sessionId) === out) live.delete(owner.sessionId); };
  out.once("finish", release);
  out.once("close", release);
}

/** 写下一行记录之前要先做的事（见 Binding.beforeRecord）。 */
export function onRecord(out: NodeJS.WritableStream, hook: () => void): void {
  const binding = bindings.get(out);
  if (binding) binding.beforeRecord = hook;
}

/** 这条会话此刻在跑的那条正文流（没有、或已经 end 了就是 null —— 往 end 过的流上写会打崩进程）。 */
export function liveTranscript(sessionId: string): NodeJS.WritableStream | null {
  const out = live.get(sessionId);
  const writable = out as (NodeJS.WritableStream & { writableEnded?: boolean; destroyed?: boolean }) | undefined;
  return out && !writable!.writableEnded && !writable!.destroyed ? out : null;
}

/**
 * 先领一个号，过一会儿才落盘的那种记录用（会话轮换旁注：实时立刻播，落盘攒到回合收口之后）。
 * 实时事件带的和后来写进 .md 的是同一个号，所以页面上它排在它真正发生的位置。
 * `turnStartedAt` 缺省 = 这条流此刻的回合。没绑定的流给 null。
 */
export function reserveRecord(out: NodeJS.WritableStream, turnStartedAt?: string | null): RecordIdentity | null {
  const binding = bindings.get(out);
  if (!binding) return null;
  return { seq: nextRecordSeq(binding.taskId, binding.sessionId), turnStartedAt: turnStartedAt === undefined ? binding.turnStartedAt : turnStartedAt };
}

/**
 * 一行 sentinel 要写下去了：先做 beforeRecord、收掉正在写的那段正文，再给它身份（给了就用给的）。
 * 没绑定的流原样返回 null，那一行不带身份。
 */
export function sentinelIdentity(
  out: NodeJS.WritableStream,
  given?: RecordIdentity | null,
  turnStartedAt?: string | null,
): RecordIdentity | null {
  const binding = bindings.get(out);
  if (!binding) return null;
  binding.beforeRecord?.();
  binding.prose = null;
  return given ?? reserveRecord(out, turnStartedAt);
}

/** 不是记录、但也把正文劈开的东西（执行诊断块）：后面的正文另起一段。 */
export function closeProse(out: NodeJS.WritableStream): void {
  const binding = bindings.get(out);
  if (binding) binding.prose = null;
}

/**
 * 写一块正文。一段正文的第一块之前先落一行标记（`t:"agent"` + 身份 + 这段开头的时刻）；返回这一块
 * 在哪段正文的第几个字起（实时事件带上它，页面据此认出「盘上已经有了的那几个字」）。没绑定的流
 * 原样写、返回 null。
 */
export function writeProse(out: NodeJS.WritableStream, text: string): { seq: number; offset: number } | null {
  const binding = bindings.get(out);
  if (!binding) {
    out.write(text);
    return null;
  }
  if (!binding.prose) {
    const seq = nextRecordSeq(binding.taskId, binding.sessionId);
    out.write(`\n${TURN_SENTINEL}${JSON.stringify({ t: "agent", seq, turnStartedAt: binding.turnStartedAt, at: now() })}\n`);
    binding.prose = { seq, offset: 0 };
  }
  const offset = binding.prose.offset;
  out.write(text);
  binding.prose.offset += text.length;
  return { seq: binding.prose.seq, offset };
}
