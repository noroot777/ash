// 挂在回复框顶上的那一列在服务端怎么读、怎么写（类型、三档 wait、接口形状见 shared/src/dispatch-suggestion.ts）：
//   · 读（`readSuggestions`）：所有地方都按这一处归一——等着的那一批只在它绑的那一问还在时算数（被答掉、被新消息
//     撤下、被别的提问换掉就不认它）；上线前摆的老派活单（tasks.dispatch_plan，仍跟 question 对得上）并进来，
//     读成同一批、按它当时说定的 afterLaunch 等（没说的按 continue）。任何一次写回都落成这一列、清掉旧列，
//     所以老单子不用迁移脚本，碰一下就是新的。
//   · 写：挂、收回、派、叉改的都是同一列，各在一笔立即加锁的事务里读、算、写（读到的就是写的底，谁都不吞掉谁）；
//     答复那一问时顺带拿掉它绑的那一批，按「读到的那三列还在」条件写（`sameColumns`：归一的结果取决于它们）。
//   · 收回的原因跟拿掉那一件**同一条更新**落库（`appendWithdrawn`）：不变量是「建议不见了 ⇒ 原因读得到」。
//     收回记录只往后接，没有任何一处删它、截它、重写它：这里没有任何东西知道用户看没看过。它跟任务同寿。
// 智能体那一笔在 dispatch-suggestion-agent.ts，派出去 / 点叉那一笔在 dispatch-suggestion-resolve.ts。
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
  parseDispatchSuggestions, storedSuggestionOf, type StoredSuggestion, type WithdrawnSuggestion,
} from "@navi/shared/dispatch-suggestion";
import { tasks } from "./db/schema.js";

/** 归一要看的三列。 */
export type SuggestionColumns = { question: string | null; dispatchSuggestions: string | null; dispatchPlan: string | null };

export const serializedSuggestions = (items: readonly StoredSuggestion[]): string | null => (items.length ? JSON.stringify(items) : null);

/** 等着的那一批（归一之后至多一批，都绑着此刻那一问）。 */
export const waitingBatchOf = (items: readonly StoredSuggestion[]): StoredSuggestion[] => items.filter((item) => item.wait !== "none");

/**
 * 上线前摆的派活单，还跟那一问对得上时读成等着的那一批。每一件的 id 由单子号和行号定：读几遍都是同一个 id，
 * 页面拿着它派、叉都对得上。
 */
function legacyPlanSuggestions(raw: string | null, question: string | null): StoredSuggestion[] {
  if (!raw || !question) return [];
  let plan: { id?: unknown; question?: unknown; order?: unknown; items?: unknown; afterLaunch?: unknown; proposedAt?: unknown };
  try {
    plan = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!plan || typeof plan.id !== "string" || plan.question !== question || !Array.isArray(plan.items)) return [];
  const batch = plan.id;
  return plan.items.flatMap((item: Record<string, unknown>, index) => storedSuggestionOf({
    ...item, id: `${batch}-${index}`, base: "trunk", proposedAt: plan.proposedAt, batch,
    order: plan.order === "parallel" ? "parallel" : "serial",
    wait: plan.afterLaunch === "done" ? "done" : "continue", question,
    review: item?.review ?? "default",
  }) ?? []);
}

export function readSuggestions(row: SuggestionColumns): StoredSuggestion[] {
  const items = parseDispatchSuggestions(row.dispatchSuggestions)
    .filter((item) => item.wait === "none" || (!!row.question && item.question === row.question));
  if (waitingBatchOf(items).length) return items;
  return [...items, ...legacyPlanSuggestions(row.dispatchPlan, row.question)];
}

/** 同一批里一件的 key 在全列里的写法（不同批的 key 可以重名）。 */
export const scopedKey = (item: Pick<StoredSuggestion, "batch">, key: string): string => `${item.batch}\n${key}`;

