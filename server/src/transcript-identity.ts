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
//
// 「谁是这条会话的写者」靠逐文件锁（run-file-lock.ts）定成原子的：正式流在锁里登记（claimTranscript），
// 回合外的追加者在锁里查有没有正式流、没有才另开一条短命的流（task-timeline.ts 的 appendTranscriptLine）。
// 短命流只为发号绑定，不登记成写者 —— 它写完一行就关，登记了只会把正式流顶掉。
//
// trace 也只在这条会话有正式流时才发号（traceRecord）：没有正式流的写者（团队调度台、duet）正文与
// 实时事件都不带身份，trace 单独带号只会让页面以为整条会话都换了读法。
//
// **身份是按回合声明的，每条记录自己说明**（读的一头只认这个，不从会话的历史或这一份快照里有没有正文去猜）：
// - 一回合带不带身份，在绑定那一刻定一次（`bindTranscript` 接号段，接不回来这一整个回合照老样子写，
//   但正式流照样登记成写者）；绑定以后领号不会失败（session-seq.ts），一回合不会写到一半忽然不带号，
//   也不会被回合外的追加者从半路改成带号。
// - 带身份的回合里，每一条记录（.md 的 sentinel、正文标记行、trace 的每一行）都带号；实时事件也一样，
//   不是记录的那几种（收口、水位、执行器簿记）不带号，信封上标 `identityTurn`（single-run-voice.ts），
//   说明它属于带身份的回合。
// - 没带号、也没标 `identityTurn` 的，就是老样子写的（团队调度台、duet、接不回号段的那一回合、升级之前）。
import { join } from "node:path";
import { RUNS_DIR } from "./paths.js";
import { withRunFileLock } from "./run-file-lock.js";
import { recordSeq, takeRecordSeq, type RecordSeq } from "./session-seq.js";
import { now } from "./util.js";
import type { RecordIdentity, TextAnchor } from "@ash/shared/session-output";

type Binding = {
  taskId: string;
  sessionId: string;
  /** 这条流此刻在哪个回合（单飞一条流就是一个回合）。 */
  turnStartedAt: string | null;
  /** 正在写的那一段正文：它的号、已经写了多少字。sentinel 一写就收口。 */
  prose: { seq: number; offset: number } | null;
  /** 最近写到的正文位置（那段收口了也留着）：trace 的每一步记它，页面据此把步骤插回原文。 */
  lastProse: TextAnchor | null;
  /** 写下一行记录之前先做的事：单飞把 trace 里攒着的正文先落，两份文件在同一处切开。 */
  beforeRecord?: () => void;
  /** 这条会话的号段（绑定时接好的）。 */
  seq: RecordSeq;
};

// 同 transcript.ts 的 TURN_SENTINEL（那边 import 这里，反过来 import 就成环了）。
const TURN_SENTINEL = "\x1e";

const bindings = new WeakMap<NodeJS.WritableStream, Binding>();
const live = new Map<string, NodeJS.WritableStream>();

/**
 * 绑定一条流。两件事分开：**登记成这条会话的写者**（`register`，正式流才登记；回合外追加者那种短命流
 * 不登记）与**能不能发号**（号段接得回来才能，返回 true）。号段接不回来时正式流照样登记成写者 —— 这一
 * 回合在跑，回合外的旁注就得从它写（照它的样子不带号），不能因为发不了号就当这条会话空着、另开一条流
 * 自己去发号，把同一回合写成一半带号一半不带。正式流别直接调这个，走 claimTranscript（在锁里登记）。
 */
export function bindTranscript(
  out: NodeJS.WritableStream,
  owner: { taskId: string; sessionId: string; turnStartedAt?: string | null },
  { register = true }: { register?: boolean } = {},
): boolean {
  if (register) {
    live.set(owner.sessionId, out);
    const release = () => { if (live.get(owner.sessionId) === out) live.delete(owner.sessionId); };
    out.once("finish", release);
    out.once("close", release);
  }
  const seq = recordSeq(owner.taskId, owner.sessionId);
  if (!seq) return false;
  bindings.set(out, { taskId: owner.taskId, sessionId: owner.sessionId, turnStartedAt: owner.turnStartedAt ?? null, prose: null, lastProse: null, seq });
  return true;
}

/**
 * 正式流（单飞的这一回合）登记成这条会话的写者。在逐文件锁里登记：正排着队、已经查过「没有正式流」的
 * 回合外追加者先写完，之后来的都会看见这条流、从它写。登记完之前别往流里写。
 */
export async function claimTranscript(
  out: NodeJS.WritableStream,
  owner: { taskId: string; sessionId: string; turnStartedAt?: string | null },
): Promise<boolean> {
  // 跟 transcript.ts 的 sessionTranscriptPath 同一个路径（锁按路径字符串排队）。
  return withRunFileLock([join(RUNS_DIR, owner.taskId, `${owner.sessionId}.md`)], () => bindTranscript(out, owner));
}

/** 这条流写的回合带不带身份（实时事件据此在信封上标 `identityTurn`）。 */
export function isIdentityStream(out: NodeJS.WritableStream): boolean {
  return bindings.has(out);
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
  return { seq: takeRecordSeq(binding.seq), turnStartedAt: turnStartedAt === undefined ? binding.turnStartedAt : turnStartedAt };
}

/**
 * trace 的一条要不要带号：这条会话此刻有正式流就从它那里领（同一个号段），连同它此刻落在正文的哪个位置
 * （`textAt`）；没有就都不带。
 */
export function traceRecord(sessionId: string): { seq: number; textAt: TextAnchor | null } | null {
  const out = liveTranscript(sessionId);
  const binding = out ? bindings.get(out) : undefined;
  return binding ? { seq: takeRecordSeq(binding.seq), textAt: binding.lastProse && { ...binding.lastProse } } : null;
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
    const seq = takeRecordSeq(binding.seq);
    out.write(`\n${TURN_SENTINEL}${JSON.stringify({ t: "agent", seq, turnStartedAt: binding.turnStartedAt, at: now() })}\n`);
    binding.prose = { seq, offset: 0 };
  }
  const offset = binding.prose.offset;
  out.write(text);
  binding.prose.offset += text.length;
  binding.lastProse = { seq: binding.prose.seq, offset: binding.prose.offset };
  return { seq: binding.prose.seq, offset };
}
