// 可以派出去的活在服务端的那一半（类型与「活多久」见 shared/src/dispatch-suggestion.ts）：
//   · 智能体交来的一批怎么收（`normalizeSuggestions`，形状照派活单的一条，多一样「从哪开工」）；
//   · 这一列怎么改（`updateSuggestions`）：挂、收回、派、叉，四处都改同一列，按「读到的那一份还在」
//     条件写回，被别处抢先改过就重读重算——智能体在回合里挂新的、用户同时派掉一件，谁都不吞掉谁；
//   · 智能体那一笔怎么落（`agentChange`）：先收回、再挂新的，同名的不挂第二件；
//   · 收回的原因跟拿掉那一件**同一条更新**落库（`updateSuggestions` 的 `withdrawn`）：不变量是「建议不见了 ⇒
//     原因读得到」，对**每一件**都成立、一直成立。原因不另走会话正文——那样是两步，中间进程退了、会话文件写
//     不进去，用户就只看到它没了。收回记录只往后接（`appendWithdrawn`），没有任何一处删它、截它、重写它：
//     「留最近 N 条」这类上限等于替用户认定更早的他已经看过了，而这里没有任何东西知道他看没看过。它跟任务
//     同寿，任务删了才没。
// 这里没有「回合结束收掉旧的」：用户还没处理的那几件只有他自己（派、叉）和挂它的智能体（收回并说明）能拿掉。
// 路由在 dispatch-suggestion-routes.ts，派出去那一下在 dispatch-suggestion-launch.ts。
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
  MAX_SUGGESTIONS_PER_CALL, MAX_SUGGESTIONS_PER_TASK, MAX_SUGGESTION_NOTE_LEN, MAX_WITHDRAW_REASON_LEN, parseDispatchSuggestions,
  type DispatchSuggestion, type DispatchSuggestionWithdrawal, type WithdrawnSuggestion,
} from "@ash/shared/dispatch-suggestion";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { ExecutorScope } from "./auth/owned-executors.js";
import { normalizeTarget } from "./dispatch-plan.js";
import { id, now } from "./util.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Store = typeof db | Transaction;

