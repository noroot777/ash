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
import type { AgentEvent, NativeAgentActivity } from "@ash/shared";
import { markdownImageRefs } from "@ash/shared/markdown-images";
import { metaSeedKey, type MetaImageField } from "./executors/markdown-image-meta.js";
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
function childEventOf(event: SessionTraceEvent | AgentEvent): { id: string; event: NativeAgentActivity } | null {
  if (event.kind !== "tool" || event.nativeWork?.type !== "activity") return null;
  return { id: event.nativeWork.id, event: event.nativeWork.event };
}

/**
 * 续聊/接管前读出每份文档的种子。正文只认 trace(屏幕上重建的就是它,跟它一致才叫一致);
 * 身份取 trace 与账本的并集 —— 消费者死前已经交代、还没写进 trace 的那几号也不许重发。
 *
 * 子文档恒接(它跨回合累加成同一份)。主文档一回合一份,只有**重启接回**那条路要接 ——
 * 回合没换、进程换了,接回的 sink 不知道这一回合前半截已经说了什么、交代过几号;传
 * `mainTurnStartedAt`(接回的那一轮的起点)时,把那一轮的主正文与身份也装进种子,键 ""
 * (sink 的 ledgers 主键同一口径)。续聊/新回合不传:那本来就是新一份主文档。
 */
