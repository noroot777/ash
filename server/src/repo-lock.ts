import { AsyncLocalStorage } from "node:async_hooks";
import { repoKey } from "./git.js";

// ── 同一仓库的写型 git 操作必须串行 ─────────────────────────────────────────
// 一个仓库的 `.git` 是所有 worktree 共用的单一状态机:ref、index.lock、
// `worktrees/` 注册表都只有一份。并行跑两个写操作不是"慢一点",是会互相拆台:
//   • 两个验收同时合并到同一个 target:A 读到 target=X 决定 FF,B 抢先把
//     target 推到 Y,A 的 `git fetch . src:target` 直接非 FF 失败 —— 用户看到
//     的是"点了验收却报 fast_forward_failed",重试一次又好了。
//   • target 恰好检出在项目目录时(最常见:main),FF 走不通会退到**在项目工作区
//     里 git merge**。两个验收同时进到这一步就是同一个工作区里两个 merge:
//     index.lock 撞车、B 的干净检查看见 A 合并到一半的文件、B 失败后的
//     `git merge --abort` 直接把 A 的合并回滚掉。
//   • `git worktree prune` / `add` / `remove` 改的是同一份注册表。
//
// 所以这里按仓库(repoKey 归一后的路径)排一条队:**排队等待,不是拒绝** ——
// 用户挨个点了 5 个任务的"验收通过",这 5 个都该成功,只是一个接一个地做。
//
// 可重入:锁的持有者集合放在 AsyncLocalStorage 里,所以"外层 acceptTask 持锁 →
// 内层 mergeTaskBranch 再要锁"直接放行,不会自己把自己锁死。这一点是刻意的,
// 它让锁可以同时放在**流程层**(整段验收原子化,守卫判断不会过期)和**操作层**
// (任何单独调用 prepareWorktree/mergeTaskBranch 的入口都自动受保护),不必靠
// "调用方记得先加锁"的约定。
const queues = new Map<string, Promise<void>>();
const heldKeys = new AsyncLocalStorage<Set<string>>();

/** 等待信息:交给调用方决定要不要写进时间线/日志。 */
export type RepoLockWait = {
  /** 本次是否真的排过队(前面有人在跑) */
  queued: boolean;
  /** 排队等待的毫秒数;未排队或可重入时为 0 */
  waitedMs: number;
};

const NO_WAIT: RepoLockWait = { queued: false, waitedMs: 0 };

/** 当前异步上下文是否已经持有该仓库的锁(供断言与测试使用)。 */
export function holdsRepoLock(repoPath: string | null | undefined): boolean {
  const key = repoKey(repoPath);
  if (!key) return false;
  return heldKeys.getStore()?.has(key) ?? false;
}

/** 当前正在排队/执行的仓库键(仅供测试与诊断)。 */
export function lockedRepoKeys(): string[] {
  return [...queues.keys()];
}

/**
 * 在仓库级互斥下执行 fn。路径为空(无仓库项目)或已持有该锁时直接执行。
 * 同一仓库的其它调用会排队等待,不同仓库互不影响。
 */
export async function withRepoLock<T>(
  repoPath: string | null | undefined,
  fn: (wait: RepoLockWait) => Promise<T> | T,
): Promise<T> {
  const key = repoKey(repoPath);
  if (!key) return await fn(NO_WAIT);
  const outer = heldKeys.getStore();
  if (outer?.has(key)) return await fn(NO_WAIT);

  const previous = queues.get(key);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // 队尾 = 前一个人跑完 + 我跑完。gate 只 resolve 不 reject(release 在
  // finally 里),所以这条链永远不会产生未处理的 rejection。
  const tail = previous ? previous.then(() => gate) : gate;
  queues.set(key, tail);

  const startedWaiting = Date.now();
  if (previous) await previous;
  const waitedMs = Date.now() - startedWaiting;
  const wait: RepoLockWait = { queued: !!previous, waitedMs };
  if (waitedMs > 30_000) console.warn(`[repo-lock] ${key} 排队等待 ${(waitedMs / 1000).toFixed(1)}s`);

  const owned = new Set(outer ?? []);
  owned.add(key);
  try {
    return await heldKeys.run(owned, () => fn(wait));
  } finally {
    release();
    // 队尾还是自己 = 后面没人在等,把条目回收掉,别让 Map 随仓库数无限长。
    if (queues.get(key) === tail) queues.delete(key);
  }
}
