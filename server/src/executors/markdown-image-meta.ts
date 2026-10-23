// 子智能体「返回结果」那一类正文的图片账本 —— nativeWork 的 message/result 与单独的
// result 事件。
//
// 为什么不并进 markdown-image-stream 的 Ledger:那本账是**追加式文档**(全文只增不减,
// 坐标永不变),而 message/result 是**整段替换的快照**(每条 agent 状态事件带来一份当下
// 全文,下一条可能整段重写),两种时序没法共用一套 scanned/settled 游标。可字节的规矩是
// 同一条:**协议读到那一刻就冻**。
//
// 身份与版本(复审 R1:同线程、同字段、同目的地、甚至局部递增的代号,都不能证明属于
// 当前可见正文的这处图片):
//   · 文档 = (线程 id × 字段)。message 与 result 是两份独立正文,各自捕获、各自交代。
//   · 代(rev) = 这份文档的第几**版**。判据是正文本身:新值是旧值的**前缀延续**(流式
//     增量、同文重放)= 同一代;其余任何情形 —— 清场(协议发空串)、已交代后换稿、
//     **非前缀的整段改写**(同一回合的第二条消息、挪动/替换引用)—— 都开新一代。上一版
//     只认「清场/已交代后换稿」,同回合连发两条消息时第二条还顶着第一条的冻结(复审 R1
//     protocolMessageReplacement:最新正文说蓝,记录仍红)。
//   · 代内按**节点**(pos)冻结,不按目的地:前缀延续里旧节点坐标不动,新出现的节点
//     (包括同路径的第二处)按**它自己**出现那一刻拍字节(复审 R1 snapshotNewOccurrence:
//     应 RED/BLUE,按目的地首见会拍成 RED/RED)。
//   · ref 发号器跨代、跨进程连续(种子接回),同文档两条记录永不撞身份。
//
// 口径:
//   · capture —— 每条带 message/result 的事件到达时按上面的判据定代,当代**还没冻结的
//     节点**当场拍字节;每个节点记一笔**临时账**(final:false)——消费者死在交代之前,
//     重建那一侧才有凭据按「落盘的那版正文」把它补回来。
//   · 交代 —— result 事件一到就交代;agent 状态到终态时交代两个字段;流收尾清掉没交代的。
//     每代至多交代一次:快照式正文没有「前缀推进」,同代交代两版会让展示端计数翻倍。
//   · 记录带 `field` + `rev`,展示端按 field 路由、按 rev 取最高代(nativeWorkModel)。
//   · 种子接回(跨进程):带上一条进程**最后一版**的正文、代号、按节点冻结的字节与
//     「那一代交代过没有」。接回后同文重放(前缀)= 同一代沿用冻结;真正的新内容自然
//     落进非前缀/清场那一档开新代 —— 「同回合重放要继承」不被推广成「下一回合也继承」
//     (复审 R1 metaResumeNewTurn)。
import type { AgentEvent, NativeAgentActivity } from "@ash/shared";
import { markdownImageRefs } from "@ash/shared/markdown-images";
import { childResultTexts } from "@ash/shared/native-work";
import {
  captureMarkdownImages,
  imageStore,
  persistMarkdownImageRefs,
  type ImageSnapshots,
  type ImageStore,
} from "../agent-attachments.js";
import { childActivity } from "./native-agent-activity.js";
import { markdownTextHash } from "./markdown-image-ledger.js";
import type { MarkdownImageSeedDoc, MarkdownImageSpot } from "./markdown-image-stream.js";

export type MetaImageField = "message" | "result";

/** meta 文档在种子表里的键(跟 ledger 的 doc id 空间用 \u0001 隔开,永不相撞)。 */
export const metaSeedKey = (id: string, field: MetaImageField): string => `${id}\u0001${field}`;

type FieldDoc = {
  /** ref 发号器:跨代连续(种子接回时从上一条进程续号)。 */
  store: ImageStore;
  /** 当前代号。 */
  rev: number;
  /** 当前代的最新全文("" = 这一代还没有内容)。 */
  text: string;
  /** 当前代曾有过内容 —— 清场信号只对有过内容的代有意义(初始化就是空)。 */
  had: boolean;
  /** 当前代:节点起点 → 首见那一刻冻的字节(或 lost 结论)。代内只前缀延续,坐标不漂。 */
  snapshots: ImageSnapshots;
  /** 当前代已记过临时账的节点起点 → 记账时的目的地(目的地变了要重记)。 */
  noted: Map<number, string>;
  /** 当前代已交代。 */
  emitted: boolean;
  /** 这份正文最近一次的快照身份(协议给的 messageId / 调用 id)。身份换了 = 换稿,哪怕
   * 文字是前缀延长 —— 两条独立快照之间,文字前缀证明不了同一份正文(复审 R1)。 */
  version?: string;
};

