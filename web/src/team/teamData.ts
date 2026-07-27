// /team 主视图里依赖 web 会话模型的装配。任务/分组的纯数据函数已经提升到
// @harness/shared，web 和 mobile 共用；这里仅保留 ConvItem 相关解析。
import type { Batch } from "@harness/shared/team";
import type { ConvItem } from "../Conversation";

const TEAM_HALT_TEXT = "你按了「停止全组」";

// 兜底:只有在团队页拿不到任何真实 group 行时,才用会话里持久存在的系统提示提示
// 「曾经停止过」。一旦有 group 行,一律以 group.paused 为准。
export function activeTeamHaltMarker(items: ConvItem[]): boolean {
  let lastHalt = -1;
  items.forEach((it, i) => {
    if (it.kind === "system" && it.text.includes(TEAM_HALT_TEXT)) lastHalt = i;
  });
  if (lastHalt < 0) return false;
  return !items.slice(lastHalt + 1).some((it) => it.kind === "user" || it.kind === "agent");
}

// ── 入站消息(执行者 → 调度者)────────────────────────────────────────────────
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

const KIND: Record<string, Inbound["kind"]> = { 执行者提问: "question", 执行者失败: "failed", 执行者完成: "done" };
const HEAD = /^【(执行者提问|执行者失败|执行者完成)】「([\s\S]+?)」\(taskId=([^)]+)\)/;
// 每个模板尾部那段是写给调度者的操作指引(「先调查…再 answer_question…」),对用户是
// 噪音,按各自的固定分界砍掉;原文仍留在 raw 里。模板(server/src/team/prompts.ts)
// 改了这里要跟着改 —— 两边同一个 commit。
const TAIL: Partial<Record<Inbound["kind"], RegExp>> = {
  question: /\n\n先调查/,
  failed: /。查它的会话与产物/,
  done: /。核查产物/,
};
const Q_PREFIX = /^已暂停等你答复[,，]问题[:：]\s*/;
// 调度者忙着的时候攒下的执行者消息会被 session.ts 合并成一条送进去(这个分隔符相连),
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

// ── feed 装配 ────────────────────────────────────────────────────────────────
// 派活卡在调度者的会话里没有留痕(dispatch 是个 MCP 工具调用),所以按时刻把它插进
// 条目流:一批执行者的 createdAt 落在某个回合的执行区间内,卡片就排在那个回合之后。
export type FeedRow =
  | { kind: "conv"; key: string; item: ConvItem }
  | { kind: "batch"; key: string; batch: Batch };

// 会话哨兵、session 元数据和任务字段虽然当前都写 ISO,历史/实时来源仍可能携带
// 不同的可解析格式。所有团队时间对齐统一先过这一处,禁止再做格式字符串比较。
export function timeMs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function itemStartTime(it: ConvItem): number | null {
  return timeMs(it.kind === "agent" ? it.time : it.at);
}

function itemEndTime(it: ConvItem): number | null {
  return timeMs(it.kind === "agent" ? it.endedAt ?? it.time : it.at);
}

export function mergeFeed(items: ConvItem[], batches: Batch[]): FeedRow[] {
  // 单调化:没时间戳的条目继承前一个已知时刻,免得插入点乱跳。
  let known: number | null = null;
  const times = items.map((it) => (known = itemEndTime(it) ?? known));
  // 解析失败的批次没有可靠插入点,稳定地留到末尾；同一毫秒保持原输入顺序。
  const sorted = batches
    .map((batch, index) => ({ batch, index, at: timeMs(batch.at) }))
    .sort((a, b) => {
      if (a.at === null) return b.at === null ? a.index - b.index : 1;
      if (b.at === null) return -1;
      return a.at - b.at || a.index - b.index;
    });
  const rows: FeedRow[] = [];
  let bi = 0;
  const flushThrough = (upTo: number | null) => {
    if (upTo === null) return;
    while (bi < sorted.length && sorted[bi]!.at !== null && sorted[bi]!.at! <= upTo) {
      const { batch } = sorted[bi++]!;
      rows.push({ kind: "batch", key: `b:${batch.key}`, batch });
    }
  };
  items.forEach((item, i) => {
    // TeamView 可能在已经收到实时日志后才挂载；此时 useConversation 为避免正文重复
    // 不加载旧快照,首条可见消息会晚于历史派活。先把明确早于首条起点的卡放到它前面,
    // 否则这些旧卡只能在最终兜底里全部堆到最新消息之后。
    if (i === 0) flushThrough(itemStartTime(item));
    // 派活发生在某个回合执行期间,所以卡片要排在那个回合之后 —— 判据是「批次时刻
    // 早于上一条目的结束时刻」,而不是跟当前条目比(那会插到回合前面去)。
    if (i > 0) flushThrough(times[i - 1] ?? null);
    rows.push({ kind: "conv", key: `c:${i}`, item });
  });
  // 剩下的(比最后一个回合还新,或时间不可解析)稳定地排在末尾。
  while (bi < sorted.length) {
    const { batch } = sorted[bi++]!;
    rows.push({ kind: "batch", key: `b:${batch.key}`, batch });
  }
  return rows;
}

// 调度者自己那条时间轴:从已解析的会话里把每个回合的执行区间捞出来。
export type LeadTurn = { from: number; to: number | null };

export function leadTurns(items: ConvItem[]): LeadTurn[] {
  return items.flatMap((it) => {
    if (it.kind !== "agent") return [];
    const from = timeMs(it.time);
    return from === null ? [] : [{ from, to: timeMs(it.endedAt) }];
  });
}
