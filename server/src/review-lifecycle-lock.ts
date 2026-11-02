// 同一条审查链上,**「上一次的收尾」与「下一次重跑换代次」互斥**。
//
// ## 先说清这个文件**不**负责什么
//
// 「旧收尾碰到新一次的资源」的根因是**资源归属少了一位身份**:`monitors.source_review_run`
// 跨轮复用、同一轮又会被重跑,所以哨兵行上要记满三件套(run + 轮次 + 代次,见
// `schema-monitors.ts` 的 `source_review_generation`),每一处收尾只动身份对得上的那些行
// (`stopMonitorsForReviewRun` 的 `owner`)。哨兵与它排着的结果由那条路管,**不靠这把锁**。
//
// 剩下**带不了身份**的那一件才归这里:合并结果审查的临时 worktree 按 `task/run` 取路径
// (`post-merge-review-worktree.ts`)。给路径塞上代次做不到更好 —— 每次重跑换一个新目录,收尾
// 一旦丢掉(崩在中间)就留下一个谁都不会再碰的 git worktree 注册项,而现在那条路径是稳定的:
// 下一次 prepare 自己会把对不上的那个移走。所以它的归属只能靠**时序**:删它的那一段与「重跑
// 换代次」互斥。顺带也补上 `finalizationStep` 里那道「代次还是不是我」的读-做间隙。
//
// ## 为什么是硬互斥,不是「动手前再读一次代次」
//
// 读完到真正下刀之间隔着仓库锁和 `git worktree remove` 几次 await,重跑完全可以插在中间 ——
// 那还是「检查完再动手」。这个文件给的是:**换代次与收尾不可能交错**。两种时序各自都收口:
//
//  · 收尾先排上 → 重跑等它做完,此后新一代的资源都诞生在旧收尾之后,旧收尾碰不到;
//  · 重跑先排上 → 收尾排在它后面,进去时代次已经变了,它那道代次闸当场把整段挡住(一个字
//    都不写、一件资源都不碰)。于是那道闸的结论**到动手那一刻仍然成立**。
//
// ## 用它的规矩
//
//  · **锁住的是「代次闸 + 资源处置」整段**,不是其中一半 —— 判据在调用方的事务/读取里,下刀
//    在之后,拆开就回到检查与动作分离;
//  · **一代次退场时由送它退场的人收尾**:重跑换代次那一段(同在这把锁里)先记下上一代是谁,
//    换完立刻按那个身份收走它的哨兵与排着的结果 —— 它自己的收尾此刻要么已经做完、要么被
//    代次闸整段挡住,不收就会一直空烧到到期(见 `reopenFailedFreeReview`);
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
