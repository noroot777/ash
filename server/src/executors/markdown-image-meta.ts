// 子智能体「返回结果」那一类正文的图片账本 —— nativeWork 的 message/result 与单独的
// result 事件。
//
// 为什么不并进 markdown-image-stream 的 Ledger:那本账是**追加式文档**(全文只增不减,
// 坐标永不变),而 message/result 是**整段替换的快照**(每条 agent 状态事件带来一份当下
// 全文,下一条可能整段重写),两种时序没法共用一套 scanned/settled 游标。可字节的规矩是
// 同一条:**协议读到那一刻就冻**,否则「返回结果里的截图」在展示前被重拍/清理,画出来的
// 是后来的文件(审查第 8 轮 R2 同类漏口:NativeAgentConversation 三处直接读工作目录)。
//
// 口径:
//   · capture —— 每条带 message/result 的事件到达时,把**新出现的目的地**的字节当场拍下
//     (同一份文档同一目的地只拍第一次:后续版本重提同一张图,说的还是先看到的那一版)。
//   · 交代 —— result 事件一到就交代(它只来一次,字符串即终稿);agent 状态到终态
//     (completed/failed/stopped)时交代 message/result 两份;流收尾把没交代的清完。
//     每份文档(id × 字段)**至多交代一次**:快照式正文没有「前缀推进」可言,交代两版会让
//     展示端同目的地计数翻倍,整组作废。
//   · 记录包一层 childActivity(同一文档身份),attachment 上带 `field` 区分它属于
//     message 还是 result —— 展示端(nativeWorkModel)靠它把记录路由到对应那段正文,
//     绝不混进执行记录那份文档的配对。
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
import type { MarkdownImageSpot } from "./markdown-image-stream.js";

export type MetaImageField = "message" | "result";

type MetaDoc = {
  store: ImageStore;
  /** 目的地 → 第一次见到它时冻的字节(或 lost 结论)。快照式正文的坐标会漂,身份只能按目的地。 */
  byDestination: Map<string, ImageSnapshot>;
  /** 各字段当前的最新全文。 */
  texts: Map<MetaImageField, string>;
  /** 已经交代过的字段 —— 至多一次(见文件头)。 */
  emitted: Set<MetaImageField>;
};

export type MetaImageAccounts = {
  /** 协议读到这条事件:带 message/result 的,新目的地的字节当场拍下。 */
  capture(event: AgentEvent): void;
  /** 这条事件进流了:该在它身上交代的记录(result 到了 / agent 到终态)。 */
  settle(event: AgentEvent): AgentEvent[];
  /** 流到头:没交代的全部交代掉。 */
  close(): AgentEvent[];
};

export function metaImageAccounts(opts: {
  cwd?: string;
  note?: (record: MarkdownImageSpot) => void;
  /** 与 sink 共用的清理账本:拍下的进 captured,被结果领走的进 claimed(见 dispose)。 */
  captured: Set<string>;
  claimed: Set<string>;
}): MetaImageAccounts {
  const docs = new Map<string, MetaDoc>();
  const docOf = (id: string): MetaDoc => {
    let found = docs.get(id);
    if (!found) {
      found = { store: imageStore(), byDestination: new Map(), texts: new Map(), emitted: new Set() };
      docs.set(id, found);
    }
    return found;
  };

  const take = (id: string, field: MetaImageField, value: unknown) => {
    if (typeof value !== "string" || !value) return;
    const doc = docOf(id);
    if (doc.texts.get(field) === value) return;
    doc.texts.set(field, value);
    // 新出现的目的地当场拍字节。坐标按这一版正文算只为喂 captureMarkdownImages,身份落在
    // 目的地上 —— 下一版正文把同一张图挪了位置,说的还是同一那一刻的画面。
    const fresh = markdownImageRefs(value).filter((ref) => !doc.byDestination.has(ref.destination));
    if (!fresh.length) return;
    const scratch: ImageSnapshots = new Map();
    for (const path of captureMarkdownImages(fresh, doc.store, scratch, { cwd: opts.cwd })) opts.captured.add(path);
    for (const snapshot of scratch.values()) {
      if (!doc.byDestination.has(snapshot.destination)) doc.byDestination.set(snapshot.destination, snapshot);
    }
  };

  const emit = (id: string, field: MetaImageField): AgentEvent[] => {
    const doc = docs.get(id);
    const text = doc?.texts.get(field);
    if (!doc || !text || doc.emitted.has(field)) return [];
    doc.emitted.add(field);
    const refs = markdownImageRefs(text);
    // persist 按起点查快照:把目的地键的快照铺回这一版(终稿)的坐标上。
    const snapshots: ImageSnapshots = new Map();
    for (const ref of refs) {
      const snapshot = doc.byDestination.get(ref.destination);
      if (snapshot) snapshots.set(ref.start, snapshot);
    }
    const out: AgentEvent[] = [];
    for (const image of persistMarkdownImageRefs(refs, doc.store, { cwd: opts.cwd, snapshots })) {
      if (image.path) opts.claimed.add(image.path);
      opts.note?.({
        doc: id, field, pos: image.pos ?? 0, source: image.source,
        ref: image.ref, path: image.path, lost: image.lost, final: true,
      });
      const activity: NativeAgentActivity = { kind: "attachment", field, ...image };
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
      for (const [id, doc] of docs) {
        for (const field of ["message", "result"] as const) {
          if (doc.texts.has(field) && !doc.emitted.has(field)) out.push(...emit(id, field));
        }
      }
      return out;
    },
  };
}
