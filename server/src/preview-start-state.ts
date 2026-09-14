import { randomUUID } from "node:crypto";

export const starting = new Map<string, Set<string>>();
const unfinished = new Map<string, Set<string>>();

export const hasUnfinishedPreviewStart = (taskId: string): boolean => !!unfinished.get(taskId)?.size;

/** 这一趟（taskId + 代号）开始由本进程驱动。 */
export function beginDriving(taskId: string, gen: string): void {
  const gens = starting.get(taskId) ?? new Set<string>();
  gens.add(gen);
  starting.set(taskId, gens);
  const pending = unfinished.get(taskId) ?? new Set<string>();
  pending.add(gen);
  unfinished.set(taskId, pending);
}

/** 这一趟结束了。**只撤自己那一代** —— 见 starting 上面的说明。 */
export function endDriving(taskId: string, gen: string): void {
  unfinished.get(taskId)?.delete(gen);
  if (!unfinished.get(taskId)?.size) unfinished.delete(taskId);
  canceledGens.delete(gen);
  onCancel.delete(gen);
  const gens = starting.get(taskId);
  if (!gens) return;
  gens.delete(gen);
  if (!gens.size) starting.delete(taskId);
}

/** 这一代此刻还有人驱动吗。清扫靠它区分「正在启动」和「上一条命留下的孤儿」。 */
export function driving(taskId: string, gen: string | undefined): boolean {
  return gen !== undefined && (starting.get(taskId)?.has(gen) ?? false);
}

/**
 * 「这一代已经被取消了」的记号 —— 专门盖**记录还没落盘**的那一段。
 *
 * 界面上那颗取消是 POST 一发出就能点的，而服务端可杀的记录要更晚才写：起预览得先查
 * 任务和项目、解析工作区、探测预览命令，进了 runPreview 还要先收掉旧的、再异步借五个
 * 端口，然后才 writeRecord。这中间用户点下取消，stopPreview 从盘上什么也读不到，只能
 * 回一句「预览已经不在跑了」——然后原来那趟照常写记录、照常起服务、照常上线。用户明明
 * 按过取消，最后还是等来了一个他不要的预览（而且这次没人再去关它）。
 *
 * 内存里记就够：这一段完全活在 startPreview 这一次调用里，进程一没它也一起没了。
 */
export const canceledGens = new Set<string>();

/**
 * 取消这一代时**立刻**要做的收口（由登记方给）。
 *
 * 取消打不断正卡在 await 里的那一趟（`taskWorkspace` 建 worktree 时还可能在等同仓库的
 * 写锁），它要等那一步自己回来才收场。可对外的那些语义不能跟着一起拖：那把自由工作流
 * 动作锁再攥着，验收和派审就被一个已经作废的启动挡满八分钟。所以登记方把「取消时先放
 * 掉什么」交给这里，`cancelDriving` 当场执行。
 */
const onCancel = new Map<string, () => void>();

/**
 * 把这个任务此刻正在驱动的那几代标成「取消」（`exceptGen` 是自己，不能把自己标掉）。
 * 返回标了几代 —— 调用方拿它回答「到底停到东西没有」。
 *
 * 标记的同时**把它从 starting 里摘掉**，两件事得分开表达：`canceledGens` 是给在跑的那趟
 * 自己看的墓碑（它下一个检查点凭这个退出，所以要一直留到它真的结束），`starting` 是对外
 * 说「这个任务正在起预览」的那句话 —— 已经取消掉的一代继续算在里面，用户就会在收到
 * 「已取消」之后刷新出一颗「关闭预览」，再点一次还照样回一句「停到了」，时间线上多出
 * 第二条「预览启动已取消」。
 */
export function cancelDriving(taskId: string, exceptGen: string | null): number {
  const gens = starting.get(taskId);
  let marked = 0;
  for (const gen of [...(gens ?? [])]) {
    if (gen === exceptGen) continue;
    canceledGens.add(gen);
    gens?.delete(gen);
    // 登记方的收口（放掉动作锁之类）在这儿当场做掉，不等那一趟自己回来。
    const close = onCancel.get(gen);
    onCancel.delete(gen);
    close?.();
    marked += 1;
  }
  if (gens && !gens.size) starting.delete(taskId);
  return marked;
}

/**
 * 「这一代正在被**我们**收掉」的记号 —— 盖的是「杀进程」到「归档记录」之间那一段。
 *
 * 预览的子进程是 ash 自己 spawn 的，`child.on("exit")` 那条看门狗因此两种情况都会响：服务
 * 自己崩了，和用户点「关闭预览」/ 任务重新开跑 / 验收回收把它杀了。两者在事件里长得一模
 * 一样，而记录要等进程确认退出之后才归档 —— 于是「我们杀它」的那一下正落在「记录还挂着
 * ready」的窗口里，被看门狗读成「预览进程已自行退出」：用户主动关掉的预览，回头在会话里
 * 多出一条红色的「预览异常」，归档记录也被写成 failed（日志弹窗上那个服务显示「失败」）。
 *
 * 所以凡是主动收的路径，都在杀之前把这一代标上、收完再撤。**撤必须排在归档之后**：那时
 * 记录已经不是 ready 了，晚到的 exit 事件本来就判不成「自行退出」，标记撤早了等于没标。
 */
const retiringGens = new Set<string>();

/** 这一代此刻正在被人为收掉吗 —— 看门狗凭它区分「我杀的」和「它自己死的」。 */
export function previewRetiring(gen: string | undefined): boolean {
  return gen !== undefined && retiringGens.has(gen);
}

/** 收掉这一代的整个过程（杀进程 + 归档）都算「人为收的」。 */
export async function whileRetiringPreview<T>(gen: string | undefined, run: () => Promise<T>): Promise<T> {
  if (gen === undefined) return run();
  retiringGens.add(gen);
  try { return await run(); } finally { retiringGens.delete(gen); }
}

export function beginPreviewStart(taskId: string, whenCanceled?: () => void): string {
  const gen = randomUUID();
  beginDriving(taskId, gen);
  // 取消时要当场做掉的收口（放掉动作锁之类）：见 onCancel。
  if (whenCanceled) onCancel.set(gen, whenCanceled);
  return gen;
}

/** 这一趟到此为止（不管是取消、失败还是正常收尾）：撤掉登记。幂等，可以重复调。 */
export function endPreviewStart(taskId: string, gen: string): void {
  endDriving(taskId, gen);
}

/** 这一趟被人取消了吗 —— 路由每过一段 await 就问一次。 */
export function previewStartCanceled(gen: string): boolean {
  return canceledGens.has(gen);
}
