// 挂在回复框顶上的建议任务随任务接力（寿命规则见 shared/src/dispatch-suggestion.ts 顶部「活多久」）。
//
// 清单里带任务行上的两列，JSON 原样：还挂着、用户没处理的那几件（`dispatchSuggestions`），和智能体收回过的
// 每一件（`dispatchWithdrawals`）。不带的话任务换一台机器那几件就不见了——用户没派也没点叉，会话里那句
// 「挂在回复框顶上了」指向空处；移回时对端新挂的、新收回的也留在对端回不来。
//
// 落到本机时：
//   · 没带（老版本对端的清单里没有这个键）跟带了个空的是两回事：没带 = 这一列不动，本机原来有什么还是
//     什么；带了 null 或空数组 = 任务在持有机上时那几件已经被处理完了。
//   · 挂着的那几件以带来的为准：任务在持有机上，派、叉、收回都发生在那儿。
//   · 收回记录只增不减：本机已有的一条不碰，带来的里本机还没有的接在后面（dispatch-suggestion.ts
//     `appendWithdrawn`，在 SQL 里追加）。持有机是老版本、或者途中少了几条，本机的也不会因此变少。
//   · 交给谁里的执行器 id 只在挂它的那台机器上有意义：落地时置空、派出去时按类型重新解析（同任务自己的
//     executorId）；本机存档里还留着同一件、类型没变，就接回本机原来选的那个。类型、模型、智能水平原样带。
//   · 从哪开工（trunk / here）原样带：派出去时页面按本机项目的分支现算起点，清单里不带分支。
//   · 说明里引用的上传附件路径由调用方先改写成本机路径（handoff-import.ts，同提问那几列）；收回记录不改写，
//     它是已经发生的事，改了字就认不出是不是同一条。
import { eq, type SQL } from "drizzle-orm";
import { AGENT_TYPES } from "@navi/shared";
import type { DispatchRunTarget } from "@navi/shared/dispatch-plan";
import {
  parseDispatchSuggestions, parseWithdrawnSuggestions, type DispatchSuggestion, type WithdrawnSuggestion,
} from "@navi/shared/dispatch-suggestion";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { appendWithdrawn } from "./dispatch-suggestion.js";
import { HandoffError, type HandoffManifest } from "./handoff-types.js";
import { now } from "./util.js";

type Carried = Pick<HandoffManifest["task"], "id" | "dispatchSuggestions" | "dispatchWithdrawals">;
type Store = Pick<typeof db, "select">;

const FIELDS = ["dispatchSuggestions", "dispatchWithdrawals"] as const;

const PARSED = { dispatchSuggestions: parseDispatchSuggestions, dispatchWithdrawals: parseWithdrawnSuggestions };

/**
 * 带了就得是 JSON 数组的文本，里面每一条都得认得出（跟读这一列的地方同一个判据）。坏值整份拒收：当成「一件都
 * 没有」落下去、或者只落认得出的那几条，都是替用户悄悄少搬了几件——移回时还会连本机存档里的一起换掉。
 * 没带和 null 都放行。
 */
export function validateSuggestionPayload(task: Partial<Record<(typeof FIELDS)[number], unknown>>): void {
  for (const field of FIELDS) {
    const raw = task[field];
    if (raw == null) continue;
    let list: unknown = null;
    try { list = typeof raw === "string" ? JSON.parse(raw) : null; } catch { /* 下面按非法报 */ }
    if (!Array.isArray(list)) throw new HandoffError(`task.${field} 非法`);
    const unreadable = list.length - PARSED[field](raw as string).length;
    if (unreadable) throw new HandoffError(`task.${field} 非法：有 ${unreadable} 条认不出`);
  }
}

export function exportSuggestions(task: typeof tasks.$inferSelect): Pick<Carried, (typeof FIELDS)[number]> {
  return { dispatchSuggestions: task.dispatchSuggestions, dispatchWithdrawals: task.dispatchWithdrawals };
}

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const serialized = (items: unknown[]): string | null => (items.length ? JSON.stringify(items) : null);