type RawSuggestion = {
  title?: unknown; body?: unknown; note?: unknown; base?: unknown;
  agentType?: unknown; executorId?: unknown; model?: unknown; reasoningEffort?: unknown;
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** 智能体交来要挂的一批：逐件核，有一件不对整批退回，不半收。没给 = 这一次只收回，交回空的。 */
export function normalizeSuggestions(
  body: { tasks?: unknown },
  scope: ExecutorScope,
): DispatchSuggestion[] | { error: string } {
  if (body.tasks === undefined || body.tasks === null) return [];
  if (!Array.isArray(body.tasks)) return { error: "tasks 必须是数组" };
  if (body.tasks.length > MAX_SUGGESTIONS_PER_CALL) {
    return { error: `一次最多挂 ${MAX_SUGGESTIONS_PER_CALL} 件，收到 ${body.tasks.length} 件；只挂真该另开任务的那几件` };
  }
  const at = now();
  const items: DispatchSuggestion[] = [];
  for (const [index, raw] of (body.tasks as RawSuggestion[]).entries()) {
    const where = `tasks[${index}]`;
    if (!raw || typeof raw !== "object") return { error: `${where} 必须是对象` };
    const title = text(raw.title);
    const taskBody = text(raw.body);
    const note = text(raw.note);
    if (!title) return { error: `${where}.title 不能为空` };
    if (!taskBody) return { error: `${where}.body 不能为空：建出来的任务正文就是它，要自带完整上下文` };
    if (note.length > MAX_SUGGESTION_NOTE_LEN) return { error: `${where}.note 不超过 ${MAX_SUGGESTION_NOTE_LEN} 字；展开的话写进 body` };
    if (raw.base !== undefined && raw.base !== "trunk" && raw.base !== "here") {
      return { error: `${where}.base 只能是 trunk（从主分支开工）或 here（接着这条任务的代码）` };
    }
    const target = normalizeTarget(raw, scope, where);
    if (target && "error" in target) return target;
    items.push({ id: id(), title, body: taskBody, note, target, base: raw.base === "here" ? "here" : "trunk", proposedAt: at });
  }
  return items;
}

/** 智能体交来要收回的那几件：每件写明是哪一件、为什么（原因原样给用户看，不能空）。 */
export function normalizeWithdrawals(body: { withdraw?: unknown }): DispatchSuggestionWithdrawal[] | { error: string } {
  if (body.withdraw === undefined || body.withdraw === null) return [];
  if (!Array.isArray(body.withdraw)) return { error: "withdraw 必须是数组" };
  const picked = new Map<string, DispatchSuggestionWithdrawal>();
  for (const [index, raw] of (body.withdraw as { id?: unknown; reason?: unknown }[]).entries()) {
    const where = `withdraw[${index}]`;
    if (!raw || typeof raw !== "object") return { error: `${where} 必须是对象` };
    const suggestion = text(raw.id);
    const reason = text(raw.reason);
    if (!suggestion) return { error: `${where}.id 不能为空：挂的时候返回的那个 id（每次返回的 hanging 里也有）` };
    if (!reason) return { error: `${where}.reason 不能为空：用户靠这一句知道它为什么不在了` };
    if (reason.length > MAX_WITHDRAW_REASON_LEN) return { error: `${where}.reason 不超过 ${MAX_WITHDRAW_REASON_LEN} 字` };
    picked.set(suggestion, { id: suggestion, reason });
  }
  return [...picked.values()];
}

/** 挂上去之后一条任务上不能超过上限：超了就整批退回（旧的还没处理，先别再挂）。 */
export function suggestionRoomError(existing: number, adding: number): string | null {
  return existing + adding > MAX_SUGGESTIONS_PER_TASK
    ? `这条任务上已经挂着 ${existing} 件用户还没处理，再挂 ${adding} 件就超过 ${MAX_SUGGESTIONS_PER_TASK} 件了；只挂最该做的，已经不成立的先用 withdraw 收回`
    : null;
}

export type AgentSuggestionChange = {
  /** 改完以后挂着的那一列；room 非空时这一笔不落，它就是原来那一列。 */
  after: DispatchSuggestion[];
  added: DispatchSuggestion[];
  /** 真收回了的那几件留下的记录（标题、原因、时刻）：跟 after 同一笔写进库。 */
  withdrawn: WithdrawnSuggestion[];
  /** 要收回、却已经不在了的（用户派掉或叉掉了）。 */
  gone: string[];
  /** 要挂、却已经有同名的挂着的：指向挂着的那一件。 */
  already: { id: string; title: string }[];
  room: string | null;
};

/**
 * 智能体这一笔怎么落：先收回、再挂新的——所以「收回旧的、挂一件同名的新说明」一次就能换。
 *   · 要收回的那件已经不在了不算错：它要的结果本来就是不在；
 *   · 新挂的跟还挂着的（或同一批里前面的）同名：不挂第二件。回复框顶上同一件事只有一行，智能体记岔了
 *     重挂一遍时用户不必去认哪一行是新的；
 *   · 挂上去超过上限：整笔不落，连收回也不落（交回 room，智能体改了重来）。
 */
export function agentChange(
  current: DispatchSuggestion[],
  withdrawals: readonly DispatchSuggestionWithdrawal[],
  adding: readonly DispatchSuggestion[],
): AgentSuggestionChange {
  const reasons = new Map(withdrawals.map((item) => [item.id, item.reason]));
  const at = now();
  const withdrawn = current.filter((item) => reasons.has(item.id))
    .map((item) => ({ id: item.id, title: item.title, reason: reasons.get(item.id)!, at }));
  const gone = withdrawals.map((item) => item.id).filter((suggestion) => !current.some((item) => item.id === suggestion));
  const after = current.filter((item) => !reasons.has(item.id));
  const added: DispatchSuggestion[] = [];
  const already: { id: string; title: string }[] = [];
  for (const item of adding) {
    const same = [...after, ...added].find((hanging) => hanging.title === item.title);
    if (same) already.push({ id: same.id, title: same.title });
    else added.push(item);
  }
  const room = suggestionRoomError(after.length, added.length);
  if (room) return { after: current, added: [], withdrawn: [], gone, already, room };
  return { after: [...after, ...added], added, withdrawn, gone, already, room: null };
}

const serialized = (items: DispatchSuggestion[]) => (items.length ? JSON.stringify(items) : null);

/**
 * 按「读到的那一份还在」条件改这一列。`change` 返回 null = 不用改（返回 null）；改成了返回改前改后两份。
 * 事务里调（派出去那一下）时只试一次：同一笔事务里没有别人插得进来。
 *
 * `guard` 是写这一笔还要成立的别的条件，跟内容版本放进**同一条**更新的 where：内容没被别人改过不等于写的权利
 * 还在。智能体挂和收回的那一路靠它——入口核过的回合与方向身份，到真写进去那一刻已经换了（用户补了新要求、
 * 回合结束了），这一笔就不落（返回 null）。叉掉、派出去各有各的授权，不带它。
 *
 * `withdrawn` 交回这一笔里智能体收回的那几件的记录（在 `change` 之后问）：接在收回记录那一列后面，跟拿掉
 * 它们的是**同一条**更新——要么都落、要么都不落。
 */
export async function updateSuggestions(
  taskId: string,
  change: (items: DispatchSuggestion[]) => DispatchSuggestion[] | null,
  store: Store = db,
  guard?: SQL,
  withdrawn?: () => WithdrawnSuggestion[],
): Promise<{ before: DispatchSuggestion[]; after: DispatchSuggestion[] } | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = (await store.select({ raw: tasks.dispatchSuggestions }).from(tasks).where(and(eq(tasks.id, taskId), guard))).at(0);
    if (!row) return null;
    const before = parseDispatchSuggestions(row.raw);
    const after = change(before);
    if (!after) return null;
    const records = withdrawn?.() ?? [];
    const written = await store.update(tasks)
      .set({
        dispatchSuggestions: serialized(after), updatedAt: now(),
        ...(records.length ? { dispatchWithdrawals: appendWithdrawn(records) } : {}),
      })
      .where(and(eq(tasks.id, taskId), guard,
        row.raw === null ? isNull(tasks.dispatchSuggestions) : eq(tasks.dispatchSuggestions, row.raw)))
      .returning({ id: tasks.id });
    if (written.length) return { before, after };
  }
  throw new Error("可以派出去的活被同时改了太多次，没能写进去，请重试");
}

