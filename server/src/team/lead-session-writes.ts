// 调度台名下那条**会话行的写入口**。从 session-consumer.ts 抽出来的,原因有两个:那个文件
// 已经顶到 700 行上限,而这两个函数一个闭包状态都不依赖(只认传进来的那台 `Lead`),属于
// 「谁都能调、调错了后果一致」的那一类 —— 正好是该独立成文件的形状。
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { recordTurnSpan } from "../session-turns.js";
import { now } from "../util.js";
import { reportLeadFailure } from "./lead-voice.js";
import type { Lead } from "./session-types.js";

/** 跑一次写库;失败只上报不外抛,返回它成没成。**只能在 lead.out.end() 之前调**。 */
export async function persistOrReport(
  lead: Lead,
  what: string,
  run: () => PromiseLike<unknown>,
  at = now(),
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    console.error(`[ash] team ${what}(${lead.taskId}) persistence failed:`, error);
    reportLeadFailure(lead, `${what}写入数据库失败：${error instanceof Error ? error.message : String(error)}`, at);
    return false;
  }
}

const sessionUpdate = () => db.update(sessions);
export type SessionPatch = Parameters<ReturnType<typeof sessionUpdate>["set"]>[0];

/**
 * 「这台调度台持有的那一行」:会话 id **加上持有者代次**(`sessions.lead_holder`,开台/接管时写下)。
 * 这台对会话行的每一笔写都拿它当条件。
 *
 * 只在调用入口看一眼内存里的 `retired` 不够:写库要等数据库空闲(node-sqlite-client 的 `whenIdle`)、
 * 回合收尾那一批没写成还要单独补写一次 —— 判过「我还在台上」之后到语句真正执行之间隔着 await,
 * 那段里新台完全可能已经接管同一行、把它清成「正在跑」。条件落在语句里,什么时候执行都按那一刻
 * 的库判,原批和补写都挡得住(第 3 轮审查第 2 条)。被接管了就是影响 0 行,不报错。
 */
// `IS` 而不是 `=`:两边都没有代次(手工拼出来的 Lead、本列出现之前的老行)算同一台,照旧写得进去。
// 真实开出来的台在建 Lead 之前就把代次写进了这一行(openLead),两边都有。
export const ownRow = (lead: Lead) => and(eq(sessions.id, lead.sessId), sql`${sessions.leadHolder} IS ${lead.holder ?? null}`);

/**
 * 这台调度台名下那条会话行的**唯一写入口**。
 *
 * 摘牌之后一个字都不写:接管那条路会复用同一行(openLead 的 resuming 分支),新台刚把
 * endedAt/exitStatus 清成 null 表示「这一段正在跑」。旧台晚到的 turnEnd 一写,在线的
 * 会话就被标成已结束,activeMs 还把两段重叠的墙钟时间重复计一遍(2026-08-26 第 9 轮
 * 审查)。**收口成一个函数是刻意的**:上一轮只在 closeLead 补了闸,beginTurn/endTurn
 * 就漏了,而漏哪一个都是同一个坏结果。闸本身落在语句里(`ownRow`),入口那一眼 `retired`
 * 只是省一次写库。
 */
export async function updateOwnSession(lead: Lead, what: string, patch: SessionPatch, at = now()): Promise<boolean> {
  if (lead.retired) return false;
  return persistOrReport(lead, what, () => sessionUpdate().set(patch).where(ownRow(lead)), at);
}

/**
 * 会话行这一笔**跟一次回合收口同一个原子批**落(`recordTurnSpan` 的 `alongside`):页面一次读出来的
 * 会话行和回合行得是同一刻的,分两笔写,中间那一刻怎么读都能读出半截(理由见 session-turns.ts 的
 * `TurnSideWrite`)。闸和失败口径都跟 `updateOwnSession` 一样:会话行那一笔按 `ownRow` 写,原批和
 * 失败后的补写都挡得住被接管的那一行(回合照落,那是这台自己跑过的回合);写不成只上报不外抛,返回
 * 会话行那一笔成没成。
 */
export async function closeOwnSessionWithTurn(
  lead: Lead,
  what: string,
  patch: SessionPatch,
  span: Omit<Parameters<typeof recordTurnSpan>[0], "alongside">,
  at = now(),
): Promise<boolean> {
  if (lead.retired) {
    await recordTurnSpan(span);
    return false;
  }
  return persistOrReport(lead, what, () => recordTurnSpan({ ...span, alongside: sessionUpdate().set(patch).where(ownRow(lead)) }), at);
}

/**
 * 把 CLI 报上来的新会话凭据补进库,**返回「这一次真的补上了」**。
 *
 * 为什么不是写一次就算完:`lead.cliSessionId` 是内存里当场换掉的,库里那笔靠这次写入。
 * 写失败还当它成了的话,后面三层会一起替它兜底失效 —— 内存 id 已是新值,同一个 id 再报
 * 一次会被「变了才写」挡掉;轮换状态机已经翻篇,不再记得欠着账;closeLead 的正常收尾只
 * 写退出码/用时,不补凭据。于是一次瞬时故障就永久留下「进程还能跑、数据库不知道这条
 * 会话」的分叉:一旦空闲回收或重启,下一次只能 fresh,刚建立的上下文无提示丢失,库里要是
 * 还留着更老的 id 甚至会去续跑旧会话(2026-08-25 第 3 轮审查)。
 *
 * 所以欠账留在 lead 上,由 consume(session-consumer.ts)在**每个回合收尾和关台前**再试;调用点都在 consume
 * 里,是因为补上之后必须连带把 rotation 翻篇 —— 那个状态是 consume 的局部变量,而且
 * 「凭据立住了」和「不必再按作废收尾」本来就是同一件事。
 */
export async function flushPendingCredential(lead: Lead, leads: ReadonlyMap<string, Lead>): Promise<boolean> {
  const patch = lead.pendingCredential;
  if (!patch) return false;
  // 只补写**当前这一代**凭据。中途判过 poisoned 的话,内存 id 已经被清成空串、库里的恢复
  // 字段也刚清掉 —— 这时候把欠账补回去等于把刚判死的 thread 复活:用户看到的持久说明是
  // 「下次开全新会话」,库里却又指回同一条坏 thread,而且补写成功还会顺手把 rotation 翻篇,
  // 让 closeLead 也不再清它(2026-08-25 第 4 轮审查)。同代校验顺带挡住其它过代的路子。
  if (!lead.cliSessionId || patch.cliSessionId !== lead.cliSessionId) {
    lead.pendingCredential = null;
    return false;
  }
  // 这条会话行可能已经被新进程接管了(工作目录被抽走那条路会复用同一行)。晚到的旧消费者
  // 不能拿自己攒的这笔凭据盖掉新进程刚报上来的有效 id —— 跟 closeLead 里那道闸同一个理由。
  // 欠账就此作废:那条行现在归新进程管,补不补轮不到这个已经出局的 handle 决定。
  if (leads.get(lead.taskId) !== lead) {
    lead.pendingCredential = null;
    return false;
  }
  const ok = await updateOwnSession(lead, "新会话凭据", patch);
  if (ok) lead.pendingCredential = null;
  return ok;
}