/**
 * 同一批里有几件不在了（派出去、点叉、被智能体收回）：还挂着的那几件指向它们的前置跟着改——派出去的换成建出来的
 * 任务 id，没建的（点叉、收回）划掉。`rewrite` 的键是 `scopedKey`，值是任务 id 或 null。不在了的那几件本身由调用方处理。
 */
export function rewritePrerequisites(items: StoredSuggestion[], rewrite: ReadonlyMap<string, string | null>): StoredSuggestion[] {
  if (!rewrite.size) return items;
  return items.map((item) => {
    if (item.settled || !item.prerequisites?.length) return item;
    const prerequisites = item.prerequisites.flatMap((ref) => {
      const scoped = scopedKey(item, ref);
      if (!rewrite.has(scoped)) return [ref];
      const replaced = rewrite.get(scoped);
      return replaced ? [replaced] : [];
    });
    const { prerequisites: _old, ...rest } = item;
    return prerequisites.length ? { ...item, prerequisites } : rest;
  });
}

/** 那一问是不是一批派活在等（同一时刻只等用户一样东西：有它就不能再提问）。 */
export const waitingOnDispatch = (row: SuggestionColumns): boolean => !!row.question && waitingBatchOf(readSuggestions(row)).length > 0;

/** 写回时的条件：归一用到的三列都还是读到的那一份。 */
export function sameColumns(row: SuggestionColumns): SQL {
  const same = (column: typeof tasks.question | typeof tasks.dispatchSuggestions | typeof tasks.dispatchPlan, value: string | null) =>
    value === null ? isNull(column) : eq(column, value);
  return and(same(tasks.question, row.question), same(tasks.dispatchSuggestions, row.dispatchSuggestions), same(tasks.dispatchPlan, row.dispatchPlan))!;
}

/**
 * 收回记录那一列的新值：在库里现有的那一份后面接上这几条。在 SQL 里接，不读出来改完再整份写回——已有的记录
 * 这一笔只是原样带过去（`json()` 只核它是 JSON、去掉多余空白），所以不存在「读的时候认不出就丢了」「写回时被
 * 截短」这两种丢法；库里那一份坏了（不是 JSON）这条更新整个失败，建议也不会被拿掉。
 *
 * 新记录整批是**一个**参数（一段 JSON 数组的文本），接在现有数组的文本后面：现有那份去掉末尾的 `]`，新的那份
 * 去掉开头的 `[`，中间一个逗号。不用 json_insert 逐条给路径和值：那样函数的实参个数跟着条数涨，而 SQLite 对
 * 实参个数有编译期上限（各版本不同，127 或 1000）；任务从别的机器移回时要一次接上对端攒下的全部记录
 * （handoff-suggestions.ts），条数没有上限。
 */
export function appendWithdrawn(records: readonly WithdrawnSuggestion[]): SQL {
  if (!records.length) return sql`${tasks.dispatchWithdrawals}`;
  const added = JSON.stringify(records);
  const current = sql`json(coalesce(${tasks.dispatchWithdrawals}, '[]'))`;
  return sql`CASE WHEN json_array_length(${current}) = 0 THEN ${added} ELSE substr(${current}, 1, length(${current}) - 1) || ',' || substr(${added}, 2) END`;
}

/** 智能体挂和收回的那一笔：任务还在跑，回合和方向还是入口核过的那一份（核的时候是空的，写的时候也得是空的）。 */
export function turnWriteGuard(seen: { activeTurnToken: string | null; activeDirectionToken: string | null }): SQL {
  return and(
    eq(tasks.status, "running"),
    seen.activeTurnToken === null ? isNull(tasks.activeTurnToken) : eq(tasks.activeTurnToken, seen.activeTurnToken),
    seen.activeDirectionToken === null ? isNull(tasks.activeDirectionToken) : eq(tasks.activeDirectionToken, seen.activeDirectionToken),
  )!;
}
