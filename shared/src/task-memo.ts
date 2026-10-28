// 任务备忘：挂在**一个任务**上的手写条目。
//
// 跟旁边两样东西的分界（三者都是「写在任务上的字」，混起来会互相顶掉）：
//   · 原始需求 / 后续追问 —— 是**发给 agent 的话**，一说出去就进了它的上下文，不能改也不能删。
//   · 随手记（notes 表）—— 挂在**项目**上，是「还没想好要不要开任务」的入口。
//   · 备忘（这里）—— 挂在任务上、**不进任何 prompt**，纯给人看：这一轮为什么这么定、
//     哪段输出要留着回头看、验收时记得查什么。所以它能改能删，也不受回合/状态影响。
//
// 正文按「几百字一条」设计（用户 2026-10-28 给的量级），上限留足一个数量级的富余。

/** 一条备忘。时间戳是 ISO 字符串，跟 tasks 一致（前端的 compactAge / formatInstant 直接吃）。 */
export interface TaskMemo {
  id: string;
  taskId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** 单条正文上限。超了直接报错，不静默截断 —— 悄悄吞掉用户写的字是最坏的一种「成功」。 */
export const TASK_MEMO_MAX_LEN = 20000;

/** 一个任务最多存多少条。够用到离谱，只拦「脚本刷进来」这类失控写入。 */
export const TASK_MEMO_MAX_COUNT = 500;

/**
 * 侧边栏铺开那一列用的摘要：一个任务一条，只带**最近更新**的那一条正文。
 *
 * 为什么不直接复用 `TaskMemo`：那一列和悬浮卡只读得下一段话，而备忘可以很长；
 * 跟追问那一列同一条规矩（见 server/src/task-follow-up.ts 的 TEXT_CAP），
 * 列表接口不该为了一张悬浮卡把几十 KB 正文全运过去。
 */
export interface TaskMemoDigest {
  taskId: string;
  /** 这个任务一共几条备忘（悬浮卡里写「共 N 条」）。 */
  count: number;
  /** 最近更新那一条的正文，按 TASK_MEMO_DIGEST_CAP 截断。 */
  text: string;
  truncated: boolean;
  /** 最近更新那一条的 updatedAt。列表按它跟追问比新旧。 */
  at: string;
}

export const TASK_MEMO_DIGEST_CAP = 1200;

/** 摘要正文的截断：两处（批量摘要、将来别的概览）共用一份，省得各截各的。 */
export function taskMemoDigestText(body: string): { text: string; truncated: boolean } {
  const text = body.trim();
  return text.length > TASK_MEMO_DIGEST_CAP
    ? { text: `${text.slice(0, TASK_MEMO_DIGEST_CAP)}…`, truncated: true }
    : { text, truncated: false };
}

/**
 * 「追问和备忘哪个新就显示哪个」—— 列表那一格和悬浮卡读的是同一份判据（用户 2026-10-28）。
 *
 * 两边的时间都可能缺：老会话的追问没有围栏时间（`at` 为 null），调用方拿任务的
 * updatedAt 兜底后传进来。两边都没有就按「追问优先」—— 那一列原本就是追问那一列。
 */
export function memoIsNewer(memoAt: string | null | undefined, followUpAt: string | null | undefined): boolean {
  if (!memoAt) return false;
  if (!followUpAt) return true;
  const memo = Date.parse(memoAt);
  const followUp = Date.parse(followUpAt);
  if (!Number.isFinite(memo)) return false;
  if (!Number.isFinite(followUp)) return true;
  return memo > followUp;
}