export async function loadMarkdownImageSeed(
  taskId: string,
  sessionId: string,
  opts: { mainTurnStartedAt?: string } = {},
): Promise<Map<string, MarkdownImageSeedDoc> | undefined> {
  type SeedWork = {
    text: string;
    /** ref 发号器的下一号 = max(ref)+1。**只管身份分配**:主文档的号在同一条会话里跨回合
     * 连续(sink 的 seen 跨文档留着),所以发号器要看全部回合 —— 但它因此**推不出**本回合
     * 交代了几处(审查第 8 轮复审 R3:拿「号数」当「完成数」,接回后把待定义引用当成交代
     * 过,定义到了也不再交付)。 */
    refs: number;
    /** 本范围(主文档=本回合,子文档=全部)已交代记录的身份(ref 号),数量用。 */
    finals: Set<number>;
    /** 本范围已交代记录的节点起点(pos)—— 推导「交代推进到哪」的唯一可信依据。 */
    delivered: Set<number>;
    /** 临时账里冻结的字节与 lost 结论,同一处取最后一笔。 */
    snapshots: Map<number, { pos: number; destination: string; path?: string; lost?: boolean }>;
  };
  const docs = new Map<string, SeedWork>();
  const doc = (id: string): SeedWork => {
    let found = docs.get(id);
    if (!found) {
      found = { text: "", refs: 0, finals: new Set(), delivered: new Set(), snapshots: new Map() };
      docs.set(id, found);
    }
    return found;
  };
  const count = (seeded: SeedWork, ref: number, pos: unknown, inScope: boolean) => {
    seeded.refs = Math.max(seeded.refs, ref + 1);
    if (!inScope) return;
    seeded.finals.add(ref);
    if (typeof pos === "number") seeded.delivered.add(pos);
  };
  /** 快照式正文(message/result)各是独立文档:发号器/代号/冻结字节按 (id × 字段) 接续。 */
  type MetaWork = { refs: number; rev: number; byDestination: Map<string, { destination: string; path?: string; lost?: boolean }> };
  const metas = new Map<string, MetaWork>();
  const meta = (id: string, field: MetaImageField): MetaWork => {
    const key = metaSeedKey(id, field);
    let found = metas.get(key);
    if (!found) {
      found = { refs: 0, rev: 0, byDestination: new Map() };
      metas.set(key, found);
    }
    return found;
  };
  for (const entry of await readTraceEntries(taskId, sessionId)) {
    const main = opts.mainTurnStartedAt !== undefined && entry.turnStartedAt === opts.mainTurnStartedAt;
    if (main && entry.event.kind === "text" && entry.event.text) {
      doc("").text += entry.event.text;
      continue;
    }
    if (entry.event.kind === "attachment" && typeof entry.event.ref === "number" && entry.event.ref < SYNTH_REF_BASE) {
      count(doc(""), entry.event.ref, entry.event.pos, main);
      continue;
    }
    const child = childEventOf(entry.event);
    if (!child) continue;
    // message/result(快照式正文)的记录不属于执行记录那份追加式文档:算进它的身份计数,
    // 接回后的第一处引用就会跳号,展示端按「来源+身份」去重时夹掉真记录。它们接到自己的
    // 账上(发号器与代号)。
    if (child.event.kind === "attachment" && child.event.field) {
      const seeded = meta(child.id, child.event.field);
      if (typeof child.event.ref === "number") seeded.refs = Math.max(seeded.refs, child.event.ref + 1);
      seeded.rev = Math.max(seeded.rev, child.event.rev ?? 0);
      continue;
    }
    if (child.event.kind === "text" && child.event.text) doc(child.id).text += child.event.text;
    else if (child.event.kind === "attachment" && typeof child.event.ref === "number" && child.event.ref < SYNTH_REF_BASE) {
      count(doc(child.id), child.event.ref, child.event.pos, true);
    }
  }
  for (const line of await readJournal(taskId, sessionId)) {
    if (line.field) {
      // 快照式正文的账:发号器、代号接续;冻的字节按目的地接回(同一回合接回时,协议把
      // 同一份正文重放给新进程,同目的地必须沿用当时拍下的那一份,而不是现在去读盘)。
      const seeded = meta(line.doc ?? "", line.field);
      if (line.final && typeof line.ref === "number") seeded.refs = Math.max(seeded.refs, line.ref + 1);
      seeded.rev = Math.max(seeded.rev, line.rev ?? 0);
      seeded.byDestination.set(line.source, {
        destination: line.source,
        ...(line.path ? { path: line.path } : {}),
        ...(line.lost ? { lost: true } : {}),
      });
      continue;
    }
    const inScope = line.doc != null || line.turnStartedAt === opts.mainTurnStartedAt;
    if (line.final) {
      if (typeof line.ref !== "number" || line.ref >= SYNTH_REF_BASE) continue;
      count(doc(line.doc ?? ""), line.ref, line.pos, inScope);
    } else if (inScope) {
      // 只冻结、没交代的那几笔:字节(或 lost 结论)接回种子,接回的 sink 交代到那一处时
      // 用**当时**的拷贝,而不是现在去读盘。同一处取最后一笔(目的地可能改过)。
      const seeded = doc(line.doc ?? "");
      seeded.snapshots.set(line.pos, {
        pos: line.pos,
        destination: line.source,
        ...(line.path ? { path: line.path } : {}),
        ...(line.lost ? { lost: true } : {}),
      });
    }
  }
  const out = new Map<string, MarkdownImageSeedDoc>();
  for (const [id, seeded] of docs) {
    if (!seeded.text && !seeded.refs) continue;
    // 交代推进到哪,只信得过「已交代的恰是正文最前面那几个节点、每条都带着节点起点」的
    // 情形:按文档顺序走节点,交付的前缀走到哪、交代线就在哪 —— 之后的引用(含还在等定义
    // 的)由接回的 sink 继续交代(审查第 8 轮 R1)。判据与发号器无关:号数跨回合连续,
    // 「本回合已交付 1 条、号是 1」推不出「本回合该有 2 条」(复审 R3)。对不上(老数据
    // 没有 pos、有越过前缀的交代)就退回老口径 —— 整段当作交代过,宁可少交代也不重复交代
    // (重复会让展示端同目的地多一条,整组作废)。
    const nodes = markdownImageRefs(seeded.text);
    let prefix = 0;
    let end = 0;
    while (prefix < nodes.length && seeded.delivered.has(nodes[prefix].start)) {
      end = Math.max(end, nodes[prefix].end);
      prefix += 1;
    }
    const trusted = seeded.delivered.size === seeded.finals.size && seeded.delivered.size === prefix;
    out.set(id, {
      text: seeded.text,
      refs: seeded.refs,
      emitted: trusted ? end : seeded.text.length,
      ...(seeded.snapshots.size ? { snapshots: [...seeded.snapshots.values()] } : {}),
    });
  }
  for (const [key, seeded] of metas) {
    if (!seeded.refs && !seeded.byDestination.size && !seeded.rev) continue;
    out.set(key, {
      text: "",
      refs: seeded.refs,
      emitted: 0,
      // 接回的进程从上一条进程的最高代 + 1 起算:两边的记录绝不共代,展示端取最高代时
      // 不会把两条进程各自的冻结混成一组。
      rev: seeded.rev + 1,
      ...(seeded.byDestination.size
        ? { snapshots: [...seeded.byDestination.values()].map((snap) => ({ pos: 0, ...snap })) }
        : {}),
    });
  }
  return out.size ? out : undefined;
}