/**
 * 收回记录那一列的新值：在库里现有的那一份后面接上这几条。在 SQL 里接（json_insert 的 `$[#]` = 接在末尾，
 * 几对路径和值从左到右依次生效），不读出来改完再整份写回——已有的记录这一笔碰都不碰，所以不存在「读的时候
 * 认不出就丢了」「写回时被截短」这两种丢法；库里那一份坏了（不是 JSON）这条更新整个失败，建议也不会被拿掉。
 */
export function appendWithdrawn(records: readonly WithdrawnSuggestion[]): SQL {
  const pairs = records.map((record) => sql`'$[#]', json(${JSON.stringify(record)})`);
  return sql`json_insert(coalesce(${tasks.dispatchWithdrawals}, '[]'), ${sql.join(pairs, sql`, `)})`;
}

/** 智能体挂和收回的那一笔：任务还在跑，回合和方向还是入口核过的那一份（核的时候是空的，写的时候也得是空的）。 */
export function turnWriteGuard(seen: { activeTurnToken: string | null; activeDirectionToken: string | null }): SQL {
  return and(
    eq(tasks.status, "running"),
    seen.activeTurnToken === null ? isNull(tasks.activeTurnToken) : eq(tasks.activeTurnToken, seen.activeTurnToken),
    seen.activeDirectionToken === null ? isNull(tasks.activeDirectionToken) : eq(tasks.activeDirectionToken, seen.activeDirectionToken),
  )!;
}

/** 去掉这几件；有一件已经不在了就整笔不改，交回不在的那几件。 */
export function withoutSuggestions(ids: readonly string[]) {
  let missing: string[] = [];
  const change = (items: DispatchSuggestion[]) => {
    const present = new Set(items.map((item) => item.id));
    missing = ids.filter((suggestion) => !present.has(suggestion));
    if (missing.length) return null;
    return items.filter((item) => !ids.includes(item.id));
  };
  return { change, missing: () => missing };
}
