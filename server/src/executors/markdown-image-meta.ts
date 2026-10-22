// 子智能体「返回结果」那一类正文的图片账本 —— nativeWork 的 message/result 与单独的
// result 事件。
//
// 为什么不并进 markdown-image-stream 的 Ledger:那本账是**追加式文档**(全文只增不减,
// 坐标永不变),而 message/result 是**整段替换的快照**(每条 agent 状态事件带来一份当下
// 全文,下一条可能整段重写),两种时序没法共用一套 scanned/settled 游标。可字节的规矩是
// 同一条:**协议读到那一刻就冻**。
//
// 身份与版本(审查第 8 轮复审 R1:同一线程、同一路径、同一字段都不能证明属于同一份正文):
//   · 文档 = (线程 id × 字段)。message 与 result 是两份独立正文,各自捕获、各自交代,
//     不共享「首见路径」—— message 先见到红图,result 后来才说同一个路径,result 那份
//     要按 result 正文到达那一刻的字节算。
//   · 代(rev) = 同一份文档的第几版生命周期。turn/started 把正文清空(协议发空串)、或者
//     已交代之后又换稿,都开新一代:目的地首见冻结、交代资格都按代重算。记录带 rev,
//     展示端只认最高代那组 —— 旧代说的是已经不在屏幕上的那一版正文。
//   · ref 发号器跨代、跨进程连续(种子接回),同文档两条记录永不撞身份。
//
// 口径:
//   · capture —— 每条带 message/result 的事件到达时,当代**新出现的目的地**当场拍字节;
//     每处引用的坐标随当前版本记一笔**临时账**(final:false)——消费者死在交代之前,
//     重建那一侧才有凭据按「落盘的那版正文」把它补回来(复审 R1 中断/恢复一例)。
//   · 交代 —— result 事件一到就交代(它只来一次,字符串即终稿);agent 状态到终态
//     (completed/failed/stopped)时交代两个字段;流收尾清掉还没交代的。每份文档**每代**
//     至多交代一次:快照式正文没有「前缀推进」,同代交代两版会让展示端同目的地计数翻倍。
//   · 记录包一层 childActivity(同一文档身份),attachment 带 `field` + `rev` ——
//     展示端(nativeWorkModel)按 field 路由到对应正文、按 rev 取最高代。
import type { AgentEvent, NativeAgentActivity } from "@ash/shared";
import { markdownImageRefs } from "@ash/shared/markdown-images";
import {
  captureMarkdownImages,
  imageStore,
  persistMarkdownImageRefs,
  type ImageSnapshot,
  type ImageSnapshots,
  type ImageStore,
} from "../agent-attachments.js";
import { childActivity } from "./native-agent-activity.js";
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
  /** 当前代曾有过内容 —— 只有「有过内容之后被清空」才算开新代的信号。 */
  had: boolean;
  /** 当前代:目的地 → 首见那一刻冻的字节(或 lost 结论)。快照式正文坐标会漂,身份按目的地。 */
  byDestination: Map<string, ImageSnapshot>;
  /** 当前代已记过临时账的 (pos, destination):版本换稿挪了坐标就按新坐标再记一笔。 */
  noted: Set<string>;
  /** 当前代已交代。 */
  emitted: boolean;
};

