// 「这条会话此刻卡在上游连不上」的**持久**那一半。
//
// 判据与两档动手一律在 `turn-stall.ts`(纯状态机);这里只负责把结论落进库、再广播一次任务行,
// 让它活过刷新、也能当场出现在任务卡片上。
//
// 为什么非得落库:项目规矩是「停止/暂停必须留下持久可见的状态,判据是用户刷新页面后仍能看
// 出」(AGENTS.md)。停滞是同一类事 —— 内存里那份(`session-waiting.ts` 的 sessionWaiting)
// 是**转瞬状态**,ash 重启就没了,而且只在会话详情那一路取得到;而「这个任务其实在干等」要
// 在列表里一眼看出来,只能靠库。
//
// 写得很省:一次停滞最多两次 UPDATE(报警时置上、上游回话或回合收尾时撤掉),而停滞本身是
// 少见状态 —— 绝大多数回合一次都不写。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { publishTaskUpdated } from "./task-store.js";

async function setStalled(sessionId: string, since: string | null): Promise<void> {
  await db.update(sessions).set({ upstreamStalledSince: since }).where(eq(sessions.id, sessionId));
}

/**
 * 置上/撤掉,并补发一次 `task.updated`。
 *
 * 补发是必须的:这一列不在 `tasks` 上,改它不会动 `tasks.updated_at` —— 没有这一次广播,
 * 卡片要等到下一次整表拉取才变(库里的 trigger 只负责把 `backgroundRevision` 推上去,让
 * 前端那套快照合并知道哪一份的后台字段更新,它自己不负责投递)。
 *
 * 失败只记一句:这是一条提示,不该掀翻正在收尾的回合。
 */
function flip(taskId: string, sessionId: string, since: string | null): void {
  void setStalled(sessionId, since)
    .then(() => publishTaskUpdated(taskId))
    .catch((error: unknown) => {
      const what = since ? "置" : "撤";
      console.warn(`[ash] ${what}会话 ${sessionId} 的上游停滞标记失败:`, error);
    });
}

export function markSessionStalled(taskId: string, sessionId: string, since: string): void {
  flip(taskId, sessionId, since);
}

/** 回合收尾那一路也调它:`ended_at` 虽然已经让读侧的 EXISTS 失效,标记本身不该留着。 */
export function clearSessionStalled(taskId: string, sessionId: string): void {
  flip(taskId, sessionId, null);
}
