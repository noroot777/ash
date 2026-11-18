// 可以派出去的活在服务端的那一半（类型与「活多久」见 shared/src/dispatch-suggestion.ts）：
//   · 智能体交来的一批怎么收（`normalizeSuggestions`，形状照派活单的一条，多一样「从哪开工」）；
//   · 这一列怎么改（`updateSuggestions`）：挂、派、叉、回合结束收旧的，四处都改同一列，按「读到的那一份还在」
//     条件写回，被别处抢先改过就重读重算——智能体在回合里挂新的、用户同时派掉一件，谁都不吞掉谁；
//   · 回合结束收掉旧的（`turnSuggestionPrune`）：只认这条任务**自己的执行器**跑完的**执行回合**。
// 路由在 dispatch-suggestion-routes.ts，派出去那一下在 dispatch-suggestion-launch.ts。
import { and, eq, isNull } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import {
  MAX_SUGGESTIONS_PER_CALL, MAX_SUGGESTIONS_PER_TASK, MAX_SUGGESTION_NOTE_LEN, parseDispatchSuggestions,
  type StoredDispatchSuggestion,
} from "@ash/shared/dispatch-suggestion";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
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

/** 智能体交来的一批：逐件核，有一件不对整批退回，不半收。 */
export function normalizeSuggestions(
  body: { tasks?: unknown },
  scope: ExecutorScope,
  turnToken: string | null,
): StoredDispatchSuggestion[] | { error: string } {
  if (!Array.isArray(body.tasks) || !body.tasks.length) return { error: "tasks 不能为空" };
  if (body.tasks.length > MAX_SUGGESTIONS_PER_CALL) {
    return { error: `一次最多挂 ${MAX_SUGGESTIONS_PER_CALL} 件，收到 ${body.tasks.length} 件；只挂真该另开任务的那几件` };
  }
  const at = now();
  const items: StoredDispatchSuggestion[] = [];
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
    items.push({ id: id(), title, body: taskBody, note, target, base: raw.base === "here" ? "here" : "trunk", proposedAt: at, turnToken });
  }
  return items;
}

/** 挂上去之后一条任务上不能超过上限：超了就整批退回（旧的还没处理，先别再挂）。 */
export function suggestionRoomError(existing: number, adding: number): string | null {
  return existing + adding > MAX_SUGGESTIONS_PER_TASK
    ? `这条任务上已经挂着 ${existing} 件还没处理，再挂 ${adding} 件就超过 ${MAX_SUGGESTIONS_PER_TASK} 件了；只挂最该做的`
    : null;
}

const serialized = (items: StoredDispatchSuggestion[]) => (items.length ? JSON.stringify(items) : null);

/**
 * 按「读到的那一份还在」条件改这一列。`change` 返回 null = 不用改（返回 null）；改成了返回改前改后两份。
 * 事务里调（派出去那一下）时只试一次：同一笔事务里没有别人插得进来。
 */
export async function updateSuggestions(
  taskId: string,
  change: (items: StoredDispatchSuggestion[]) => StoredDispatchSuggestion[] | null,
  store: Store = db,
): Promise<{ before: StoredDispatchSuggestion[]; after: StoredDispatchSuggestion[] } | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = (await store.select({ raw: tasks.dispatchSuggestions }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!row) return null;
    const before = parseDispatchSuggestions(row.raw);
    const after = change(before);
    if (!after) return null;
    const written = await store.update(tasks)
      .set({ dispatchSuggestions: serialized(after), updatedAt: now() })
      .where(and(eq(tasks.id, taskId), row.raw === null ? isNull(tasks.dispatchSuggestions) : eq(tasks.dispatchSuggestions, row.raw)))
      .returning({ id: tasks.id });
    if (written.length) return { before, after };
  }
  throw new Error("可以派出去的活被同时改了太多次，没能写进去，请重试");
}

/** 去掉这几件；有一件已经不在了就整笔不改，交回不在的那几件。 */
export function withoutSuggestions(ids: readonly string[]) {
  let missing: string[] = [];
  const change = (items: StoredDispatchSuggestion[]) => {
    const present = new Set(items.map((item) => item.id));
    missing = ids.filter((suggestion) => !present.has(suggestion));
    if (missing.length) return null;
    return items.filter((item) => !ids.includes(item.id));
  };
  return { change, missing: () => missing };
}

/**
 * 回合结算之前问一句：这一轮算不算「这条任务自己的执行器跑完的执行回合」。算就交回这一轮的令牌（挂在这一轮
 * 的留下），不算交回 undefined。
 *
 * 不算的：审查者回合（会话 role）、旁路回合（就地验证、讨论的一段、计划模式、原生命令——会话行上的
 * side_turn，重启接回时也读得到）、`@` 别人来问一句（这一轮的执行器不是任务自己的）。
 * 必须在 settleTaskStatus **之前**读：结算落位那一笔会把回合令牌清掉。
 */
export async function turnSuggestionPrune(taskId: string, sessionId: string): Promise<string | null | undefined> {
  const task = (await db.select({
    raw: tasks.dispatchSuggestions, token: tasks.activeTurnToken, agentType: tasks.agentType,
    mode: tasks.mode, parentId: tasks.parentId, nativeTurn: tasks.nativeTurn, verifyRound: tasks.verifyRound,
  }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task?.raw || task.mode !== "single" || task.parentId || task.nativeTurn || task.verifyRound) return undefined;
  const session = (await db.select({ role: sessions.role, sideTurn: sessions.sideTurn, agentType: sessions.agentType })
    .from(sessions).where(eq(sessions.id, sessionId))).at(0);
  if (!session || session.role !== "single" || session.sideTurn) return undefined;
  if ((task.agentType as AgentType | null) && session.agentType !== task.agentType) return undefined;
  return task.token ?? null;
}

/** 收掉不是这一轮挂的那几件。改了交回 true（调用方据此广播）。 */
export async function pruneSuggestions(taskId: string, keepTurn: string | null): Promise<boolean> {
  const changed = await updateSuggestions(taskId, (items) => {
    const kept = items.filter((item) => keepTurn !== null && item.turnToken === keepTurn);
    return kept.length === items.length ? null : kept;
  });
  return !!changed;
}
