// 调度台名下那条**会话行的写入口**。从 session-consumer.ts 抽出来的,原因有两个:那个文件
// 已经顶到 700 行上限,而这两个函数一个闭包状态都不依赖(只认传进来的那台 `Lead`),属于
// 「谁都能调、调错了后果一致」的那一类 —— 正好是该独立成文件的形状。
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
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
 * 这台调度台名下那条会话行的**唯一写入口**。
 *
 * 摘牌之后一个字都不写:接管那条路会复用同一行(openLead 的 resuming 分支),新台刚把
 * endedAt/exitStatus 清成 null 表示「这一段正在跑」。旧台晚到的 turnEnd 一写,在线的
 * 会话就被标成已结束,activeMs 还把两段重叠的墙钟时间重复计一遍(2026-08-26 第 9 轮
 * 审查)。**收口成一个函数是刻意的**:上一轮只在 closeLead 补了闸,beginTurn/endTurn
 * 就漏了,而漏哪一个都是同一个坏结果。
 *
 * 「查完到写进去之间又换了台」这个窗口不存在:retireLead 是同步的,只能从别的同步代码
 * 里跑(attachLead / deliver / closeLead);而这里从判断到 drizzle 把语句递给 node:sqlite
 * 中间没有 await,谁也插不进来。
 */
export async function updateOwnSession(lead: Lead, what: string, patch: SessionPatch, at = now()): Promise<boolean> {
  if (lead.retired) return false;
  return persistOrReport(lead, what, () => sessionUpdate().set(patch).where(eq(sessions.id, lead.sessId)), at);
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
