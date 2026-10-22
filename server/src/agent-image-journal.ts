// 「正文里的图」的**持久**账本:跟消费者不同生死的那一份。
//
// 交代出去的 attachment 事件要经消费者(single-run / lead-voice 的 for-await)写进 trace
// 才算落盘;消费者在「字节已冻结/已交代」与「写进 trace」之间死掉(落库抛错、停任务、进程
// 被杀)时,uploads 里那份字节还在(sink 的 dispose 不删露过脸的),可「它属于哪份文档哪一
// 处引用」这层关系只活在内存里,刷新重建就只剩一个没人认领的孤儿文件加一格「图取不到」
// (审查第 7 轮 R3)。所以 sink 每记一笔值得持久化的账(临时冻结、最终交代)都**旁路**追加
// 到这份 jsonl;重建执行过程时按行合并 —— trace 里已有的一律以 trace 为准,只补 trace 缺的。
//
// 同一份文件还顺带钉死跨进程的身份接续(审查第 7 轮 R2 第 2 行):续聊/接管开新 sink 时,
// 从 trace(已落盘的正文与已交代的身份)读出每份子文档「写到哪了、用掉几号」,喂回 sink 的
// 种子(MarkdownImageSeedDoc)—— 子文档跨回合、跨进程累加成同一份,身份不接上,重开后的
// 第一处引用又从 0 号发起,跟重建那一路撞身份,展示端两处一起「图取不到」。
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { childActivity } from "./executors/native-agent-activity.js";
import type {
  MarkdownImageAccounting,
  MarkdownImageSeedDoc,
  MarkdownImageSpot,
} from "./executors/markdown-image-stream.js";
import { RUNS_DIR } from "./paths.js";
import {
  parseSessionTraceLines,
  readableRunPath,
  sessionTracePath,
  type SessionTraceEntry,
  type SessionTraceEvent,
} from "./transcript.js";

export function imageJournalPath(taskId: string, sessionId: string): string {
  return join(RUNS_DIR, taskId, `${sessionId}.images.jsonl`);
}

type JournalLine = MarkdownImageSpot & { at: string; turnStartedAt: string };

// 合成记录的身份从这儿起:真身份是小整数,隔 2^30 保证两边永远撞不上;展示端拿身份去重和
// 配对计数,数值本身不进任何排序。
const SYNTH_REF_BASE = 1 << 30;

/**
 * 给一条会话造一份接到持久账本上的记账口(交给 RunOpts.images / attach 的 images)。
 *
 * `turnStartedAt` 给函数是为常驻调度台:它一条会话横跨多个回合,账要记在**当下**那一轮上,
 * 否则跟 trace 行对不上号,合并时会把 trace 里已有的记录再补一遍(多出来的那条让展示端
 * 「第 n 处 ↔ 第 n 条」的对账失衡,反把好图拖成作废)。
 */