/** 文档在对账里的身份:子文档跨回合是同一份,主文档一回合一份(sink 的 Ledger 同一口径);
 * message/result 的快照式正文各是独立一份(别跟同 id 的执行记录文档撞位置)。 */
const docKey = (doc: string | null | undefined, turnStartedAt: string, field?: string): string =>
  (doc == null ? `\u0000${turnStartedAt}` : doc) + (field ? `\u0001${field}` : "");

function imageEvent(line: JournalLine, ref: number): SessionTraceEvent {
  const image: AgentEvent = {
    kind: "attachment",
    source: line.source,
    ref,
    pos: line.pos,
    ...(line.field ? { field: line.field, rev: line.rev ?? 0 } : {}),
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
 *     记录(SYNTH_REF_BASE 起,不跟真身份撞),让展示端配对认领那份字节。
 * 两类都只补**已落盘正文里真有这个节点、目的地也对得上**的那一处(见 nodeAt):正文没落盘
 * 的引用屏幕上本来就不存在,硬补只会让「第 n 处 ↔ 第 n 条」的对账多出一条,反把已显示的
 * 同目的地引用拖成作废 —— final 一样会死在落笔前的半路上(审查第 8 轮 R1 实测 B)。
 *
 * 追加在末尾即可:展示端按 turnStartedAt 键入分组(conversationTraceGroups),合成行自己
 * 带着原回合的起点;同一目的地内的**文档顺序**不靠追加位置表达 —— 每条记录都带着节点身份
 * `pos`,展示端按它把同目的地的记录排回文档顺序再配对(审查第 8 轮 R1 实测 A:接回后新流
 * 先交付、补回行在后,按出场顺序配就是红蓝对调)。
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
  const tracedKey = (turn: string, doc: string | null | undefined, field: string | undefined, source: string, ref: number) =>
    `${turn}\u0000${doc ?? ""}\u0000${field ?? ""}\u0000${source}\u0000${ref}`;
  for (const entry of entries) {
    const event = entry.event;
    if (event.kind === "text" && event.text) {
      const key = docKey(null, entry.turnStartedAt);
      texts.set(key, (texts.get(key) ?? "") + event.text);
      continue;
    }
    if (event.kind === "attachment" && typeof event.ref === "number") {
      traced.add(tracedKey(entry.turnStartedAt, null, undefined, event.source ?? "", event.ref));
      continue;
    }
    // 快照式正文(message/result)按**替换**语义收集:展示端认的是最后一版(含空串清场),
    // field 账的恢复只认「落盘的这一版里真有这个节点」—— 不核对就补,补回来的可能是没保存
    // 的另一版的记录(复审 R1 中断/恢复一例)。result 事件的正文是原始字符串,记录的 pos
    // 也是按它算的,两边同一口径。
    const work = event.kind === "tool" ? event.nativeWork : undefined;
    if (work?.type === "agent") {
      if (typeof work.message === "string") texts.set(docKey(work.id, entry.turnStartedAt, "message"), work.message);
      if (typeof work.result === "string") texts.set(docKey(work.id, entry.turnStartedAt, "result"), work.result);
    } else if (work?.type === "result") {
      texts.set(docKey(work.id, entry.turnStartedAt, "result"), work.result);
    }
    const child = childEventOf(event);
    if (!child) continue;
    if (child.event.kind === "text" && child.event.text) {
      texts.set(child.id, (texts.get(child.id) ?? "") + child.event.text);
    } else if (child.event.kind === "attachment" && typeof child.event.ref === "number") {
      traced.add(tracedKey(entry.turnStartedAt, child.id, child.event.field, child.event.source ?? "", child.event.ref));
    }
  }
  const finalsAt = new Set<string>();
  /** 账本 final 的 身份 → pos:给 trace 里没带 pos 的老记录补上节点身份,新旧记录混在
   * 同一目的地时,展示端的文档序排序才有依据(复审 R3:只要有一条没 pos 排序就不生效)。 */
  const finalPos = new Map<string, number>();
  for (const line of journal) {
    if (!line.final) continue;
    finalsAt.add(`${docKey(line.doc, line.turnStartedAt, line.field)}\u0000${line.pos}`);
    if (typeof line.ref === "number") {
      finalPos.set(tracedKey(line.turnStartedAt, line.doc ?? null, line.field, line.source, line.ref), line.pos);
    }
  }
  // 「真实正文里的对应节点」:恢复只认**已落盘正文**里确实存在、目的地也对得上的那一处。
  // 身份对不上节点的(正文没写进 trace 的后半截、目的地后来改写过的旧笔),final 和临时账
  // 一条都不补 —— 补了就是让展示端拿「正文里不存在的引用」去配对:同目的地多出一条,
  // 原本已交付的那几处整组被判作废(审查第 8 轮 R1 实测 B:正文只有 1 处 shot.png,恢复出
  // 2 条记录,好图变「图取不到」)。
  const nodes = new Map<string, Map<number, string>>();
  const nodeAt = (key: string, pos: number): string | undefined => {
    let found = nodes.get(key);
    if (!found) {
      found = new Map();
      for (const node of markdownImageRefs(texts.get(key) ?? "")) found.set(node.start, node.destination);
      nodes.set(key, found);
    }
    return found.get(pos);
  };
  const synth: { line: JournalLine; event: SessionTraceEvent }[] = [];
  const provisional = new Map<string, JournalLine>();
  for (const line of journal) {
    if (line.final) {
      if (typeof line.ref !== "number") continue;
      // 追加式文档核 text 事件拼出的正文;快照式正文核 agent/result 事件里最后一版 ——
      // 两类都只补「落盘正文里真有这个节点、目的地也对得上」的那一处。
      if (nodeAt(docKey(line.doc, line.turnStartedAt, line.field), line.pos) !== line.source) continue;
      const key = tracedKey(line.turnStartedAt, line.doc, line.field, line.source, line.ref);
      if (traced.has(key)) continue;
      traced.add(key);
      synth.push({ line, event: imageEvent(line, line.ref) });
    } else {
      // 同一处取最后一笔:目的地可能改过(还在写的定义行后来接长了;快照式正文换稿挪过
      // 坐标),最后那笔才是定论。键带 field:两份字段文档的同一坐标不是同一处。
      provisional.set(`${docKey(line.doc, line.turnStartedAt, line.field)}\u0000${line.pos}`, line);
    }
  }
  let bump = 0;
  for (const [key, line] of provisional) {
    if (finalsAt.has(key)) continue;
    if (nodeAt(docKey(line.doc, line.turnStartedAt, line.field), line.pos) !== line.source) continue;
    synth.push({ line, event: imageEvent(line, SYNTH_REF_BASE + bump++) });
  }
  const patched = entries.map((entry) => {
    const event = entry.event;
    if (event.kind === "attachment" && typeof event.ref === "number" && event.pos === undefined) {
      const pos = finalPos.get(tracedKey(entry.turnStartedAt, null, undefined, event.source ?? "", event.ref));
      if (pos !== undefined) return { ...entry, event: { ...event, pos } };
    }
    const child = childEventOf(event);
    if (child && child.event.kind === "attachment" && typeof child.event.ref === "number" && child.event.pos === undefined) {
      const pos = finalPos.get(tracedKey(entry.turnStartedAt, child.id, child.event.field, child.event.source ?? "", child.event.ref));
      if (pos !== undefined) {
        return { ...entry, event: childActivity(child.id, { ...child.event, pos }) as SessionTraceEvent };
      }
    }
    return entry;
  });
  if (!synth.length && patched.every((entry, i) => entry === entries[i])) return entries;
  synth.sort((a, b) =>
    (a.line.doc ?? "").localeCompare(b.line.doc ?? "")
    || a.line.turnStartedAt.localeCompare(b.line.turnStartedAt)
    || a.line.pos - b.line.pos);
  return [
    ...patched,
    ...synth.map(({ line, event }) => ({ at: line.at, turnStartedAt: line.turnStartedAt, event })),
  ];
}
