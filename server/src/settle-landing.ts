// 一次**失败回合**在任务上的落位优先级 —— 正常结算与启动对账共用的那一份。
//
// 为什么单独一个文件:这条优先级原先在两处各写了一份,而且**写法不同** —— 正常结算
// (`settle-status.ts`)用分支顺序表达,启动对账(`task-reconcile.ts`)用一行三元表达式。
// 两份一漂,同一个事实就按进了哪个入口给出两种结论:一个已完成的任务被一次失败续聊打断,
// 不重启收尾保住 `done`,重启收尾却整个降成 `failed`(第 1 轮审查 F2,已实测)。用户那边唯一的
// 区别只是「ash 有没有重启」,而那不该是任务结论的输入。
//
// 所以这里只放**纯函数**:它不碰库、不写状态、没有副作用,两个入口把各自手里的事实交进来,
// 拿回同一个答案。恢复层只提供事实,不自己定优先级。
//
// 字段**一个都不给默认值**,这是刻意的:将来多一个轴(比如「审查旁路回合」),加进这个类型
// 就会让两个调用点同时编译不过 —— 比在某一侧补一个分支、另一侧忘掉要安全。
import type { TaskStatus } from "@ash/shared";

export interface FailedTurnFacts {
  /** 这一轮被 **ash 自己**判了失败(看门狗熔断,或者上次中断留下的回合结局核实不了)。 */
  ashFailed: boolean;
  /**
   * 续聊前那个状态 —— 非空 = 这一轮是**终态之后的一次对话**,不是任务的执行。
   * 旁路回合(就地验证)恢复的可能是 `paused`/`backlog` 一类,不止三个终态。
   */
  followUpFrom: TaskStatus | null;
  /** 残留的队列起跑请求里记着的**起跑前状态** —— 非空 = 这一轮其实从没真正开始。 */
  queueAdvancePrev: TaskStatus | null;
  /** 持续目标被打断、而且**留住了**(`interruptCliGoal` 说它还在):可以 `/goal resume` 续跑。 */
  goalHeld: boolean;
}

/**
 * 这一轮失败了,任务该落在哪。
 *
 * 优先级从高到低,每一条都是审查换来的:
 *
 * ① **终态续聊回到原终态。** 续聊的既定契约是「只能变好,不会变差」:用户给一个已完成的任务
 *    发条消息(「再发布一下」),不该因为这一轮没交卷、或者上游断了被我们熔断,就把 `done` 打成
 *    `failed`。**回合失败和任务此前的成果是两个轴** —— 这一轮的失败记在回合区间上
 *    (`session_turns.outcome`)和时间线里,任务那一行不动。
 *
 * ② **ash 判的失败压过下面两条。** 它压过残留的队列占位(第 1 轮审查 F2 的同类实例:起跑回执
 *    之后 `clearQueueAdvance` 没写成,旧请求还在,于是「还有请求」被当成「尚未起跑」,把一轮确凿
 *    的失败落回 `paused`/`backlog`),也压过持续目标的「暂停」—— 那句话替用户表达了「它在等你」,
 *    而这一轮是我们自己判失败的(第 5 轮审查 F3)。
 *
 * ③ **残留的队列占位回起跑前状态。** 这一轮压根没开始,不该留下一条失败记录。
 *
 * ④ **持续目标留住了就 `paused`。** 任务和历史都在,`/goal resume` 续跑。
 *
 * ⑤ 其余:`failed`。
 */
export function failedTurnLanding(facts: FailedTurnFacts): TaskStatus {
  if (facts.followUpFrom) return facts.followUpFrom;
  if (facts.ashFailed) return "failed";
  if (facts.queueAdvancePrev) return facts.queueAdvancePrev;
  if (facts.goalHeld) return "paused";
  return "failed";
}
