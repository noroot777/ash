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
