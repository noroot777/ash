// 完成确认（严格 done 协议）的那张**内存快路票**。
//
// 从 runs.ts 搬出来单独成文件：那边装的是「这一轮的运行时事实」（谁在跑、谁占着 turn、停没
// 停），而这一张票自己带着一套不变量 —— 它属于哪一代方向世代、谁能消费它、谁只能撤掉它。
// 两件事各自都在长，挤在一起已经到了行数上限。这几个函数只有这一个入口，runs.ts 不转发。
//
// exit 0 只说明 CLI 进程正常退出,不代表任务目标达成(agent 报错后正常退出照样
// exit 0)。done 必须由 agent 亲口确认:回合内调 complete_task(MCP → POST
// /tasks/:id/complete)置标记,settle 时 take 消费。
// 这里是**同进程的快路**;权威那份落在 tasks.complete_confirmed_at(DB),因为
// 确认走 HTTP 打到监听进程、而跑这个回合的未必是同一个进程 —— 只有内存标记时,
// 跨进程的确认会静默丢掉(见 schema.completeConfirmedAt 的注释)。settle 两边
// 任一命中即算确认。
//
// ## 这张票**跟着方向世代走**(`tasks.direction_epoch`,见 task-direction-epoch.ts)
//
// 同一张完成票有 DB 和内存两个有效来源,settle 是任一命中即算确认 —— 所以只给其中一个加
// 归属屏障等于没加。DB 那一列由每一次起跑清零、由 settle 消费;内存这条原来只按 taskId 存,
// 于是**没有任何东西把它绑在某一轮上**:改派失败后的回滚合法地把它还回来(那一刻没有新回合,
// 还得对),紧接着任务又跑了一轮新工作 —— 新回合起跑清掉的只有 DB 那一列,这张旧票留在内存
// 里被新一轮的结算吃掉,一轮从没交卷的工作就此显示「已完成」(第 1 轮审查 F1 实测
// `sequential-direction-restore-then-fresh-run`,无需任何并发)。
//
// 所以存的不是「有没有」,而是**「哪一代的」**:
//
//  · `confirmDone(taskId, epoch)` —— 这张票属于那一代(落库那一笔的 RETURNING 给的就是它);
//  · `takeConfirmed(taskId, epoch)` —— **只取属于这一代的那一张**,别人那一代的原样留着
//    (改派清场要收走的是旧方向那张,不能顺手把新方向刚拿到的也抹掉);
//  · `drainConfirmed(taskId, epoch)` —— 结算专用:这一格一律清空(别漏到下一回合),返回
//    「清掉的那张是不是这一代的」;
//  · 还票时**按它原来那一代还**(`confirmDone(taskId, 它来的那一代)`),于是「这张票还作不
//    作数」永远由消费者比对当下那一代来回答,不需要每个还票点各自再查一次库。
const confirmed = new Map<string, number>();

export function confirmDone(taskId: string, directionEpoch: number): void {
  confirmed.set(taskId, directionEpoch);
}

/**
 * Check-and-clear(对称 takeCanceled):**只消费属于 `directionEpoch` 那一代的那一张**。
 *
 * 另一代的留着不动 —— 这是给「收走旧方向那张票」的调用方用的(改派清场、丢弃迟到状态),
 * 它们不该碰新方向自己拿到的确认。结算要的是另一种语义,见 `drainConfirmed`。
 */
export function takeConfirmed(taskId: string, directionEpoch: number): boolean {
  if (confirmed.get(taskId) !== directionEpoch) return false;
  confirmed.delete(taskId);
  return true;
}

/**
 * **结算专用**:这一格一律清空(标记只在本回合内有效,别漏到下一回合),返回清掉的那张票
 * 是不是 `directionEpoch` 这一代的 —— 不是就当没有确认过,那正是 F1 要挡的跨代消费。
 */
export function drainConfirmed(taskId: string, directionEpoch: number): boolean {
  const held = confirmed.get(taskId);
  confirmed.delete(taskId);
  return held === directionEpoch;
}

/**
 * **撤掉一次还没结算的确认**。返回它本来在不在。
 *
 * 用在「确认之后又挂了哨兵」那一刻(task-complete.ts):那一次确认已经不成立了,而只清
 * `tasks.complete_confirmed_at` 不够 —— settle 是两条道任一命中即算确认,内存这条快路留着
 * 的话任务照旧落 done(第 1 轮审查 F1 的原话:不能只清 DB 而保留内存快路)。
 *
 * **不比代次**:撤销是「这份确认不成立了」,哪一代的都该走。
 */
export function revokeConfirmed(taskId: string): boolean {
  return confirmed.delete(taskId);
}

/**
 * 内存这条快路上现在有**属于这一代**的确认吗？**不消费它**（对称 `takeConfirmed` 的只读版）。
 *
 * 用在「刚挂上哨兵,要不要撤确认」那一步:没有确认可撤就该原样返回,而不是顺手写一段等待。
 * 借 `takeConfirmed` 一问一还的话,中间任何一个 await 都会让另一路读到一个假的「没确认」。
 */
export function hasConfirmed(taskId: string, directionEpoch: number): boolean {
  return confirmed.get(taskId) === directionEpoch;
}