function landedTarget(raw: DispatchRunTarget | null | undefined, mine: DispatchRunTarget | null | undefined): DispatchRunTarget | null {
  // 本机不认识的智能体类型（对端版本更新）：按没指明交给谁落，派出去时用这条任务的默认值。
  if (!raw || typeof raw !== "object" || !AGENT_TYPES.includes(raw.agentType)) return null;
  return {
    agentType: raw.agentType,
    executorId: mine?.agentType === raw.agentType ? mine.executorId : null,
    model: text(raw.model), reasoningEffort: text(raw.reasoningEffort),
  };
}

/** 带来的那几件逐件按已知的几样重建（多出来的键不落库）；`mine` 是本机存档里挂着的，只用来接回执行器。 */
function landed(raw: string | null, mine: DispatchSuggestion[]): DispatchSuggestion[] {
  const kept = new Map(mine.map((item) => [item.id, item.target]));
  return parseDispatchSuggestions(raw).map((item) => ({
    id: item.id, title: item.title, body: item.body, note: typeof item.note === "string" ? item.note : "",
    target: landedTarget(item.target, kept.get(item.id)), base: item.base === "here" ? "here" : "trunk",
    proposedAt: typeof item.proposedAt === "string" ? item.proposedAt : now(),
  }));
}

// 一条收回记录是一次收回：同一件、同一时刻的就是同一条。
const recordKey = (record: WithdrawnSuggestion) => `${record.id}\n${record.at}`;

/** 带来的收回记录里本机还没有的那几条，照带来的先后。 */
function freshWithdrawn(raw: string | null, mine: WithdrawnSuggestion[]): WithdrawnSuggestion[] {
  const have = new Set(mine.map(recordKey));
  return parseWithdrawnSuggestions(raw).flatMap((record) => {
    if (have.has(recordKey(record))) return [];
    have.add(recordKey(record));
    return [{ id: record.id, title: record.title, reason: record.reason, at: record.at }];
  });
}

/** 第一次落到本机（新建任务行）：两列照带来的落，没带就是空的。 */
export function landedSuggestionColumns(carried: Carried): { dispatchSuggestions: string | null; dispatchWithdrawals: string | null } {
  return {
    dispatchSuggestions: serialized(landed(carried.dispatchSuggestions ?? null, [])),
    dispatchWithdrawals: serialized(freshWithdrawn(carried.dispatchWithdrawals ?? null, [])),
  };
}

/**
 * 本机已有这条任务的存档（移回、再次接过来）：跟覆盖任务行同一笔事务里读本机那两列，交回要写的。
 * 没带的那一列不出现在结果里，于是不被覆盖；收回记录交回的是「往后接」的 SQL，不是整列的新值。
 */
export async function returnedSuggestionColumns(
  store: Store,
  carried: Carried,
): Promise<{ dispatchSuggestions?: string | null; dispatchWithdrawals?: SQL }> {
  if (carried.dispatchSuggestions === undefined && carried.dispatchWithdrawals === undefined) return {};
  const mine = (await store.select({ suggestions: tasks.dispatchSuggestions, withdrawals: tasks.dispatchWithdrawals })
    .from(tasks).where(eq(tasks.id, carried.id))).at(0);
  const fresh = carried.dispatchWithdrawals === undefined
    ? []
    : freshWithdrawn(carried.dispatchWithdrawals, parseWithdrawnSuggestions(mine?.withdrawals));
  return {
    ...(carried.dispatchSuggestions === undefined
      ? {}
      : { dispatchSuggestions: serialized(landed(carried.dispatchSuggestions, parseDispatchSuggestions(mine?.suggestions))) }),
    ...(fresh.length ? { dispatchWithdrawals: appendWithdrawn(fresh) } : {}),
  };
}
