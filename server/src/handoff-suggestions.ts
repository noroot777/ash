// 挂在回复框顶上的活随任务接力（寿命规则、三档 wait 见 shared/src/dispatch-suggestion.ts 顶部）。
//
// 清单里带任务行上的两列：还挂着、用户没处理的那几件（`dispatchSuggestions`，按本机读这一列的口径归一过——
// 等着的那一批只在那一问还在时带，老派活单并成这一列带），等着的那一批里已经处理掉的那几件（`dispatchSettled`，
// 单开一个键：老版本对端不认识了结记录，混在前一列里会被当成还挂着的；处理完时交给智能体的清单靠它，不带的话
// 先派了一件再接力，最后交出去的清单里就没有那一件），和智能体收回过的每一件（`dispatchWithdrawals`，JSON 原样）。等着的那一批绑的那一问随 question 那一列一起走，
// 到了对端照样停着等；老版本对端不认识 wait，那一批落成不等的几件、那一问落成普通提问。不带的话任务换一台机器
// 那几件就不见了——用户没派也没点叉；移回时对端新挂的、新收回的也留在对端回不来。
//
// 落到本机时：
//   · 没带（老版本对端的清单里没有这个键）跟带了个空的是两回事：没带 = 这一列不动，本机原来有什么还是
//     什么；带了 null 或空数组 = 任务在持有机上时那几件已经被处理完了。
//   · 挂着的那几件以带来的为准：任务在持有机上，派、叉、收回都发生在那儿。本机那一列里的老派活单
//     （tasks.dispatch_plan）一并清掉：带来的那一份已经是归一过的全部。
//   · 收回记录只增不减：本机已有的一条不碰，带来的里本机还没有的接在后面（dispatch-suggestion.ts
//     `appendWithdrawn`，在 SQL 里追加）。持有机是老版本、或者途中少了几条，本机的也不会因此变少。
//   · 交给谁里的执行器 id 只在挂它的那台机器上有意义：落地时置空、派出去时按类型重新解析（同任务自己的
//     executorId）；本机存档里还留着同一件、类型没变，就接回本机原来选的那个。类型、模型、智能水平原样带。
//   · 从哪开工（trunk / here）原样带：派出去时页面按本机项目的分支现算起点，清单里不带分支。
//   · 挂着的那几件前置指着的已有任务本机都得有，缺了整个拒收（`checkCarriedPrerequisites`，理由见那里）。
//   · 说明里引用的上传附件路径由调用方先改写成本机路径（handoff-import.ts，同提问那几列）；收回记录不改写，
//     它是已经发生的事，改了字就认不出是不是同一条。
import { eq, inArray, type SQL } from "drizzle-orm";
import { AGENT_TYPES } from "@navi/shared";
import type { DispatchRunTarget } from "@navi/shared/dispatch-target";
import {
  hangingSuggestions, parseDispatchSuggestions, parseWithdrawnSuggestions, type StoredSuggestion, type WithdrawnSuggestion,
} from "@navi/shared/dispatch-suggestion";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { appendWithdrawn, pendingReceiptsOf, readSuggestions, serializedSuggestions } from "./dispatch-suggestion.js";
import { HandoffError, type HandoffManifest } from "./handoff-types.js";
import { now } from "./util.js";

type Carried = Pick<HandoffManifest["task"], "id" | "dispatchSuggestions" | "dispatchWithdrawals" | "dispatchSettled">;
type Store = Pick<typeof db, "select">;

const FIELDS = ["dispatchSuggestions", "dispatchWithdrawals", "dispatchSettled"] as const;

const settledOf = (raw: string | null | undefined): StoredSuggestion[] => parseDispatchSuggestions(raw).filter((item) => item.settled);
const PARSED = { dispatchSuggestions: parseDispatchSuggestions, dispatchWithdrawals: parseWithdrawnSuggestions, dispatchSettled: settledOf };

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
  const items = readSuggestions(task);
  return {
    dispatchSuggestions: serializedSuggestions(hangingSuggestions(items)),
    dispatchWithdrawals: task.dispatchWithdrawals,
    dispatchSettled: serializedSuggestions(items.filter((item) => item.settled)),
  };
}

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const serialized = (items: WithdrawnSuggestion[]): string | null => (items.length ? JSON.stringify(items) : null);

function landedTarget(raw: DispatchRunTarget | null | undefined, mine: DispatchRunTarget | null | undefined): DispatchRunTarget | null {
  // 本机不认识的智能体类型（对端版本更新）：按没指明交给谁落，派出去时用这条任务的默认值。
  if (!raw || typeof raw !== "object" || !AGENT_TYPES.includes(raw.agentType)) return null;
  return {
    agentType: raw.agentType,
    executorId: mine?.agentType === raw.agentType ? mine.executorId : null,
    model: text(raw.model), reasoningEffort: text(raw.reasoningEffort),
  };
}

