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
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { publishTaskUpdated } from "./task-store.js";

/**
 * 写入**按回合身份比对**(CAS):只有会话行此刻正跑着的就是这一轮,才动它。
 *
 * 不比对的那一版有个安静的错法(第 1 轮审查第 5 条):常驻台换台/摘牌之后,旧台手里那个
 * 看门狗计时器还可能醒一次 —— 它拿 sessionId 直接 UPDATE,于是**旧台的结论落在新台正在
 * 答的那一轮上**(凭空亮起一个停滞环),或者反过来把新台刚置上的标记撤掉。`turn_started_at`
 * 是回合身份本身(`session-turns.ts` 的 `nextTurnStart` 保证逐轮唯一),拿它当版本号最省:
 * 不用再加一列,也不依赖调用方先去查一次。
 *
 * 内存那一侧的同一道闸是 `turn-stall.ts` 的「持有者 + 回合」双判,外加 `retireLead` 摘牌时
 * 当场作废旧台那一份。三道都要有:摘牌那一道是主动交牌(旧台从此连计时器条目都没有),这一道
 * 兜的是**异步窗口** —— 计时器已经决定要写、UPDATE 还在飞的那几毫秒里换了台,写落地时行已经
 * 归新台了。
 *
 * **一个看着像误伤、其实不是的情形**:常驻台用户插话时,`lead.turnStart` 是队首(执行器此刻
 * 真在跑的那一轮 T1),而会话行上的 `turn_started_at` 已经被插话那一轮(T2)的 beginTurn 覆盖
 * 成 T2 —— 这时 T1 的停滞写不进去。不补救是对的:插话本身就会 interrupt 掉 T1,它马上就要
 * 收尾了;而 T2 如果同样连不上上游,它会以自己的身份另开一份停滞,那时行上写的正是 T2。
 */
async function setStalled(sessionId: string, turnStartedAt: string, since: string | null): Promise<void> {
  await db
    .update(sessions)
    .set({ upstreamStalledSince: since })
    .where(and(eq(sessions.id, sessionId), eq(sessions.turnStartedAt, turnStartedAt)));
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
function flip(taskId: string, sessionId: string, turnStartedAt: string, since: string | null): void {
  void setStalled(sessionId, turnStartedAt, since)
    .then(() => publishTaskUpdated(taskId))
    .catch((error: unknown) => {
      const what = since ? "置" : "撤";
      console.warn(`[ash] ${what}会话 ${sessionId} 的上游停滞标记失败:`, error);
    });
}

export function markSessionStalled(taskId: string, sessionId: string, turnStartedAt: string, since: string): void {
  flip(taskId, sessionId, turnStartedAt, since);
}

/**
 * 回合收尾那一路也调它:`ended_at` 虽然已经让读侧的 EXISTS 失效,标记本身不该留着 ——
 * 下一轮复用同一行会把 `ended_at` 清成 null,留着的标记当场又亮起来(第 1 轮审查第 3 条)。
 *
 * 开始边界上还有一道:`session-turns.ts` 的 `resumedTurnFields` 顺手把这一列清零。两道都要
 * 有 —— 这一道是「终止边界」,那一道兜住的是进程都没了、根本没人来撤的那种。
 */
export function clearSessionStalled(taskId: string, sessionId: string, turnStartedAt: string): void {
  flip(taskId, sessionId, turnStartedAt, null);
}
