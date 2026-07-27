// /team 主视图的纯数据装配:从任务列表 + 已解析的指挥台会话里推出「批次」「入站
// 消息」「谁在等你」这些视图概念。纯函数、无 JSX、不碰 api —— 三个组件共用同一套
// 推导,也方便单独看懂。
import type { Task, TaskStatus } from "@harness/shared";
import type { ConvItem } from "../Conversation";
import { executorMix } from "../executorLabel";

// ── 批次(一次 dispatch)────────────────────────────────────────────────────
// 一次 dispatch = 一个内部分组(groups.owner_task_id 指回团队任务)。内部组被
// GET /groups 过滤掉了(前端根本拿不到那些组行),所以批次信息全部从工人身上反推:
// groupId 分堆、最早的 createdAt 当批次时刻、有人带 queueId 就是串行批。
export type Batch = { key: string; workers: Task[]; serial: boolean; at: string };

export function workersOf(all: Task[], leadId: string): Task[] {
  return all
    .filter((t) => t.parentId === leadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function batchesOf(workers: Task[]): Batch[] {
  const by = new Map<string, Task[]>();
  for (const w of workers) {
    const k = w.groupId ?? `solo:${w.id}`; // 理论上都有内部组;没有也别把它吞掉
    const arr = by.get(k);
    if (arr) arr.push(w);
    else by.set(k, [w]);
  }
  return [...by.entries()]
    .map(([key, ws]) => ({
      key,
      workers: ws,
      serial: ws.some((w) => !!w.queueId),
      at: ws.reduce((m, w) => (w.createdAt < m ? w.createdAt : m), ws[0]!.createdAt),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

// ── 状态计数(header 右侧那排)──────────────────────────────────────────────
// 「等你答复」是 question 非空的组合态,不是一个 TaskStatus,所以单独一档,
// 并且排在最前面 —— 它是唯一「不动手就永远停在这」的状态。
export type CountBucket = { label: string; status: TaskStatus; awaitingAnswer?: boolean; n: number };

export function statusCounts(workers: Task[]): CountBucket[] {
  const n = (pick: (t: Task) => boolean) => workers.filter(pick).length;
  const asking = (t: Task) => !!t.question;
  const buckets: CountBucket[] = [
    { label: "等答复", status: "paused", awaitingAnswer: true, n: n(asking) },
    { label: "干活", status: "running", n: n((t) => !asking(t) && t.status === "running") },
    { label: "排队", status: "queued", n: n((t) => !asking(t) && (t.status === "queued" || t.status === "backlog")) },
    { label: "暂停", status: "paused", n: n((t) => !asking(t) && t.status === "paused") },
    { label: "挂了", status: "failed", n: n((t) => t.status === "failed") },
    { label: "完成", status: "done", n: n((t) => t.status === "done") },
    { label: "取消", status: "canceled", n: n((t) => t.status === "canceled") },
  ];
  return buckets.filter((b) => b.n > 0);
}

// 「工人 4（codex×3 · claude×1）」里括号那截。
export function agentMix(workers: Task[]): string {
  return executorMix(workers);
}

// ── 入站消息(工人 → 指挥者)────────────────────────────────────────────────
// server 把三种唤醒写成 〔系统〕turn(server/src/team/prompts.ts 的 INBOUND_*),
// 于是它们在会话里就是普通的 system 条目。这里按模板前缀认回来,画成「⇢ 来自④」
// 那种气泡。解析只在这一个地方,模板改了就改这儿。
export type Inbound = {
  kind: "question" | "failed" | "done" | "note";
  title?: string;
  taskId?: string;
  body: string; // 给人看的那截
  raw: string; // 原始整条(hover 可看,不丢信息)
};

const KIND: Record<string, Inbound["kind"]> = { 工人提问: "question", 工人失败: "failed", 工人完成: "done" };
const HEAD = /^【(工人提问|工人失败|工人完成)】「([\s\S]+?)」\(taskId=([^)]+)\)/;
// 每个模板尾部那段是写给指挥者的操作指引(「先调查…再 answer_question…」),对用户是
// 噪音,按各自的固定分界砍掉;原文仍留在 raw 里。模板(server/src/team/prompts.ts)
// 改了这里要跟着改 —— 两边同一个 commit。
const TAIL: Partial<Record<Inbound["kind"], RegExp>> = {
  question: /\n\n先调查/,
  failed: /。查它的会话与产物/,
  done: /。核查产物/,
};
const Q_PREFIX = /^已暂停等你答复[,，]问题[:：]\s*/;
// 指挥者忙着的时候攒下的工人消息会被 session.ts 合并成一条送进去(这个分隔符相连),
// 所以先拆开再逐条认。
const MERGE_SEP = "\n\n---\n\n";

export function parseInbound(text: string): Inbound[] | null {
  const rows: Inbound[] = text.split(MERGE_SEP).map((c) => {
    const raw = c.trim();
    const m = HEAD.exec(raw);
    if (!m) return { kind: "note" as const, body: raw, raw };
    const kind = KIND[m[1]!]!;
    let body = raw.slice(m[0].length).trim();
    const tail = TAIL[kind];
    if (tail) body = body.split(tail)[0]!.trim();
    if (kind === "question") body = body.replace(Q_PREFIX, "");
    return { kind, title: m[2], taskId: m[3], body, raw };
  });
  // 一条都不像入站消息 → 交回去当普通系统提示渲染(比如空闲回收、被接回的提示)。
  return rows.some((r) => r.kind !== "note") ? rows : null;
}

// ── 谁在等你 ─────────────────────────────────────────────────────────────────
// 等得最久的那个排最前(它最该被处理)。等待起点用工人自己那个提问回合的结束时刻。
export type Waiting = { task: Task; since: string | null };

export function waitingWorkers(workers: Task[]): Waiting[] {
  return workers
    .filter((w) => !!w.question)
    .map((w) => ({ task: w, since: w.endedAt ?? w.startedAt ?? null }))
    .sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
}

// ── feed 装配 ────────────────────────────────────────────────────────────────
// 派活卡在指挥者的会话里没有留痕(dispatch 是个 MCP 工具调用),所以按时刻把它插进
// 条目流:一批工人的 createdAt 落在某个回合的执行区间内,卡片就排在那个回合之后。
export type FeedRow =
  | { kind: "conv"; key: string; item: ConvItem }
  | { kind: "batch"; key: string; batch: Batch };

function itemTime(it: ConvItem): string | null {
  return it.kind === "agent" ? it.endedAt ?? it.time ?? null : it.at ?? null;
}

export function mergeFeed(items: ConvItem[], batches: Batch[]): FeedRow[] {
  // 单调化:没时间戳的条目继承前一个已知时刻,免得插入点乱跳。
  let known: string | null = null;
  const times = items.map((it) => (known = itemTime(it) ?? known));
  const sorted = [...batches].sort((a, b) => a.at.localeCompare(b.at));
  const rows: FeedRow[] = [];
  let bi = 0;
  const flush = (upTo: string | null) => {
    while (bi < sorted.length && (upTo === null || sorted[bi]!.at <= upTo)) {
      const b = sorted[bi++]!;
      rows.push({ kind: "batch", key: `b:${b.key}`, batch: b });
    }
  };
  items.forEach((item, i) => {
    // 派活发生在某个回合执行期间,所以卡片要排在那个回合之后 —— 判据是「批次时刻
    // 早于上一条目的结束时刻」,而不是跟当前条目比(那会插到回合前面去)。
    if (i > 0) flush(times[i - 1] ?? null);
    rows.push({ kind: "conv", key: `c:${i}`, item });
  });
  flush(null); // 剩下的(比最后一个回合还新)排在末尾
  return rows;
}

// 指挥者自己那条时间轴:从已解析的会话里把每个回合的执行区间捞出来。
export function leadTurns(items: ConvItem[]): { from: string; to: string | null }[] {
  return items
    .filter((it): it is Extract<ConvItem, { kind: "agent" }> => it.kind === "agent" && !!it.time)
    .map((it) => ({ from: it.time!, to: it.endedAt ?? null }));
}
