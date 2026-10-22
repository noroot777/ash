// `tasks.direction_epoch`：**这条任务到目前为止一共进过第几个方向** —— 一个永不归零的持久世代。
//
// 它存在的理由只有一句：**回滚要分得清「我离开时那一轮」和「后来又跑完的另一轮」**。
//
// 方向身份原来由三列表达（`active_turn_token` / `active_direction_token` /
// `active_direction_version`），而它们都是**回合内**的：`status.ts` 一离开运行态就把前两列置
// null、版本归零。于是「这几列现在空着」这个事实同时对应两种完全不同的世界：
//
//   · 我清掉的那一轮已经结束了（回滚该落地）；
//   · 我清掉的那一轮结束了，**后来又跑完了另一轮**（回滚是迟到者，一个字都不许写回去）。
//
// 两条备用回滚分支（`restorePreviousDirectionState` 的 fallback、`restorePreviousCompletionState`）
// 原来就只会看「非 running/queued + 活动回合为空 + 提问和完成确认为空」，于是把后一种当成了前
// 一种：一个已经跑完新回合的任务，被旧改派的迟到回滚重新写回旧提问和旧完成确认（第 4 轮审查
// F1-B 实测 `F1_B_LATE_ROLLBACK_AFTER_NEW_DIRECTION_DONE` / `F1_B_COMPLETION_FALLBACK_SAME_CLASS`）。
//
// 所以这一列的两条性质缺一不可：
//
//  · **回合起跑时前进**（`turnDirectionStart`）—— 报告给出的触发时序要求「新回合已经开跑并结
//    束」，只在方向轮换时前进的话，一轮完整跑完的回合在它眼里什么都没发生过；
//  · **任何状态落位都不许把它归零** —— 归零就等于把上面那个「空着」的歧义原样搬了过来。
//    `status.ts` 清三列身份时**有意不碰这一列**，那不是漏写。
//
// ## 为什么不拿 `tasks.resume_prompt_generation` 当这道屏障
//
// 那是**检查点那一格**的占用代次，判的是「这段文字还是不是我取走的那一次」。拿它当方向屏障，
// 等于让三张票（检查点 / 提问 / 完成确认）重新共用一套 CAS —— 第 3 轮审查 F1-C 实测过那个现场：
// 检查点一处不符就连提问和完成票一起放弃恢复，新工作一个字没送出去，用户的提问、agent 的完成
// 确认和那段待续工作三样同时消失。三张票必须各判资格，这一列只给后两张用。
//
// ## 唯一写入口：**方向身份这四列的每一种写法都在这个文件里**
//
// 代次只有在**所有** writer 都维护它时才是归属凭证（`task-resume-prompt.ts` 文件头记着这一课
// 的三次学费）。光禁止「直写 `directionEpoch`」挡不住真正会发生的那种退化 —— 某处把
// `turnDirectionStart(...)` 展开回「只写三列身份」的样子，世代就此不再前进，而直写检查一个字
// 都发现不了（第 1 轮审查 N2 实测：两处生产起跑各自展开，既有回归照样 exit 0）。所以收口的
// 是**整组身份**，一共只有三种写法：
//
//  · 装上一个新方向（回合开跑 / 改派轮换）：`turnDirectionStart` / `directionRotate`
//    —— 世代跟在同一笔里，展不开也绕不过；
//  · 回合结束清掉身份：`directionIdentityCleared()`（`status.ts`，有意不碰世代）；
//  · 改派失败把旧身份放回去：`directionIdentityRestored()`（不是新方向，所以不推世代）。
//
// 外加回滚的资格条件 `directionEpochUnchangedSince(epoch)`。
//
// 这条不靠自觉：`test-task-steer-rollback.ts` 的结构锁遍历 `server/src` 的每一条
// `update(tasks)`，谁在自己那边直写这四列中的任何一列就红。
import { eq, sql, type SQL } from "drizzle-orm";
import { tasks } from "./db/schema.js";

/**
 * **换了一个方向**要写的那四列：三列回合内身份 + 这一格永不归零的世代。
 *
 * `version` 是回合内的「第几个方向」（1 = 尚未引导），归零由 `status.ts` 负责；世代则一路只增。
 * 两者同一笔落库，是为了让「方向换了」这件事只有一种写法 —— 分开写就会出现只换 token 不推世代
 * 的入口，而那正好是这道屏障唯一能被绕开的方式。
 */
export const directionRotate = (
  turnToken: string | null,
  directionToken: string,
  version: number,
) => ({
  activeTurnToken: turnToken,
  activeDirectionToken: directionToken,
  activeDirectionVersion: version,
  directionEpoch: sql`${tasks.directionEpoch} + 1`,
});

/** 一个**新回合**开跑时的方向身份（回合内第 1 个方向）。两处起跑入口共用，世代因此漏不掉。 */
export const turnDirectionStart = (turnToken: string, directionToken: string) =>
  directionRotate(turnToken, directionToken, 1);

/**
 * **到落笔这一刻，这条任务还停在我离开时那个方向世代吗。**
 *
 * 用在两条备用回滚分支上：它们判不了回合身份（那几列已经被 `status.ts` 清空），只能靠这一列
 * 回答「这中间有没有又跑完一轮」。相等 ⇒ 我离开之后没有任何新方向开过工，回滚仍然有效；
 * 不等 ⇒ 我是迟到者，一个字都不许写回去。
 *
 * 存量行缺省 `0`（notNull，见 `db/index.ts` 的 ALTER）：它要参与 `=` 比较，NULL 比出来谁也不
 * 等于谁 —— 那样所有回滚都会被判成过期，连同一轮内的正常失败回滚一起挡死。
 */
export const directionEpochUnchangedSince = (epoch: number): SQL => eq(tasks.directionEpoch, epoch);

/**
 * **回合结束，身份作废**（`status.ts` 离开运行态时的那一笔）。
 *
 * 有意不碰世代：这一组归零留下的那条分不清的边，正是世代存在的理由（见文件头）。放在这里
 * 而不是让调用方自己拼，是为了让「写方向身份」只有三种写法、结构锁能一网打尽。
 */
export const directionIdentityCleared = () => ({
  activeTurnToken: null,
  activeDirectionToken: null,
  activeDirectionVersion: 0,
});

/**
 * **改派失败，把清掉的那组身份放回去**（`task-steer-direction-state.ts` 的精确回滚）。
 *
 * 这不是装上一个新方向，所以**不推世代** —— 世代只增不减，回滚本来就不该让它倒退。
 *
 * `preserveBarrier`：Claude 没确认原生引导、这一轮已被结束时，回合身份要放回去，但方向屏障
 * 得留着（旧方向迟到的完成/提问仍然不许写进来），所以方向那两格仍填清场时装上的那一组。
 */
export const directionIdentityRestored = (
  snapshot: {
    activeTurnToken: string | null;
    activeDirectionToken: string | null;
    activeDirectionVersion: number;
    clearedDirectionToken: string;
    clearedDirectionVersion: number;
  },
  preserveBarrier: boolean,
) => ({
  activeTurnToken: snapshot.activeTurnToken,
  activeDirectionToken: preserveBarrier ? snapshot.clearedDirectionToken : snapshot.activeDirectionToken,
  activeDirectionVersion: preserveBarrier ? snapshot.clearedDirectionVersion : snapshot.activeDirectionVersion,
});
