// 还没交给智能体的答复：等着的那一批派活说定「派完就算完成」（shared/dispatch-suggestion.ts `DispatchWait`），处理完那一下
// 不叫醒它，建好的清单记在问答记录上（`QuestionRecord.undelivered`），等这条任务下一回合开头一并交给它，
// 交过就摘掉。
//
// 为什么记在问答记录上、不排一条待发送消息：待发送消息一到空闲就送进会话、把智能体叫起来——不叫醒正是
// 这件事的目的；它还会在托盘里留一条「你排着的话」，可这句话不是用户说的。投递方式照接力前言
// （handoff-notice.ts）：拼进下一回合的 prompt，起跑成功后划掉。
import { and, eq } from "drizzle-orm";
import type { QuestionRecord } from "@navi/shared/questions";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { clearHandoffNotice, handoffNoticeFrom } from "./handoff-notice.js";

const historyOf = (raw: string | null | undefined): QuestionRecord[] => {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value as QuestionRecord[] : [];
  } catch {
    return [];
  }
};

/** 下一回合开头要补交的那几段（按答复先后），连同它们的记录 id（起跑成功后拿去划掉）。 */
export function undeliveredReplies(rawHistory: string | null | undefined): { text: string; ids: string[] } {
  const pending = historyOf(rawHistory).filter((record) => record.undelivered && !record.deleted && record.reply);
  return { text: pending.map((record) => record.reply).join("\n\n"), ids: pending.map((record) => record.id) };
}

/**
 * 交过了就划掉。整列条件写：问答记录这一列别处也在写（新的答复、删除消息），读到之后被改过就重读一遍；
 * 两次都没写中就放弃——最坏是下一回合再收到一遍同一段，远好过盖掉别人刚写下的记录。
 */
export async function markRepliesDelivered(taskId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = (await db.select({ history: tasks.questionHistory }).from(tasks).where(eq(tasks.id, taskId))).at(0);
      if (!row?.history) return;
      const history = historyOf(row.history);
      if (!history.some((record) => record.undelivered && ids.includes(record.id))) return;
      const next = history.map((record) => {
        if (!record.undelivered || !ids.includes(record.id)) return record;
        const { undelivered: _delivered, ...rest } = record;
        return rest;
      });
      const written = await db.update(tasks).set({ questionHistory: JSON.stringify(next) })
        .where(and(eq(tasks.id, taskId), eq(tasks.questionHistory, row.history))).returning({ id: tasks.id });
      if (written.length) return;
    }
  } catch (error) {
    console.warn(`[navi] 补交的答复划不掉 ${taskId}:`, error);
  }
}

/**
 * 回合开头一次性交出去的两段：接力前言（handoff-notice.ts）和补交的答复。两条起跑入口（orchestrator 续跑、
 * task-run 全新起跑）都按这一处取、在 spawn 之后 `clear()` 划掉——早了被冻住的那一轮会把它们白白吃掉。
 * 审查、验证、原生命令这类旁路回合不取（交给它们，任务本人就再也收不到了），用 `NO_ONE_SHOT_NOTICES`。
 */
export type OneShotNotices = { handoff: string; carried: string; clear: () => Promise<void> };

export const NO_ONE_SHOT_NOTICES: OneShotNotices = { handoff: "", carried: "", clear: async () => {} };

export function oneShotNotices(task: { id: string; handoff: string | null; questionHistory: string | null }): OneShotNotices {
  const handoff = handoffNoticeFrom(task.handoff);
  const carried = undeliveredReplies(task.questionHistory);
  return {
    handoff,
    carried: carried.text,
    clear: async () => {
      if (handoff) await clearHandoffNotice(task.id);
      await markRepliesDelivered(task.id, carried.ids);
    },
  };
}
