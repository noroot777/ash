// 「这个任务正在切进 running」这道门。
//
// 起因：**收旧预览和把状态写成 running 是两步，中间隔着 await**。库里那一行在这段缝里还是
// `done`，任何按状态放行的自由工作流动作都会读到过期的事实：起预览会起在正被 agent 改的
// 工作区上，验收会把一个马上要开跑的任务点成 accepted（然后它就成了 accepted + running 这种
// 自相矛盾的任务——界面按已验收锁死操作，执行器却还在改它）。
//
// 所以这道门是**所有自由工作流写动作共用的**，不是预览路由的私有判断：`setTaskStatus` 在收
// 预览之前同步竖起来、状态真的落库之后才放下，期间 `tryAcquireFreeWorkflowAction` 一律拿不到
// 锁（free-workflow-lock.ts）。起预览那一路另外自己问一次，只为把话说准：「任务正在修改
// 代码」比「已有操作正在进行」更接近用户此刻遇到的事。
//
// 单独一个模块是为了方向干净：锁、状态、预览三边都要用它，谁也不该为它去 import 另外两个。
//
// 计数而不是布尔：同一个任务并发走两次开跑路径时，先结束的那次不能把后一次的门放下。
const rerunning = new Map<string, number>();

/** 开始切进 running：从这一刻起不许有新的自由工作流动作。**必须在任何 await 之前调**。 */
export function beginRerunGate(taskId: string): void {
  rerunning.set(taskId, (rerunning.get(taskId) ?? 0) + 1);
}

/** 状态已经落库了，门可以放下 —— 之后靠库里那一行 `running` 自己挡。 */
export function endRerunGate(taskId: string): void {
  const left = (rerunning.get(taskId) ?? 0) - 1;
  if (left > 0) rerunning.set(taskId, left);
  else rerunning.delete(taskId);
}

/** 此刻是不是正卡在「已经开始开跑、状态还没落库」那一段。 */
export function rerunGateClosed(taskId: string): boolean {
  return rerunning.has(taskId);
}