export type MetaImageAccounts = {
  /** 协议读到这条事件:带 message/result 的,当代新目的地的字节当场拍下。 */
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
  /** 跨进程种子(metaSeedKey 键):ref 发号器、代号、上一条进程冻的字节。 */
  seed?: ReadonlyMap<string, MarkdownImageSeedDoc>;
}): MetaImageAccounts {
  const docs = new Map<string, FieldDoc>();
  const docOf = (id: string, field: MetaImageField): FieldDoc => {
    const key = metaSeedKey(id, field);
    let found = docs.get(key);
    if (!found) {
      const seeded = opts.seed?.get(key);
      const store = imageStore();
      const byDestination = new Map<string, ImageSnapshot>();
      if (seeded) {
        store.refs = seeded.refs;
        // 上一条进程冻的字节接回当代:重启接回时协议会把同一份正文重放给新进程,这时
        // 同一目的地必须沿用**当时**拍下的那一份,而不是现在去读盘(代号更高不等于字节
        // 更新 —— 展示端取最高代,接不上种子就等于用后来的文件顶替说话那一刻的画面)。
        for (const snap of seeded.snapshots ?? []) {
          byDestination.set(snap.destination, {
            destination: snap.destination,
            ...(snap.path ? { path: snap.path } : {}),
            ...(snap.lost ? { lost: true } : {}),
          });
        }
      }
      found = { store, rev: seeded?.rev ?? 0, text: "", had: false, byDestination, noted: new Set(), emitted: false };
      docs.set(key, found);
    }
    return found;
  };

  const reopen = (doc: FieldDoc) => {
    doc.rev += 1;
    doc.text = "";
    doc.had = false;
    doc.byDestination = new Map();
    doc.noted = new Set();
    doc.emitted = false;
  };

  const take = (id: string, field: MetaImageField, value: unknown) => {
    if (typeof value !== "string") return;
    if (!value) {
      // 协议明确清场(turn/started 发空的 message/result):这一代到此为止,下一段内容是
      // 新一代 —— 不开新代的话,继续发言后的新结论配的还是上一段首见的旧字节(复审 R1
      // 同线程继续一例)。没内容过的空串不算信号(初始化就是空)。
      const existing = docs.get(metaSeedKey(id, field));
      if (existing?.had) reopen(existing);
      return;
    }
    const doc = docOf(id, field);
    if (doc.text === value) return;
    // 已交代之后又换稿(没有清场信号也一样):交代过的那版已经定格,新稿是新一代。
    if (doc.emitted) reopen(doc);
    doc.text = value;
    doc.had = true;
    const refs = markdownImageRefs(value);
    // 当代新出现的目的地当场拍字节;坐标按这一版正文算只为喂 captureMarkdownImages,
    // 身份落在目的地上。
    const fresh = refs.filter((ref) => !doc.byDestination.has(ref.destination));
    if (fresh.length) {
      const scratch: ImageSnapshots = new Map();
      for (const path of captureMarkdownImages(fresh, doc.store, scratch, { cwd: opts.cwd })) opts.captured.add(path);
      for (const snapshot of scratch.values()) {
        if (!doc.byDestination.has(snapshot.destination)) doc.byDestination.set(snapshot.destination, snapshot);
      }
    }
    // 临时账随**当前版本的坐标**记:消费者死在交代之前,恢复侧只认「落盘正文里真有这个
    // 节点」—— 坐标跟着版本挪,账也要跟着挪,否则对不上号的临时账一条都补不回来。
    for (const ref of refs) {
      const snapshot = doc.byDestination.get(ref.destination);
      if (!snapshot || (!snapshot.path && !snapshot.lost)) continue;
      const key = `${ref.start}\u0000${ref.destination}`;
      if (doc.noted.has(key)) continue;
      doc.noted.add(key);
      if (snapshot.path) opts.exposed.add(snapshot.path);
      opts.note?.({
        doc: id, field, rev: doc.rev, pos: ref.start, source: ref.destination,
        ...(snapshot.path ? { path: snapshot.path } : {}),
        ...(snapshot.lost ? { lost: true } : {}),
        final: false,
      });
    }
  };

  const emit = (id: string, field: MetaImageField): AgentEvent[] => {
    const doc = docs.get(metaSeedKey(id, field));
    if (!doc || !doc.text || doc.emitted) return [];
    doc.emitted = true;
    const refs = markdownImageRefs(doc.text);
    // persist 按起点查快照:把目的地键的快照铺回这一版(当代终稿)的坐标上。
    const snapshots: ImageSnapshots = new Map();
    for (const ref of refs) {
      const snapshot = doc.byDestination.get(ref.destination);
      if (snapshot) snapshots.set(ref.start, snapshot);
    }
    const out: AgentEvent[] = [];
    for (const image of persistMarkdownImageRefs(refs, doc.store, { cwd: opts.cwd, snapshots })) {
      if (image.path) opts.claimed.add(image.path);
      opts.note?.({
        doc: id, field, rev: doc.rev, pos: image.pos ?? 0, source: image.source,
        ref: image.ref, path: image.path, lost: image.lost, final: true,
      });
      const activity: NativeAgentActivity = { kind: "attachment", field, rev: doc.rev, ...image };
      out.push(childActivity(id, activity));
    }
    return out;
  };

  return {
    capture(event) {
      const work = event.kind === "tool" ? event.nativeWork : undefined;
      if (!work) return;
      if (work.type === "agent") {
        take(work.id, "message", work.message);
        take(work.id, "result", work.result);
      } else if (work.type === "result") {
        take(work.id, "result", work.result);
      }
    },
    settle(event) {
      const work = event.kind === "tool" ? event.nativeWork : undefined;
      if (!work) return [];
      if (work.type === "result") return emit(work.id, "result");
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
