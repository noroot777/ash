// 起这一轮之前的那串闸：接力存档、回合占位、验收互斥、唤醒资格。
//
// 为什么单独一份：这几道闸共享一个**同一个人都看不见的不变量** —— 从 `claimTurn` 占住位
// 到把活交给 `continueTask` 那个大 try 之间，每一条出路都得自己把占位还回去，大 try 的
// finally 管不到这一段。散在那个函数里的时候，新加一道闸就会漏掉这件事：第 4 轮加的
// `wakeGuard` 要读库，一次读失败把异常抛在这条缝里，占位就留在内存里没人放 —— 任务停在
// paused，点运行说「回合正在进行」、点停止说「没有在运行的进程」，连真人后续回复都起不来，
// 而库早就恢复正常了（第 5 轮审查单次读故障注入实测：run 与 stop 双 409）。
//
// 收成一个函数之后出口只有两个，不变量就由类型本身兜着：
//   `true`  = 占位在手，调用方负责在自己的 finally 里 `releaseTurn`
//   `false` = 这一轮不起，**占位已经还回去了**（或者压根没占）
import { claimTurn, reclaimTurn, releaseTurn } from "./runs.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { handoffBlockReason } from "./handoff-guard.js";

export type TurnEntryInput = {
  taskId: string;
  /** 这一回合的身份（"single" / "reviewer"…），占位转正时写进它。 */
  sessionRole: string;
  /** 任务行上的接力状态；接力出去的任务在本机只是历史存档。 */
  handoff?: string | null;
  /** 调用方已在入口原子占好位（continueWhenIdle / run 路由），这里只做身份接管。 */
  turnHeld?: boolean;
  /** 「这个任务此刻还能不能被这条消息叫醒」——占住位之后才问（见 orchestrator 的 opts）。 */
  wakeGuard?: () => Promise<string | null>;
};

export async function enterTurn(input: TurnEntryInput): Promise<boolean> {
  const { taskId } = input;
  // 接力出去的任务：路由层各有 409，但队列推进/排队消息投递等程序化续聊全汇到这里，
  // 必须在占位之前收口（消息按「未投递」留在托盘，事实不丢）。
  if (handoffBlockReason(input.handoff)) {
    if (input.turnHeld) releaseTurn(taskId);
    return false;
  }
  // 抢不到 = 这个任务此刻正跑着别的回合，这一句话没送出去。调用方必须知道。
  // turnHeld 那条路用真实身份接管——只读预检查代替不了原子所有权（审查实测：两个并发
  // 启动双双 202）。
  if (input.turnHeld) reclaimTurn(taskId, input.sessionRole);
  else if (!claimTurn(taskId, input.sessionRole)) return false;

  // 验收互斥：**先占己锁（turn），再查彼锁（acceptance），两步之间没有 await**——
  // acceptTask 那边是镜像（beginAccepting 先占，acceptanceGuard 再查 isTurnClaimed）。
  // 任意交错下至少一方看到对方已占而退避；只查不占是 TOCTOU（审查实测 40/40：检查刚
  // 通过验收就开始，回复照样启动并摘牌）。退避 = 消息按「未投递」排队，验收事实原封不动。
  if (isAcceptingTask(taskId)) {
    releaseTurn(taskId);
    return false;
  }

  // 同一个位置、同一个理由：占住回合之后才问「这一轮还该不该起」。排在这里而不是更后面，
  // 是因为从 continueTask 那句 `update(tasks)` 起这一轮就开始留痕了（followUpFrom、回合
  // token、基线），撤回要付的代价一路变贵；而这一刻除了锁本身什么都没动，`false` 对调用方
  // 就是干净的「一个字没送出去」。
  //
  // 这一问要读库，所以它**必须自带 try**（理由见文件头）。读失败按「这一轮先不起」处理，
  // 但不当成拒绝：调用方据此把消息放回托盘重投，而不是取消掉 —— 一次读故障不该让一条
  // 事件永久消失（宁可晚发，不能不发）。
  if (input.wakeGuard) {
    let blocked: string | null = null;
    try {
      blocked = await input.wakeGuard();
    } catch (error) {
      // 出声：咽下去的话，「读不到状态」和「状态说不该起」在日志里长得一模一样。
      console.error(`[ash] 起跑前的资格检查读失败 task=${taskId}:`, error);
      blocked = "读不到这个任务此刻的状态";
    }
    if (blocked) {
      releaseTurn(taskId);
      return false;
    }
  }
  return true;
}
