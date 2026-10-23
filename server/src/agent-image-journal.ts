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
import { childResultTexts } from "@ash/shared/native-work";
import { externalImageDestination } from "./agent-attachments.js";
import { markdownTextHash } from "./executors/markdown-image-ledger.js";
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
    /** 不需要本地结果的节点(站外/data:,交代时如实记过):推交代线时是**合法间隔**。 */
    noRecord: Set<number>;
  };
  const docs = new Map<string, SeedWork>();
  const doc = (id: string): SeedWork => {
    let found = docs.get(id);
    if (!found) {
      found = { text: "", refs: 0, finals: new Set(), delivered: new Set(), snapshots: new Map(), noRecord: new Set() };
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
  /** 快照式正文(message/result)各是独立文档:发号器/代号/冻结字节按 (id × 字段) 接续。
   * `text` 是 trace 里最后一版正文(含空串清场);`emitted` 是交代过的代号集合;`lines` 是
   * 账本逐行(出口只取最高代那组,按**节点**接回 —— 代内前缀延续,坐标不漂)。 */
  type MetaWork = {
    refs: number;
    rev: number;
    text?: string;
    /** trace 里最后那版正文的协议身份(messageId/调用 id)。与 meta 侧 doc.version 同一
     * 口径:没带身份的事件不清旧值。 */
    version?: string;
    emitted: Set<number>;
    lines: {
      rev: number; pos: number; destination: string; path?: string; lost?: boolean;
      len?: number; hash?: number; version?: string; final?: boolean;
    }[];
  };
  const metas = new Map<string, MetaWork>();
  const meta = (id: string, field: MetaImageField): MetaWork => {
    const key = metaSeedKey(id, field);
    let found = metas.get(key);
    if (!found) {
      found = { refs: 0, rev: 0, emitted: new Set(), lines: [] };
      metas.set(key, found);
    }
    return found;
  };
  /** 调用 id → name/input:结构化结果要按调用的形状拆子正文,与记账侧(meta)同一把尺。 */
  const calls = new Map<string, { name: string; input: unknown }>();
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
    const work = entry.event.kind === "tool" ? entry.event.nativeWork : undefined;
    if (work?.type === "call") calls.set(work.id, { name: work.name, input: work.input });
    if (work?.type === "agent") {
      // 快照式正文按**替换**语义取最后一版(空串 = 清场):种子判「重放同一代」还是「新
      // 内容开新代」全靠它 —— 不带正文的种子只能无条件继承冻结,正是复审 R1 的新回合一例。
      // 协议身份(messageId)跟着正文走:接回的进程靠它识破「新消息以旧消息开头」的换稿
      // (第 10 轮审查 R2 resumedIdentity);没带身份的事件不清旧值,与 meta 侧同口径。
      if (typeof work.message === "string") {
        const seeded = meta(work.id, "message");
        seeded.text = work.message;
        if (work.messageId !== undefined) seeded.version = work.messageId;
      }
      if (typeof work.result === "string") meta(work.id, "result").text = work.result;
    } else if (work?.type === "result") {
      // 结构化结果与记账侧同一把尺(childResultTexts):账记在子正文的文档上,正文也按
      // 子正文接回,否则指纹与节点都对不上号。拆不出的按原文整份。子正文的身份 = 这一次
      // 调用(meta 侧 take 的 version 同源):下一次 wait 再报同文也是新快照。
      const saved = calls.get(work.id);
      const children = childResultTexts(saved?.name, saved?.input, work.result);
      if (children.length) for (const child of children) {
        const seeded = meta(child.id, "result");
        seeded.text = child.text;
        seeded.version = work.id;
      }
      else meta(work.id, "result").text = work.result;
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
      seeded.emitted.add(child.event.rev ?? 0);
      continue;
    }
    if (child.event.kind === "text" && child.event.text) doc(child.id).text += child.event.text;
    else if (child.event.kind === "attachment" && typeof child.event.ref === "number" && child.event.ref < SYNTH_REF_BASE) {
      count(doc(child.id), child.event.ref, child.event.pos, true);
    }
  }
  for (const line of await readJournal(taskId, sessionId)) {
    if (line.field) {
      // 快照式正文的账:发号器无条件接续(多留几号无害);**代号与已交代**要先过正文指纹
      // 才算数 —— 账可能属于比落盘更新、一字未存的一版(复审 R1 journalAheadOfTrace),
      // 这儿就信它,接回的就是没保存那版的字节。筛选在出口处对着 trace 正文做。
      const seeded = meta(line.doc ?? "", line.field);
      if (line.final && typeof line.ref === "number") seeded.refs = Math.max(seeded.refs, line.ref + 1);
      seeded.lines.push({
        rev: line.rev ?? 0, pos: line.pos, destination: line.source,
        ...(line.path ? { path: line.path } : {}),
        ...(line.lost ? { lost: true } : {}),
        ...(typeof line.len === "number" && typeof line.hash === "number" ? { len: line.len, hash: line.hash } : {}),
        ...(typeof line.version === "string" ? { version: line.version } : {}),
        ...(line.final ? { final: true } : {}),
      });
      continue;
    }
    const inScope = line.doc != null || line.turnStartedAt === opts.mainTurnStartedAt;
    if (line.final && line.skipped) {
      // 站外/data: 节点:没有结果可交付,但它**交代过了** —— 推交代线时跳过它,而不是在
      // 它身上断言「后面都没交代」(复审 R3:一个站外图让整段被当成已完成,待定引用作废)。
      if (inScope) doc(line.doc ?? "").noRecord.add(line.pos);
      continue;
    }
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
    let covered = 0;
    while (prefix < nodes.length) {
      const start = nodes[prefix].start;
      if (seeded.delivered.has(start)) covered += 1;
      // 没交付记录的节点要么是账上记过的合法间隔(skipped 行),要么**可证明**不需要本地
      // 结果(站外/data:,交代侧本来就不产记录)—— 老账没有 skipped 行(复审 R3),只能按
      // 真实解析出的目的地自证;相对路径不算,它该有记录,没有就是真断了。
      else if (!seeded.noRecord.has(start) && !externalImageDestination(nodes[prefix].destination)) break;
      end = Math.max(end, nodes[prefix].end);
      prefix += 1;
    }
    // 判据仍是「已交付的恰是前缀、每条都对得上节点」,只是前缀里允许穿插无需本地结果的
    // 节点(covered 只数真交付的);对不上就退回老口径,宁可少交代也不重复交代。
    const trusted = seeded.delivered.size === seeded.finals.size && seeded.delivered.size === covered;
    out.set(id, {
      text: seeded.text,
      refs: seeded.refs,
      emitted: trusted ? end : seeded.text.length,
      ...(seeded.snapshots.size ? { snapshots: [...seeded.snapshots.values()] } : {}),
    });
  }
  for (const [key, seeded] of metas) {
    if (!seeded.refs && !seeded.lines.length && !seeded.rev && !seeded.text) continue;
    if (seeded.text) {
      // 正文在:接回的进程把同文重放(前缀)认成**同一代**,冻结按节点沿用,交代过的不再
      // 交代;真正的新内容(非前缀/清场后)由 meta 账自己开新代。账本行先过**正文指纹**:
      // 同坐标同来源证明不了同一版(红/蓝两版等长同路径,按坐标全对得上),只有「记账时的
      // 前 len 字符」指纹对得上落盘正文的才算这版的账,比落盘更新的那一版(一字未存)整组
      // 不认(复审 R1 journalAheadOfTrace)。老账没有指纹,沿旧口径放行,节点接回时仍按
      // (pos, destination) 双重核对。
      const text = seeded.text;
      // 身份先行:指纹核得过内容、核不过身份 —— 两条独立消息恰好同文时 len/hash 完全相同,
      // 只有记账时的协议身份对上落盘那条的,才算这版的账(第 10 轮审查 R2 identicalTextJournal)。
      // 单边没带身份(老账、没报 messageId 的协议)沿旧口径放行,交给指纹与节点核对。
      const verified = seeded.lines.filter((line) =>
        (line.version === undefined || seeded.version === undefined || line.version === seeded.version)
        && (line.len === undefined || line.hash === undefined
          ? true
          : line.len <= text.length && markdownTextHash(text.slice(0, line.len)) === line.hash));
      const rev = verified.reduce((top, line) => Math.max(top, line.rev), seeded.rev);
      const emitted = seeded.emitted.has(rev) || verified.some((line) => line.final && line.rev === rev);
      const byPos = new Map<number, { pos: number; destination: string; path?: string; lost?: boolean }>();
      for (const line of verified) {
        if (line.rev !== rev) continue;
        byPos.set(line.pos, {
          pos: line.pos, destination: line.destination,
          ...(line.path ? { path: line.path } : {}),
          ...(line.lost ? { lost: true } : {}),
        });
      }
      out.set(key, {
        text,
        refs: seeded.refs,
        emitted: emitted ? text.length : 0,
        rev,
        ...(seeded.version !== undefined ? { version: seeded.version } : {}),
        ...(byPos.size ? { snapshots: [...byPos.values()] } : {}),
      });
    } else {
      // 清场收尾、或老 trace 里读不到正文:不知道上一代长什么样,就**不继承**任何冻结 ——
      // 「同一回合重放要继承」不能无条件推广(复审 R1 新回合一例)。下一段内容从比一切已知
      // 代号(含账本里没核验的)都新的一代起算,免得跟死代的账撞号。
      const top = seeded.lines.reduce((high, line) => Math.max(high, line.rev), seeded.rev);
      out.set(key, { text: "", refs: seeded.refs, emitted: 0, rev: top + 1 });
    }
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
    ...(line.field ? { field: line.field, rev: line.rev ?? 0, ...(line.version !== undefined ? { version: line.version } : {}) } : {}),
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
  /** docKey → 落盘正文的协议身份(messageId/调用 id)。账本行的身份要对上它才算这版的账
   * (两条独立消息恰好同文时指纹分不开,第 10 轮审查 R2 identicalTextJournal)。 */
  const textVersions = new Map<string, string>();
  /** 调用 id → name/input:结构化结果按子正文收集,与记账侧同一把尺(childResultTexts)。 */
  const calls = new Map<string, { name: string; input: unknown }>();
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
    if (work?.type === "call") calls.set(work.id, { name: work.name, input: work.input });
    if (work?.type === "agent") {
      if (typeof work.message === "string") {
        texts.set(docKey(work.id, entry.turnStartedAt, "message"), work.message);
        // 没带身份的事件不清旧值(与 meta 的 doc.version 同口径)。
        if (work.messageId !== undefined) textVersions.set(docKey(work.id, entry.turnStartedAt, "message"), work.messageId);
      }
      if (typeof work.result === "string") texts.set(docKey(work.id, entry.turnStartedAt, "result"), work.result);
    } else if (work?.type === "result") {
      // 结构化结果拆成子正文(账在子文档上,见 meta 的 capture),正文也按子文档收集,
      // 指纹与节点核对才对得上号(复审 R1 routedJournalLate/encodedMarkdown)。
      const saved = calls.get(work.id);
      const children = childResultTexts(saved?.name, saved?.input, work.result);
      if (children.length) {
        for (const child of children) {
          texts.set(docKey(child.id, entry.turnStartedAt, "result"), child.text);
          // 子正文的身份 = 这一次调用(meta 记账的 version 同源)。
          textVersions.set(docKey(child.id, entry.turnStartedAt, "result"), work.id);
        }
      } else {
        texts.set(docKey(work.id, entry.turnStartedAt, "result"), work.result);
      }
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
    if (!line.final || line.skipped) continue;
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
  let bump = 0;
  const provisional = new Map<string, JournalLine>();
  /** 快照式正文的账按文档攒起来,代号筛选在下面单独做(追加式文档没有「代」,走原路)。 */
  const fieldDocs = new Map<string, JournalLine[]>();
  for (const line of journal) {
    if (line.skipped) continue;
    if (line.field) {
      const key = docKey(line.doc, line.turnStartedAt, line.field);
      fieldDocs.set(key, [...(fieldDocs.get(key) ?? []), line]);
      continue;
    }
    if (line.final) {
      if (typeof line.ref !== "number") continue;
      // 只补「落盘正文里真有这个节点、目的地也对得上」的那一处(nodeAt 的注释)。
      if (nodeAt(docKey(line.doc, line.turnStartedAt, line.field), line.pos) !== line.source) continue;
      const key = tracedKey(line.turnStartedAt, line.doc, line.field, line.source, line.ref);
      if (traced.has(key)) continue;
      traced.add(key);
      synth.push({ line, event: imageEvent(line, line.ref) });
    } else {
      // 同一处取最后一笔:目的地可能改过(还在写的定义行后来接长了),最后那笔才是定论。
      provisional.set(`${docKey(line.doc, line.turnStartedAt, line.field)}\u0000${line.pos}`, line);
    }
  }
  for (const [key, line] of provisional) {
    if (finalsAt.has(key)) continue;
    if (nodeAt(docKey(line.doc, line.turnStartedAt, line.field), line.pos) !== line.source) continue;
    synth.push({ line, event: imageEvent(line, SYNTH_REF_BASE + bump++) });
  }
  // 快照式正文:**哪一代对得上落盘的那版正文,就恢复哪一代** —— 从最高代往下找第一个
  // 「至少一个节点核对得上」的代。身份(docKey/临时账键)不带代号的上一版在这儿栽过:
  // 旧代已在同一坐标交代过,就把新代同坐标的临时冻结压掉,正文明明保存的是新版,恢复出
  // 的只剩旧代字节(复审 R1 journalGeneration:应 BLUE,实际 RED)。更老的代一条都不补:
  // 它们说的是已经不在屏幕上的版本,展示端按最高代取,补了也只会在同目的地计数里添乱。
  for (const [key, lines] of fieldDocs) {
    // 指纹先行:带 len/hash 的账只认「记账时的正文前缀」与落盘正文对得上的那几笔 ——
    // 同坐标同来源不能证明同一版(复审 R1 journalAheadOfTrace);老账没有指纹,仍按节点
    // 核对放行。
    const text = texts.get(key) ?? "";
    // 身份先行(同种子出口):两边都带协议身份时必须相等,单边没带沿旧口径放行。
    const version = textVersions.get(key);
    const verified = lines.filter((line) =>
      (line.version === undefined || version === undefined || line.version === version)
      && (typeof line.len !== "number" || typeof line.hash !== "number"
        ? true
        : line.len <= text.length && markdownTextHash(text.slice(0, line.len)) === line.hash));
    const revs = [...new Set(verified.map((line) => line.rev ?? 0))].sort((a, b) => b - a);
    for (const rev of revs) {
      const current = verified.filter((line) => (line.rev ?? 0) === rev);
      const passing = current.filter((line) => nodeAt(key, line.pos) === line.source);
      if (!passing.length) continue;
      const finalsHere = new Set(passing.filter((line) => line.final).map((line) => line.pos));
      const pending = new Map<number, JournalLine>();
      for (const line of passing) {
        if (line.final) {
          if (typeof line.ref !== "number") continue;
          const traceKey = tracedKey(line.turnStartedAt, line.doc, line.field, line.source, line.ref);
          if (traced.has(traceKey)) continue;
          traced.add(traceKey);
          synth.push({ line, event: imageEvent(line, line.ref) });
        } else if (!finalsHere.has(line.pos)) {
          pending.set(line.pos, line);
        }
      }
      for (const line of pending.values()) synth.push({ line, event: imageEvent(line, SYNTH_REF_BASE + bump++) });
      break;
    }
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