export function markdownImageAccounting(
  taskId: string,
  sessionId: string,
  turnStartedAt: string | (() => string),
  seed?: ReadonlyMap<string, MarkdownImageSeedDoc>,
): MarkdownImageAccounting {
  const path = imageJournalPath(taskId, sessionId);
  let ready = false;
  return {
    seed,
    note(record) {
      // 账本是旁路:它自己坏了(盘满、权限)不许影响事件流 —— 丢的只是「消费者死了还能
      // 恢复」这一档,而不记这笔账之前本来就没有这一档。
      try {
        if (!ready) {
          mkdirSync(dirname(path), { recursive: true });
          ready = true;
        }
        const turn = typeof turnStartedAt === "function" ? turnStartedAt() : turnStartedAt;
        appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), turnStartedAt: turn, ...record })}\n`);
      } catch {
        /* 见上 */
      }
    },
  };
}

async function readTraceEntries(taskId: string, sessionId: string): Promise<SessionTraceEntry[]> {
  const raw = await readFile(readableRunPath(sessionTracePath(taskId, sessionId)), "utf8").catch(() => null);
  // 坏行跳过、好行照用:这里只是尽力恢复身份与正文,严格性由 readSessionTrace 那条路把守。
  return raw ? parseSessionTraceLines(raw).entries : [];
}

async function readJournal(taskId: string, sessionId: string): Promise<JournalLine[]> {
  const raw = await readFile(readableRunPath(imageJournalPath(taskId, sessionId)), "utf8").catch(() => null);
  if (!raw) return [];
  const lines: JournalLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JournalLine;
      if (parsed && typeof parsed.pos === "number" && typeof parsed.source === "string") lines.push(parsed);
    } catch {
      /* 半截尾行:进程死在落笔那一刻,前面的行照用 */
    }
  }
  return lines;
}

/** 子文档的一条活动(正文/附件):trace 与实时事件同一形状,两处读取都从这儿走。 */
function childEventOf(event: SessionTraceEvent | AgentEvent): { id: string; event: AgentEvent } | null {
  if (event.kind !== "tool" || event.nativeWork?.type !== "activity") return null;
  return { id: event.nativeWork.id, event: event.nativeWork.event };
}

/**
 * 续聊/接管前读出每份子文档的种子。正文只认 trace(屏幕上重建的就是它,跟它一致才叫一致);
 * 身份取 trace 与账本的并集 —— 消费者死前已经交代、还没写进 trace 的那几号也不许重发。
 */
export async function loadMarkdownImageSeed(
  taskId: string,
  sessionId: string,
): Promise<Map<string, MarkdownImageSeedDoc> | undefined> {
  const docs = new Map<string, MarkdownImageSeedDoc>();
  const doc = (id: string): MarkdownImageSeedDoc => {
    let found = docs.get(id);
    if (!found) {
      found = { text: "", refs: 0 };
      docs.set(id, found);
    }
    return found;
  };
  for (const entry of await readTraceEntries(taskId, sessionId)) {
    const child = childEventOf(entry.event);
    if (!child) continue;
    if (child.event.kind === "text" && child.event.text) doc(child.id).text += child.event.text;
    else if (child.event.kind === "attachment" && typeof child.event.ref === "number" && child.event.ref < SYNTH_REF_BASE) {
      const seeded = doc(child.id);
      seeded.refs = Math.max(seeded.refs, child.event.ref + 1);
    }
  }
  for (const line of await readJournal(taskId, sessionId)) {
    if (!line.final || line.doc == null || typeof line.ref !== "number" || line.ref >= SYNTH_REF_BASE) continue;
    const seeded = doc(line.doc);
    seeded.refs = Math.max(seeded.refs, line.ref + 1);
  }
  for (const [id, seeded] of docs) if (!seeded.text && !seeded.refs) docs.delete(id);
  return docs.size ? docs : undefined;
}

/** 文档在对账里的身份:子文档跨回合是同一份,主文档一回合一份(sink 的 Ledger 同一口径)。 */
const docKey = (doc: string | null | undefined, turnStartedAt: string): string =>
  doc == null ? `\u0000${turnStartedAt}` : doc;

function imageEvent(line: JournalLine, ref: number): SessionTraceEvent {
  const image: AgentEvent = {
    kind: "attachment",
    source: line.source,
    ref,
    ...(line.path ? { path: line.path } : {}),
    ...(line.lost ? { lost: true } : {}),
  };
  // childActivity 的返回类型是宽的 AgentEvent;这两种形状(裸 attachment / tool+activity)
  // 恰是 trace 校验(transcript.ts validTraceEvent)认的子集,收窄是安全的。
  return (line.doc == null ? image : childActivity(line.doc, image)) as SessionTraceEvent;
}

/**
 * 重建执行过程时把 trace **缺**的图记录从账本补回来;trace 有的一律以 trace 为准。
 *
 * 两类缺口,出路不同:
 *   · 已交代、没写进 trace(final):按原身份补一条 —— 字节、来源、身份都是真的,只是
 *     消费者死在落笔之前。
 *   · 只冻结、没交代(临时账):消费者死了,交代那一步永远不会来。补一条**合成身份**的
 *     记录(SYNTH_REF_BASE 起,不跟真身份撞),让展示端配对认领那份字节。只补**正文真
 *     到了 trace** 的那一处:正文没落盘的引用屏幕上本来就不存在,硬补只会让「第 n 处 ↔
 *     第 n 条」的对账多出一条,反把已显示的同目的地引用拖成作废。
 *
 * 追加在末尾即可:展示端按 turnStartedAt 键入分组(conversationTraceGroups),合成行自己
 * 带着原回合的起点;同一目的地内的次序按(文档, 回合, 位置)排,正好排在已交代那些后面
 * (交代是按位置前缀推进的,缺的只会是后缀)。
 */
export async function mergeImageJournal(
  taskId: string,
  sessionId: string,
  entries: SessionTraceEntry[],
): Promise<SessionTraceEntry[]> {
  const journal = await readJournal(taskId, sessionId);
  if (!journal.length) return entries;
  const traced = new Set<string>();
  const texts = new Map<string, string>();
  const tracedKey = (turn: string, doc: string | null | undefined, source: string, ref: number) =>
    `${turn}\u0000${doc ?? ""}\u0000${source}\u0000${ref}`;
  for (const entry of entries) {
    const event = entry.event;
    if (event.kind === "text" && event.text) {
      const key = docKey(null, entry.turnStartedAt);
      texts.set(key, (texts.get(key) ?? "") + event.text);
      continue;
    }
    if (event.kind === "attachment" && typeof event.ref === "number") {
      traced.add(tracedKey(entry.turnStartedAt, null, event.source ?? "", event.ref));
      continue;
    }
    const child = childEventOf(event);
    if (!child) continue;
    if (child.event.kind === "text" && child.event.text) {
      texts.set(child.id, (texts.get(child.id) ?? "") + child.event.text);
    } else if (child.event.kind === "attachment" && typeof child.event.ref === "number") {
      traced.add(tracedKey(entry.turnStartedAt, child.id, child.event.source ?? "", child.event.ref));
    }
  }
  const finalsAt = new Set<string>();
  for (const line of journal) {
    if (line.final) finalsAt.add(`${docKey(line.doc, line.turnStartedAt)}\u0000${line.pos}`);
  }
  const synth: { line: JournalLine; event: SessionTraceEvent }[] = [];
  const provisional = new Map<string, JournalLine>();
  for (const line of journal) {
    if (line.final) {
      if (typeof line.ref !== "number") continue;
      const key = tracedKey(line.turnStartedAt, line.doc, line.source, line.ref);
      if (traced.has(key)) continue;
      traced.add(key);
      synth.push({ line, event: imageEvent(line, line.ref) });
    } else {
      // 同一处取最后一笔:目的地可能改过(还在写的定义行后来接长了),最后那笔才是定论。
      provisional.set(`${docKey(line.doc, line.turnStartedAt)}\u0000${line.pos}`, line);
    }
  }
  let bump = 0;
  for (const [key, line] of provisional) {
    if (finalsAt.has(key)) continue;
    const text = texts.get(docKey(line.doc, line.turnStartedAt));
    if (!text || !text.startsWith("![", line.pos)) continue;
    synth.push({ line, event: imageEvent(line, SYNTH_REF_BASE + bump++) });
  }
  if (!synth.length) return entries;
  synth.sort((a, b) =>
    (a.line.doc ?? "").localeCompare(b.line.doc ?? "")
    || a.line.turnStartedAt.localeCompare(b.line.turnStartedAt)
    || a.line.pos - b.line.pos);
  return [
    ...entries,
    ...synth.map(({ line, event }) => ({ at: line.at, turnStartedAt: line.turnStartedAt, event })),
  ];
}
