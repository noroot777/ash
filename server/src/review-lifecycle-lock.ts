// 同一条审查链上,**「上一次的收尾」与「下一次重跑换代次」互斥**。
//
// 为什么光有代次闸不够(第 4 轮审查 F2):`failReviewStart` 事务里的那道代次闸只约束**落账
// 那一笔**。它提交之后,这一轮在重试闸眼里已经是合法的 failed/error,用户随时可以点「继续本
// 轮审查」—— 而那一次会 `restartRegressionEvidence` 换一个新代次、把新一代的审查者拉起来,
// 新一代的哨兵、待发结果、合并结果审查工作区也随之产生。可上一次的收尾还没做完:它接着做的
// `stopReviewRunMonitors(run.id)` / `cancelPendingMonitorEvents` / `cleanupPostMergeReviewWorktree`
// 全是**run 级**的,一个代次都不认 —— 于是旧收尾把新一代刚挂上的哨兵停掉、把它等的结果作废
// (实测:新哨兵 running → stopped,而新一代审查者还在跑,它要等的结果再也不会来)。
//
// 为什么不是「清理前再读一次代次」:那仍然是「检查完再动手」—— 读完到真正下刀之间隔着
// `serialize`、仓库锁、`git worktree remove` 几次 await,重跑完全可以插在中间。这个文件给的是
// 硬保证:**换代次与收尾不可能交错**。两种时序各自都收口:
//
//  · 收尾先排上 → 重跑等它做完,此后新一代的资源都诞生在旧收尾之后,旧收尾碰不到;
//  · 重跑先排上 → 收尾排在它后面,进去时代次已经变了,它那道代次闸当场把整段挡住(一个字
//    都不写、一件资源都不碰)。于是那道闸的结论**到动手那一刻仍然成立**。
//
// ## 用它的规矩
//
//  · **锁住的是「代次闸 + 资源处置」整段**,不是其中一半 —— 判据在调用方的事务/读取里,下刀
//    在之后,拆开就回到检查与动作分离;
//  · **这把锁必须是最外层**:段里会取数据库事务、仓库锁(`withRepoLock`)、哨兵的 `task:<id>`
//    队列。谁要是反过来在持有那几把的时候来取这一把,就有了环;
//  · **不许重入**:同一条 run 的 job 在另一个 job 里 await 自己 = 自锁(链是先排后跑)。
//    `reopenFailedFreeReview` 因此只把**换代次那一笔**放进来,`launchReviewRound` 和它
//    catch 里的 `failReviewStart` 都留在外面。
//
// 只保证**本进程内**的顺序,跟 `serialize`、仓库锁同一档:跨进程的交错(两个服务共用一个库)
// 本来就不在这套机制的射程内。重启之后旧收尾的闭包随进程一起没了,也就不存在交错。
const chains = new Map<string, Promise<unknown>>();

/**
 * 把 `job` 排进这条 run 的生命周期链:前一个做完才轮到它(成败都算做完)。
 *
 * key 用 **runId** 而不是 taskId:互斥的是同一条审查链上的收尾与重跑,别把同一个任务上另一条
 * 审查链(合并结果审查与工作区审查可以并存)一起串死。
 */
export function reviewLifecycle<T>(runId: string, job: () => Promise<T>): Promise<T> {
  const key = `review-life:${runId}`;
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  // 链上只留「做完了」这个事实:失败不该把后面的人一起拽进 unhandled rejection。
  const tail = next.then(() => {}, () => {});
  chains.set(key, tail);
  // 队尾空了就把 key 删掉:一条 run 的生命周期事件个位数,留着只是让这张表随进程寿命单增。
  // 判据是「此刻的队尾还是我」—— 后面有人排上来过就不能删,那会把它前面的等待一起丢掉。
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}
