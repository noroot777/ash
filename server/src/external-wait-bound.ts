// 「这一段里等外部东西,都别超过 N 毫秒」—— 给回合收尾这类**占着回合锁**的代码用。
//
// 收尾链里有些步骤在很深的调用里才碰外部命令或仓库锁(例如基线对账拆空壳工作目录:
// discardTaskWorkspace → withRepoLock → 一串 git)。把时限一路当参数传下去要改十几个签名,
// 新加一条 git 又会漏;所以用一个异步上下文圈住那一段:
//   · execFileText 没显式给 `timeoutMs` 时取这里的时限(到点按进程组杀,见 exec.ts);
//   · withRepoLock 排队超过时限就放弃排队、让出队位(还没拿到手的等待,放弃没有副作用)。
// 到点时回调 `onTimeout` 收到一句「放弃了什么」,由圈这一段的人决定怎么留痕。
//
// **只圈收尾里那几段确定该有界的调用**。自带上限的命令(命令站的 20 分钟、网络 git 的 120 秒)
// 不被这里覆盖,见 exec.ts。
//
// **时限只在这一段还没结束时有效**:异步上下文会跟着这一段里 `void` 出去的后续工作走(验收门禁
// 跑完之后的合并、排到之后才起跑的派审),它们早已不在收尾里,不该被收尾的时限误杀。所以
// `run` 一结束这份时限就失效,之后再问 `externalWaitBound()` 一律是 undefined。
import { AsyncLocalStorage } from "node:async_hooks";

export type ExternalWaitBound = {
  ms: number;
  onTimeout: (what: string) => void;
};

const scope = new AsyncLocalStorage<{ bound: ExternalWaitBound; active: boolean }>();

export async function withExternalWaitBound<T>(bound: ExternalWaitBound, run: () => Promise<T>): Promise<T> {
  const store = { bound, active: true };
  try { return await scope.run(store, run); }
  finally { store.active = false; }
}

/** 当前异步上下文里的时限;不在任何还没结束的圈定段里时为 undefined(老行为:不设时限)。 */
export function externalWaitBound(): ExternalWaitBound | undefined {
  const store = scope.getStore();
  return store?.active ? store.bound : undefined;
}
