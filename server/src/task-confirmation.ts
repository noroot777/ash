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
//  · `drainConfirmed(taskId, epoch)` —— 结算专用:把这一代连同更早的残留一并清掉(别漏到下
//    一回合),返回「清掉的那张是不是这一代的」;
//  · 还票时**按它原来那一代还**(`confirmDone(taskId, 它来的那一代)`),于是「这张票还作不
//    作数」永远由消费者比对当下那一代来回答,不需要每个还票点各自再查一次库。
//
// ## 比代次这件事,**写和删也得比**(第 2 轮审查 F1)
//
// 只在「读」的时候比代次是不够的:这一格每个任务只有一个槽,epoch 是槽里的**值**而不是槽的
// 归属。于是旧那一代的迟到操作虽然再也骗不到结算,却还能**把新那一代的有效票毁掉**:
//
//  · 旧回滚还票是一次无条件 `Map.set`,会把已经在槽里的新票直接顶成旧代 —— 随后结算按新那
//    一代去问,答案是「没有确认过」,一个**真的交了卷**的回合于是显示失败(改成 Map 之前这里
//    是 `Set.add`,重复添加没有破坏力,所以这是换存储引入的退化);
//  · 不带代次的删同理:带着旧身份的清理照样能删掉后来那一代的票。
//
// 所以写是**单调的**(更旧的不许盖更新的),删是**有上界的**(只删到调用方说得清的那一代为
// 止,更晚的留着)。真正的 task 级作废(`revokeConfirmed`)另开一个名字,语义是「这份确认本身
// 不成立了」,跟代次无关。
const confirmed = new Map<string, number>();

/**
 * 记一张属于 `directionEpoch` 那一代的票。**单调写**:槽里已经有更晚那一代的票时直接返回。
 *
 * 旧那一代的还票(改派回滚、清场失败还票)和新那一代的确认共用这一个槽,而还票那一笔晚到完全
 * 可能 —— 它排在一次 await 过的 UPDATE 之后,这中间新回合的 complete 完全来得及落库。无条件
 * 覆盖的话,那张本来有效的新票就此变成旧代,结算按新那一代一问「没确认过」,一个真交了卷的回
 * 合显示失败(第 2 轮审查 F1 实测 `cross-generation-overwrite`)。
 */
export function confirmDone(taskId: string, directionEpoch: number): void {
  const held = confirmed.get(taskId);
  if (held !== undefined && held > directionEpoch) return;
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
 * **结算专用**:把这一代连同更早的残留一并清掉(标记只在本回合内有效,别漏到下一回合),返回
 * 清掉的那张是不是 `directionEpoch` 这一代的 —— 不是就当没有确认过,那正是第 1 轮审查 F1 要
 * 挡的跨代消费。
 *
 * **更晚那一代的票不删**:结算手里这一代来自它自己读到的那一行,而那一行可能已经旧了(新回合
 * 就在这中间起跑并确认)。连那张一起清掉的话,下一次结算同样会判「没确认过」。
 */
export function drainConfirmed(taskId: string, directionEpoch: number): boolean {
  const held = confirmed.get(taskId);
  if (held === undefined || held > directionEpoch) return false;
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
 * **不比代次**,因为它说的是「这份确认本身不成立了」,而不是「旧身份来清场」—— 调用方此刻就
 * 站在这个任务当下那一轮里。带着旧身份来清的那种要用 `revokeConfirmedUpTo`。
 */
export function revokeConfirmed(taskId: string): boolean {
  return confirmed.delete(taskId);
}

/**
 * **清到 `throughEpoch` 那一代为止**:槽里是这一代或更早的就删掉,更晚的原样留着。返回删没删。
 *
 * 给「带着一个已经过去的身份来扫残留」的调用方用(原生 ACK 之后的二次清场)。它要扫的是「我
 * 这条改派自己 ACK 之前落下来的任何东西」—— 包括绕开身份 CAS、没带正确代次落进来的那种,所以
 * 不能按等号收;但它**证不了后来没有别的回合起跑并交卷**,所以也不能无条件删
 * (第 2 轮审查 F1 实测 `cross-generation-discard`)。上界正是它自己清场时推出的那一代。
 */
export function revokeConfirmedUpTo(taskId: string, throughEpoch: number): boolean {
  const held = confirmed.get(taskId);
  if (held === undefined || held > throughEpoch) return false;
  confirmed.delete(taskId);
  return true;
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