export type MetaImageAccounts = {
  /** 协议读到这条事件:带 message/result 的,按版本判代,当代新节点的字节当场拍下。 */
  capture(event: AgentEvent): void;
  /** 这条事件进流了:该在它身上交代的记录(result 到了 / agent 到终态)。 */
  settle(event: AgentEvent): AgentEvent[];
  /** 流到头:没交代的全部交代掉。 */
  close(): AgentEvent[];
};

export function metaImageAccounts(opts: {
  cwd?: string;
  note?: (record: MarkdownImageSpot) => void;
  /** 与 sink 共用的清理账本:拍下的进 captured,记过临时账的进 exposed(dispose 不删),
   * 被结果领走的进 claimed。 */
  captured: Set<string>;
  claimed: Set<string>;
  exposed: Set<string>;
  /** 跨进程种子(metaSeedKey 键):上一条进程的正文、代号、发号器与按节点冻结的字节。 */
  seed?: ReadonlyMap<string, MarkdownImageSeedDoc>;
}): MetaImageAccounts {
  const docs = new Map<string, FieldDoc>();
  /** 调用 id → name/input:结果事件只带调用 id,结构化结果要按**调用**的形状才拆得出子正文。 */
  const calls = new Map<string, { name: string; input: unknown }>();
  const docOf = (id: string, field: MetaImageField): FieldDoc => {
    const key = metaSeedKey(id, field);
    let found = docs.get(key);
    if (!found) {
      const seeded = opts.seed?.get(key);
      const store = imageStore();
      const snapshots: ImageSnapshots = new Map();
      if (seeded) {
        store.refs = seeded.refs;
        // 上一条进程这一代冻的字节按**节点**接回:重启接回时协议会把同一份正文(或它的
        // 延续)重放给新进程,同代同节点必须沿用**当时**拍下的那一份,而不是现在去读盘。
        // 接回的正文走不到同一代(非前缀)时,这张表随 reopen 整个丢弃,不会泄给新代。
        for (const snap of seeded.snapshots ?? []) {
          snapshots.set(snap.pos, {
            destination: snap.destination,
            ...(snap.path ? { path: snap.path } : {}),
            ...(snap.lost ? { lost: true } : {}),
          });
        }
      }
      found = {
        store,
        rev: seeded?.rev ?? 0,
        text: seeded?.text ?? "",
        had: !!seeded?.text,
        snapshots,
        // 种子里的节点都是上一条进程记过账的(按当时的目的地),重放同一代时不再记第二笔;
        // 目的地要是变了(定义行后来接长),按新目的地重拍重记。
        noted: new Map([...snapshots].map(([pos, snap]) => [pos, snap.destination])),
        // 种子说这一代交代过(emitted 覆盖全文)就不再交代:重放同文再交代一遍,展示端同
        // 目的地计数翻倍,整组作废。
        emitted: !!seeded?.text && (seeded.emitted ?? seeded.text.length) >= seeded.text.length,
        // 上一条进程最后那版正文的协议身份:接回后身份一换就按换稿走(take 的 replaced),
        // 哪怕新文是旧文的前缀延长 —— 不接,重启前的冻结会被安到重启后的新话上。
        ...(seeded?.version !== undefined ? { version: seeded.version } : {}),
      };
      docs.set(key, found);
    }
    return found;
  };

  const reopen = (doc: FieldDoc) => {
    doc.rev += 1;
    doc.text = "";
    doc.had = false;
    doc.snapshots = new Map();
    doc.noted = new Map();
    doc.emitted = false;
  };

  const take = (id: string, field: MetaImageField, value: unknown, version?: string) => {
    if (typeof value !== "string") return;
    const key = metaSeedKey(id, field);
    if (!value) {
      // 协议明确清场(turn/started 发空的 message/result):这一代到此为止。种子里有账、
      // 本进程还没建档的也要应答 —— 新进程续聊的第一个清场信号恰恰落在这种时刻,跳过它,
      // 下一段正文就会顶着上一条进程的代号和冻结说话(复审 R1 新回合继承一例)。
      const existing = docs.get(key) ?? (opts.seed?.has(key) ? docOf(id, field) : undefined);
      if (existing?.had) reopen(existing);
      return;
    }
    const doc = docOf(id, field);
    // 协议给了快照身份(messageId / 调用 id)而且换了,就按换稿走:两条**独立**的完整快照
    // 之间,文字前缀证明不了同一份正文 —— 同回合第二条消息恰好以第一条开头时,图早被重拍
    // 过,沿用上一条的冻结是把旧字节安在新话上(复审 R1 distinctPrefixMessages)。
    const replaced = version !== undefined && doc.version !== undefined && version !== doc.version && doc.had;
    if (version !== undefined) doc.version = version;
    if (doc.text === value && !replaced) return;
    // 新一代的判据(见文件头):已交代后的任何变化、换了快照身份,或**非前缀**的改写。
    // 前缀延续(流式增量、重放后接着说)留在当代 —— 代内坐标因此永不漂移,节点账才能按 pos 记。
    if (doc.emitted || replaced || !value.startsWith(doc.text)) reopen(doc);
    doc.text = value;
    doc.had = true;
    const refs = markdownImageRefs(value);
    // 当代还没冻结的节点当场拍字节:同路径的第二处是**另一个节点**,按它自己出现的时刻拍。
    // 全量传入 —— capture 自带「同起点同目的地才跳过」,目的地改写过的节点按新目的地重拍。
    for (const path of captureMarkdownImages(refs, doc.store, doc.snapshots, { cwd: opts.cwd })) {
      opts.captured.add(path);
    }
    // 临时账按节点记:消费者死在交代之前,恢复侧按「落盘正文里真有这个节点」补回。账带
    // 正文指纹(len/hash):同坐标同来源证明不了同一**版**正文,恢复侧只认指纹对得上落盘
    // 正文的那几笔(复审 R1 journalAheadOfTrace)。来源写冻结时的目的地(读不到新目的地时
    // 冻结停在旧目的地,账不许替没冻到的字节背书);目的地真换到了就按新目的地再记一笔。
    for (const ref of refs) {
      const snapshot = doc.snapshots.get(ref.start);
      if (!snapshot || (!snapshot.path && !snapshot.lost)) continue;
      if (doc.noted.get(ref.start) === snapshot.destination) continue;
      doc.noted.set(ref.start, snapshot.destination);
      if (snapshot.path) opts.exposed.add(snapshot.path);
      opts.note?.({
        doc: id, field, rev: doc.rev, pos: ref.start, source: snapshot.destination,
        ...(snapshot.path ? { path: snapshot.path } : {}),
        ...(snapshot.lost ? { lost: true } : {}),
        len: doc.text.length, hash: markdownTextHash(doc.text),
        ...(doc.version !== undefined ? { version: doc.version } : {}),
        final: false,
      });
    }
  };

  const emit = (id: string, field: MetaImageField): AgentEvent[] => {
    const doc = docs.get(metaSeedKey(id, field));
    if (!doc || !doc.text || doc.emitted) return [];
    doc.emitted = true;
    const refs = markdownImageRefs(doc.text);
    const out: AgentEvent[] = [];
    for (const image of persistMarkdownImageRefs(refs, doc.store, { cwd: opts.cwd, snapshots: doc.snapshots })) {
      if (image.path) opts.claimed.add(image.path);
      opts.note?.({
        doc: id, field, rev: doc.rev, pos: image.pos ?? 0, source: image.source,
        ref: image.ref, path: image.path, lost: image.lost,
        len: doc.text.length, hash: markdownTextHash(doc.text),
        ...(doc.version !== undefined ? { version: doc.version } : {}),
        final: true,
      });
      // 交代事件同样带身份:展示端把记录配给正文前,先核「这组记录说的就是这条消息」——
      // 同文不同身份是两份独立快照(第 10 轮审查 R2)。
      const activity: NativeAgentActivity = {
        kind: "attachment", field, rev: doc.rev,
        ...(doc.version !== undefined ? { version: doc.version } : {}),
        ...image,
      };
      out.push(childActivity(id, activity));
    }
    return out;
  };

  return {
    capture(event) {
      const work = event.kind === "tool" ? event.nativeWork : undefined;
      if (!work) return;
      if (work.type === "call") {
        calls.set(work.id, { name: work.name, input: work.input });
      } else if (work.type === "agent") {
        take(work.id, "message", work.message, work.messageId);
        take(work.id, "result", work.result);
      } else if (work.type === "result") {
        // 结构化结果(wait 的 statuses、taskoutput 的 <output>)按**子正文**各记各的账
        // (文档 = 子智能体 id × result),提取与展示端共用 childResultTexts:扫原始 JSON
        // 的坐标和转义在解码后的正文里对不上,title 带引号的图连节点都数不出(复审 R1
        // encodedMarkdown/routedJournalLate)。快照身份 = 这一次调用:下一次 wait 再报的
        // 同文是新快照,照换代重拍。拆不出的仍按原文整份记。
        const saved = calls.get(work.id);
        const children = childResultTexts(saved?.name, saved?.input, work.result);
        if (children.length) for (const child of children) take(child.id, "result", child.text, work.id);
        else take(work.id, "result", work.result);
      }
    },
    settle(event) {
      const work = event.kind === "tool" ? event.nativeWork : undefined;
      if (!work) return [];
      if (work.type === "result") {
        const saved = calls.get(work.id);
        const children = childResultTexts(saved?.name, saved?.input, work.result);
        if (children.length) return children.flatMap((child) => emit(child.id, "result"));
        return emit(work.id, "result");
      }
      if (work.type === "agent" && (work.closed === true || ["completed", "failed", "stopped"].includes(work.status))) {
        return [...emit(work.id, "message"), ...emit(work.id, "result")];
      }
      return [];
    },
    close() {
      const out: AgentEvent[] = [];
      for (const key of docs.keys()) {
        const sep = key.indexOf("\u0001");
        out.push(...emit(key.slice(0, sep), key.slice(sep + 1) as MetaImageField));
      }
      return out;
    },
  };
}