/**
 * 带来的那几件逐件按已知的几样重建（多出来的键不落库，读这一列的那一份解析器已经做了）；`mine` 只用来接回执行器。
 * 了结记录接回两种：还在等的那一批的（同一批、绑着同一问），和还没交给智能体的回执（`pendingReceiptsOf`，那一批
 * 不等了、建了的任务还没告诉它）；别的（不再等的那一批里点叉的）没人要了。
 */
function landed(raw: string | null, settledRaw: string | null | undefined, mine: StoredSuggestion[]): StoredSuggestion[] {
  const kept = new Map(mine.map((item) => [item.id, item.target]));
  const hanging = hangingSuggestions(parseDispatchSuggestions(raw));
  const waiting = new Set(hanging.filter((item) => item.wait !== "none").map((item) => `${item.batch}\n${item.question ?? ""}`));
  const settled = settledOf(settledRaw)
    .filter((item) => pendingReceiptsOf([item]).length || waiting.has(`${item.batch}\n${item.question ?? ""}`));
  return [...settled, ...hanging.map((item) => ({
    ...item, target: landedTarget(item.target, kept.get(item.id)), proposedAt: item.proposedAt || now(),
  }))];
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

/**
 * 带来的那几件里，前置指着的已有任务（同一批里先派出去的那件换成的任务号、智能体直接指的任务号）本机都得有：任务
 * 接力过来，它派出去的那几条留在原机上，指着它们的那一件在这里只会报「前置任务不存在」。不能把那条前置划掉了事
 * ——那件要的是它们的代码，划掉就会在没有那份代码时开工。所以缺了就整个拒收（在任何落库之前），说清怎么办。
 * 同一批里还挂着的件用 key 指的不算：它们跟着一起来了。
 */
export async function checkCarriedPrerequisites(store: Store, carried: Carried): Promise<void> {
  if (carried.dispatchSuggestions == null) return;
  const hanging = hangingSuggestions(parseDispatchSuggestions(carried.dispatchSuggestions));
  const wanted = new Map<string, string>();
  for (const item of hanging) {
    for (const ref of item.prerequisites ?? []) {
      const sameBatch = hanging.some((other) => other.batch === item.batch && other.key === ref);
      if (!sameBatch && !wanted.has(ref)) wanted.set(ref, item.title);
    }
  }
  if (!wanted.size) return;
  const found = new Set((await store.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, [...wanted.keys()]))).map((row) => row.id));
  const missing = [...wanted].filter(([ref]) => !found.has(ref));
  if (!missing.length) return;
  throw new HandoffError(
    `${missing.map(([ref, title]) => `「${title}」要等的任务 ${ref} `).join("、")}不在这台机器上，接过来也派不出去，什么都没导入。`
      + "请在原机上先把这几件派出去或点叉，或者把它们要等的任务一起接力过来，再接力这一条。",
    409,
  );
}

/** 第一次落到本机（新建任务行）：两列照带来的落，没带就是空的。 */
export function landedSuggestionColumns(carried: Carried): { dispatchSuggestions: string | null; dispatchWithdrawals: string | null } {
  return {
    dispatchSuggestions: serializedSuggestions(landed(carried.dispatchSuggestions ?? null, carried.dispatchSettled, [])),
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
): Promise<{ dispatchSuggestions?: string | null; dispatchPlan?: null; dispatchWithdrawals?: SQL }> {
  if (carried.dispatchSuggestions === undefined && carried.dispatchWithdrawals === undefined) return {};
  const mine = (await store.select({ suggestions: tasks.dispatchSuggestions, withdrawals: tasks.dispatchWithdrawals })
    .from(tasks).where(eq(tasks.id, carried.id))).at(0);
  const fresh = carried.dispatchWithdrawals === undefined
    ? []
    : freshWithdrawn(carried.dispatchWithdrawals, parseWithdrawnSuggestions(mine?.withdrawals));
  return {
    ...(carried.dispatchSuggestions === undefined
      ? {}
      : {
        dispatchSuggestions: serializedSuggestions(landed(carried.dispatchSuggestions, carried.dispatchSettled, parseDispatchSuggestions(mine?.suggestions))),
        dispatchPlan: null,
      }),
    ...(fresh.length ? { dispatchWithdrawals: appendWithdrawn(fresh) } : {}),
  };
}
